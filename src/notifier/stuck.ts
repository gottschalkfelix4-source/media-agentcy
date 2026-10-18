import { notifyAdmins, userLabel, type AppContext } from '../agent/context.js';
import { checkRequest, requestFix } from '../agent/requestTools.js';
import type { ToolContext } from '../agent/tool.js';
import type { BotRequest } from '../db/repo.js';

/**
 * Stuck requests: open requests older than STUCK_REQUEST_DAYS are diagnosed once a day (same logic as the
 * agent's check_request) and the safe fixes are applied right away (search again, rescan, retry). Whatever
 * needs the admin ends up in one summary message instead of one ping per title.
 */

const RECHECK_MS = 24 * 3_600_000;
/** The admin hears about the same title at most every 3 days. */
const REPORT_AGAIN_MS = 3 * 24 * 3_600_000;
const MAX_PER_RUN = 10;

const AUTO_ACTIONS = new Set(['search_again', 'rescan_library', 'retry_request']);

const ACTION_LABEL: Record<string, string> = {
  search_again: 'neu gesucht',
  rescan_library: 'Mediathek neu eingelesen',
  retry_request: 'Anfrage erneut abgeschickt',
};

function ageDays(sqlTime: string) {
  return (Date.now() - Date.parse(sqlTime.replace(' ', 'T') + 'Z')) / 86_400_000;
}

export interface StuckResult {
  checked: number;
  fixed: { title: string; user: string; action: string }[];
  needsAdmin: { title: string; user: string; stage: string; hint: string }[];
}

export async function checkStuckRequests(ctx: AppContext): Promise<StuckResult> {
  const { repo, config, logger } = ctx;
  const result: StuckResult = { checked: 0, fixed: [], needsAdmin: [] };
  const days = config.STUCK_REQUEST_DAYS;
  if (days <= 0) return result;

  const seen = new Set<string>();
  const due = repo
    .pendingBotRequests()
    .filter((r): r is BotRequest & { tmdb_id: number } => !!r.tmdb_id && ageDays(r.created_at) >= days)
    .filter((r) => {
      const last = repo.getKv(`stuck_check:${r.id}`);
      return !last || Date.now() - Date.parse(last) > RECHECK_MS;
    })
    .slice(0, MAX_PER_RUN);

  for (const r of due) {
    repo.setKv(`stuck_check:${r.id}`, new Date().toISOString());
    const user = repo.getUser(r.user_id);
    if (!user || user.status !== 'active') continue;
    // The same title requested by several users is diagnosed and fixed once.
    const key = `${r.media_type}:${r.tmdb_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const toolCtx: ToolContext = { ...ctx, user, isAdmin: false, turn: { startedAt: Date.now(), sent: [], quiet: true } };
    try {
      const diag = (await checkRequest.run({ tmdbId: r.tmdb_id, mediaType: r.media_type }, toolCtx)) as {
        title?: string;
        stage: string;
        hint: string;
        suggestedAction?: string;
        requestId?: number;
      };
      result.checked++;
      const title = diag.title ?? r.title;
      const action = diag.suggestedAction;
      if (action && AUTO_ACTIONS.has(action)) {
        try {
          await requestFix.run({ action: action as 'search_again', mediaType: r.media_type, tmdbId: r.tmdb_id, title, requestId: diag.requestId }, toolCtx);
          result.fixed.push({ title, user: userLabel(user), action });
          repo.logAction(user.id, null, 'stuck_autofix', { title, action, stage: diag.stage });
          continue;
        } catch (err) {
          // Cooldown or not possible: fall through to the admin summary.
          diag.hint = `${diag.hint} (Automatisch ${ACTION_LABEL[action]} hat nicht geklappt: ${(err as Error).message})`;
        }
      }
      if (action === 'remind_admin' || action === 'escalate' || (action && AUTO_ACTIONS.has(action))) {
        const reported = repo.getKv(`stuck_reported:${r.id}`);
        if (!reported || Date.now() - Date.parse(reported) > REPORT_AGAIN_MS) {
          repo.setKv(`stuck_reported:${r.id}`, new Date().toISOString());
          result.needsAdmin.push({ title, user: userLabel(user), stage: diag.stage, hint: diag.hint });
        }
      }
    } catch (err) {
      logger.warn({ err, request: r.id }, 'Prüfung einer hängenden Anfrage fehlgeschlagen');
    }
  }

  const showFixed = config.ADMIN_NOTIFY_AUTOFIX && result.fixed.length > 0;
  if (showFixed || result.needsAdmin.length) {
    const lines = ['🔧 *Hängende Anfragen* (automatische Prüfung)'];
    if (showFixed) {
      lines.push('', 'Selbst angestoßen:');
      for (const f of result.fixed) lines.push(`• ${f.title} (${f.user}): ${ACTION_LABEL[f.action]}`);
    }
    if (result.needsAdmin.length) {
      lines.push('', 'Braucht dich:');
      for (const n of result.needsAdmin) lines.push(`• ${n.title} (${n.user}): ${n.hint}`);
    }
    await notifyAdmins(ctx, lines.join('\n'));
  }
  return result;
}
