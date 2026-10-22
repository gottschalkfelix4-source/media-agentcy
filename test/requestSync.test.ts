/**
 * Website requests (Jellyseerr/Ombi) are assigned to bot users via their linked accounts.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';

let app: ReturnType<typeof import('../src/app.js')['createApp']>;
let syncRequests: typeof import('../src/notifier/requestSync.js')['syncRequests'];

const old = '2026-01-10T12:00:00.000Z';
const req = (id: number, by: object, tmdbId: number, mediaStatus: number, status = 2, mediaAddedAt = old) => ({
  id,
  status,
  type: 'movie',
  createdAt: old,
  updatedAt: old,
  media: { id, tmdbId, status: mediaStatus, mediaType: 'movie', mediaAddedAt },
  requestedBy: by,
});
const seerrRequests: ReturnType<typeof req>[] = [];

before(async () => {
  Object.assign(process.env, { DATA_DIR: mkdtempSync(path.join(tmpdir(), 'mag-sync-')), LOG_LEVEL: 'silent', LLM_PROVIDER: 'custom', LLM_BASE_URL: 'http://unused' });
  const { createApp } = await import('../src/app.js');
  ({ syncRequests } = await import('../src/notifier/requestSync.js'));
  app = createApp({ async sendText() {} });
  app.ctx.services.seerr = {
    allRequests: async () => seerrRequests,
    title: async (_: string, tmdbId: number) => `Film ${tmdbId}`,
  } as never;
  app.ctx.services.ombi = {
    movieRequests: async () => [{ id: 7, title: 'Ombi-Film', theMovieDbId: 300, available: false, approved: true, requestedDate: old, requestedUser: { userName: 'LENA' } }],
    tvRequests: async () => [],
  } as never;
});

test('requests are assigned via Seerr id or media server name, finished ones are stored as done', async () => {
  const lena = app.repo.createUser('4915100000020', { status: 'active', display_name: 'Lena' });
  app.repo.updateUser(lena.id, { seerr_user_id: 4, jellyfin_username: 'lena' });
  const ole = app.repo.createUser('4915100000021', { status: 'active', display_name: 'Ole' });
  app.repo.updateUser(ole.id, { jellyfin_username: 'ole' });
  app.repo.addBotRequest({ user_id: lena.id, source: 'seerr', external_id: '50', tmdb_id: 100, media_type: 'movie', title: 'Schon über den Bot' });

  seerrRequests.push(
    req(1, { id: 4 }, 101, 5), // Lena, available long ago
    req(2, { id: 8, jellyfinUsername: 'Ole' }, 102, 3), // Ole via Jellyfin name, downloading
    req(3, { id: 4 }, 103, 2, 3), // declined → skipped
    req(4, { id: 99 }, 104, 3), // nobody linked
    req(5, { id: 4 }, 100, 3), // same title Lena already asked the bot for → no duplicate
  );

  const r = await syncRequests(app.ctx, { full: true });
  assert.deepEqual(r, { imported: 3, unmatched: 1, removed: 0, errors: [] });

  const lenas = app.repo.botRequestsForUser(lena.id);
  const done = lenas.find((b) => b.external_id === '1')!;
  assert.equal(done.via, 'web');
  assert.equal(done.title, 'Film 101');
  assert.ok(done.notified_at, 'available → done');
  assert.equal(done.created_at, '2026-01-10 12:00:00');
  assert.ok(app.repo.wasNotified('seerr', '1', lena.id), 'the poller must not announce it');
  assert.equal(lenas.filter((b) => b.tmdb_id === 100).length, 1);
  assert.ok(lenas.some((b) => b.source === 'ombi' && b.external_id === 'movie:7' && !b.notified_at), 'Ombi name matched case-insensitively');

  const [oles] = app.repo.botRequestsForUser(ole.id);
  assert.equal(oles.external_id, '2');
  assert.equal(oles.notified_at, null, 'still waiting → poller notifies later');

  assert.equal((await syncRequests(app.ctx, { full: true })).imported, 0, 'idempotent');
});

test('a request that finished just now is imported as waiting so the user still gets the message', async () => {
  const lena = app.repo.getUserByWaId('4915100000020')!;
  seerrRequests.push(req(6, { id: 4 }, 106, 5, 2, new Date().toISOString()));
  assert.equal((await syncRequests(app.ctx)).imported, 1);
  const r = app.repo.botRequestsForUser(lena.id).find((b) => b.external_id === '6')!;
  assert.equal(r.notified_at, null);
  assert.ok(app.repo.pendingBotRequests().some((b) => b.id === r.id));
});

test('Ombi series requested on the website: first episodes trigger the partial notice, matched via the Jellyfin name', async () => {
  const mia = app.repo.createUser('4915100000022', { status: 'active', display_name: 'Mia' });
  app.repo.updateUser(mia.id, { jellyfin_username: 'mia' });
  app.ctx.services.seerr = undefined; // only Ombi here
  const episodes = [{ episodeNumber: 1, available: false }, { episodeNumber: 2, available: false }];
  app.ctx.services.ombi = {
    movieRequests: async () => [],
    tvRequests: async () => [
      { id: 30, title: 'Ombi-Serie', externalProviderId: 900, childRequests: [{ id: 31, available: false, approved: true, requestedUser: { userName: 'MIA' }, seasonRequests: [{ seasonNumber: 1, episodes }] }] },
    ],
  } as never;
  await app.poller.runOnce();
  const r = app.repo.botRequestsForUser(mia.id).find((b) => b.external_id === 'tv:31')!;
  assert.ok(r, 'imported via Jellyfin name');
  assert.equal(app.repo.wasNotified('partial', String(r.id), mia.id), false, 'nothing there yet');

  episodes[0].available = true;
  await app.poller.runOnce();
  assert.equal(app.repo.wasNotified('partial', String(r.id), mia.id), true, 'first episode → partial notice');
  assert.equal(app.repo.botRequestsForUser(mia.id).find((b) => b.external_id === 'tv:31')!.notified_at, null, 'not done yet');
});

test('waiting Ombi requests deleted in Ombi disappear, finished ones and fresh bot requests stay', async () => {
  const mia = app.repo.getUserByWaId('4915100000022')!;
  const before = '2026-01-10 12:00:00';
  app.repo.addBotRequest({ user_id: mia.id, source: 'ombi', external_id: 'movie:40', tmdb_id: 400, media_type: 'movie', title: 'Gelöschter Film', via: 'web', created_at: before });
  app.repo.addBotRequest({ user_id: mia.id, source: 'ombi', external_id: 'movie:41', tmdb_id: 401, media_type: 'movie', title: 'Fertiger Film', via: 'web', created_at: before, notified_at: before });
  app.repo.addBotRequest({ user_id: mia.id, source: 'ombi', external_id: '12', tmdb_id: 402, media_type: 'movie', title: 'Bot-Film', created_at: before });
  app.repo.addBotRequest({ user_id: mia.id, source: 'ombi', external_id: null, tmdb_id: 403, media_type: 'tv', title: 'Gelöschte Bot-Serie', created_at: before });
  app.repo.addBotRequest({ user_id: mia.id, source: 'ombi', external_id: null, tmdb_id: 404, media_type: 'movie', title: 'Gerade angefragt' });
  app.ctx.services.ombi = {
    movieRequests: async () => [{ id: 50, title: 'Bot-Film', theMovieDbId: 402, available: false, approved: true, requestedDate: old }],
    tvRequests: async () => [], // the Ombi-Serie (tv:31) is gone too, but was imported just now → grace period
  } as never;

  const r = await syncRequests(app.ctx);
  assert.equal(r.removed, 2);
  const left = app.repo.botRequestsForUser(mia.id).map((b) => b.title).sort();
  assert.deepEqual(left, ['Bot-Film', 'Fertiger Film', 'Gerade angefragt', 'Ombi-Serie']);
});
