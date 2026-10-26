/**
 * "Sign in with ChatGPT" (plan usage for open-source apps): registration, ID-token check, refresh, sign-out,
 * and the Responses provider. Fake fetch, real RS256 signatures. Run: npm test
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatGPTAuth } from '../src/llm/chatgptAuth.js';
import { ChatGPTProvider } from '../src/llm/chatgpt.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function idToken(claims: Record<string, unknown>, key = privateKey) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  body?: string;
  auth?: string | null;
}

/** Fake OpenAI auth server; `token` decides what the token endpoint answers. */
function fakeOpenAI(token: (form: URLSearchParams) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined;
    calls.push({ url, body, auth: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
    }
    if (url.endsWith('/jwks.json')) return json({ keys: [jwk] });
    if (url.endsWith('/oauth/token')) return token(new URLSearchParams(body));
    if (url.endsWith('/oauth/revoke')) return new Response('', { status: 200 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'mag-gpt-')), 'chatgpt-auth.json');
const PLAN = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';

async function signIn(auth: ChatGPTAuth, opts: { scope?: string; sub?: string; clientId?: string } = {}) {
  const url = new URL(auth.startLogin());
  const state = url.searchParams.get('state')!;
  const callback = `http://127.0.0.1:1455/auth/callback?code=abc&state=${state}&scope=${encodeURIComponent(opts.scope ?? PLAN)}${opts.clientId === undefined ? '&client_id=oaiapp_123' : opts.clientId ? `&client_id=${opts.clientId}` : ''}`;
  return { url, result: await auth.completeLogin(callback) };
}

function issuer(opts: { scope?: string; sub?: string } = {}) {
  let nonce = '';
  let refreshCount = 0;
  const fake = fakeOpenAI((form) => {
    if (form.get('grant_type') === 'authorization_code') {
      return json({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        id_token: idToken({ iss: 'https://auth.openai.com', aud: form.get('client_id'), sub: opts.sub ?? 'user-1', email: 'felix@example.com', nonce, exp: Math.floor(Date.now() / 1000) + 600 }),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: opts.scope ?? PLAN,
      });
    }
    refreshCount++;
    return json({ access_token: `at-r${refreshCount}`, refresh_token: `rt-r${refreshCount}`, expires_in: 3600 });
  });
  return { ...fake, setNonce: (n: string) => (nonce = n), refreshes: () => refreshCount };
}

/** Starts a login and makes the fake server sign the ID token with that attempt's nonce. */
async function connect(auth: ChatGPTAuth, srv: ReturnType<typeof issuer>) {
  const start = auth.startLogin.bind(auth);
  auth.startLogin = (o) => {
    const u = start(o);
    srv.setNonce(new URL(u).searchParams.get('nonce')!);
    return u;
  };
  return signIn(auth);
}

test('first sign-in registers the app: dynamic client, host id, PKCE, plan scopes, loopback redirect', () => {
  const file = tmpFile();
  const auth = new ChatGPTAuth(file, fakeOpenAI(() => json({})).fetchImpl);
  const url = new URL(auth.startLogin());
  const p = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.equal(p.get('client_id'), 'dynamic_agent_client');
  assert.equal(p.get('agent_name_hint'), 'Media Agentcy');
  assert.match(p.get('ext_agent_host_id')!, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(p.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(p.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.equal(p.get('resource'), 'https://api.openai.com/v1');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.match(p.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.get('prompt'), null);
  // The host id is stable across attempts and stored owner-only.
  assert.equal(new URL(auth.startLogin()).searchParams.get('ext_agent_host_id'), p.get('ext_agent_host_id'));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('callback: validated sign-in is saved; later sign-ins reuse the issued client id', async () => {
  const file = tmpFile();
  const srv = issuer();
  const auth = new ChatGPTAuth(file, srv.fetchImpl);
  const { result } = await connect(auth, srv);
  assert.equal(result.firstPlanSignIn, true);
  assert.deepEqual({ ...result.status, expiresAt: undefined }, { connected: true, planUsage: true, email: 'felix@example.com', registered: true, expiresAt: undefined, authFile: file });

  const exchange = new URLSearchParams(srv.calls.find((c) => c.url.endsWith('/oauth/token'))!.body);
  assert.equal(exchange.get('client_id'), 'oaiapp_123');
  assert.equal(exchange.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(exchange.get('resource'), 'https://api.openai.com/v1');
  assert.match(exchange.get('code_verifier')!, /^[A-Za-z0-9_-]{64}$/);

  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.account.client_id, 'oaiapp_123');
  assert.equal(saved.account.refresh_token, 'rt-1');

  const again = new URL(auth.startLogin()).searchParams;
  assert.equal(again.get('client_id'), 'oaiapp_123');
  assert.equal(again.get('agent_name_hint'), null);
  assert.equal(again.get('login_hint'), 'felix@example.com');
  assert.ok(again.get('id_token_hint'));
  const second = await connect(auth, srv);
  assert.equal(second.result.firstPlanSignIn, false, 'the plan notice is shown only once');
});

test('callback is rejected for an unknown state, a declined consent, a bad signature, or a missing client id', async () => {
  const srv = issuer();
  const auth = new ChatGPTAuth(tmpFile(), srv.fetchImpl);
  await assert.rejects(auth.completeLogin('http://127.0.0.1:1455/auth/callback?code=x&state=nope&client_id=oaiapp_1'), /keinem offenen Versuch/);
  const s1 = new URL(auth.startLogin()).searchParams.get('state');
  await assert.rejects(auth.completeLogin(`http://127.0.0.1:1455/auth/callback?error=access_denied&state=${s1}`), /abgelehnt/);
  const s2 = new URL(auth.startLogin()).searchParams.get('state');
  await assert.rejects(auth.completeLogin(`?code=x&state=${s2}`), /unvollständig/);

  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const forged = new ChatGPTAuth(
    tmpFile(),
    fakeOpenAI((form) => json({ access_token: 'a', refresh_token: 'r', scope: PLAN, id_token: idToken({ iss: 'https://auth.openai.com', aud: form.get('client_id'), sub: 'x', exp: 9e9 }, other) })).fetchImpl,
  );
  const s3 = new URL(forged.startLogin()).searchParams.get('state');
  await assert.rejects(forged.completeLogin(`http://127.0.0.1:1455/auth/callback?code=x&state=${s3}&client_id=oaiapp_9`), /Signatur ungültig/);
});

test('without the plan scope the sign-in is kept but inference is refused', async () => {
  const srv = issuer({ scope: 'email openid profile offline_access' });
  const auth = new ChatGPTAuth(tmpFile(), srv.fetchImpl);
  const { result } = await connect(auth, srv);
  assert.equal(result.status.connected, true);
  assert.equal(result.status.planUsage, false);
  assert.equal(result.firstPlanSignIn, false);
  await assert.rejects(auth.accessToken(), /keine Nutzung des ChatGPT-Abos/);
  assert.equal(new URL(auth.startLogin({ consent: true })).searchParams.get('prompt'), 'consent');
});

test('refresh: parallel callers share one refresh, rotated tokens are saved; a dead session is cleared', async () => {
  const file = tmpFile();
  const srv = issuer();
  const auth = new ChatGPTAuth(file, srv.fetchImpl);
  await connect(auth, srv);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.account.expires_at = Date.now() + 60_000; // inside the refresh margin
  writeFileSync(file, JSON.stringify(saved));

  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.equal(a, 'at-r1');
  assert.equal(b, 'at-r1');
  assert.equal(srv.refreshes(), 1);
  const refreshForm = new URLSearchParams(srv.calls.filter((c) => c.url.endsWith('/oauth/token')).at(-1)!.body);
  assert.equal(refreshForm.get('client_id'), 'oaiapp_123');
  assert.equal(refreshForm.get('refresh_token'), 'rt-1');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).account.refresh_token, 'rt-r1');

  const dead = new ChatGPTAuth(file, fakeOpenAI(() => json({ error: 'refresh_token_reused' }, 400)).fetchImpl);
  await assert.rejects(dead.accessToken(true), /neu verbinden/);
  assert.equal(dead.status().connected, false);
  assert.equal(dead.status().registered, true, 'the registration (client id) is kept for the next sign-in');
});

test('sign-out revokes the refresh token and keeps the registration', async () => {
  const file = tmpFile();
  const srv = issuer();
  const auth = new ChatGPTAuth(file, srv.fetchImpl);
  await connect(auth, srv);
  assert.deepEqual(await auth.logout(), { revoked: true });
  const revoke = new URLSearchParams(srv.calls.find((c) => c.url.endsWith('/oauth/revoke'))!.body);
  assert.equal(revoke.get('token'), 'rt-1');
  assert.equal(revoke.get('token_type_hint'), 'refresh_token');
  assert.equal(revoke.get('client_id'), 'oaiapp_123');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.account.refresh_token, undefined);
  assert.equal(saved.account.client_id, 'oaiapp_123');
});

test('an old Codex auth.json at the same path is set aside, not overwritten', () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ tokens: { access_token: 'x', refresh_token: 'y' } }));
  const auth = new ChatGPTAuth(file, fakeOpenAI(() => json({})).fetchImpl);
  assert.equal(auth.status().connected, false);
  assert.match(readFileSync(`${file}.codex-backup`, 'utf8'), /refresh_token/);
});

