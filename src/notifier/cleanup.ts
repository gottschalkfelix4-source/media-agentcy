import type { AppContext } from '../agent/context.js';
import type { BotRequest, User } from '../db/repo.js';
import type { WatchState } from '../integrations/jellyfin.js';

/**
 * Cleanup offers: a title that a user requested and has watched completely is offered for deletion
 * ("may it go from the server to free space?"). The check runs here in the backend, so the bot never
 * learns who else watched or requested a title. Nothing is deleted without the user's yes and the admin's OK.
 */

const CHECK_EVERY_MS = 3_600_000;
const RECHECK_MS = 24 * 3_600_000;
/** At most one question per user and week, so nobody is nagged. */
const ASK_AGAIN_MS = 7 * 24 * 3_600_000;
const MAX_CHECKS_PER_RUN = 10;
const MAX_FOREIGN_JELLYFIN_USERS = 40;
/** Questions only go out at a decent time of day (local time, TZ env). */
const ASK_FROM_HOUR = 9;
const ASK_UNTIL_HOUR = 21;

export interface Progress {
  /** Everything that can be watched has been watched. */
  complete: boolean;
  /** At least something was watched. */
  started: boolean;
}

export function toProgress(ws: WatchState | undefined): Progress | undefined {
  if (!ws || ws.total <= 0) return undefined;
  return { complete: ws.played >= ws.total, started: ws.played > 0 };
}

interface TitleRefs {
  jellyfinId?: string;
  plexKey?: string;
}

async function resolveTitle(ctx: AppContext, type: 'movie' | 'tv', tmdbId: number, title: string): Promise<TitleRefs> {
  const { jellyfin, plex } = ctx.services;
  const [jf, px] = await Promise.all([
    jellyfin ? jellyfin.findByTmdb(type, tmdbId, title).catch(() => undefined) : undefined,
    plex ? plex.findByTmdb(type, tmdbId, title).catch(() => undefined) : undefined,
  ]);
  return { jellyfinId: jf?.id, plexKey: px?.ratingKey };
}

/** Progress of a user from every media server they are linked to (the better value counts). undefined = unknown. */
export async function progressOf(ctx: AppContext, user: User, refs: TitleRefs, type: 'movie' | 'tv'): Promise<Progress | undefined> {
  const { jellyfin, plex } = ctx.services;
  const found: Progress[] = [];
  if (jellyfin && user.jellyfin_user_id && refs.jellyfinId) {
    const p = toProgress(await jellyfin.watchState(user.jellyfin_user_id, refs.jellyfinId, type));
    if (p) found.push(p);
  }
  if (plex && user.plex_username && refs.plexKey) {
    const p = toProgress(await plex.watchState(user.plex_username, refs.plexKey, type));
    if (p) found.push(p);
  }
  if (!found.length) return undefined;
  return { complete: found.some((p) => p.complete), started: found.some((p) => p.started) };
}

/**
 * Does anybody else still have this title open? That is: another bot user who requested it and has not finished
 * it, another bot user (or, on Jellyfin, any account) who is in the middle of it. Unknown progress of somebody
 * who requested it counts as open.
 */
export async function othersStillOpen(ctx: AppContext, owner: User, type: 'movie' | 'tv', tmdbId: number, refs: TitleRefs): Promise<boolean> {
  const { repo, services } = ctx;
  const seen = new Set<string>();
  for (const u of repo.listUsers('active')) {
    if (u.id === owner.id) continue;
    if (u.jellyfin_user_id) seen.add(u.jellyfin_user_id);
    const requested = repo.hasBotRequest(u.id, '', '', tmdbId, type);
    const p = await progressOf(ctx, u, refs, type).catch(() => undefined);
    if (requested && !p?.complete) return true;
    if (p?.started && !p.complete) return true;
  }
  if (services.jellyfin && refs.jellyfinId) {
    const accounts = (await services.jellyfin.users()).filter((a) => !a.disabled && a.id !== owner.jellyfin_user_id && !seen.has(a.id));
    for (const a of accounts.slice(0, MAX_FOREIGN_JELLYFIN_USERS)) {
      const p = toProgress(await services.jellyfin.watchState(a.id, refs.jellyfinId, type).catch(() => undefined));
      if (p?.started && !p.complete) return true;
    }
  }
  return false;
}

/** True when the title may be offered: requester finished it, nobody else has it open, a series has ended. */
async function offerable(ctx: AppContext, user: User, r: BotRequest & { tmdb_id: number }) {
  const refs = await resolveTitle(ctx, r.media_type, r.tmdb_id, r.title);
  if (!refs.jellyfinId && !refs.plexKey) return false;
  const mine = await progressOf(ctx, user, refs, r.media_type);
  if (!mine?.complete) return false;
  if (r.media_type === 'tv' && ctx.services.sonarr) {
    const [s] = await ctx.services.sonarr.find({ tmdbId: r.tmdb_id });
    // Still running: new episodes will come, so "complete" is only a snapshot.
    if (!s || s.status !== 'ended') return false;
  }
  return !(await othersStillOpen(ctx, user, r.media_type, r.tmdb_id, refs));
}

