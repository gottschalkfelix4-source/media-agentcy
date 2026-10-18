import type { AppContext } from '../agent/context.js';
import type { Services } from '../integrations/index.js';
import type { RecentItem } from '../integrations/http.js';

/**
 * Weekly "new on the server" message: fixed text (no LLM), same content for everyone, sent to all active
 * users who didn't opt out. Jellyfin is the source when configured, otherwise Plex.
 */

export const DIGEST_DAYS = ['so', 'mo', 'di', 'mi', 'do', 'fr', 'sa'] as const;
const MAX_MOVIES = 15;
const MAX_SERIES = 12;

export interface NewOnServer {
  movies: { title: string; year?: number }[];
  series: { title: string; newSeries: boolean; episodes: number; seasons: number[] }[];
}

export async function collectNew(services: Services, days = 7): Promise<NewOnServer> {
  const since = new Date(Date.now() - days * 86_400_000);
  const source = services.jellyfin ?? services.plex;
  if (!source) throw new Error('Weder Jellyfin noch Plex konfiguriert');
  return groupNew(await source.recentlyAdded(since));
}

export function groupNew(items: RecentItem[]): NewOnServer {
  const movies: NewOnServer['movies'] = [];
  const seen = new Set<string>();
  const series = new Map<string, NewOnServer['series'][number]>();
  const entry = (title: string) => {
    let s = series.get(title);
    if (!s) series.set(title, (s = { title, newSeries: false, episodes: 0, seasons: [] }));
    return s;
  };
  for (const it of items) {
    if (it.type === 'movie') {
      const key = `${it.title}|${it.year ?? ''}`;
      if (!seen.has(key)) movies.push({ title: it.title, year: it.year });
      seen.add(key);
    } else if (it.type === 'series') {
      entry(it.title).newSeries = true;
    } else {
      const s = entry(it.title);
      s.episodes++;
      if (it.season != null && !s.seasons.includes(it.season)) s.seasons.push(it.season);
    }
  }
  return { movies, series: [...series.values()].map((s) => ({ ...s, seasons: s.seasons.sort((a, b) => a - b) })) };
}

function seasonText(seasons: number[]) {
  if (!seasons.length) return '';
  if (seasons.length === 1) return `Staffel ${seasons[0]}`;
  const contiguous = seasons.every((s, i) => i === 0 || s === seasons[i - 1] + 1);
  return contiguous ? `Staffel ${seasons[0]}–${seasons[seasons.length - 1]}` : `Staffel ${seasons.join(', ')}`;
}

export function digestText(n: NewOnServer): string | undefined {
  if (!n.movies.length && !n.series.length) return undefined;
  const lines = ['📬 *Wochenrückblick*', 'Das ist in den letzten 7 Tagen neu dazugekommen:'];
  if (n.movies.length) {
    lines.push('', '🎬 *Filme*');
    for (const m of n.movies.slice(0, MAX_MOVIES)) lines.push(`- ${m.title}${m.year ? ` (${m.year})` : ''}`);
    if (n.movies.length > MAX_MOVIES) lines.push(`- … und ${n.movies.length - MAX_MOVIES} weitere`);
  }
  if (n.series.length) {
    lines.push('', '📺 *Serien*');
    // New series first, then the ones with the most new episodes.
    const sorted = [...n.series].sort((a, b) => Number(b.newSeries) - Number(a.newSeries) || b.episodes - a.episodes);
    for (const s of sorted.slice(0, MAX_SERIES)) {
      const seasons = seasonText(s.seasons);
      const what = s.newSeries
        ? `neu${seasons ? ` (${seasons})` : ''}`
        : `${s.episodes === 1 ? 'eine neue Folge' : `${s.episodes} neue Folgen`}${seasons ? ` (${seasons})` : ''}`;
      lines.push(`- ${s.title}: ${what}`);
    }
    if (n.series.length > MAX_SERIES) lines.push(`- … und ${n.series.length - MAX_SERIES} weitere`);
  }
  lines.push('', 'Viel Spaß! Fehlt dir etwas? Schreib mir einfach, dann frage ich es an.', '_Keine Lust auf den Wochenrückblick? Schreib "Wochenrückblick aus"._');
  return lines.join('\n');
}

/** Recipients: active users who didn't opt out. */
export function digestRecipients(ctx: AppContext) {
  return ctx.repo.listUsers('active').filter((u) => u.digest && !u.bot_paused);
}

export async function sendDigest(ctx: AppContext) {
  const { repo, config, messenger, logger } = ctx;
  const text = digestText(await collectNew(ctx.services));
  if (!text) {
    repo.logAction(null, null, 'digest_skipped', { reason: 'nothing new' });
    return { sent: 0, text: undefined };
  }
  let sent = 0;
  for (const user of digestRecipients(ctx)) {
    try {
      await messenger.sendText(user, text);
      repo.addMessage(user.id, 'assistant', text);
      sent++;
    } catch (err) {
      logger.warn({ err, user: user.id }, 'Wochenrückblick konnte nicht gesendet werden');
    }
  }
  repo.logAction(null, null, 'digest_sent', { users: sent });
  return { sent, text };
}

/** Local date (TZ env) as YYYY-MM-DD. */
const localDay = (d: Date) => d.toLocaleDateString('sv-SE');

/** Poller step: sends once on DIGEST_DAY from DIGEST_HOUR on. */
export async function maybeSendDigest(ctx: AppContext, now = new Date()) {
  const { config, repo } = ctx;
  if (!config.DIGEST_ENABLED) return;
  if (DIGEST_DAYS[now.getDay()] !== config.DIGEST_DAY || now.getHours() < config.DIGEST_HOUR) return;
  const today = localDay(now);
  if (repo.getKv('digest_last') === today) return;
  // Mark first: a failing source must not lead to a retry storm every poll.
  repo.setKv('digest_last', today);
  await sendDigest(ctx);
}
