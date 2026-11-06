/**
 * "Fully watched → may it be deleted?" offers: backend check, user answer, admin decision.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import type { User } from '../src/db/repo.js';
import type { ToolContext } from '../src/agent/tool.js';

let app: ReturnType<typeof import('../src/app.js')['createApp']>;
let checkCleanupOffers: typeof import('../src/notifier/cleanup.js')['checkCleanupOffers'];
let answerCleanup: typeof import('../src/agent/cleanupTools.js')['answerCleanup'];
let decideCleanup: typeof import('../src/agent/cleanupTools.js')['decideCleanup'];

const sent: { to: string; text: string }[] = [];
const events: { userId: number; text: string }[] = [];
const deleted: number[] = [];
const noon = new Date();
noon.setHours(12, 0, 0, 0);

/** Jellyfin item id = "jf<tmdb>"; played[jellyfinUser][tmdb] = [played, total] (default: nothing seen). */
const played: Record<string, Record<number, [number, number]>> = {};
const sonarrStatus: Record<number, string> = { 701: 'continuing' };

const toolCtx = (user: User, isAdmin = false): ToolContext => ({
  ...app.ctx,
  user,
  isAdmin,
  turn: { startedAt: Date.now(), sent: [], quiet: true },
});

before(async () => {
  Object.assign(process.env, {
    DATA_DIR: mkdtempSync(path.join(tmpdir(), 'mag-clean-')),
    LOG_LEVEL: 'silent',
    ADMIN_NUMBERS: '4915199999990',
    LLM_PROVIDER: 'custom',
    LLM_BASE_URL: 'http://unused',
  });
  const { createApp } = await import('../src/app.js');
  ({ checkCleanupOffers } = await import('../src/notifier/cleanup.js'));
  ({ answerCleanup, decideCleanup } = await import('../src/agent/cleanupTools.js'));
  app = createApp({
    async sendText(user, text) {
      sent.push({ to: user.wa_id, text });
    },
  });
  app.ctx.dispatchEvent = (userId, text) => void events.push({ userId, text });
  app.ctx.services.jellyfin = {
    findByTmdb: async (_t: string, tmdbId: number) => ({ id: `jf${tmdbId}`, tmdbId: String(tmdbId) }),
    watchState: async (userId: string, itemId: string) => {
      const [p, t] = played[userId]?.[Number(itemId.slice(2))] ?? [0, 1];
      return { played: p, total: t };
    },
    users: async () => [],
  } as never;
  app.ctx.services.radarr = {
    find: async (o: { tmdbId: number }) => [{ radarrId: o.tmdbId + 1000 }],
    deleteMovie: async (id: number) => void deleted.push(id),
  } as never;
  app.ctx.services.sonarr = {
    find: async (o: { tmdbId: number }) => [{ sonarrId: o.tmdbId, status: sonarrStatus[o.tmdbId] ?? 'ended' }],
  } as never;
});

function user(wa: string, name: string, jf: string) {
  const u = app.repo.createUser(wa, { status: 'active', display_name: name });
  app.repo.updateUser(u.id, { jellyfin_user_id: jf, jellyfin_username: name });
  return app.repo.getUser(u.id)!;
}
const request = (userId: number, tmdbId: number, type: 'movie' | 'tv', title: string) =>
  app.repo.addBotRequest({
    user_id: userId,
    source: 'seerr',
    external_id: String(tmdbId * 10 + userId),
    tmdb_id: tmdbId,
    media_type: type,
    title,
    notified_at: '2026-01-01 10:00:00',
  });

