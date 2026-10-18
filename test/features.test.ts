/**
 * Onboarding, outage/maintenance mode, weekly digest and voice messages with mocked services and a scripted LLM.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { RecentItem } from '../src/integrations/http.js';
import type { ChatMessage, CompletionResult } from '../src/llm/types.js';

type Step = (msgs: ChatMessage[]) => CompletionResult;
const script: Step[] = [];
let llmCalls = 0;
const say = (text: string): Step => () => ({ content: text, toolCalls: [] });

const sent: { to: string; text: string }[] = [];
const lastTo = (wa: string) => sent.filter((s) => s.to === wa).at(-1)?.text ?? '';

let jfDown = false;
const created: { name: string; password: string }[] = [];
let recent: RecentItem[] = [];

const sttRequests: { auth?: string; body: string }[] = [];
const stt = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    sttRequests.push({ auth: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: ' Kannst du Dune anfragen? ' }));
  });
});

let app: ReturnType<typeof import('../src/app.js')['createApp']>;
const ADMIN = '4915199999998';

async function waitFor(pred: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Sends a message and waits until the bot answered it. */
async function write(waId: string, text: string, extra: object = {}) {
  const before = sent.filter((s) => s.to === waId).length;
  await app.router.onIncoming({ waId, text, ...extra });
  await waitFor(() => sent.filter((s) => s.to === waId).length > before);
  return lastTo(waId);
}

before(async () => {
  await new Promise<void>((r) => stt.listen(0, r));
  Object.assign(process.env, {
    DATA_DIR: mkdtempSync(path.join(tmpdir(), 'mag-feat-')),
    LOG_LEVEL: 'silent',
    ADMIN_NUMBERS: ADMIN,
    ADMIN_NAME: 'Felix',
    SERVER_NAME: 'Felix-Kino',
    DEBOUNCE_MS: '0',
    LLM_PROVIDER: 'custom',
    LLM_BASE_URL: 'http://unused',
  });
  const { createApp } = await import('../src/app.js');
  app = createApp({
    async sendText(user, text) {
      sent.push({ to: user.wa_id, text });
    },
  });
  app.ctx.llm = {
    name: 'scripted',
    async complete(req) {
      llmCalls++;
      const step = script.shift();
      if (!step) throw new Error('script exhausted');
      return step(req.messages);
    },
  };
  app.ctx.services.jellyfin = {
    publicUrl: 'https://jf.example',
    async ping() {
      if (jfDown) throw new Error('connect ECONNREFUSED');
      return { ok: true };
    },
    users: async () => [{ id: 'jf-1', name: 'joerg.mueller' }],
    async createUser(name: string, password: string) {
      created.push({ name, password });
      return { id: 'jf-new', name };
    },
    recentlyAdded: async () => recent,
  } as never;
  app.ctx.services.seerr = {
    importFromJellyfin: async () => [{ id: 42, jellyfinUsername: 'joerg.mueller2' }],
    findUserByName: async () => undefined,
  } as never;
  app.repo.createUser(ADMIN, { role: 'admin', status: 'active', display_name: 'Felix' });
});

after(() => stt.close());

test('onboarding: Jellyfin + Jellyseerr account, the password only goes out via WhatsApp', async () => {
  const { onboardUser, usernameFor } = await import('../src/agent/onboarding.js');
  const u = app.repo.createUser('4915100000101', { status: 'active', display_name: 'Jörg Müller' });
  assert.equal(usernameFor(u), 'joerg.mueller');
  assert.equal(usernameFor({ ...u, display_name: '🎬', push_name: null }), `nutzer${u.id}`);

  const r = await onboardUser(app.ctx, u);
  assert.equal(r.jellyfin?.username, 'joerg.mueller2', 'taken name gets a number');
  assert.equal(r.seerrUserId, 42);
  assert.deepEqual(r.errors, []);

  const msg = lastTo(u.wa_id);
  const pw = msg.match(/Passwort: (\S+)/)![1];
  assert.equal(pw.length, 12);
  assert.equal(created[0].password, pw);
  assert.match(msg, /Server: https:\/\/jf\.example/);
  assert.match(msg, /Benutzer: joerg\.mueller2/);

  const stored = app.repo.recentMessages(u.id, 1)[0].content;
  assert.ok(!stored.includes(pw), 'history keeps no password');
  assert.match(stored, /Passwort: ••••/);
  assert.ok(!r.note!.includes(pw), 'the LLM never sees it');

  const linked = app.repo.getUser(u.id)!;
  assert.equal(linked.jellyfin_user_id, 'jf-new');
  assert.equal(linked.jellyfin_username, 'joerg.mueller2');
  assert.equal(linked.seerr_user_id, 42);
});

