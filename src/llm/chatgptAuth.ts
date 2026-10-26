import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LLMError } from './types.js';

/**
 * "Sign in with ChatGPT" with ChatGPT plan usage for open-source apps (OpenAI's official flow):
 * https://developers.openai.com/siwc/token-sharing-open-source
 *
 * - First sign-in registers this installation as a user-defined agent (client_id=dynamic_agent_client);
 *   the callback returns the issued client_id, which is reused for every later sign-in and refresh.
 * - The redirect URI has to be a 127.0.0.1 loopback address. The bot runs on a server, so the browser
 *   ends up on a page that doesn't load – the admin pastes that address into the web UI and we finish here.
 * - Credentials live in one file in DATA_DIR (0600, written atomically), never in the browser.
 */

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const CHATGPT_API = 'https://api.openai.com/v1';
export const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const AGENT_NAME = 'Media Agentcy';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const ATTEMPT_TTL_MS = 30 * 60_000;
/** Refresh a little before the access token (1 h) runs out. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

interface Account {
  email?: string;
  issuer: string;
  subject: string;
  client_id: string;
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  /** Unix ms. */
  expires_at?: number;
  scopes: string[];
  saved_at: string;
  /** The one-time "you're using your ChatGPT plan" notice was shown. */
  plan_notice_shown?: boolean;
}

interface StoredFile {
  ext_agent_host_id: string;
  account?: Account;
}

interface Attempt {
  state: string;
  nonce: string;
  verifier: string;
  /** Issued client id for a reauthorization, undefined for a first registration. */
  clientId?: string;
  createdAt: number;
}

export interface ChatGPTStatus {
  connected: boolean;
  /** The granted scopes allow using the ChatGPT plan for inference. */
  planUsage: boolean;
  email?: string;
  registered: boolean;
  expiresAt?: string;
  authFile: string;
}

type Fetch = typeof fetch;

export class ChatGPTAuth {
  private attempts = new Map<string, Attempt>();
  private refreshing?: Promise<Account>;
  private discovery?: Promise<{ jwks_uri: string; issuer: string; revocation_endpoint?: string }>;