test('only fully watched titles that nobody else has open are offered; yes goes to the admin, admin deletes', async () => {
  app.repo.createUser('4915199999990', { status: 'active', role: 'admin', display_name: 'Admin' });
  const lena = user('4915100000100', 'Lena', 'jf-lena');
  const ole = user('4915100000101', 'Ole', 'jf-ole');
  request(lena.id, 100, 'movie', 'Fertig-Film');
  request(lena.id, 200, 'movie', 'Zweiter Film');
  played['jf-lena'] = { 100: [1, 1], 200: [1, 1] };
  // Ole requested the second movie too and has not seen it: it stays
  request(ole.id, 200, 'movie', 'Zweiter Film');

  const made = await checkCleanupOffers(app.ctx, (u, e, t) => void events.push({ userId: u, text: `${e}||${t}` }), noon);
  assert.equal(made.length, 1);
  const offer = app.repo.getCleanupOffer(made[0])!;
  assert.equal(offer.title, 'Fertig-Film');
  assert.match(events.at(-1)!.text, /Fertig-Film/);
  assert.doesNotMatch(events.at(-1)!.text, /Ole/);

  // no second question within the hour
  const again = await checkCleanupOffers(app.ctx, () => assert.fail('no second question'), noon);
  assert.equal(again.length, 0);

  const ctx = toolCtx(lena);
  await answerCleanup.run({ offerId: offer.id, agree: true }, ctx);
  const agreed = app.repo.getCleanupOffer(offer.id)!;
  assert.equal(agreed.status, 'agreed');
  assert.ok(sent.some((s) => s.text.includes('Löschfreigabe') && s.text.includes('Fertig-Film')));
  await assert.rejects(answerCleanup.run({ offerId: offer.id, agree: false }, ctx), /schon beantwortet/);
  await assert.rejects(decideCleanup.run({ offerId: offer.id, action: 'delete', force: false }, toolCtx(lena)), /Nur der Admin/);

  const admin = app.repo.listAdmins()[0];
  const res = (await decideCleanup.run({ offerId: offer.id, action: 'delete', force: false }, toolCtx(admin, true))) as { deleted: string };
  assert.equal(res.deleted, 'Fertig-Film');
  assert.deepEqual(deleted, [1100]);
  assert.equal(app.repo.getCleanupOffer(offer.id)!.status, 'deleted');
  assert.equal(app.repo.getTicket(agreed.ticket_id!)!.status, 'resolved');
  assert.match(events.at(-1)!.text, /gelöscht/);
});

test('a no is remembered and never asked again; running series are skipped; a second viewer blocks deletion', async () => {
  const mia = user('4915100000102', 'Mia', 'jf-mia');
  const ben = user('4915100000103', 'Ben', 'jf-ben');
  request(mia.id, 701, 'tv', 'Laufende Serie');
  request(mia.id, 700, 'tv', 'Beendete Serie');
  played['jf-mia'] = { 701: [10, 10], 700: [8, 8] };
  app.repo.setKv('cleanup_last_run', '2000-01-01T00:00:00Z');

  const made = await checkCleanupOffers(app.ctx, () => {}, noon);
  assert.equal(made.length, 1);
  const offer = app.repo.getCleanupOffer(made[0])!;
  assert.equal(offer.title, 'Beendete Serie'); // the running one is skipped

  await answerCleanup.run({ offerId: offer.id, agree: false }, toolCtx(mia));
  assert.ok(app.repo.listFacts(mia.id).some((f) => f.fact.includes('Beendete Serie')));
  assert.equal(app.repo.getCleanupOffer(offer.id)!.status, 'declined');
  assert.ok(app.repo.cleanupOfferFor(mia.id, 700, 'tv')); // declined: never again

  // a second viewer is in the middle of a title the first one agreed to delete
  request(mia.id, 300, 'movie', 'Gemeinsamer Film');
  const agreedOffer = app.repo.createCleanupOffer({ user_id: mia.id, tmdb_id: 300, media_type: 'movie', title: 'Gemeinsamer Film' });
  await answerCleanup.run({ offerId: agreedOffer.id, agree: true }, toolCtx(mia));
  request(ben.id, 300, 'movie', 'Gemeinsamer Film');
  const admin = app.repo.listAdmins()[0];
  await assert.rejects(decideCleanup.run({ offerId: agreedOffer.id, action: 'delete', force: false }, toolCtx(admin, true)), /noch offen/);
  assert.equal(app.repo.getCleanupOffer(agreedOffer.id)!.status, 'agreed');
});
