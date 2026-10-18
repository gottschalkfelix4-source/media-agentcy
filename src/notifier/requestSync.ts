import type { AppContext } from '../agent/context.js';
import type { User } from '../db/repo.js';

/**
 * Imports requests made on the Jellyseerr/Overseerr or Ombi website into bot_requests, assigned to the
 * bot user whose linked accounts made them. They show up under "Anfragen" in the web UI, the agent's
 * my_requests/check_request see them, and the poller notifies when a waiting one becomes available.
 * Requests that are already available are stored as done (no notification), declined ones are skipped.
 */

const AVAILABLE = 5;
const DECLINED = 3;

export interface SyncResult {
  imported: number;
  /** Requests whose requester is not linked to any bot user. */
  unmatched: number;
  errors: string[];
}

const lc = (v?: string | null) => v?.trim().toLowerCase() || undefined;

/** ISO date → SQLite datetime text, so imported rows sort and compare like the rest. */
const sqlTime = (iso?: string) => {
  const d = iso ? new Date(iso) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 19).replace('T', ' ') : undefined;
};

function matcher(users: User[]) {
  return {
    seerr: (by: { id: number; jellyfinUsername?: string; plexUsername?: string }) =>
      users.filter(
        (u) =>
          u.seerr_user_id === by.id ||
          (!!lc(by.jellyfinUsername) && lc(u.jellyfin_username) === lc(by.jellyfinUsername)) ||
          (!!lc(by.plexUsername) && lc(u.plex_username) === lc(by.plexUsername)),
      ),
    ombi: (name?: string) =>
      lc(name) ? users.filter((u) => [u.ombi_username, u.jellyfin_username, u.plex_username].some((v) => lc(v) === lc(name))) : [],
  };
}

/** Became available this recently → import as waiting, so the poller still sends the "it's there" message. */
const FRESH_MS = 2 * 3_600_000;

/**
 * full = page through everything; otherwise only the newest 100 Seerr requests. On the very first sync
 * everything that is already available counts as done, later only what became available more than 2 h ago
 * (a request that was made and finished between two polls still gets its notification).
 */
export async function syncRequests(ctx: AppContext, opts: { full?: boolean } = {}): Promise<SyncResult> {
  const { repo, services, logger } = ctx;
  const result: SyncResult = { imported: 0, unmatched: 0, errors: [] };
  const firstSync = !repo.getKv('requests_synced');
  const fresh = (iso?: string) => !firstSync && !!iso && Date.now() - Date.parse(iso) < FRESH_MS;
  const match = matcher(repo.listUsers('active'));

  const add = (u: User, r: { source: 'seerr' | 'ombi'; key: string; tmdbId: number | null; type: 'movie' | 'tv'; title: string; available: boolean; at?: string }) => {
    if (repo.hasBotRequest(u.id, r.source, r.key, r.tmdbId, r.type)) return;
    repo.addBotRequest({
      user_id: u.id,
      source: r.source,
      external_id: r.key,
      tmdb_id: r.tmdbId,
      media_type: r.type,
      title: r.title,
      via: 'web',
      created_at: sqlTime(r.at),
      notified_at: r.available ? sqlTime(new Date().toISOString()) : null,
    });
    // Already available: never announce it (the website user knows); the poller dedups on this.
    if (r.available) repo.markNotified(r.source, r.key, u.id);
    result.imported++;
  };

  if (services.seerr) {
    const seerr = services.seerr;
    try {
      for (const req of await seerr.allRequests(opts.full ? 20 : 1)) {
        if (req.status === DECLINED) continue;
        const users = match.seerr(req.requestedBy);
        if (!users.length) {
          result.unmatched++;
          continue;
        }
        const todo = users.filter((u) => !repo.hasBotRequest(u.id, 'seerr', String(req.id), req.media.tmdbId, req.media.mediaType));
        if (!todo.length) continue;
        const title = await seerr.title(req.media.mediaType, req.media.tmdbId).catch(() => `TMDB ${req.media.tmdbId}`);
        for (const u of todo) {
          add(u, { source: 'seerr', key: String(req.id), tmdbId: req.media.tmdbId, type: req.media.mediaType, title, available: req.media.status === AVAILABLE && !fresh(req.media.mediaAddedAt ?? req.media.updatedAt), at: req.createdAt });
        }
      }
    } catch (err) {
      result.errors.push(`Jellyseerr: ${(err as Error).message}`);
    }
  }

  if (services.ombi) {
    const ombi = services.ombi;
    try {
      for (const m of await ombi.movieRequests()) {
        if (m.denied) continue;
        const users = match.ombi(m.requestedUser?.userName);
        if (!users.length) result.unmatched++;
        for (const u of users) add(u, { source: 'ombi', key: `movie:${m.id}`, tmdbId: m.theMovieDbId || null, type: 'movie', title: m.title, available: m.available, at: m.requestedDate });
      }
      for (const t of await ombi.tvRequests()) {
        for (const c of t.childRequests ?? []) {
          if (c.denied) continue;
          const users = match.ombi(c.requestedUser?.userName);
          if (!users.length) result.unmatched++;
          for (const u of users) add(u, { source: 'ombi', key: `tv:${c.id}`, tmdbId: t.externalProviderId ?? null, type: 'tv', title: t.title, available: c.available });
        }
      }
    } catch (err) {
      result.errors.push(`Ombi: ${(err as Error).message}`);
    }
  }

  repo.setKv('requests_synced', new Date().toISOString());
  if (result.imported) logger.info({ ...result }, 'Anfragen von der Webseite übernommen');
  return result;
}
