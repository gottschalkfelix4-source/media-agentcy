import { z } from 'zod';
import { titleScore } from '../integrations/http.js';
import { MEDIA_STATUS, REQUEST_STATUS } from '../integrations/seerr.js';
import { notifyAdmins, userLabel } from './context.js';
import { defineTool, ToolError, type ToolContext } from './tool.js';

type MediaType = 'movie' | 'tv';

// ---------------------------------------------------------------- verdict

export type RequestStage =
  | 'available'
  | 'not_requested'
  | 'waiting_for_approval'
  | 'declined'
  | 'failed'
  | 'not_in_downloader'
  | 'not_monitored'
  | 'downloaded_not_in_library'
  | 'downloading'
  | 'download_problem'
  | 'download_failed'
  | 'not_released'
  | 'partially_available'
  | 'searching'
  | 'unknown';

export type RequestAction = 'search_again' | 'rescan_library' | 'retry_request' | 'remind_admin' | 'escalate';

export interface RequestFacts {
  type: MediaType;
  /** Days since the request was made. */
  ageDays?: number;
  /** Seerr request status (1 pending … 5 completed). */
  requestStatus?: number;
  /** Seerr media status (1 unknown … 5 available). */
  mediaStatus?: number;
  /** 'not_configured' = no Radarr/Sonarr, null = title not found there. */
  arr: 'not_configured' | null | { monitored: boolean; complete: boolean; partial?: boolean; released?: boolean; continuing?: boolean };
  queue: { problems: string[]; health?: string }[];
  /** Latest download/import failure, if it is the most recent download event. */
  lastFailure?: string;
  /** 'all' = on every media server, 'some' = only on some, undefined = no media server configured. */
  library?: 'all' | 'some' | 'none';
}