test('voice messages are transcribed after the access checks, too long ones are not', async () => {
  const { config } = app.ctx;
  Object.assign(config, {
    VOICE_ENABLED: true,
    STT_BASE_URL: `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`,
    STT_API_KEY: 'sk-test',
    STT_MODEL: 'whisper-large-v3-turbo',
  });
  const u = app.repo.createUser('4915100000102', { status: 'active', display_name: 'Vera' });
  let seen = '';
  script.push((msgs) => {
    seen = (msgs.at(-1) as { content: string }).content;
    return { content: 'Klar, schaue ich nach!', toolCalls: [] };
  });
  const audio = (seconds: number) => ({ seconds, mime: 'audio/ogg; codecs=opus', download: async () => new Uint8Array([1, 2, 3]) });
  await write(u.wa_id, '[Sprachnachricht]', { audio: audio(5) });
  assert.equal(seen, '[Sprachnachricht] Kannst du Dune anfragen?');
  assert.equal(sttRequests.length, 1);
  assert.equal(sttRequests[0].auth, 'Bearer sk-test');
  assert.match(sttRequests[0].body, /whisper-large-v3-turbo/);
  assert.match(sttRequests[0].body, /filename="sprachnachricht\.ogg"/);

  script.push((msgs) => {
    seen = (msgs.at(-1) as { content: string }).content;
    return { content: 'Magst du es kürzer sagen?', toolCalls: [] };
  });
  await write(u.wa_id, '[Sprachnachricht]', { audio: audio(600) });
  assert.match(seen, /zu lang/);
  assert.equal(sttRequests.length, 1, 'not sent to the STT service');

  // unknown numbers never reach the STT service
  config.UNKNOWN_USER_POLICY = 'ignore';
  await app.router.onIncoming({ waId: '4915100000199', text: '[Sprachnachricht]', audio: audio(5) });
  assert.equal(sttRequests.length, 1);
  config.VOICE_ENABLED = false;
});

test('weekly digest: grouped list, sent once on the configured day, opted-out users skipped', async () => {
  const { DIGEST_DAYS, maybeSendDigest } = await import('../src/notifier/digest.js');
  const now = new Date().toISOString();
  recent = [
    { type: 'movie', title: 'Dune', year: 2021, added: now },
    { type: 'series', title: 'Severance', year: 2022, added: now },
    { type: 'episode', title: 'Severance', season: 1, added: now },
    { type: 'episode', title: 'The Bear', season: 3, added: now },
    { type: 'episode', title: 'The Bear', season: 3, added: now },
    { type: 'episode', title: 'The Bear', season: 3, added: now },
  ];
  const fan = app.repo.createUser('4915100000103', { status: 'active', display_name: 'Fan' });
  const grumpy = app.repo.createUser('4915100000104', { status: 'active', display_name: 'Grumpy' });
  app.repo.updateUser(grumpy.id, { digest: 0 });

  const day = new Date();
  Object.assign(app.ctx.config, { DIGEST_ENABLED: true, DIGEST_DAY: DIGEST_DAYS[day.getDay()], DIGEST_HOUR: 0 });
  const calls = llmCalls;
  await maybeSendDigest(app.ctx, day);
  const text = lastTo(fan.wa_id);
  assert.match(text, /📬 \*Wochenrückblick\*/);
  assert.match(text, /- Dune \(2021\)/);
  assert.match(text, /- Severance: neu \(Staffel 1\)/);
  assert.match(text, /- The Bear: 3 neue Folgen \(Staffel 3\)/);
  assert.match(text, /Wochenrückblick aus/);
  assert.ok(text.indexOf('Severance') < text.indexOf('The Bear'), 'new series first');
  assert.equal(lastTo(grumpy.wa_id), '', 'opted out');
  assert.equal(llmCalls, calls, 'no LLM involved');

  const count = sent.length;
  await maybeSendDigest(app.ctx, day);
  assert.equal(sent.length, count, 'only once per day');

  // users opt out via the agent
  const { setDigest } = await import('../src/agent/userTools.js');
  await setDigest.run({ enabled: false }, { ...app.ctx, user: fan, isAdmin: false, turn: { startedAt: Date.now(), sent: [] } });
  assert.equal(app.repo.getUser(fan.id)!.digest, 0);
  app.ctx.config.DIGEST_ENABLED = false;
});