// ---------------------------------------------------------------- provider

function sse(events: unknown[]) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function providerWith(responses: (Response | (() => Response))[]) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const auth = { accessToken: async (force?: boolean) => (force ? 'fresh-token' : 'token') } as unknown as ChatGPTAuth;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get('authorization') });
    const r = responses.shift();
    if (!r) throw new Error('no response left');
    return typeof r === 'function' ? r() : r;
  }) as typeof fetch;
  return { llm: new ChatGPTProvider({ auth, model: 'gpt-test', fetch: fetchImpl }), calls };
}

const tools = [{ name: 'search_media', description: 'Sucht', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];

test('provider: Responses request follows the plan-usage rules; namespaced tool calls come back and are echoed', async () => {
  const { llm, calls } = providerWith([
    sse([
      { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', summary: [] } },
      { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'search_media', namespace: 'media_agentcy', arguments: '{"query":"Dune"}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 7 } } },
    ]),
    sse([
      { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Dune ist da.' }] } },
      { type: 'response.completed', response: { usage: { input_tokens: 60, output_tokens: 4 } } },
    ]),
  ]);
  const messages: any[] = [
    { role: 'system', content: 'Du bist ein Bot.' },
    { role: 'user', content: 'Gibt es Dune?', images: [{ mime: 'image/jpeg', base64: 'AAAA' }] },
  ];
  const first = await llm.complete({ messages, tools, temperature: 0.3 });
  assert.deepEqual(first.toolCalls, [{ id: 'call_1', name: 'search_media', arguments: '{"query":"Dune"}' }]);
  assert.deepEqual(first.usage, { input: 50, output: 7 });

  const body = calls[0].body;
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].auth, 'Bearer token');
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.instructions, 'Du bist ein Bot.');
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.tools[0].type, 'namespace');
  assert.equal(body.tools[0].tools[0].name, 'search_media');
  assert.ok(!body.input.some((i: any) => i.role === 'system'), 'no system message items');
  assert.deepEqual(body.input[0].content[1], { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' });

  messages.push({ role: 'assistant', content: first.content, toolCalls: first.toolCalls, raw: first.raw });
  messages.push({ role: 'tool', toolCallId: 'call_1', name: 'search_media', content: '[]' });
  const second = await llm.complete({ messages, tools, toolChoice: 'none' });
  assert.equal(second.content, 'Dune ist da.');
  const echoed = calls[1].body.input;
  assert.deepEqual(echoed[1], { type: 'function_call', call_id: 'call_1', name: 'search_media', namespace: 'media_agentcy', arguments: '{"query":"Dune"}' }, 'echoed without id, reasoning dropped');
  assert.deepEqual(echoed[2], { type: 'function_call_output', call_id: 'call_1', output: '[]' });
  assert.equal(calls[1].body.tool_choice, 'none');
});

test('provider: 401 refreshes once, usage limits are explained, incomplete streams are errors', async () => {
  const limited = () =>
    json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }, 429);
  const { llm, calls } = providerWith([
    json({ detail: 'nope' }, 401),
    sse([{ type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'ok' }] } }, { type: 'response.completed', response: {} }]),
    limited,
    sse([{ type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'halb' }] } }]),
  ]);
  const msg = [{ role: 'user' as const, content: 'hi' }];
  assert.equal((await llm.complete({ messages: msg })).content, 'ok');
  assert.equal(calls[1].auth, 'Bearer fresh-token');
  await assert.rejects(llm.complete({ messages: msg }), /Nutzungslimit erreicht.*chatgpt\.com\/settings\/usage/);
  assert.equal(calls.length, 3, 'a usage limit is not retried');
  await assert.rejects(llm.complete({ messages: msg }), /bevor die Antwort fertig war/);
});

test('provider: model list from /v1/models, without a configured model the first listed one is used', async () => {
  const { calls } = providerWith([]);
  const auth = { accessToken: async () => 'token' } as unknown as ChatGPTAuth;
  const responses = [
    json({ models: [{ slug: 'hidden', visibility: 'hide' }, { slug: 'gpt-a', visibility: 'list' }, { slug: 'gpt-b', visibility: 'list' }] }),
    sse([{ type: 'response.completed', response: {} }]),
  ];
  const llm = new ChatGPTProvider({
    auth,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: null });
      return responses.shift()!;
    }) as typeof fetch,
  });
  await llm.complete({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls[1].body.model, 'gpt-a');
});