/** Where a request is stuck and what to do about it. Pure, so it is easy to test. */
export function requestVerdict(f: RequestFacts): { stage: RequestStage; hint: string; action?: RequestAction } {
  const age = f.ageDays ?? 0;
  const arr = f.arr;
  const inLibrary = f.library === 'all' || f.library === undefined;

  if (f.mediaStatus === 5 || (f.library === 'all' && (arr === 'not_configured' || arr === null || arr.complete))) {
    return { stage: 'available', hint: 'Der Titel ist verfügbar und kann geschaut werden.' };
  }
  if (f.requestStatus === 1) {
    return {
      stage: 'waiting_for_approval',
      hint: 'Die Anfrage wartet noch auf die Freigabe durch den Admin.',
      action: age >= 1 ? 'remind_admin' : undefined,
    };
  }
  if (f.requestStatus === 3) return { stage: 'declined', hint: 'Die Anfrage wurde vom Admin abgelehnt. Bei Fragen dazu an den Admin wenden.' };
  if (f.requestStatus === 4) {
    return { stage: 'failed', hint: 'Die Anfrage konnte nicht an den Downloader übergeben werden. Ein erneuter Versuch hilft meistens.', action: 'retry_request' };
  }
  if (arr === 'not_configured') {
    return {
      stage: 'unknown',
      hint: `Kein Downloader angebunden, genauer Stand unbekannt. Status laut Anfragesystem: ${MEDIA_STATUS[f.mediaStatus ?? 1] ?? 'unbekannt'}.`,
      action: age >= 7 ? 'remind_admin' : undefined,
    };
  }
  if (arr === null) {
    if (f.requestStatus === undefined && (f.mediaStatus ?? 1) <= 1) {
      return { stage: 'not_requested', hint: 'Der Titel wurde noch nicht angefragt. Anfragen anbieten (request_media).' };
    }
    return {
      stage: 'not_in_downloader',
      hint: 'Die Anfrage ist freigegeben, aber beim Downloader nie angekommen.',
      action: f.requestStatus !== undefined ? 'retry_request' : 'escalate',
    };
  }
  if (!arr.monitored) return { stage: 'not_monitored', hint: 'Der Titel wird beim Downloader nicht überwacht, das muss der Admin einstellen.', action: 'escalate' };
  if (arr.complete) {
    if (!inLibrary) {
      return {
        stage: 'downloaded_not_in_library',
        hint: 'Die Datei ist heruntergeladen, taucht aber noch nicht in der Bibliothek auf. Ein Bibliotheks-Scan behebt das meist.',
        action: 'rescan_library',
      };
    }
    return { stage: 'available', hint: 'Der Titel ist verfügbar und kann geschaut werden.' };
  }
  if (f.queue.length) {
    if (f.queue.some((q) => q.problems.length || q.health === 'warning' || q.health === 'error')) {
      return { stage: 'download_problem', hint: 'Der Download hängt oder hat einen Fehler. Eine neue Suche nach einer anderen Version hilft oft.', action: 'search_again' };
    }
    return { stage: 'downloading', hint: 'Wird gerade heruntergeladen. Fortschritt und Restzeit stehen unter download.' };
  }
  if (f.lastFailure) {
    return { stage: 'download_failed', hint: `Der letzte Download ist fehlgeschlagen (${f.lastFailure}). Neue Suche starten.`, action: 'search_again' };
  }
  if (f.type === 'movie' && arr.released === false) {
    return { stage: 'not_released', hint: 'Der Film ist noch nicht digital erschienen. Er wird automatisch geladen, sobald es eine Version gibt.' };
  }
  if (arr.partial) {
    return {
      stage: 'partially_available',
      hint: arr.continuing
        ? 'Ein Teil der Folgen ist da. Die Serie läuft noch, neue Folgen kommen nach der Ausstrahlung automatisch.'
        : 'Ein Teil der Folgen ist da, der Rest wird noch gesucht.',
      action: age >= 2 ? 'search_again' : undefined,
    };
  }
  if (age < 1) return { stage: 'searching', hint: 'Die Suche nach einer passenden Version läuft gerade erst. Etwas Geduld.' };
  return {
    stage: 'searching',
    hint:
      age >= 14
        ? 'Seit über zwei Wochen keine passende Version gefunden. Neue Suche starten und den Admin informieren.'
        : 'Bisher keine passende Version gefunden. Neue Suche starten.',
    action: 'search_again',
  };
}

// ---------------------------------------------------------------- gathering

