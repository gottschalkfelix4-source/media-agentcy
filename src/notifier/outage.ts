import { notifyAdmins, type AppContext } from '../agent/context.js';
import type { Repo, User } from '../db/repo.js';
import { handToHermes, hermesEnabled } from '../agent/hermes.js';

/**
 * Known disruptions: a maintenance notice set by the admin, or an outage detected by pinging the media
 * servers. Users who write during a disruption get a fixed notice (no LLM call) and a message once
 * everything runs again; the agent sees the disruption in its prompt and doesn't open tickets for it.
 */

export interface Maintenance {
  message: string;
  since: string;
  /** Ends by itself at this time. */
  until?: string;
}

export interface Outage {
  services: string[];
  since: string;
  error?: string;
}

export type Disruption = ({ kind: 'maintenance' } & Maintenance) | ({ kind: 'outage' } & Outage);

/** A user gets the fixed notice at most this often. */
const NOTICE_EVERY_MS = 2 * 3_600_000;
/** Consecutive failed pings before an outage counts (one hiccup is not an outage). */
const FAILS_BEFORE_OUTAGE = 2;
const MEDIA_SERVERS = ['jellyfin', 'plex'] as const;
const SERVICE_LABEL: Record<string, string> = { jellyfin: 'Jellyfin', plex: 'Plex' };

const K = { maintenance: 'maintenance', outage: 'outage', fails: 'outage_fails', affected: 'disruption_affected' };