test('outage: detected after two failed pings, fixed notice without LLM, agent knows, all-clear afterwards', async () => {
  const { checkDisruptions, getOutage } = await import('../src/notifier/outage.js');
  const ute = app.repo.createUser('4915100000105', { status: 'active', display_name: 'Ute' });
  app.repo.updateUser(ute.id, { jellyfin_username: 'ute' });
  const plexOnly = app.repo.createUser('4915100000106', { status: 'active', display_name: 'Paul' });
  app.repo.updateUser(plexOnly.id, { plex_username: 'paul' });

  jfDown = true;
  await checkDisruptions(app.ctx);
  assert.equal(getOutage(app.repo), undefined, 'one failed ping is no outage');
  await checkDisruptions(app.ctx);
  assert.deepEqual(getOutage(app.repo)?.services, ['jellyfin']);
  assert.match(lastTo(ADMIN), /Störung erkannt.*Jellyfin/);

  const calls = llmCalls;
  assert.match(await write(ute.wa_id, 'Jellyfin lädt bei mir nicht'), /Bekannte Störung.*Felix weiß Bescheid/s);
  assert.equal(llmCalls, calls, 'no LLM call for the notice');

  // within 2 h the agent answers again, with the outage in its prompt
  let system = '';
  script.push((msgs) => {
    system = (msgs[0] as { content: string }).content;
    return { content: 'Ja, das ist die Störung – Felix ist dran.', toolCalls: [] };
  });
  await write(ute.wa_id, 'Und wie lange noch?');
  assert.match(system, /Aktuelle Störung \(wichtig\)[\s\S]*Jellyfin nicht erreichbar[\s\S]*KEIN Ticket/);

  // a Plex-only user is not affected by a Jellyfin outage
  script.push(say('Hi Paul!'));
  assert.equal(await write(plexOnly.wa_id, 'Hallo'), 'Hi Paul!');

  jfDown = false;
  await checkDisruptions(app.ctx);
  assert.equal(getOutage(app.repo), undefined);
  assert.match(lastTo(ute.wa_id), /Felix-Kino läuft wieder/);
  assert.equal(lastTo(plexOnly.wa_id), 'Hi Paul!', 'no all-clear for unaffected users');
  assert.match(lastTo(ADMIN), /Jellyfin wieder erreichbar/);
});

test('maintenance notice: set by the admin, answered without LLM, all-clear when lifted or expired', async () => {
  const { checkDisruptions, getMaintenance, setMaintenance } = await import('../src/notifier/outage.js');
  const u = app.repo.createUser('4915100000107', { status: 'active', display_name: 'Mia' });
  await setMaintenance(app.ctx, 'Server-Umbau, bis ca. 22 Uhr', 2);
  const calls = llmCalls;
  const notice = await write(u.wa_id, 'Geht gerade was?');
  assert.match(notice, /Wartung.*Server-Umbau, bis ca\. 22 Uhr/s);
  assert.match(notice, /geplant bis/);
  assert.equal(llmCalls, calls);

  const r = await setMaintenance(app.ctx, null);
  assert.equal(r.notified, 1);
  assert.match(lastTo(u.wa_id), /Wartung ist vorbei/);

  // timed maintenance expires by itself in the next poll
  await setMaintenance(app.ctx, 'Kurz neu starten', 1);
  await write(u.wa_id, 'Hallo?');
  app.repo.setKv('maintenance', JSON.stringify({ ...getMaintenance(app.repo)!, until: new Date(Date.now() - 1000).toISOString() }));
  await checkDisruptions(app.ctx);
  assert.equal(getMaintenance(app.repo), undefined);
  assert.match(lastTo(u.wa_id), /Wartung ist vorbei/);
  assert.match(lastTo(ADMIN), /Wartungshinweis ist abgelaufen/);
});