function ageDays(ts?: string | null) {
  if (!ts) return undefined;
  const t = Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? undefined : Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

const FAILURE_EVENTS = new Set(['downloadFailed', 'importFailed']);
const DOWNLOAD_EVENTS = new Set(['grabbed', 'downloadFolderImported', 'episodeFileImported', ...FAILURE_EVENTS]);

interface Target {
  type: MediaType;
  tmdbId: number;
  title: string;
  requestId?: number;
  requestStatus?: number;
  mediaStatus?: number;
  requestedAt?: string;
  ownRequest: boolean;
}

/** The user's own requests: Jellyseerr (if linked) plus everything requested through the bot. */
async function ownRequests(ctx: ToolContext): Promise<Target[]> {
  const { seerr } = ctx.services;
  const out = new Map<string, Target>();
  if (seerr && ctx.user.seerr_user_id) {
    const reqs = await seerr.userRequests(ctx.user.seerr_user_id, 20).catch(() => []);
    for (const r of reqs) {
      out.set(`${r.media.mediaType}:${r.media.tmdbId}`, {
        type: r.media.mediaType,
        tmdbId: r.media.tmdbId,
        title: await seerr.title(r.media.mediaType, r.media.tmdbId).catch(() => `TMDB ${r.media.tmdbId}`),
        requestId: r.id,
        requestStatus: r.status,
        mediaStatus: r.media.status,
        requestedAt: r.createdAt,
        ownRequest: true,
      });
    }
  }
  for (const b of ctx.repo.botRequestsForUser(ctx.user.id, 30)) {
    if (!b.tmdb_id) continue;
    const key = `${b.media_type}:${b.tmdb_id}`;
    if (out.has(key)) continue;
    out.set(key, {
      type: b.media_type,
      tmdbId: b.tmdb_id,
      title: b.title,
      requestId: b.source === 'seerr' && b.external_id ? Number(b.external_id) : undefined,
      mediaStatus: b.notified_at ? 5 : undefined,
      requestedAt: b.created_at,
      ownRequest: true,
    });
  }
  return [...out.values()];
}

async function resolveTarget(ctx: ToolContext, a: { title?: string; tmdbId?: number; mediaType?: MediaType }) {
  const own = (await ownRequests(ctx)).filter((t) => !a.mediaType || t.type === a.mediaType);
  if (a.tmdbId) {
    const hit = own.find((t) => t.tmdbId === a.tmdbId);
    if (hit) return hit;
  } else if (a.title) {
    const best = own.map((t) => ({ t, s: titleScore(a.title!, t.title) })).sort((x, y) => y.s - x.s)[0];
    if (best && best.s >= 0.5) return best.t;
  } else {
    const open = own.filter((t) => t.mediaStatus !== 5);
    if (open.length === 1) return open[0];
    return { choose: open.map((t) => ({ title: t.title, type: t.type, tmdbId: t.tmdbId })) };
  }

  // Not one of the user's requests: look the title up in the request system.
  const { seerr } = ctx.services;
  if (!seerr) throw new ToolError('Keine passende Anfrage dieses Nutzers gefunden.');
  if (a.tmdbId && a.mediaType) {
    return { type: a.mediaType, tmdbId: a.tmdbId, title: await seerr.title(a.mediaType, a.tmdbId), ownRequest: false } satisfies Target;
  }
  if (!a.title) throw new ToolError('Bei einer tmdbId bitte auch mediaType angeben.');
  const hits = (await seerr.search(a.title)).filter((r) => !a.mediaType || r.mediaType === a.mediaType);
  const best = hits.map((r) => ({ r, s: titleScore(a.title!, r.title) })).sort((x, y) => y.s - x.s)[0];
  if (!best || best.s < 0.5) throw new ToolError(`"${a.title}" nicht gefunden. Mit search_media nach dem genauen Titel suchen.`);
  return { type: best.r.mediaType, tmdbId: best.r.tmdbId, title: best.r.title, ownRequest: false } satisfies Target;
}

async function findInDownloader(ctx: ToolContext, type: MediaType, tmdbId: number, title: string) {
  const { radarr, sonarr } = ctx.services;
  if (type === 'movie') {
    if (!radarr) return undefined;
    const m = (await radarr.find({ tmdbId }))[0] ?? (await radarr.find({ title }))[0];
    return m ? { kind: 'radarr' as const, id: m.radarrId, movie: m } : null;
  }
  if (!sonarr) return undefined;
  const s = (await sonarr.find({ tmdbId }))[0] ?? (await sonarr.find({ title })).find((x) => !x.tmdbId || x.tmdbId === tmdbId);
  return s ? { kind: 'sonarr' as const, id: s.sonarrId, series: s } : null;
}

/** Whether the title shows up on the media servers. Deliberately one answer for all servers. */
async function libraryState(ctx: ToolContext, type: MediaType, tmdbId: number, names: string[]): Promise<RequestFacts['library']> {
  const { jellyfin, plex } = ctx.services;
  const checks: Promise<boolean>[] = [];
  const matches = (name: string) => names.some((n) => titleScore(n, name) >= 0.8);
  if (jellyfin) {
    checks.push(
      (async () => {
        for (const n of names) {
          const hits = await jellyfin.search(n, type === 'movie' ? 'Movie' : 'Series', 5);
          if (hits.some((h) => h.tmdbId === String(tmdbId) || matches(h.name))) return true;
        }
        return false;
      })().catch(() => false),
    );
  }
  if (plex) {
    checks.push(
      (async () => {
        for (const n of names) {
          const hits = await plex.search(n, 8);
          if (hits.some((h) => h.type === (type === 'movie' ? 'movie' : 'show') && matches(h.name))) return true;
        }
        return false;
      })().catch(() => false),
    );
  }
  if (!checks.length) return undefined;
  const found = await Promise.all(checks);
  return found.every(Boolean) ? 'all' : found.some(Boolean) ? 'some' : 'none';
}

/** Makes sure the user gets the automatic "ist verfügbar" message for this title. */
function ensureTracked(ctx: ToolContext, t: { type: MediaType; tmdbId: number; title: string; requestId?: number }) {
  if (!ctx.services.seerr) return false;
  const tracked = ctx.repo.botRequestsForUser(ctx.user.id, 100).some((b) => b.tmdb_id === t.tmdbId && b.media_type === t.type && !b.notified_at);
  if (!tracked) {
    ctx.repo.addBotRequest({
      user_id: ctx.user.id,
      source: 'seerr',
      external_id: t.requestId ? String(t.requestId) : null,
      tmdb_id: t.tmdbId,
      media_type: t.type,
      title: t.title,
    });
  }
  return true;
}

// ---------------------------------------------------------------- tools

const mediaType = z.enum(['movie', 'tv']).describe('movie = Film, tv = Serie');

export const checkRequest = defineTool({
  name: 'check_request',
  description:
    'Verfolgt eine Medienanfrage durchs ganze System (Anfrage → Freigabe → Downloader → Download → Bibliothek) und sagt, wo sie steckt (stage), warum, und welche Aktion hilft (suggestedAction). Für Fragen wie "Was ist mit meiner Anfrage X?" oder "Wann kommt X?". Ohne Titel: die einzige offene Anfrage bzw. eine Auswahlliste.',
  schema: z.object({
    title: z.string().optional().describe('Titel der Anfrage, wie der Nutzer ihn nennt'),
    tmdbId: z.number().int().optional(),
    mediaType: mediaType.optional(),
  }),
  async run(a, ctx) {
    const target = await resolveTarget(ctx, a);
    if ('choose' in target) {
      if (!target.choose.length) return { stage: 'none', hint: 'Der Nutzer hat keine offenen Anfragen.' };
      return { stage: 'choose', hint: 'Mehrere offene Anfragen. Nachfragen, welche gemeint ist, oder alle kurz prüfen.', openRequests: target.choose };
    }
    const { seerr, radarr, sonarr } = ctx.services;
    const t: Target = { ...target };

    if (seerr) {
      const d = await seerr.details(t.type, t.tmdbId).catch(() => undefined);
      if (d) {
        t.title = d.title ?? d.name ?? t.title;
        t.mediaStatus = d.mediaInfo?.status ?? t.mediaStatus;
        const reqs = d.mediaInfo?.requests ?? [];
        const req =
          reqs.find((r) => r.id === t.requestId) ??
          reqs.find((r) => ctx.user.seerr_user_id && r.requestedBy?.id === ctx.user.seerr_user_id) ??
          reqs.toSorted((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
        if (req) {
          t.requestId = req.id;
          t.requestStatus = req.status;
          t.requestedAt ??= req.createdAt;
        }
      }
    }

    const arrHit = await findInDownloader(ctx, t.type, t.tmdbId, t.title).catch(() => null);
    let arr: RequestFacts['arr'] = arrHit === undefined ? 'not_configured' : null;
    let queue: Awaited<ReturnType<NonNullable<typeof radarr>['queue']>> = [];
    let lastFailure: string | undefined;
    const extra: Record<string, unknown> = {};
    const names = [t.title];

    if (arrHit) {
      const history =
        arrHit.kind === 'radarr' ? await radarr!.history(arrHit.id, 15).catch(() => []) : await sonarr!.history(arrHit.id, 15).catch(() => []);
      queue = (arrHit.kind === 'radarr' ? await radarr!.queue(arrHit.id) : await sonarr!.queue(arrHit.id)).slice(0, 5);
      const lastDownload = history.filter((h) => DOWNLOAD_EVENTS.has(h.event)).toSorted((x, y) => y.date.localeCompare(x.date))[0];
      if (lastDownload && FAILURE_EVENTS.has(lastDownload.event)) lastFailure = lastDownload.reason ?? lastDownload.event;

      if (arrHit.kind === 'radarr') {
        const m = arrHit.movie;
        names.push(m.title);
        arr = { monitored: m.monitored, complete: m.hasFile, released: m.isAvailable };
        extra.releases = m.releases;
      } else {
        const s = arrHit.series;
        names.push(s.title);
        const [have, want] = (s.episodesOnDisk ?? '0/0').split('/').map(Number);
        arr = { monitored: s.monitored, complete: want > 0 && have >= want, partial: have > 0 && have < want, continuing: s.status === 'continuing' };
        extra.episodes = s.episodesOnDisk;
        extra.seasons = s.seasons?.map((x) => `Staffel ${x.season}: ${x.onDisk ?? '?'}${x.monitored ? '' : ' (nicht überwacht)'}`);
      }
    }

    const library = await libraryState(ctx, t.type, t.tmdbId, [...new Set(names)]);
    const facts: RequestFacts = { type: t.type, ageDays: ageDays(t.requestedAt), requestStatus: t.requestStatus, mediaStatus: t.mediaStatus, arr, queue, lastFailure, library };
    const verdict = requestVerdict(facts);
    const notify = verdict.stage !== 'available' && verdict.stage !== 'not_requested' && verdict.stage !== 'declined' && ensureTracked(ctx, t);

    return {
      title: t.title,
      type: t.type,
      tmdbId: t.tmdbId,
      requestId: t.requestId,
      requestedByThisUser: t.ownRequest,
      requestedAt: t.requestedAt?.slice(0, 10),
      waitingDays: facts.ageDays,
      request: t.requestStatus ? REQUEST_STATUS[t.requestStatus] : 'keine Anfrage gefunden',
      media: MEDIA_STATUS[t.mediaStatus ?? 1],
      stage: verdict.stage,
      hint: verdict.hint,
      suggestedAction: verdict.action,
      download: queue.length ? queue.map((q) => ({ episode: q.episode, progress: q.progress, timeLeft: q.timeLeft, problems: q.problems })) : undefined,
      lastFailure,
      onServer: library === undefined ? undefined : library === 'all' ? 'ja' : library === 'some' ? 'noch nicht vollständig eingelesen' : 'nein',
      ...extra,
      notifyWhenAvailable: notify || undefined,
    };
  },
});

const COOLDOWN_HOURS: Record<Exclude<RequestAction, 'escalate'>, number> = {
  search_again: 6,
  rescan_library: 1,
  retry_request: 6,
  remind_admin: 24,
};

export const requestFix = defineTool({
  name: 'request_fix',
  description: `Bringt eine hängende Anfrage wieder in Gang. Vorher check_request aufrufen und dessen suggestedAction verwenden.
- search_again: beim Downloader neu nach einer Version suchen (nichts gefunden, Download hängt/fehlgeschlagen, Folgen fehlen)
- rescan_library: Bibliothek neu einlesen (Datei ist da, taucht aber nicht auf)
- retry_request: fehlgeschlagene Anfrage erneut an den Downloader schicken (braucht requestId)
- remind_admin: Admin an eine Anfrage erinnern, die auf Freigabe wartet oder seit Langem festhängt
Der Nutzer wird automatisch benachrichtigt, sobald der Titel verfügbar ist.`,
  schema: z.object({
    action: z.enum(['search_again', 'rescan_library', 'retry_request', 'remind_admin']),
    mediaType,
    tmdbId: z.number().int(),
    title: z.string(),
    requestId: z.number().int().optional(),
    note: z.string().max(500).optional().describe('Nur remind_admin: kurzer Hinweis für den Admin, z. B. was check_request ergeben hat'),
  }),
  async run(a, ctx) {
    const { seerr, radarr, sonarr, jellyfin, plex } = ctx.services;
    const kvKey = `request_fix:${ctx.user.id}:${a.action}:${a.mediaType}:${a.tmdbId}`;
    if (!ctx.isAdmin) {
      const last = ctx.repo.getKv(kvKey);
      const hours = COOLDOWN_HOURS[a.action];
      if (last && Date.now() - Date.parse(last) < hours * 3_600_000) {
        throw new ToolError(`Das wurde für diesen Titel vor kurzem schon gemacht (geht wieder nach ${hours} h). Wenn es weiter hängt: escalate_to_admin.`);
      }
      if (ctx.repo.countActionsSince(ctx.user.id, 'request_fix', '-1 day') >= 10) {
        throw new ToolError('Tageslimit für Anfrage-Hilfen erreicht. Bitte an den Admin eskalieren.');
      }
    }

    let result: unknown;
    switch (a.action) {
      case 'search_again': {
        const hit = await findInDownloader(ctx, a.mediaType, a.tmdbId, a.title);
        if (hit === undefined) throw new ToolError(`${a.mediaType === 'movie' ? 'Radarr' : 'Sonarr'} ist nicht konfiguriert.`);
        if (hit === null) throw new ToolError('Titel ist beim Downloader nicht angelegt. retry_request versuchen oder an den Admin eskalieren.');
        result = hit.kind === 'radarr' ? await radarr!.search(hit.id) : await sonarr!.searchSeries(hit.id);
        break;
      }
      case 'rescan_library': {
        const hit = await findInDownloader(ctx, a.mediaType, a.tmdbId, a.title).catch(() => null);
        const r: Record<string, unknown> = {};
        const attempt = async (name: string, fn: () => Promise<unknown>) => {
          r[name] = await fn().then(
            () => 'ok',
            (err: unknown) => (err as Error).message,
          );
        };
        if (hit?.kind === 'radarr') await attempt('radarr', () => radarr!.rescan(hit.id));
        if (hit?.kind === 'sonarr') await attempt('sonarr', () => sonarr!.rescan(hit.id));
        if (jellyfin) await attempt('jellyfin', () => jellyfin.scanLibrary());
        if (plex) await attempt('plex', () => plex.scanLibrary());
        if (!Object.keys(r).length) throw new ToolError('Kein Dienst zum Einlesen konfiguriert.');
        result = r;
        break;
      }
      case 'retry_request': {
        if (!seerr) throw new ToolError('Jellyseerr/Overseerr ist nicht konfiguriert.');
        if (!a.requestId) throw new ToolError('requestId fehlt (steht im Ergebnis von check_request).');
        const req = await seerr.getRequest(a.requestId);
        if (req.media.tmdbId !== a.tmdbId) throw new ToolError('Die requestId gehört nicht zu diesem Titel.');
        const res = await seerr.retryRequest(a.requestId);
        result = { status: REQUEST_STATUS[res.status] ?? res.status };
        break;
      }
      case 'remind_admin': {
        await notifyAdmins(
          ctx,
          `📨 *Anfrage hängt* – ${userLabel(ctx.user)} fragt nach "${a.title}" (${a.mediaType === 'movie' ? 'Film' : 'Serie'}${a.requestId ? `, Anfrage #${a.requestId}` : ''}).${a.note ? `\n${a.note}` : ''}`,
        );
        result = 'Admin informiert';
        break;
      }
    }

    ctx.repo.setKv(kvKey, new Date().toISOString());
    ctx.repo.logAction(ctx.user.id, null, 'request_fix', { action: a.action, title: a.title, tmdbId: a.tmdbId, mediaType: a.mediaType });
    const notify = ensureTracked(ctx, { type: a.mediaType, tmdbId: a.tmdbId, title: a.title, requestId: a.requestId });
    return {
      ok: true,
      result,
      note: notify ? 'Der Nutzer wird automatisch benachrichtigt, sobald der Titel verfügbar ist.' : undefined,
    };
  },
});