  constructor(
    readonly file: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  status(): ChatGPTStatus {
    const a = this.read().account;
    return {
      connected: !!a?.refresh_token,
      planUsage: !!a?.refresh_token && a.scopes.includes(PLAN_SCOPE),
      email: a?.email,
      registered: !!a?.client_id,
      expiresAt: a?.expires_at ? new Date(a.expires_at).toISOString() : undefined,
      authFile: this.file,
    };
  }

  /** Builds the authorize URL for a new sign-in (first registration or reauthorization). */
  startLogin(opts: { consent?: boolean } = {}): string {
    const stored = this.read();
    const account = stored.account;
    const attempt: Attempt = {
      state: b64url(randomBytes(24)),
      nonce: b64url(randomBytes(24)),
      verifier: b64url(randomBytes(48)),
      clientId: account?.client_id,
      createdAt: Date.now(),
    };
    this.pruneAttempts();
    this.attempts.set(attempt.state, attempt);

    const params = new URLSearchParams({
      client_id: attempt.clientId ?? DYNAMIC_CLIENT,
      ext_agent_host_id: stored.ext_agent_host_id,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      resource: CHATGPT_API,
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: 'S256',
      code_challenge: b64url(createHash('sha256').update(attempt.verifier).digest()),
    });
    if (!attempt.clientId) params.set('agent_name_hint', AGENT_NAME);
    if (attempt.clientId && account?.id_token) params.set('id_token_hint', account.id_token);
    if (attempt.clientId && account?.email) params.set('login_hint', account.email);
    // Only when the admin explicitly turns plan usage on after declining it earlier.
    if (opts.consent) params.set('prompt', 'consent');
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Finishes a sign-in from the address the browser was redirected to (http://127.0.0.1:1455/auth/callback?...). */
  async completeLogin(callback: string): Promise<{ status: ChatGPTStatus; firstPlanSignIn: boolean }> {
    const q = parseCallback(callback);
    const state = q.get('state');
    const attempt = state ? this.attempts.get(state) : undefined;
    if (!attempt || Date.now() - attempt.createdAt > ATTEMPT_TTL_MS) {
      throw new LLMError('Diese Anmeldung gehört zu keinem offenen Versuch (oder ist älter als 30 Minuten). Bitte noch einmal auf „Continue with ChatGPT“ klicken.');
    }
    this.attempts.delete(attempt.state);

    const error = q.get('error');
    if (error === 'access_denied') throw new LLMError('Die Anmeldung wurde in ChatGPT abgelehnt.');
    if (error) throw new LLMError(`ChatGPT-Anmeldung fehlgeschlagen: ${error}${q.get('error_description') ? ` – ${q.get('error_description')}` : ''}`);

    const code = q.get('code');
    if (!code) throw new LLMError('In der eingefügten Adresse fehlt der Parameter „code“. Bitte die komplette Adresse aus der Adressleiste kopieren.');
    const returned = q.get('client_id') ?? undefined;
    let clientId: string;
    if (attempt.clientId) {
      if (returned && returned !== attempt.clientId) throw new LLMError('ChatGPT hat eine andere Client-ID zurückgegeben als die gespeicherte – Anmeldung verworfen.');
      clientId = attempt.clientId;
    } else {
      if (!returned || returned === DYNAMIC_CLIENT) throw new LLMError('Die Registrierung ist unvollständig (keine Client-ID in der Antwort). Bitte erneut anmelden.');
      clientId = returned;
    }

    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: REDIRECT_URI,
        resource: CHATGPT_API,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const tokens = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !tokens.access_token) {
      const code = tokens.error ?? `HTTP ${res.status}`;
      throw new LLMError(
        code === 'invalid_grant'
          ? 'Der Anmeldecode ist abgelaufen oder wurde schon benutzt. Bitte noch einmal auf „Continue with ChatGPT“ klicken.'
          : `Token-Tausch fehlgeschlagen: ${code}${tokens.error_description ? ` – ${tokens.error_description}` : ''}`,
        res.status,
      );
    }
    if (!tokens.id_token) throw new LLMError('ChatGPT hat kein ID-Token geliefert.');
    const claims = await this.validateIdToken(tokens.id_token, clientId, attempt.nonce);

    const stored = this.read();
    const previous = stored.account;
    if (previous?.client_id === clientId && previous.subject !== claims.sub) {
      throw new LLMError('Das ist ein anderes ChatGPT-Konto als das verbundene. Erst trennen, dann mit dem neuen Konto anmelden.');
    }
    const scopes = (tokens.scope ?? q.get('scope') ?? '').split(/[\s+]+/).filter(Boolean).sort();
    const account: Account = {
      email: typeof claims.email === 'string' ? claims.email : previous?.email,
      issuer: ISSUER,
      subject: claims.sub,
      client_id: clientId,
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type ?? 'Bearer',
      expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes,
      saved_at: new Date().toISOString(),
      plan_notice_shown: previous?.subject === claims.sub ? previous.plan_notice_shown : false,
    };
    const firstPlanSignIn = scopes.includes(PLAN_SCOPE) && !account.plan_notice_shown;
    if (firstPlanSignIn) account.plan_notice_shown = true;
    this.write({ ...stored, account });
    return { status: this.status(), firstPlanSignIn };
  }

  /** Signs out: revokes the refresh token, clears the tokens, keeps the registration (client id, host id). */
  async logout(): Promise<{ revoked: boolean }> {
    const stored = this.read();
    const a = stored.account;
    if (!a) return { revoked: true };
    let revoked = !a.refresh_token;
    if (a.refresh_token) {
      try {
        const endpoint = (await this.loadDiscovery()).revocation_endpoint ?? `${ISSUER}/oauth/revoke`;
        for (let i = 0; i < 3 && !revoked; i++) {
          const res = await this.fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: a.refresh_token, token_type_hint: 'refresh_token', client_id: a.client_id }),
            signal: AbortSignal.timeout(15_000),
          }).catch(() => undefined);
          if (res?.ok) revoked = true;
          else if (res && res.status < 500) break;
          else await sleep(500 * 2 ** i);
        }
      } catch {
        // Discovery failed – sign out locally anyway and say so.
      }
    }
    this.write({ ...stored, account: { ...a, access_token: undefined, refresh_token: undefined, expires_at: undefined, saved_at: new Date().toISOString() } });
    return { revoked };
  }

  /** A valid access token with plan permission, refreshed when needed. */
  async accessToken(force = false): Promise<string> {
    let a = this.read().account;
    if (!a?.refresh_token) throw new LLMError('ChatGPT ist nicht verbunden. In der Web-Oberfläche unter Einstellungen → KI-Anbieter auf „Continue with ChatGPT“ klicken.');
    if (!a.scopes.includes(PLAN_SCOPE)) {
      throw new LLMError('Die ChatGPT-Anmeldung erlaubt keine Nutzung des ChatGPT-Abos. In den Einstellungen „Abo-Nutzung aktivieren“ wählen oder einen anderen Anbieter einstellen.');
    }
    if (force || !a.access_token || !a.expires_at || a.expires_at - Date.now() < REFRESH_MARGIN_MS) a = await this.refresh(force ? a.access_token : undefined);
    return a.access_token!;
  }

  /** One refresh at a time: the refresh token rotates, a second parallel refresh would invalidate the session. */
  private refresh(rejected?: string): Promise<Account> {
    this.refreshing ??= this.doRefresh(rejected).finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  /** `rejected`: the access token the API just refused (401) – refresh even though it hasn't expired yet. */
  private async doRefresh(rejected?: string): Promise<Account> {
    const stored = this.read();
    const a = stored.account;
    if (!a?.refresh_token) throw new LLMError('ChatGPT ist nicht verbunden.');
    // Another caller may have refreshed while we waited (then the token differs from the rejected one).
    if (a.access_token && a.access_token !== rejected && a.expires_at && a.expires_at - Date.now() >= REFRESH_MARGIN_MS) return a;
    let res: Response;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: a.client_id, refresh_token: a.refresh_token, resource: CHATGPT_API }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new LLMError(`ChatGPT-Token konnte nicht erneuert werden (Netzwerk): ${(err as Error).message}`);
    }
    const tokens = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !tokens.access_token) {
      const code = tokens.error ?? '';
      if (TERMINAL_REFRESH_ERRORS.has(code)) {
        this.write({ ...stored, account: { ...a, access_token: undefined, refresh_token: undefined, expires_at: undefined } });
        throw new LLMError('Die ChatGPT-Anmeldung ist abgelaufen oder wurde in ChatGPT getrennt. Bitte in der Web-Oberfläche neu verbinden.', 401);
      }
      throw new LLMError(`ChatGPT-Token konnte nicht erneuert werden: ${code || `HTTP ${res.status}`}`, res.status);
    }
    const next: Account = {
      ...a,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? a.refresh_token,
      id_token: tokens.id_token ?? a.id_token,
      token_type: tokens.token_type ?? a.token_type,
      expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean).sort() : a.scopes,
      saved_at: new Date().toISOString(),
    };
    this.write({ ...this.read(), account: next });
    return next;
  }

  private async validateIdToken(token: string, clientId: string, nonce: string): Promise<{ sub: string; email?: unknown }> {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) throw new LLMError('Ungültiges ID-Token.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    const discovery = await this.loadDiscovery();
    const jwksRes = await this.fetchImpl(discovery.jwks_uri, { signal: AbortSignal.timeout(15_000) });
    if (!jwksRes.ok) throw new LLMError(`OpenAI-Schlüssel (JWKS) nicht abrufbar: HTTP ${jwksRes.status}`);
    const { keys = [] } = (await jwksRes.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    const jwk = keys.find((k) => !header.kid || k.kid === header.kid);
    if (!jwk) throw new LLMError('ID-Token: passender OpenAI-Schlüssel nicht gefunden.');
    const alg = header.alg ?? '';
    const hash = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', ES256: 'sha256', ES384: 'sha384', PS256: 'sha256' }[alg];
    if (!hash) throw new LLMError(`ID-Token: Algorithmus ${alg || '?'} wird nicht unterstützt.`);
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const ok = verifySignature(
      hash,
      Buffer.from(`${h}.${p}`),
      alg.startsWith('ES') ? { key, dsaEncoding: 'ieee-p1363' } : alg.startsWith('PS') ? { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */ } : key,
      Buffer.from(s, 'base64url'),
    );
    if (!ok) throw new LLMError('ID-Token: Signatur ungültig.');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== discovery.issuer) throw new LLMError('ID-Token: falscher Aussteller.');
    if (!aud.includes(clientId)) throw new LLMError('ID-Token: gehört zu einer anderen Client-ID.');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() - 60_000) throw new LLMError('ID-Token: abgelaufen.');
    if (claims.nonce !== nonce) throw new LLMError('ID-Token: Nonce passt nicht zum Anmeldeversuch.');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new LLMError('ID-Token: ohne Kontokennung.');
    return { sub: claims.sub, email: claims.email };
  }

  private loadDiscovery() {
    this.discovery ??= (async () => {
      const res = await this.fetchImpl(DISCOVERY_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new LLMError(`OpenAI-Anmeldedienst nicht erreichbar: HTTP ${res.status}`);
      return (await res.json()) as { jwks_uri: string; issuer: string; revocation_endpoint?: string };
    })().catch((err) => {
      this.discovery = undefined;
      throw err;
    });
    return this.discovery;
  }

  private pruneAttempts() {
    const now = Date.now();
    for (const [k, v] of this.attempts) if (now - v.createdAt > ATTEMPT_TTL_MS) this.attempts.delete(k);
  }

  /** Reads the credential file; creates the stable host id on first use. */
  private read(): StoredFile {
    let data: Partial<StoredFile> & { tokens?: unknown } = {};
    if (existsSync(this.file)) {
      try {
        data = JSON.parse(readFileSync(this.file, 'utf8')) as typeof data;
      } catch {
        data = {};
      }
      // An old Codex auth.json at this path: keep it aside instead of overwriting it.
      if (data.tokens && !data.ext_agent_host_id) {
        renameSync(this.file, `${this.file}.codex-backup`);
        data = {};
      }
    }
    if (typeof data.ext_agent_host_id === 'string' && data.ext_agent_host_id) return data as StoredFile;
    const fresh: StoredFile = { ext_agent_host_id: `urn:uuid:${randomUUID()}`, account: data.account };
    this.write(fresh);
    return fresh;
  }

  private write(data: StoredFile) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Accepts the full callback URL or just its query string. */
function parseCallback(input: string) {
  const s = input.trim();
  if (!s) throw new LLMError('Bitte die Adresse aus der Adressleiste einfügen.');
  try {
    return new URL(s).searchParams;
  } catch {
    return new URLSearchParams(s.slice(s.indexOf('?') + 1));
  }
}

const b64url = (b: Buffer) => b.toString('base64url');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One instance per credential file, so a pending sign-in and a running refresh survive provider re-creation. */
const instances = new Map<string, ChatGPTAuth>();
export function chatgptAuth(file: string, fetchImpl?: Fetch) {
  const key = path.resolve(file);
  let a = instances.get(key);
  if (!a || fetchImpl) {
    a = new ChatGPTAuth(key, fetchImpl);
    instances.set(key, a);
  }
  return a;
}
