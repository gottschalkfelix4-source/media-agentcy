/**
 * Grok plan via xAI's device-code sign-in: code request, polling (pending / slow_down / declined), refresh,
 * sign-out, and the provider with the OAuth token. Fake fetch. Run: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GrokProvider } from '../src/llm/grok.js';
import { GrokAuth } from '../src/llm/grokAuth.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'mag-grok-')), 'grok-auth.json');

/** Fake xAI auth server; `token` decides what the token endpoint answers. */
function fakeXai(token: (form: URLSearchParams) => Response, device: () => Response = () => deviceCode()) {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const form = new URLSearchParams(init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? ''));
    calls.push({ url, form });
    if (url === 'https://auth.x.ai/oauth2/device/code') return device();
    if (url === 'https://auth.x.ai/oauth2/token') return token(form);
    if (url === 'https://auth.x.ai/oauth2/revoke') return new Response('', { status: 200 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const deviceCode = (extra: Record<string, unknown> = {}) =>
  json({ device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://accounts.x.ai/device', verification_uri_complete: 'https://accounts.x.ai/device?code=ABCD-EFGH', interval: 0, expires_in: 600, ...extra });

const tokens = (n = 1) => json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, id_token: jwt({ sub: 'u1', email: 'felix@example.com' }), expires_in: 3600 });

async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'condition reached');
}

test('device sign-in: shows the code, waits through pending and slow_down, then stores the tokens (0600)', async () => {
  let polls = 0;
  const { fetchImpl, calls } = fakeXai((form) => {
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(form.get('device_code'), 'dev-1');
    polls++;
    if (polls === 1) return json({ error: 'authorization_pending' }, 400);
    if (polls === 2) return json({ error: 'slow_down' }, 400);
    return tokens();
  });
  const auth = new GrokAuth(tmpFile(), fetchImpl, 1);
  {
    const started = await auth.startLogin();
    assert.equal(started.pending?.userCode, 'ABCD-EFGH');
    assert.equal(started.pending?.url, 'https://accounts.x.ai/device?code=ABCD-EFGH');
    assert.equal(started.connected, false);
    const form = calls[0]!.form;
    assert.equal(form.get('client_id'), 'b1a00492-073a-47ea-816f-4c329264a828');
    assert.match(form.get('scope')!, /offline_access/);
    assert.match(form.get('scope')!, /api:access/);

    await until(() => auth.status().connected);
  }
  const s = auth.status();
  assert.equal(s.email, 'felix@example.com');
  assert.equal(s.pending, undefined);
  assert.equal(polls, 3);
  assert.equal(await auth.accessToken(), 'at-1');
  if (process.platform !== 'win32') assert.equal(statSync(auth.file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(auth.file, 'utf8').includes('dev-1'), 'the device code is not stored');
});

test('device sign-in: a declined code ends with a message, an untrusted verification address is refused', async () => {
  const declined = new GrokAuth(tmpFile(), fakeXai(() => json({ error: 'access_denied' }, 400)).fetchImpl, 1);
  await declined.startLogin();
  await until(() => !declined.status().pending);
  assert.match(declined.status().error!, /abgelehnt/);
  assert.equal(declined.status().connected, false);

  const evil = new GrokAuth(tmpFile(), fakeXai(tokens, () => deviceCode({ verification_uri: 'https://evil.example/device', verification_uri_complete: undefined })).fetchImpl, 1);
  await assert.rejects(evil.startLogin(), /unerwartete Bestätigungsadresse/);
});

test('refresh: expired token is renewed once for parallel callers, keeps the refresh token if not rotated; invalid_grant signs out', async () => {
  let refreshes = 0;
  let mode: 'ok' | 'dead' = 'ok';
  const { fetchImpl } = fakeXai((form) => {
    if (form.get('grant_type') !== 'refresh_token') return tokens();
    refreshes++;
    if (mode === 'dead') return json({ error: 'invalid_grant' }, 400);
    assert.equal(form.get('refresh_token'), 'rt-1');
    return json({ access_token: `at-r${refreshes}`, expires_in: 3600 });
  });
  const auth = new GrokAuth(tmpFile(), fetchImpl, 1);
  await auth.startLogin();
  await until(() => auth.status().connected);

  // Forced (401): both callers share one refresh.
  const [a, b] = await Promise.all([auth.accessToken(true), auth.accessToken(true)]);
  assert.equal(a, 'at-r1');
  assert.equal(b, 'at-r1');
  assert.equal(refreshes, 1);
  assert.equal(JSON.parse(readFileSync(auth.file, 'utf8')).account.refresh_token, 'rt-1');

  mode = 'dead';
  await assert.rejects(auth.accessToken(true), /abgelaufen oder wurde bei xAI widerrufen/);
  assert.equal(auth.status().connected, false);
  await assert.rejects(auth.accessToken(), /nicht verbunden/);
});

test('logout revokes the refresh token and forgets the account', async () => {
  const { fetchImpl, calls } = fakeXai(() => tokens());
  const auth = new GrokAuth(tmpFile(), fetchImpl, 1);
  await auth.startLogin();
  await until(() => auth.status().connected);
  const { revoked } = await auth.logout();
  assert.equal(revoked, true);
  const revoke = calls.find((c) => c.url.endsWith('/revoke'))!;
  assert.equal(revoke.form.get('token'), 'rt-1');
  assert.equal(auth.status().connected, false);
  assert.equal(auth.status().email, undefined);
});

test('provider: chat completions at api.x.ai with the OAuth token, one retry after 401, 403 explains the tier gate', async () => {
  const tokenCalls: boolean[] = [];
  const auth = { accessToken: async (force = false) => (tokenCalls.push(force), force ? 'fresh' : 'stale') } as unknown as GrokAuth;
  const provider = new GrokProvider({ auth, model: 'grok-4.7' });
  const seen: { url: string; auth: string | null; body: any }[] = [];
  let next: Response[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return next.shift()!;
  }) as typeof fetch;
  try {
    next = [new Response('unauthorized', { status: 401 }), json({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })];
    const res = await provider.complete({ messages: [{ role: 'user', content: 'Test' }] });
    assert.equal(res.content, 'OK');
    assert.equal(seen[0]!.url, 'https://api.x.ai/v1/chat/completions');
    assert.equal(seen[0]!.auth, 'Bearer stale');
    assert.equal(seen[1]!.auth, 'Bearer fresh');
    assert.equal(seen[1]!.body.model, 'grok-4.7');
    assert.deepEqual(tokenCalls, [false, true]);

    next = [json({ code: 'permission denied' }, 403)];
    await assert.rejects(provider.complete({ messages: [{ role: 'user', content: 'Test' }] }), /HTTP 403\).*SuperGrok/);

    next = [json({ data: [{ id: 'grok-4.7' }, { id: 'grok-imagine-image' }, { id: 'grok-4.20-0309-reasoning' }] })];
    assert.deepEqual(await provider.listModels(), ['grok-4.7', 'grok-4.20-0309-reasoning']);
  } finally {
    globalThis.fetch = orig;
  }
});
