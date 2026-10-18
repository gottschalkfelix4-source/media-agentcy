/**
 * Web API test: login, settings (live reload), users, takeover.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';

const ADMIN = '4915199999999';
const sent: { to: string; text: string }[] = [];

let web: { request(path: string, init?: RequestInit): Response | Promise<Response> };
let app: ReturnType<typeof import('../src/app.js')['createApp']>;
let config: typeof import('../src/config.js')['config'];
let cookie = '';

before(async () => {
  Object.assign(process.env, {
    DATA_DIR: mkdtempSync(path.join(tmpdir(), 'mag-web-')),
    LOG_LEVEL: 'silent',
    ADMIN_NUMBERS: ADMIN,
    BOT_NAME: 'EnvBot',
    DEBOUNCE_MS: '0',
    LLM_PROVIDER: 'custom',
    LLM_BASE_URL: 'http://unused',
    LLM_API_KEY: 'sk-secret-value-1234',
    WEB_PASSWORD: 'correct horse',
  });
  const { createApp } = await import('../src/app.js');
  const { createHttpApp } = await import('../src/server/http.js');
  ({ config } = await import('../src/config.js'));
  app = createApp({
    async sendText(user, text) {
      sent.push({ to: user.wa_id, text });
    },
  });
  app.ctx.llm = {
    name: 'scripted',
    async complete() {
      return { content: 'Bot-Antwort', toolCalls: [] };
    },
  };
  app.ensureAdminUsers();
  web = createHttpApp({ app, version: 'test' });
});

const req = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await web.request(`/api${url}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as any };
};

test('API needs a login', async () => {
  assert.equal((await req('GET', '/overview')).status, 401);
  assert.equal((await req('GET', '/auth/me')).json.authenticated, false);
});

test('wrong password is rejected, correct one sets a session cookie', async () => {
  assert.equal((await req('POST', '/auth/login', { password: 'nope' })).status, 401);
  const ok = await req('POST', '/auth/login', { password: 'correct horse' });
  assert.equal(ok.status, 200);
  const set = ok.headers.get('set-cookie') ?? '';
  assert.match(set, /ma_session=/);
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Strict/i);
  cookie = set.split(';')[0];
  assert.equal((await req('GET', '/auth/me')).json.authenticated, true);
});

test('state-changing requests must be JSON', async () => {
  const res = await web.request('/api/broadcast', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: 'hi' });
  assert.equal(res.status, 415);
});

test('overview works and the admin number became an admin user', async () => {
  const o = await req('GET', '/overview');
  assert.equal(o.status, 200);
  assert.equal(o.json.bot.name, 'EnvBot');
  assert.equal(app.repo.getUserByWaId(ADMIN)?.role, 'admin');
});

test('settings: secrets are not exposed, changes apply live, null resets to env', async () => {
  const s = await req('GET', '/settings');
  const key = s.json.settings.find((x: any) => x.key === 'LLM_API_KEY');
  assert.equal(key.value, null);
  assert.equal(key.isSet, true);
  assert.equal(key.hint, '…1234');
  assert.ok(!JSON.stringify(s.json).includes('sk-secret-value'));

  const put = await req('PUT', '/settings', { values: { BOT_NAME: 'WebBot', REQUESTS_PER_DAY: '3' } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.changed.sort(), ['BOT_NAME', 'REQUESTS_PER_DAY']);
  assert.equal(config.BOT_NAME, 'WebBot');
  assert.equal(config.REQUESTS_PER_DAY, 3);
  assert.equal(put.json.settings.find((x: any) => x.key === 'BOT_NAME').source, 'ui');

  assert.equal((await req('PUT', '/settings', { values: { REQUESTS_PER_DAY: 'viele' } })).status, 400);
  assert.equal(config.REQUESTS_PER_DAY, 3);
  assert.equal((await req('PUT', '/settings', { values: { HTTP_PORT: '9000' } })).status, 400);

  await req('PUT', '/settings', { values: { BOT_NAME: null } });
  assert.equal(config.BOT_NAME, 'EnvBot');
});

test('users: create, direct message, takeover keeps the bot quiet', async () => {
  const created = await req('POST', '/users', { phone: '+49 151 0000 0002', display_name: 'Max' });
  assert.equal(created.status, 200);
  const id = created.json.id;
  assert.equal((await req('POST', '/users', { phone: '4915100000002' })).status, 409);

  const list = await req('GET', '/users');
  assert.equal(list.json.find((u: any) => u.id === id).runtime.state, 'idle');

  const msg = await req('POST', `/users/${id}/messages`, { text: 'Hallo vom Admin' });
  assert.equal(msg.status, 200);
  assert.deepEqual(sent.at(-1), { to: '4915100000002', text: 'Hallo vom Admin' });
  const page = await req('GET', `/users/${id}/messages`);
  assert.equal(page.json.at(-1).via, 'admin');

  await req('PATCH', `/users/${id}`, { bot_paused: true });
  const before = sent.length;
  await app.router.onIncoming({ waId: '4915100000002', pushName: 'Max', text: 'Bist du da?' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, before, 'paused bot must not answer');
  assert.equal((await req('GET', `/users/${id}/messages`)).json.at(-1).content, 'Bist du da?');

  await req('PATCH', `/users/${id}`, { bot_paused: false });
  await app.router.onIncoming({ waId: '4915100000002', pushName: 'Max', text: 'Und jetzt?' });
  const start = Date.now();
  while (sent.length === before && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.at(-1)?.text, 'Bot-Antwort');

  const detail = await req('GET', `/users/${id}`);
  assert.equal(detail.json.usage.total.calls, 1);
  assert.ok(detail.json.runtime.lastReplyAt);
});

test('user import: candidates from the media servers, create and link with phone numbers', async () => {
  app.ctx.services.jellyfin = { users: async () => [{ id: 'jf-1', name: 'lena', admin: false, disabled: false }, { id: 'jf-2', name: 'ole', admin: false, disabled: false }] } as never;
  app.ctx.services.seerr = { users: async () => [{ id: 4, displayName: 'Lena K.', jellyfinUsername: 'lena' }] } as never;
  try {
    const cand = await req('GET', '/user-import/candidates');
    assert.equal(cand.status, 200);
    const lena = cand.json.candidates.find((c: any) => c.jellyfin?.name === 'lena');
    assert.equal(lena.name, 'Lena K.');
    assert.equal(lena.seerr.id, 4);

    const res = await req('POST', '/user-import', {
      users: [
        { phone: '+49 151 0000 0010', display_name: 'Lena K.', jellyfin_user_id: 'jf-1', jellyfin_username: 'lena', seerr_user_id: 4 },
        { phone: '0151 0000 0011', jellyfin_username: 'ole' },
        { phone: '4915100000012', jellyfin_username: 'lena' },
      ],
    });
    assert.equal(res.status, 200);
    const [ok, local, dup] = res.json.results;
    assert.equal(ok.action, 'created');
    assert.match(local.error, /Ländervorwahl/);
    assert.match(dup.error, /schon mit .* verknüpft/);

    const u = app.repo.getUser(ok.userId)!;
    assert.equal(u.wa_id, '4915100000010');
    assert.equal(u.status, 'active');
    assert.equal(u.jellyfin_user_id, 'jf-1');
    assert.equal(u.seerr_user_id, 4);
    assert.equal(sent.filter((s) => s.to === '4915100000010').length, 0, 'no welcome unless asked for');

    const again = await req('GET', '/user-import/candidates');
    assert.equal(again.json.candidates.find((c: any) => c.jellyfin?.name === 'lena').existing.id, u.id);
  } finally {
    app.ctx.services.jellyfin = undefined;
    app.ctx.services.seerr = undefined;
  }
});

test('admin numbers cannot be deleted, other users can', async () => {
  const admin = app.repo.getUserByWaId(ADMIN)!;
  assert.equal((await req('DELETE', `/users/${admin.id}`)).status, 400);
  const max = app.repo.getUserByWaId('4915100000002')!;
  assert.equal((await req('DELETE', `/users/${max.id}`)).status, 200);
  assert.equal(app.repo.getUser(max.id), undefined);
});

test('logout ends the session', async () => {
  await req('POST', '/auth/logout', {});
  assert.equal((await req('GET', '/overview')).status, 401);
});
