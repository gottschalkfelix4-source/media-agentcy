import type { Repo, Ticket } from '../db/repo.js';
import type { ToolContext } from './tool.js';

/** How long an open ticket without a title counts as "the problem we're talking about". */
const FRESH_MS = 6 * 3_600_000;

const OPEN = ['open', 'auto_fixing', 'escalated'] as const;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function mediaTitle(t: Ticket) {
  try {
    return t.media_ref ? String((JSON.parse(t.media_ref) as { title?: unknown }).title ?? '') : '';
  } catch {
    return '';
  }
}

function mediaTmdb(t: Ticket) {
  try {
    return t.media_ref ? (JSON.parse(t.media_ref) as { tmdbId?: unknown }).tmdbId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every problem a user brings up gets a ticket, even if the model skipped report_problem: the tools that check
 * or fix something reuse the matching open ticket (same title, or the most recent one when there is no title)
 * and open one otherwise. Admins don't get tickets this way – they open them explicitly with create_ticket.
 */
export function ensureTicket(
  ctx: ToolContext,
  p: { title: string; description: string; category: string; media?: { title: string; type: string; tmdbId?: number; season?: number; episode?: number } },
): Ticket | undefined {
  if (ctx.isAdmin) return undefined;
  const open = ctx.repo.listTickets({ userId: ctx.user.id, statuses: [...OPEN], limit: 20 });
  const key = p.media ? norm(p.media.title) : '';
  const hit = key
    ? open.find((t) => {
        if (p.media?.tmdbId && mediaTmdb(t) === p.media.tmdbId) return true;
        const m = norm(mediaTitle(t));
        return (m && (m.includes(key) || key.includes(m))) || norm(t.title).includes(key);
      })
    : open.find((t) => Date.now() - Date.parse(t.updated_at.replace(' ', 'T') + 'Z') < FRESH_MS);
  if (hit) return hit;
  const t = ctx.repo.createTicket({
    user_id: ctx.user.id,
    title: p.title,
    description: p.description,
    category: p.category,
    severity: 'normal',
    media_ref: p.media,
  });
  ctx.repo.appendTicketAction(t.id, 'auto_ticket', 'Automatisch angelegt, als der Bot das Problem geprüft hat');
  return t;
}

/** A hanging request became available: the tickets about it are done (the user hears about it from the request notice). */
export function resolveRequestTickets(repo: Repo, userId: number, m: { tmdbId?: number | null; title?: string }) {
  const key = m.title ? norm(m.title) : '';
  for (const t of repo.listTickets({ userId, statuses: [...OPEN], limit: 50 })) {
    if (t.category !== 'missing_media') continue;
    const tmdb = mediaTmdb(t);
    const match = (m.tmdbId && tmdb === m.tmdbId) || (key && norm(mediaTitle(t)) === key);
    if (!match) continue;
    repo.updateTicket(t.id, { status: 'resolved', resolution: 'Titel ist jetzt verfügbar' });
    repo.appendTicketAction(t.id, 'available', 'Titel ist jetzt verfügbar');
    repo.closeWatchesForTicket(t.id);
  }
}
