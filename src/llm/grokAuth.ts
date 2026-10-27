import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LLMError } from './types.js';

/**
 * Grok plan (SuperGrok / X Premium+) via xAI's OAuth device-code login (RFC 8628), the way Hermes Agent,
 * OpenClaw, OpenCode and other open-source agents sign in: the admin opens xAI's page, confirms the code
 * shown in the web UI, and we poll the token endpoint in the background. No loopback redirect, so it
 * works on a server without pasting addresses around.
 *
 * - xAI has no client registration for third-party apps; everyone uses its shared public client.
 * - Which subscriptions may use the API is decided by xAI (a 403 after a successful sign-in = tier not allowed).
 * - Credentials live in one file in DATA_DIR (0600, written atomically), never in the browser.
 */

const ISSUER = 'https://auth.x.ai';
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const REVOKE_URL = `${ISSUER}/oauth2/revoke`;
export const GROK_API = 'https://api.x.ai/v1';
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPES = 'openid profile email offline_access grok-cli:access api:access';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Refresh a little before the access token runs out. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const TERMINAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_request', 'access_denied', 'unauthorized_client']);

interface Account {
  email?: string;
  subject?: string;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  /** Unix ms. */
  expires_at?: number;
  saved_at: string;
}

interface StoredFile {
  account?: Account;
}

interface Pending {
  deviceCode: string;
  userCode: string;
  url: string;
  intervalMs: number;
  expiresAt: number;
  /** Bumped per sign-in, so an older poll loop stops when a new one starts. */
  generation: number;
}

export interface GrokStatus {
  connected: boolean;
  email?: string;
  expiresAt?: string;
  /** A sign-in waiting for confirmation on xAI's page. */
  pending?: { userCode: string; url: string; expiresAt: string };
  /** Why the last sign-in didn't finish (declined, expired, network). Cleared by the next one. */
  error?: string;
  authFile: string;
}

type Fetch = typeof fetch;

export class GrokAuth {
  private pending?: Pending;
  private generation = 0;
  private lastError?: string;
  private refreshing?: Promise<Account>;

  constructor(
    readonly file: string,
    private readonly fetchImpl: Fetch = fetch,
    /** Tests shorten the poll interval. */
    private readonly minIntervalMs = 1000,
  ) {}

  status(): GrokStatus {
    const a = this.read().account;
    const p = this.pending && this.pending.expiresAt > Date.now() ? this.pending : undefined;
    return {
      connected: !!a?.refresh_token,
      email: a?.email,
      expiresAt: a?.expires_at ? new Date(a.expires_at).toISOString() : undefined,
      pending: p ? { userCode: p.userCode, url: p.url, expiresAt: new Date(p.expiresAt).toISOString() } : undefined,
      error: this.lastError,
      authFile: this.file,
    };
  }