export function cleanupQuestion(title: string, type: 'movie' | 'tv') {
  return `Du hast ${type === 'movie' ? 'den Film' : 'die Serie'} *${title}* angefragt und komplett geschaut. Soll ${type === 'movie' ? 'er' : 'sie'} vom Server gelöscht werden, damit Platz frei wird? Antworte einfach mit Ja oder Nein. Es wird nichts ohne dein Ja gelöscht.`;
}

type Notify = (userId: number, event: string, template: string) => void;

/** Poller step: asks users whether a finished title may be deleted. Returns the offers made. */
export async function checkCleanupOffers(ctx: AppContext, notify: Notify, now = new Date()) {
  const { repo, config, logger } = ctx;
  const offers: number[] = [];
  if (!config.CLEANUP_OFFERS) return offers;
  if (now.getHours() < ASK_FROM_HOUR || now.getHours() >= ASK_UNTIL_HOUR) return offers;
  const last = repo.getKv('cleanup_last_run');
  if (last && now.getTime() - Date.parse(last) < CHECK_EVERY_MS) return offers;
  repo.setKv('cleanup_last_run', now.toISOString());

  const users = new Map(repo.listUsers('active').map((u) => [u.id, u]));
  const lastCheck = (r: BotRequest) => Date.parse(repo.getKv(`cleanup_check:${r.id}`) ?? '1970-01-01');
  const asked = new Set<number>();

  const candidates = repo
    .listBotRequests({ limit: 1000 })
    .filter((r): r is typeof r & { tmdb_id: number } => !!r.tmdb_id && !!r.notified_at)
    .filter((r) => {
      const u = users.get(r.user_id);
      return !!u && !u.bot_paused && u.role !== 'admin' && !!(u.jellyfin_user_id || u.plex_username);
    })
    .filter((r) => !repo.cleanupOfferFor(r.user_id, r.tmdb_id, r.media_type))
    .filter((r) => now.getTime() - lastCheck(r) > RECHECK_MS)
    .sort((a, b) => lastCheck(a) - lastCheck(b))
    .slice(0, MAX_CHECKS_PER_RUN);

  for (const r of candidates) {
    const user = users.get(r.user_id)!;
    if (asked.has(user.id)) continue;
    const prev = repo.lastCleanupOffer(user.id);
    if (prev && (prev.status === 'asked' || now.getTime() - Date.parse(prev.asked_at.replace(' ', 'T') + 'Z') < ASK_AGAIN_MS)) continue;
    repo.setKv(`cleanup_check:${r.id}`, now.toISOString());
    try {
      if (!(await offerable(ctx, user, r))) continue;
    } catch (err) {
      logger.warn({ err, request: r.id }, 'Prüfung auf Löschangebot fehlgeschlagen');
      continue;
    }
    const offer = repo.createCleanupOffer({ user_id: user.id, tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title });
    repo.logAction(user.id, null, 'cleanup_asked', { offerId: offer.id, title: r.title });
    asked.add(user.id);
    offers.push(offer.id);
    const what = r.media_type === 'movie' ? 'Film' : 'Serie';
    notify(
      user.id,
      `[Aufräumen] Der Nutzer hat den ${what} "${r.title}" selbst angefragt und laut System komplett gesehen. Frag ihn freundlich in deinem Stil, ob er vom Server gelöscht werden darf, damit Platz frei wird. Mach klar, dass ohne sein Ja nichts gelöscht wird. Nenne nichts über andere Nutzer. Seine Antwort hältst du mit answer_cleanup (Angebot ${offer.id}) fest.`,
      `🧹 ${cleanupQuestion(r.title, r.media_type)}`,
    );
  }
  return offers;
}

/**
 * Safety net right before deleting: the situation can have changed since the user said yes
 * (a second user started it). Returns true when the title is still free to delete.
 */
export async function stillDeletable(ctx: AppContext, offer: { user_id: number; tmdb_id: number; media_type: 'movie' | 'tv'; title: string }) {
  const user = ctx.repo.getUser(offer.user_id);
  if (!user) return true;
  const refs = await resolveTitle(ctx, offer.media_type, offer.tmdb_id, offer.title);
  if (!refs.jellyfinId && !refs.plexKey) return true;
  return !(await othersStillOpen(ctx, user, offer.media_type, offer.tmdb_id, refs));
}