function readJson<T>(repo: Repo, key: string): T | undefined {
  const raw = repo.getKv(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export const getMaintenance = (repo: Repo) => readJson<Maintenance>(repo, K.maintenance);
export const getOutage = (repo: Repo) => readJson<Outage>(repo, K.outage);

const labels = (services: string[]) => services.map((s) => SERVICE_LABEL[s] ?? s).join(' und ');
const time = (iso: string) => new Date(iso).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function currentDisruption(repo: Repo): Disruption | undefined {
  const m = getMaintenance(repo);
  if (m && (!m.until || Date.parse(m.until) > Date.now())) return { kind: 'maintenance', ...m };
  const o = getOutage(repo);
  if (o) return { kind: 'outage', ...o };
  return undefined;
}

/** An outage of one server doesn't concern users who only use the other one. */
function concerns(d: Disruption, user: User) {
  if (d.kind === 'maintenance') return true;
  const own = [user.jellyfin_username && 'jellyfin', user.plex_username && 'plex'].filter(Boolean) as string[];
  return own.length === 0 || own.some((s) => d.services.includes(s));
}

/** One line for the system prompts. */
export function disruptionPromptBlock(repo: Repo, adminName: string, user?: User) {
  const d = currentDisruption(repo);
  if (!d || (user && !concerns(d, user))) return '';
  const what =
    d.kind === 'maintenance'
      ? `Wartung (seit ${time(d.since)}${d.until ? `, geplant bis ${time(d.until)}` : ''}): ${d.message}`
      : `Bekannte Störung seit ${time(d.since)}: ${labels(d.services)} nicht erreichbar${d.error ? ` (${d.error})` : ''}.`;
  if (!user) return `\n## Aktuelle Störung\n${what}\nNutzer bekommen automatisch einen Hinweis und eine Nachricht, wenn alles wieder läuft. Wartungshinweis setzen/aufheben: set_maintenance.\n`;
  return `\n## Aktuelle Störung (wichtig)\n${what}\nDer Nutzer hat dazu schon einen Hinweis bekommen. Bei Wiedergabe- oder Verbindungsproblemen: kurz darauf verweisen, KEIN Ticket, keine Diagnose, nicht eskalieren – ${adminName} ist dran und der Nutzer bekommt automatisch Bescheid, sobald es wieder läuft. Anfragen und alles andere laufen normal weiter.\n`;
}

/**
 * Fixed notice for a user who writes during a disruption, or undefined if he got one within the last 2 hours
 * (or the disruption doesn't concern him). Remembers him for the all-clear message.
 */
export function disruptionNotice(ctx: AppContext, user: User): string | undefined {
  const { repo, config } = ctx;
  const d = currentDisruption(repo);
  if (!d || user.role === 'admin' || !concerns(d, user)) return undefined;

  const affected = new Set(readJson<number[]>(repo, K.affected) ?? []);
  affected.add(user.id);
  repo.setKv(K.affected, JSON.stringify([...affected]));

  const key = `disruption_notice:${user.id}`;
  const last = repo.getKv(key);
  if (last && Date.parse(last) >= Date.parse(d.since) && Date.now() - Date.parse(last) < NOTICE_EVERY_MS) return undefined;
  repo.setKv(key, new Date().toISOString());

  const head =
    d.kind === 'maintenance'
      ? `🛠️ *Wartung*: ${d.message}${d.until ? `\n(geplant bis ${time(d.until)})` : ''}`
      : `⚠️ *Bekannte Störung*: ${config.SERVER_NAME} ist gerade nicht erreichbar. ${config.ADMIN_NAME} weiß Bescheid und ist dran.`;
  return `${head}\n\nIch sage dir automatisch Bescheid, sobald alles wieder läuft. Brauchst du trotzdem etwas (z. B. einen Film anfragen), schreib mir einfach nochmal.`;
}

/** All clear: message everyone who wrote during the disruption – once nothing is disrupted anymore. */
async function allClear(ctx: AppContext, kind: Disruption['kind']) {
  const { repo, config, messenger, logger } = ctx;
  if (currentDisruption(repo)) return 0;
  const ids = readJson<number[]>(repo, K.affected) ?? [];
  repo.deleteKv(K.affected);
  const text =
    kind === 'maintenance'
      ? `✅ Die Wartung ist vorbei, ${config.SERVER_NAME} läuft wieder. Danke für deine Geduld!`
      : `✅ ${config.SERVER_NAME} läuft wieder. Danke für deine Geduld!`;
  let sent = 0;
  for (const id of ids) {
    const user = repo.getUser(id);
    if (!user || user.status !== 'active') continue;
    try {
      await messenger.sendText(user, text);
      repo.addMessage(user.id, 'assistant', text);
      sent++;
    } catch (err) {
      logger.warn({ err, user: id }, 'Entwarnung konnte nicht gesendet werden');
    }
  }
  return sent;
}

/** Sets (message) or clears (null) the maintenance notice. */
export async function setMaintenance(ctx: AppContext, message: string | null, hours?: number) {
  const { repo } = ctx;
  const before = getMaintenance(repo);
  if (message) {
    const m: Maintenance = {
      message: message.trim(),
      since: before?.since ?? new Date().toISOString(),
      ...(hours && hours > 0 ? { until: new Date(Date.now() + hours * 3_600_000).toISOString() } : {}),
    };
    repo.setKv(K.maintenance, JSON.stringify(m));
    repo.logAction(null, null, 'maintenance_set', { message: m.message, until: m.until });
    return { maintenance: m, notified: 0 };
  }
  if (!before) return { maintenance: undefined, notified: 0 };
  repo.deleteKv(K.maintenance);
  repo.logAction(null, null, 'maintenance_cleared', {});
  return { maintenance: undefined, notified: await allClear(ctx, 'maintenance') };
}

/** Poller step: pings the media servers, opens/closes the outage and expires timed maintenance. */
export async function checkDisruptions(ctx: AppContext) {
  const { repo, config, services } = ctx;

  const m = getMaintenance(repo);
  if (m?.until && Date.parse(m.until) <= Date.now()) {
    repo.deleteKv(K.maintenance);
    const notified = await allClear(ctx, 'maintenance');
    await notifyAdmins(ctx, `🛠️ Wartungshinweis ist abgelaufen${notified ? ` – ${notified} Nutzer haben eine Entwarnung bekommen` : ''}.`);
  }

  const outage = getOutage(repo);
  const targets = MEDIA_SERVERS.filter((k) => services[k]);
  if (!config.OUTAGE_DETECTION || !targets.length) {
    if (outage) {
      repo.deleteKv(K.outage);
      await allClear(ctx, 'outage');
    }
    repo.deleteKv(K.fails);
    return;
  }

  const failed: string[] = [];
  let error: string | undefined;
  await Promise.all(
    targets.map(async (k) => {
      try {
        await services[k]!.ping();
      } catch (err) {
        failed.push(k);
        error ??= (err as Error).message.slice(0, 120);
      }
    }),
  );

  if (!failed.length) {
    repo.deleteKv(K.fails);
    if (outage) {
      repo.deleteKv(K.outage);
      repo.logAction(null, null, 'outage_resolved', { services: outage.services });
      const minutes = Math.round((Date.now() - Date.parse(outage.since)) / 60_000);
      const notified = await allClear(ctx, 'outage');
      await notifyAdmins(ctx, `✅ ${labels(outage.services)} wieder erreichbar (Störung dauerte ca. ${minutes} Min.)${notified ? `. ${notified} Nutzer haben eine Entwarnung bekommen.` : '.'}`);
    }
    return;
  }

  const fails = Number(repo.getKv(K.fails) ?? 0) + 1;
  repo.setKv(K.fails, String(fails));
  if (outage) {
    if (failed.sort().join() !== [...outage.services].sort().join()) repo.setKv(K.outage, JSON.stringify({ ...outage, services: failed, error }));
    return;
  }
  if (fails < FAILS_BEFORE_OUTAGE) return;
  const o: Outage = { services: failed, since: new Date().toISOString(), error };
  repo.setKv(K.outage, JSON.stringify(o));
  repo.logAction(null, null, 'outage_detected', { services: failed, error });
  const hermes = config.HERMES_OUTAGES && hermesEnabled(config) ? await handToHermes(ctx, { outage: { services: failed.map((s) => SERVICE_LABEL[s] ?? s), error } }) : undefined;
  const hermesLine = !hermes ? '' : hermes.ok ? '\n🤖 Hermes ist informiert und schaut nach.' : `\n⚠️ Übergabe an Hermes fehlgeschlagen: ${hermes.error}`;
  await notifyAdmins(
    ctx,
    `⚠️ *Störung erkannt*: ${labels(failed)} nicht erreichbar${error ? ` (${error})` : ''}.\nNutzer, die jetzt schreiben, bekommen automatisch einen Hinweis und eine Entwarnung, sobald es wieder läuft. Ich melde mich, wenn es wieder geht.${hermesLine}`,
  );
}