  /** Requests a device code and starts polling in the background. The UI shows the code and polls status(). */
  async startLogin(): Promise<GrokStatus> {
    const res = await this.post(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPES }).catch((err: Error) => {
      throw new LLMError(`xAI-Anmeldedienst nicht erreichbar: ${err.message}`);
    });
    const data = (await res.json().catch(() => ({}))) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      interval?: number;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.device_code || !data.user_code || !data.verification_uri) {
      throw new LLMError(`xAI-Anmeldung konnte nicht gestartet werden: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}`, res.status);
    }
    const url = data.verification_uri_complete ?? data.verification_uri;
    // The admin opens this link – only xAI's own https pages.
    const host = safeUrl(url);
    if (host?.protocol !== 'https:' || !(host.hostname === 'x.ai' || host.hostname.endsWith('.x.ai'))) {
      throw new LLMError('xAI hat eine unerwartete Bestätigungsadresse geliefert – Anmeldung abgebrochen.');
    }
    this.pending = {
      deviceCode: data.device_code,
      userCode: data.user_code,
      url,
      intervalMs: Math.max(this.minIntervalMs, (data.interval ?? 5) * 1000),
      expiresAt: Date.now() + (data.expires_in && data.expires_in > 0 ? data.expires_in : 600) * 1000,
      generation: ++this.generation,
    };
    this.lastError = undefined;
    void this.poll(this.pending);
    return this.status();
  }

  cancelLogin() {
    this.pending = undefined;
    this.generation++;
  }

  /** Polls the token endpoint until the code is confirmed, declined or expired. */
  private async poll(p: Pending) {
    let interval = p.intervalMs;
    const current = () => this.pending?.generation === p.generation;
    const fail = (msg: string) => {
      if (!current()) return;
      this.pending = undefined;
      this.lastError = msg;
    };
    while (current()) {
      await sleep(interval);
      if (!current()) return;
      if (Date.now() > p.expiresAt) return fail('Der Code ist abgelaufen. Bitte noch einmal auf „Mit Grok anmelden“ klicken.');
      let res: Response;
      try {
        res = await this.post(TOKEN_URL, { grant_type: DEVICE_GRANT, device_code: p.deviceCode, client_id: CLIENT_ID });
      } catch {
        // Network hiccup: keep trying until the code expires.
        interval = Math.min(interval * 2, 30_000);
        continue;
      }
      const tokens = (await res.json().catch(() => ({}))) as TokenResponse;
      if (res.ok && tokens.access_token) {
        if (!current()) return;
        if (!tokens.refresh_token) return fail('xAI hat keinen Refresh-Token geliefert – die Anmeldung würde nach einer Stunde verfallen. Bitte erneut versuchen.');
        const claims = jwtClaims(tokens.id_token ?? tokens.access_token);
        this.write({
          account: {
            email: typeof claims.email === 'string' ? claims.email : undefined,
            subject: typeof claims.sub === 'string' ? claims.sub : undefined,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            id_token: tokens.id_token,
            expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
            saved_at: new Date().toISOString(),
          },
        });
        this.pending = undefined;
        return;
      }
      switch (tokens.error) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          // RFC 8628: 5 s more on every slow_down (scaled down in tests).
          interval += 5 * this.minIntervalMs;
          continue;
        case 'access_denied':
          return fail('Die Anmeldung wurde bei xAI abgelehnt.');
        case 'expired_token':
          return fail('Der Code ist abgelaufen. Bitte noch einmal auf „Mit Grok anmelden“ klicken.');
        default:
          if (res.status >= 500 || res.status === 429) {
            interval = Math.min(interval * 2, 30_000);
            continue;
          }
          return fail(`xAI-Anmeldung fehlgeschlagen: ${tokens.error_description ?? tokens.error ?? `HTTP ${res.status}`}`);
      }
    }
  }

  /** Signs out: revokes the refresh token at xAI and deletes the tokens here. */
  async logout(): Promise<{ revoked: boolean }> {
    this.cancelLogin();
    this.lastError = undefined;
    const a = this.read().account;
    let revoked = !a?.refresh_token;
    if (a?.refresh_token) {
      const res = await this.post(REVOKE_URL, { token: a.refresh_token, token_type_hint: 'refresh_token', client_id: CLIENT_ID }).catch(() => undefined);
      revoked = !!res?.ok;
    }
    this.write({});
    return { revoked };
  }

  /** A valid access token, refreshed when needed. `force`: the API just refused it (401). */
  async accessToken(force = false): Promise<string> {
    let a = this.read().account;
    if (!a?.refresh_token) throw new LLMError('Grok ist nicht verbunden. In der Web-Oberfläche unter Einstellungen → KI-Anbieter → Grok-Abo auf „Mit Grok anmelden“ klicken.');
    if (force || !a.access_token || !a.expires_at || a.expires_at - Date.now() < REFRESH_MARGIN_MS) a = await this.refresh(force ? a.access_token : undefined);
    return a.access_token!;
  }

  /** One refresh at a time: if xAI rotates the refresh token, a second parallel refresh would invalidate the session. */
  private refresh(rejected?: string): Promise<Account> {
    this.refreshing ??= this.doRefresh(rejected).finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh(rejected?: string): Promise<Account> {
    const a = this.read().account;
    if (!a?.refresh_token) throw new LLMError('Grok ist nicht verbunden.');
    // Another caller may have refreshed while we waited (then the token differs from the rejected one).
    if (a.access_token && a.access_token !== rejected && a.expires_at && a.expires_at - Date.now() >= REFRESH_MARGIN_MS) return a;
    let res: Response;
    try {
      res = await this.post(TOKEN_URL, { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: a.refresh_token });
    } catch (err) {
      throw new LLMError(`Grok-Token konnte nicht erneuert werden (Netzwerk): ${(err as Error).message}`);
    }
    const tokens = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !tokens.access_token) {
      const code = tokens.error ?? '';
      if (TERMINAL_REFRESH_ERRORS.has(code)) {
        this.write({ account: { ...a, access_token: undefined, refresh_token: undefined, expires_at: undefined } });
        throw new LLMError('Die Grok-Anmeldung ist abgelaufen oder wurde bei xAI widerrufen. Bitte in der Web-Oberfläche neu verbinden.', 401);
      }
      throw new LLMError(`Grok-Token konnte nicht erneuert werden: ${code || `HTTP ${res.status}`}`, res.status);
    }
    const next: Account = {
      ...a,
      access_token: tokens.access_token,
      // xAI doesn't always rotate the refresh token – keep the old one then.
      refresh_token: tokens.refresh_token ?? a.refresh_token,
      id_token: tokens.id_token ?? a.id_token,
      expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      saved_at: new Date().toISOString(),
    };
    this.write({ account: next });
    return next;
  }

  private post(url: string, body: Record<string, string>) {
    return this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

  private read(): StoredFile {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as StoredFile;
    } catch {
      return {};
    }
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
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Reads the claims for display (email, account id). The token came straight from xAI's token endpoint over
 * TLS and only labels the connection, so it isn't verified against the JWKS here.
 */
function jwtClaims(token?: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token!.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeUrl(s: string) {
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One instance per credential file, so a pending sign-in and a running refresh survive provider re-creation. */
const instances = new Map<string, GrokAuth>();
export function grokAuth(file: string, fetchImpl?: Fetch, minIntervalMs?: number) {
  const key = path.resolve(file);
  let a = instances.get(key);
  if (!a || fetchImpl) {
    a = new GrokAuth(key, fetchImpl, minIntervalMs);
    instances.set(key, a);
  }
  return a;
}
