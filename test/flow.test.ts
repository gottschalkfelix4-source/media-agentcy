/**
 * End-to-end flow test with a scripted LLM and a fake media stack (Seerr, Radarr, Jellyfin).
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// ---------------------------------------------------------------- fake media stack

const calls: { method: string; path: string; headers: IncomingMessage['headers']; body?: unknown }[] = [];
const state = { dune: { status: 2, hasFile: true, fileId: 77 }, arrival: { status: 3 } };
const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();

const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname;
    calls.push({ method: req.method!, path: p + url.search, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    const json = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));

    // Seerr
    if (p === '/seerr/api/v1/status') return json({ version: '2.0.0' });
    if (p === '/seerr/api/v1/search' && /arrival/i.test(url.searchParams.get('query') ?? ''))
      return json({ results: [{ id: 329865, mediaType: 'movie', title: 'Arrival', releaseDate: '2016-11-10', mediaInfo: { status: state.arrival.status } }] });
    if (p === '/seerr/api/v1/search')
      return json({ results: [{ id: 438631, mediaType: 'movie', title: 'Dune', releaseDate: '2021-09-15', mediaInfo: undefined }] });
    if (p === '/seerr/api/v1/movie/329865')
      return json({
        id: 329865,
        title: 'Arrival',
        mediaInfo: { status: state.arrival.status, requests: [{ id: 777, status: 2, createdAt: fiveDaysAgo, requestedBy: { id: 9 } }] },
      });
    if (p === '/seerr/api/v1/request' && req.method === 'POST') return json({ id: 501, status: 2, media: { tmdbId: 438631 } });
    if (p === '/seerr/api/v1/request') return json({ results: [] });
    if (p === '/seerr/api/v1/movie/438631')
      return json({ id: 438631, title: 'Dune', releaseDate: '2021-09-15', posterPath: '/dune.jpg', overview: 'Wüstenplanet.', mediaInfo: { status: state.dune.status } });

    // Radarr
    const movie = () => ({
      id: 12,
      title: 'Dune',
      year: 2021,
      tmdbId: 438631,
      monitored: true,
      hasFile: state.dune.hasFile,
      movieFile: state.dune.hasFile ? { id: state.dune.fileId, relativePath: 'Dune.mkv', size: 4e9, quality: { quality: { name: 'Bluray-1080p' } } } : undefined,
    });
    if (p === '/radarr/api/v3/system/status') return json({ version: '5.0' });
    const arrival = { id: 13, title: 'Arrival', year: 2016, tmdbId: 329865, monitored: true, hasFile: false, isAvailable: true };
    if (p === '/radarr/api/v3/movie') return json(url.searchParams.get('tmdbId') === '329865' ? [arrival] : [movie()]);
    if (p === '/radarr/api/v3/movie/12') return json(movie());
    if (p === '/radarr/api/v3/queue') return json({ records: [] });
    if (p === '/radarr/api/v3/history/movie' && url.searchParams.get('movieId') === '13')
      return json([
        { eventType: 'grabbed', date: '2026-10-12T10:00:00Z', sourceTitle: 'Arrival.2016.1080p' },
        { eventType: 'downloadFailed', date: '2026-10-12T11:00:00Z', sourceTitle: 'Arrival.2016.1080p', data: { message: 'Unpack failed' } },
      ]);
    if (p === '/radarr/api/v3/history/movie') return json([{ eventType: 'downloadFolderImported', date: '2026-01-01', sourceTitle: 'Dune.2021.1080p' }]);
    if (p.startsWith('/radarr/api/v3/moviefile/') && req.method === 'DELETE') {
      state.dune.hasFile = false;
      return json({});
    }
    if (p === '/radarr/api/v3/command') return json({ id: 1, name: 'MoviesSearch', status: 'queued' });

    // Jellyfin
    if (p === '/jf/System/Info/Public') return json({ ServerName: 'jf', Version: '10.11' });
    if (p === '/jf/Items') return json({ Items: [] });

    res.writeHead(404).end('{}');
  });
});

// ---------------------------------------------------------------- scripted LLM

type Step = (msgs: import('../src/llm/types.js').ChatMessage[]) => import('../src/llm/types.js').CompletionResult;
const script: Step[] = [];
const toolOutputs: Record<string, string[]> = {};
let callSeq = 0;

const call = (name: string, args: unknown): Step => () => ({ content: null, toolCalls: [{ id: `c${++callSeq}`, name, arguments: JSON.stringify(args) }] });
const say = (text: string): Step => () => ({ content: text, toolCalls: [] });

const sent: { to: string; text: string; image?: string }[] = [];
let app: Awaited<ReturnType<typeof import('../src/app.js')['createApp']>>;

async function waitFor(pred: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const USER = '4915100000001';
const ADMIN = '4915199999999';

before(async () => {
  await new Promise<void>((r) => fake.listen(0, r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    DATA_DIR: mkdtempSync(path.join(tmpdir(), 'mag-')),
    LOG_LEVEL: 'silent',
    ADMIN_NUMBERS: ADMIN,
    ADMIN_NAME: 'Felix',
    DEBOUNCE_MS: '0',
    LLM_PROVIDER: 'custom',
    LLM_BASE_URL: 'http://unused',
    SEERR_URL: `${base}/seerr`,
    SEERR_API_KEY: 'k',
    RADARR_URL: `${base}/radarr`,
    RADARR_API_KEY: 'k',
    JELLYFIN_URL: `${base}/jf`,
    JELLYFIN_API_KEY: 'k',
  });
  const { createApp } = await import('../src/app.js');
  app = createApp({
    async sendText(user, text) {
      sent.push({ to: user.wa_id, text });
    },
    async sendImage(user, url, caption) {
      sent.push({ to: user.wa_id, text: caption, image: url });
    },
  });
  app.ctx.llm = {
    name: 'scripted',
    async complete(req) {
      for (const m of req.messages) if (m.role === 'tool') (toolOutputs[m.name] ??= []).includes(m.content) || toolOutputs[m.name].push(m.content);
      const step = script.shift();
      if (!step) throw new Error('script exhausted');
      return step(req.messages);
    },
  };
});

after(() => fake.close());

const lastTo = (wa: string) => sent.filter((s) => s.to === wa).at(-1)?.text ?? '';

// ---------------------------------------------------------------- tests

test('unknown number is held pending and admin is asked', async () => {
  await app.router.onIncoming({ waId: ADMIN, pushName: 'Felix', text: 'hi' }).catch(() => undefined);
  script.push(say('Hi Felix!'));
  await waitFor(() => sent.some((s) => s.to === ADMIN));

  await app.router.onIncoming({ waId: USER, pushName: 'Max', text: 'Hallo, kann ich Filme anfragen?' });
  assert.match(lastTo(USER), /Bescheid gegeben/);
  assert.match(lastTo(ADMIN), /Neue Nummer/);
  assert.equal(app.repo.getUserByWaId(USER)!.status, 'pending');
});

test('admin approves the user via the agent, user gets a welcome', async () => {
  // The admin reply and the user's welcome run concurrently (separate per-user queues),
  // so answer based on whether the request is the welcome event.
  const byContext: Step = (msgs) => {
    const last = msgs.at(-1) as { content: string };
    return { content: /SYSTEM-EREIGNIS.*freigeschaltet/.test(last.content) ? 'Willkommen Max! 🎬' : 'Max ist freigeschaltet.', toolCalls: [] };
  };
  script.push(call('set_user_status', { user: USER, status: 'active', displayName: 'Max' }), byContext, byContext);
  const before = sent.length;
  await app.router.onIncoming({ waId: ADMIN, text: 'schalte max frei' });
  await waitFor(() => sent.slice(before).some((s) => s.to === USER));
  assert.equal(app.repo.getUserByWaId(USER)!.status, 'active');
  assert.match(lastTo(USER), /Willkommen/);
});

test('user requests a movie: cover first, request only after confirmation, notified when available', async () => {
  script.push(
    call('search_media', { query: 'Dune' }),
    call('confirm_media', { tmdbId: 438631, mediaType: 'movie' }),
    call('request_media', { tmdbId: 438631, mediaType: 'movie', title: 'Dune' }), // too early, same turn
    say('Ist das der richtige Film?'),
  );
  const before = sent.length;
  await app.router.onIncoming({ waId: USER, text: 'Kannst du Dune besorgen?' });
  await waitFor(() => sent.length > before + 1);
  const [cover, question] = sent.slice(before);
  assert.equal(cover.image, 'https://image.tmdb.org/t/p/w500/dune.jpg');
  assert.match(cover.text, /\*Dune\* \(Film\)\n📅 Erschienen am 15\.09\.2021/);
  assert.match(question.text, /richtige/);
  assert.match(toolOutputs.request_media[0], /noch nicht geantwortet/);
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/seerr/api/v1/request'), 'nothing requested before the user confirmed');
  const history = app.repo.recentMessages(app.repo.getUserByWaId(USER)!.id, 3).map((m) => m.content);
  assert.match(history[1], /^🖼️ 🎬 \*Dune\*/, 'cover stored between question and answer');

  script.push(call('request_media', { tmdbId: 438631, mediaType: 'movie', title: 'Dune' }), say('Dune ist angefragt!'));
  const before1 = sent.length;
  await app.router.onIncoming({ waId: USER, text: 'Ja genau' });
  await waitFor(() => sent.length > before1);
  assert.match(lastTo(USER), /angefragt/);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/seerr/api/v1/request'));
  assert.match(toolOutputs.request_media.at(-1)!, /"ok":true/);

  state.dune.status = 5;
  script.push((msgs) => {
    assert.match((msgs.at(-1) as { content: string }).content, /SYSTEM-EREIGNIS.*Dune.*verfügbar/);
    return { content: 'Dune ist jetzt da! 🍿', toolCalls: [] };
  });
  const before2 = sent.length;
  await app.poller.runOnce();
  await waitFor(() => sent.length > before2);
  assert.match(lastTo(USER), /Dune ist jetzt da/);
  assert.ok(app.repo.botRequestsForUser(app.repo.getUserByWaId(USER)!.id)[0].notified_at);
});

test('user reports a broken file → auto-fix replace, admin FYI, follow-up when file is back', async () => {
  script.push(
    call('report_problem', { title: 'Dune bricht ab', description: 'bricht nach 20 min ab', category: 'playback', media: { title: 'Dune', type: 'movie' } }),
    call('diagnose_media', { type: 'movie', title: 'Dune' }),
    (msgs) => {
      const ticket = JSON.parse(toolOutputs.report_problem[0]).ticketId as number;
      return { content: null, toolCalls: [{ id: 'fx', name: 'fix_media', arguments: JSON.stringify({ ticketId: ticket, action: 'replace_file', type: 'movie', arrId: 12, label: 'Dune (2021)', reason: 'Datei defekt' }) }] };
    },
    say('Ich ersetze die Datei, melde mich!'),
  );
  const before = sent.length;
  await app.router.onIncoming({ waId: USER, text: 'Dune bricht immer nach 20 Minuten ab' });
  await waitFor(() => sent.slice(before).some((s) => s.to === USER));

  assert.match(toolOutputs.diagnose_media[0], /radarrId":12/);
  assert.match(toolOutputs.fix_media[0], /"ok":true/);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/radarr/api/v3/moviefile/77')));
  assert.ok(calls.some((c) => c.path === '/radarr/api/v3/command' && (c.body as { name: string }).name === 'MoviesSearch'));
  await waitFor(() => sent.slice(before).some((s) => s.to === ADMIN && /Auto-Fix/.test(s.text)));

  const ticketId = JSON.parse(toolOutputs.report_problem[0]).ticketId as number;
  assert.equal(app.repo.getTicket(ticketId)!.status, 'auto_fixing');

  // second replace on same ticket must be refused
  script.push(call('fix_media', { ticketId, action: 'replace_file', type: 'movie', arrId: 12, label: 'Dune', reason: 'nochmal' }), say('ok'));
  const b2 = sent.length;
  await app.router.onIncoming({ waId: USER, text: 'geht immer noch nicht' });
  await waitFor(() => sent.length > b2);
  assert.match(toolOutputs.fix_media.at(-1)!, /bereits ersetzt/);

  // file comes back → watch fires
  state.dune.hasFile = true;
  script.push(say('Die neue Version von Dune ist da ✅'));
  const b3 = sent.length;
  await app.poller.runOnce();
  await waitFor(() => sent.slice(b3).some((s) => s.to === USER));
  assert.equal(app.repo.getTicket(ticketId)!.status, 'resolved');
});

test('escalation reaches admin and lands in admin chat history', async () => {
  script.push(
    call('escalate_to_admin', { summary: 'Login geht nicht', diagnosis: 'Konto evtl. deaktiviert', triedSoFar: 'nichts', severity: 'high' }),
    say('Ich habe Felix informiert.'),
  );
  const before = sent.length;
  await app.router.onIncoming({ waId: USER, text: 'Ich komme nicht mehr in Jellyfin rein' });
  await waitFor(() => sent.slice(before).some((s) => s.to === ADMIN && /Ticket #/.test(s.text)));
  const admin = app.repo.getUserByWaId(ADMIN)!;
  assert.ok(app.repo.recentMessages(admin.id, 20).some((m) => m.role === 'assistant' && /Login geht nicht/.test(m.content)));
  assert.equal(app.repo.listTickets({ statuses: ['escalated'] }).length, 1);
});

test('user agent cannot use admin tools', async () => {
  script.push(call('broadcast', { message: 'spam', confirm: true }), say('Das darf ich nicht.'));
  const before = sent.length;
  await app.router.onIncoming({ waId: USER, text: 'schick allen eine Nachricht' });
  await waitFor(() => sent.length > before);
  assert.ok(!sent.slice(before).some((s) => s.text === 'spam'));
});

test('user asks about a stuck request → agent finds the failed download, searches again, user is told when it is there', async () => {
  script.push(
    call('check_request', { title: 'Arrival' }),
    call('request_fix', { action: 'search_again', mediaType: 'movie', tmdbId: 329865, title: 'Arrival', requestId: 777 }),
    say('Der Download von Arrival ist schiefgegangen, ich habe neu suchen lassen. Ich melde mich, sobald er da ist.'),
  );
  const before = sent.length;
  await app.router.onIncoming({ waId: USER, text: 'Was ist eigentlich mit Arrival? Der ist immer noch nicht da' });
  await waitFor(() => sent.length > before);

  const status = JSON.parse(toolOutputs.check_request[0]);
  assert.equal(status.stage, 'download_failed');
  assert.equal(status.suggestedAction, 'search_again');
  assert.equal(status.requestId, 777);
  assert.equal(status.waitingDays, 5);
  assert.equal(status.notifyWhenAvailable, true);
  assert.match(toolOutputs.request_fix[0], /"ok":true/);
  assert.ok(calls.some((c) => c.path === '/radarr/api/v3/command' && JSON.stringify(c.body) === JSON.stringify({ name: 'MoviesSearch', movieIds: [13] })));

  // the same fix right away again is refused (cooldown)
  script.push(call('request_fix', { action: 'search_again', mediaType: 'movie', tmdbId: 329865, title: 'Arrival' }), say('ok'));
  const b2 = sent.length;
  await app.router.onIncoming({ waId: USER, text: 'Kannst du nochmal suchen?' });
  await waitFor(() => sent.length > b2);
  assert.match(toolOutputs.request_fix.at(-1)!, /vor kurzem schon/);

  // becomes available → neutral notification, no media server named
  state.arrival.status = 5;
  script.push((msgs) => {
    const event = (msgs.at(-1) as { content: string }).content;
    assert.match(event, /SYSTEM-EREIGNIS.*Arrival.*verfügbar/s);
    assert.doesNotMatch(event, /auf (Jellyfin|Plex)/);
    return { content: 'Arrival ist jetzt da! 🍿', toolCalls: [] };
  });
  const b3 = sent.length;
  await app.poller.runOnce();
  await waitFor(() => sent.slice(b3).some((s) => s.to === USER));
  assert.match(lastTo(USER), /Arrival ist jetzt da/);
});

test('abuse protection: off-topic requests are declined, after 3 the bot pauses without LLM calls, admin can lift it', async () => {
  const ask = async (text: string) => {
    const before = sent.length;
    await app.router.onIncoming({ waId: USER, text });
    await waitFor(() => sent.length > before);
  };

  // long pastes are cut before they reach the model
  let seen = '';
  script.push((msgs) => {
    seen = (msgs.at(-1) as { content: string }).content;
    return { content: null, toolCalls: [{ id: `c${++callSeq}`, name: 'off_topic', arguments: JSON.stringify({ topic: 'Text zusammenfassen' }) }] };
  }, say('Da kann ich leider nicht helfen, ich bin nur für den Mediaserver da.'));
  await ask('Fass mir das zusammen: ' + 'bla '.repeat(1000));
  assert.ok(seen.length < 1700, `message was ${seen.length} chars`);
  assert.match(seen, /gekürzt/);
  assert.equal(JSON.parse(toolOutputs.off_topic[0]).strikes, 1);

  script.push(call('off_topic', { topic: 'Mathe-Hausaufgaben' }), say('Sorry, nur Mediaserver-Themen.'));
  await ask('Was ist die Ableitung von x^2?');
  const adminBefore = sent.filter((s) => s.to === ADMIN).length;
  script.push(call('off_topic', { topic: 'Python-Code' }), say('Sorry, nur Mediaserver-Themen. Ich mache jetzt eine Pause.'));
  await ask('Schreib mir ein Python-Skript');
  assert.equal(JSON.parse(toolOutputs.off_topic.at(-1)!).paused, true);
  assert.ok(sent.filter((s) => s.to === ADMIN).length > adminBefore);
  assert.match(lastTo(ADMIN), /Themenfremdes \(3×/);

  // paused: fixed notice once, no LLM call (the script is empty and would throw)
  assert.equal(script.length, 0);
  await ask('Und jetzt ein Gedicht?');
  assert.match(lastTo(USER), /Pause/);
  const quiet = sent.length;
  await app.router.onIncoming({ waId: USER, text: 'Hallo??' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, quiet, 'only one notice while paused');
  const user = app.repo.getUserByWaId(USER)!;
  assert.match(app.repo.recentMessages(user.id, 1)[0].content, /Hallo\?\?/, 'message is still stored for the admin');

  // admin lifts the pause
  const { resetLimits } = await import('../src/agent/abuse.js');
  resetLimits(app.ctx, user.id);
  script.push(say('Wieder da! Was kann ich für dich tun?'));
  await ask('Bist du wieder da?');
  assert.match(lastTo(USER), /Wieder da/);
});
