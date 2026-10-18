import { z } from 'zod';
import { pingAll } from '../integrations/index.js';
import { MEDIA_STATUS, REQUEST_STATUS } from '../integrations/seerr.js';
import { titleScore } from '../integrations/http.js';
import { notifyAdmins, userLabel } from './context.js';
import { defineTool, ToolError, type Tool, type ToolContext } from './tool.js';

const mediaType = z.enum(['movie', 'tv']).describe('movie = Film, tv = Serie');

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ---------------------------------------------------------------- requests

export const searchMedia = defineTool({
  name: 'search_media',
  description:
    'Sucht Filme/Serien (TMDB über Jellyseerr/Ombi) und zeigt, ob sie schon auf dem Server verfügbar oder angefragt sind. Immer vor request_media verwenden.',
  schema: z.object({
    query: z.string().describe('Titel, ggf. mit Jahr'),
    type: mediaType.optional(),
  }),
  async run({ query, type }, ctx) {
    const { seerr, ombi, jellyfin, plex } = ctx.services;
    let results: { tmdbId: number; mediaType: 'movie' | 'tv'; title: string; status: string }[] | undefined;
    if (seerr) results = await seerr.search(query);
    else if (ombi) results = await ombi.search(query);
    if (results) return { results: type ? results.filter((r) => r.mediaType === type) : results };

    // No request system configured: at least check the libraries.
    return {
      note: 'Kein Anfragesystem konfiguriert – nur Bibliothekssuche möglich.',
      jellyfin: jellyfin ? await safe(() => jellyfin.search(query, 'Movie,Series')) : undefined,
      plex: plex ? await safe(() => plex.search(query)) : undefined,
    };
  },
});

export const requestMedia = defineTool({
  name: 'request_media',
  description:
    'Fragt einen Film/eine Serie im Namen des Nutzers an (Jellyseerr bevorzugt, sonst Ombi). Nur nach search_media und wenn klar ist, welcher Titel gemeint ist. Der Nutzer wird automatisch benachrichtigt, sobald der Titel verfügbar ist.',
  schema: z.object({
    tmdbId: z.number().int(),
    mediaType,
    title: z.string().describe('Titel für Benachrichtigungen'),
    seasons: z.array(z.number().int().positive()).optional().describe('Nur bei Serien: bestimmte Staffeln. Weglassen = alle Staffeln.'),
  }),
  async run({ tmdbId, mediaType, title, seasons }, ctx) {
    const { seerr, ombi } = ctx.services;
    if (!ctx.isAdmin) {
      const today = ctx.repo.countActionsSince(ctx.user.id, 'request_media', '-1 day');
      if (today >= ctx.config.REQUESTS_PER_DAY) {
        throw new ToolError(`Tageslimit von ${ctx.config.REQUESTS_PER_DAY} Anfragen erreicht. Morgen geht wieder was – oder der Admin hilft.`);
      }
    }
    if (seerr) {
      try {
        const req = await seerr.request({ mediaType, tmdbId, seasons: seasons?.length ? seasons : 'all', asUserId: ctx.user.seerr_user_id ?? undefined });
        ctx.repo.addBotRequest({ user_id: ctx.user.id, source: 'seerr', external_id: String(req.id), tmdb_id: tmdbId, media_type: mediaType, title });
        ctx.repo.logAction(ctx.user.id, null, 'request_media', { tmdbId, mediaType, title, requestId: req.id });
        return {
          ok: true,
          requestId: req.id,
          status: REQUEST_STATUS[req.status] ?? req.status,
          note: req.status === 1 ? 'Anfrage muss noch vom Admin freigegeben werden.' : 'Anfrage freigegeben, Download startet automatisch.',
        };
      } catch (err) {
        const msg = (err as Error).message;
        if (/409|already|bereits/i.test(msg)) return { ok: false, reason: 'Dieser Titel wurde bereits angefragt oder ist schon vorhanden.' };
        throw err;
      }
    }
    if (ombi) {
      const res = await ombi.request({ mediaType, tmdbId, asUserName: ctx.user.ombi_username ?? ctx.user.jellyfin_username ?? undefined });
      ctx.repo.addBotRequest({
        user_id: ctx.user.id,
        source: 'ombi',
        external_id: res?.requestId ? String(res.requestId) : null,
        tmdb_id: tmdbId,
        media_type: mediaType,
        title,
      });
      ctx.repo.logAction(ctx.user.id, null, 'request_media', { tmdbId, mediaType, title, via: 'ombi' });
      return { ok: true, message: res?.message ?? 'Angefragt über Ombi.' };
    }
    throw new ToolError('Kein Anfragesystem (Jellyseerr/Ombi) konfiguriert.');
  },
});

export const myRequests = defineTool({
  name: 'my_requests',
  description: 'Listet die Medienanfragen des Nutzers mit aktuellem Status.',
  schema: z.object({}),
  async run(_args, ctx) {
    const { seerr } = ctx.services;
    if (seerr && ctx.user.seerr_user_id) {
      const reqs = await seerr.userRequests(ctx.user.seerr_user_id, 15);
      return Promise.all(
        reqs.map(async (r) => ({
          title: await seerr.title(r.media.mediaType, r.media.tmdbId).catch(() => `TMDB ${r.media.tmdbId}`),
          type: r.media.mediaType,
          requested: r.createdAt.slice(0, 10),
          request: REQUEST_STATUS[r.status] ?? r.status,
          media: MEDIA_STATUS[r.media.status] ?? r.media.status,
        })),
      );
    }
    const own = ctx.repo.botRequestsForUser(ctx.user.id, 15);
    return Promise.all(
      own.map(async (r) => {
        let status = r.notified_at ? 'verfügbar' : 'angefragt';
        if (!r.notified_at && seerr && r.tmdb_id) {
          const d = await seerr.details(r.media_type, r.tmdb_id).catch(() => undefined);
          if (d?.mediaInfo) status = MEDIA_STATUS[d.mediaInfo.status] ?? status;
        }
        return { title: r.title, type: r.media_type, requested: r.created_at.slice(0, 10), status };
      }),
    );
  },
});

export const checkLibrary = defineTool({
  name: 'check_library',
  description: 'Sucht direkt in den Bibliotheken von Jellyfin und Plex, ob ein Titel vorhanden ist (inkl. Item-IDs für Diagnose/Refresh).',
  schema: z.object({ query: z.string() }),
  async run({ query }, ctx) {
    const { jellyfin, plex } = ctx.services;
    return {
      jellyfin: jellyfin ? await safe(() => jellyfin.search(query)) : 'nicht konfiguriert',
      plex: plex ? await safe(() => plex.search(query)) : 'nicht konfiguriert',
    };
  },
});

// ---------------------------------------------------------------- problems

export const reportProblem = defineTool({
  name: 'report_problem',
  description:
    'Legt ein Ticket für ein gemeldetes Problem an. Immer aufrufen, sobald klar ist, worum es geht – noch vor Diagnose oder Fix.',
  schema: z.object({
    title: z.string().describe('Kurzer Titel, z.B. "Dune bricht nach 20 Min ab"'),
    description: z.string().describe('Was der Nutzer beschreibt, inkl. Gerät/App/Fehlermeldung'),
    category: z.enum(['playback', 'missing_media', 'quality', 'audio_subtitles', 'metadata', 'download', 'account', 'server', 'other']),
    severity: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
    media: z
      .object({
        title: z.string(),
        type: mediaType,
        season: z.number().int().optional(),
        episode: z.number().int().optional(),
      })
      .optional(),
  }),
  async run({ title, description, category, severity, media }, ctx) {
    const t = ctx.repo.createTicket({ user_id: ctx.user.id, title, description, category, severity, media_ref: media });
    return { ticketId: t.id, status: t.status };
  },
});

export const diagnoseMedia = defineTool({
  name: 'diagnose_media',
  description:
    'Prüft einen Titel technisch: Status in Radarr/Sonarr (Datei vorhanden, Qualität, Sprachen, Codecs), laufende Downloads, Download-Historie (Fehler) und den Eintrag in Jellyfin/Plex. Liefert IDs für fix_media.',
  schema: z.object({
    type: mediaType,
    title: z.string().optional(),
    tmdbId: z.number().int().optional(),
    season: z.number().int().optional(),
    episode: z.number().int().optional(),
  }),
  async run({ type, title, tmdbId, season, episode }, ctx) {
    const { radarr, sonarr, jellyfin, plex } = ctx.services;
    if (!title && !tmdbId) throw new ToolError('title oder tmdbId angeben');
    const out: Record<string, unknown> = {};

    if (type === 'movie') {
      if (!radarr) out.radarr = 'nicht konfiguriert';
      else {
        const matches = await radarr.find({ title, tmdbId });
        if (!matches.length) out.radarr = 'Film nicht in Radarr gefunden (nie angefragt/heruntergeladen?)';
        else {
          const m = matches[0];
          out.radarr = {
            ...m,
            otherMatches: matches.slice(1).map((x) => `${x.title} (${x.year}) id=${x.radarrId}`),
            queue: await safe(() => radarr.queue(m.radarrId)),
            history: await safe(() => radarr.history(m.radarrId)),
          };
        }
      }
    } else {
      if (!sonarr) out.sonarr = 'nicht konfiguriert';
      else {
        const matches = await sonarr.find({ title, tmdbId });
        if (!matches.length) out.sonarr = 'Serie nicht in Sonarr gefunden';
        else {
          const s = matches[0];
          out.sonarr = {
            ...s,
            otherMatches: matches.slice(1).map((x) => `${x.title} (${x.year}) id=${x.sonarrId}`),
            episodes: season !== undefined ? await safe(() => sonarr.episodeDetails(s.sonarrId, season, episode)) : undefined,
            queue: await safe(() => sonarr.queue(s.sonarrId)),
            history: await safe(() => sonarr.history(s.sonarrId)),
          };
        }
      }
    }

    const q = title ?? '';
    if (jellyfin && q) {
      out.jellyfin = await safe(async () => {
        const hits = (await jellyfin.search(q, type === 'movie' ? 'Movie' : 'Series', 3)).filter((h) => titleScore(q, h.name) >= 0.5);
        if (!hits.length) return 'nicht in Jellyfin-Bibliothek gefunden';
        if (type === 'movie') return jellyfin.item(hits[0].id);
        const eps = season !== undefined ? await jellyfin.episodes(hits[0].id, season) : undefined;
        const ep = episode !== undefined ? eps?.find((e) => e.name.includes(`E${episode} `)) : undefined;
        return { series: hits[0], episode: ep ? await jellyfin.item(ep.id) : undefined, episodesInSeason: eps?.length };
      });
    }
    if (plex && q) {
      out.plex = await safe(async () => {
        const hits = (await plex.search(q, 5)).filter((h) => h.type === (type === 'movie' ? 'movie' : 'show') && titleScore(q, h.name) >= 0.5);
        if (!hits.length) return 'nicht in Plex-Bibliothek gefunden';
        return type === 'movie' ? plex.item(hits[0].ratingKey) : hits[0];
      });
    }
    return out;
  },
});

export const checkPlayback = defineTool({
  name: 'check_playback',
  description:
    'Zeigt die aktuellen/letzten Wiedergabe-Sessions des Nutzers (Gerät, App, Direct Play vs. Transcoding + Gründe) und die letzten Jellyfin-Aktivitäten/Fehler. Hilfreich bei Ruckeln, Abbrüchen, "geht nicht".',
  schema: z.object({}),
  async run(_args, ctx) {
    return playbackInfo(ctx, ctx.user.jellyfin_user_id, ctx.user.plex_username);
  },
});

export async function playbackInfo(ctx: ToolContext, jellyfinUserId: string | null, plexUsername: string | null) {
  const { jellyfin, plex } = ctx.services;
  const out: Record<string, unknown> = {};
  if (jellyfin) {
    if (!jellyfinUserId) out.jellyfin = 'Nutzer ist nicht mit einem Jellyfin-Konto verknüpft (Admin muss link_user ausführen).';
    else {
      out.jellyfinSessions = await safe(() => jellyfin.sessions(jellyfinUserId));
      out.jellyfinActivity = await safe(() => jellyfin.activity({ userId: jellyfinUserId, limit: 40 }).then((a) => a.slice(0, 12)));
    }
  }
  if (plex) {
    out.plexSessions = plexUsername ? await safe(() => plex.sessions(plexUsername)) : 'kein Plex-Benutzername verknüpft';
  }
  return out;
}

export const checkDownloads = defineTool({
  name: 'check_downloads',
  description: 'Zeigt laufende Downloads (Radarr/Sonarr-Warteschlange) mit Fortschritt, Restzeit und Problemen. Optional nach Titel filtern.',
  schema: z.object({ title: z.string().optional() }),
  async run({ title }, ctx) {
    const { radarr, sonarr } = ctx.services;
    const filter = <T extends { title: string }>(items: T[]) => (title ? items.filter((i) => titleScore(title, i.title) >= 0.3) : items).slice(0, 15);
    return {
      movies: radarr ? await safe(async () => filter(await radarr.queue())) : undefined,
      series: sonarr ? await safe(async () => filter(await sonarr.queue())) : undefined,
    };
  },
});

export const fixMedia = defineTool({
  name: 'fix_media',
  description: `Behebt Medienprobleme automatisch. IDs vorher per diagnose_media/check_library holen.
- replace_file: aktuelle Datei löschen und neue Version suchen (defekte Datei, Abbrüche, falsche Sprache, Ton asynchron, sehr schlechte Qualität). Nur EINMAL pro Ticket.
- search_missing: fehlende Datei/Folgen suchen lassen.
- rescan: Radarr/Sonarr + Mediaserver-Bibliothek neu einlesen (Titel fehlt in App obwohl Datei da).
- refresh_metadata: Metadaten/Poster in Jellyfin/Plex neu laden (falsches Bild/Titel/Beschreibung).`,
  schema: z.object({
    ticketId: z.number().int().optional().describe('Pflicht für normale Nutzer'),
    action: z.enum(['replace_file', 'search_missing', 'rescan', 'refresh_metadata']),
    type: mediaType,
    arrId: z.number().int().optional().describe('radarrId bzw. sonarrId'),
    episodeIds: z.array(z.number().int()).max(30).optional().describe('Sonarr episodeIds (für Folgen)'),
    season: z.number().int().optional(),
    jellyfinItemId: z.string().optional(),
    plexRatingKey: z.string().optional(),
    label: z.string().describe('Menschlich lesbarer Titel, z.B. "Dune (2021)" oder "The Office S03E05"'),
    reason: z.string().describe('Warum diese Aktion'),
  }),
  async run(a, ctx) {
    const { radarr, sonarr, jellyfin, plex } = ctx.services;
    const ticket = a.ticketId ? ctx.repo.getTicket(a.ticketId) : undefined;
    if (!ctx.isAdmin) {
      if (!ticket || ticket.user_id !== ctx.user.id) throw new ToolError('Für Nutzer ist eine gültige ticketId (eigenes Ticket) Pflicht. Erst report_problem.');
    }

    let result: unknown;
    switch (a.action) {
      case 'replace_file': {
        if (!ctx.isAdmin) {
          if (!ctx.config.AUTOFIX_REPLACE_FILE) throw new ToolError('Automatisches Ersetzen ist deaktiviert – bitte an den Admin eskalieren.');
          const prev = JSON.parse(ticket!.actions) as { action: string }[];
          if (prev.some((p) => p.action.startsWith('replace_file'))) {
            throw new ToolError('Für dieses Ticket wurde die Datei bereits ersetzt. Bitte an den Admin eskalieren statt erneut zu ersetzen.');
          }
          const n = ctx.repo.countActionsSince(ctx.user.id, 'replace_file', '-1 day');
          if (n >= ctx.config.AUTOFIX_MAX_REPLACEMENTS_PER_DAY) throw new ToolError('Tageslimit für automatische Ersetzungen erreicht – bitte an den Admin eskalieren.');
        }
        if (!a.arrId) throw new ToolError('arrId fehlt');
        if (a.type === 'movie') {
          if (!radarr) throw new ToolError('Radarr nicht konfiguriert');
          result = await radarr.replaceFile(a.arrId);
          ctx.repo.addWatch({ user_id: ctx.user.id, ticket_id: ticket?.id ?? null, kind: 'radarr_movie', ref: { movieId: a.arrId }, label: a.label });
        } else {
          if (!sonarr) throw new ToolError('Sonarr nicht konfiguriert');
          if (!a.episodeIds?.length) throw new ToolError('episodeIds angeben (welche Folgen ersetzt werden sollen)');
          result = await sonarr.replaceEpisodeFiles(a.arrId, a.episodeIds);
          ctx.repo.addWatch({
            user_id: ctx.user.id,
            ticket_id: ticket?.id ?? null,
            kind: 'sonarr_episodes',
            ref: { seriesId: a.arrId, episodeIds: a.episodeIds },
            label: a.label,
          });
        }
        break;
      }
      case 'search_missing': {
        if (!a.arrId) throw new ToolError('arrId fehlt');
        if (a.type === 'movie') {
          if (!radarr) throw new ToolError('Radarr nicht konfiguriert');
          result = await radarr.search(a.arrId);
          ctx.repo.addWatch({ user_id: ctx.user.id, ticket_id: ticket?.id ?? null, kind: 'radarr_movie', ref: { movieId: a.arrId }, label: a.label });
        } else {
          if (!sonarr) throw new ToolError('Sonarr nicht konfiguriert');
          if (a.episodeIds?.length) {
            result = await sonarr.searchEpisodes(a.episodeIds);
            ctx.repo.addWatch({
              user_id: ctx.user.id,
              ticket_id: ticket?.id ?? null,
              kind: 'sonarr_episodes',
              ref: { seriesId: a.arrId, episodeIds: a.episodeIds },
              label: a.label,
            });
          } else if (a.season !== undefined) result = await sonarr.searchSeason(a.arrId, a.season);
          else result = await sonarr.searchSeries(a.arrId);
        }
        break;
      }
      case 'rescan': {
        const r: Record<string, unknown> = {};
        if (a.arrId && a.type === 'movie' && radarr) r.radarr = await safe(() => radarr.rescan(a.arrId!));
        if (a.arrId && a.type === 'tv' && sonarr) r.sonarr = await safe(() => sonarr.rescan(a.arrId!));
        if (jellyfin) r.jellyfin = await safe(() => (a.jellyfinItemId ? jellyfin.refreshItem(a.jellyfinItemId) : jellyfin.scanLibrary()));
        if (plex) r.plex = await safe(() => plex.scanLibrary());
        result = r;
        break;
      }
      case 'refresh_metadata': {
        const r: Record<string, unknown> = {};
        if (a.jellyfinItemId && jellyfin) r.jellyfin = await safe(() => jellyfin.refreshItem(a.jellyfinItemId!));
        if (a.plexRatingKey && plex) r.plex = await safe(() => plex.refreshItem(a.plexRatingKey!));
        if (a.arrId && a.type === 'movie' && radarr) r.radarr = await safe(() => radarr.refresh(a.arrId!));
        if (a.arrId && a.type === 'tv' && sonarr) r.sonarr = await safe(() => sonarr.refresh(a.arrId!));
        if (!Object.keys(r).length) throw new ToolError('Keine Item-ID angegeben (jellyfinItemId/plexRatingKey/arrId).');
        result = r;
        break;
      }
    }

    ctx.repo.logAction(ctx.user.id, ticket?.id ?? null, a.action, { label: a.label, reason: a.reason, arrId: a.arrId });
    if (ticket) {
      ctx.repo.appendTicketAction(ticket.id, `${a.action}: ${a.label}`, a.reason);
      if (a.action === 'replace_file' || a.action === 'search_missing') ctx.repo.updateTicket(ticket.id, { status: 'auto_fixing' });
    }
    if (!ctx.isAdmin && ctx.config.ADMIN_NOTIFY_AUTOFIX && a.action === 'replace_file') {
      void notifyAdmins(
        ctx,
        `🔧 *Auto-Fix* für ${userLabel(ctx.user)}${ticket ? ` (Ticket #${ticket.id})` : ''}\n${a.label}: Datei wird ersetzt.\nGrund: ${a.reason}`,
      );
    }
    return {
      ok: true,
      result,
      note:
        a.action === 'replace_file' || a.action === 'search_missing'
          ? 'Suche läuft. Der Nutzer wird automatisch benachrichtigt, sobald eine neue Datei da ist.'
          : undefined,
    };
  },
});

export const escalateToAdmin = defineTool({
  name: 'escalate_to_admin',
  description:
    'Meldet ein Problem an den Admin, wenn du es nicht selbst lösen kannst oder darfst (Server down, viele Titel betroffen, Konto/Login, Fix fehlgeschlagen, unklare Ursache, Nutzer verlangt Admin).',
  schema: z.object({
    ticketId: z.number().int().optional(),
    summary: z.string().describe('Problem in 1-3 Sätzen'),
    diagnosis: z.string().describe('Was du herausgefunden hast (technisch, für den Admin)'),
    triedSoFar: z.string().describe('Was bereits versucht wurde'),
    severity: z.enum(['low', 'normal', 'high', 'critical']),
  }),
  async run(a, ctx) {
    let ticket = a.ticketId ? ctx.repo.getTicket(a.ticketId) : undefined;
    if (ticket && !ctx.isAdmin && ticket.user_id !== ctx.user.id) ticket = undefined;
    if (!ticket) {
      ticket = ctx.repo.createTicket({
        user_id: ctx.user.id,
        title: a.summary.slice(0, 80),
        description: a.summary,
        category: 'other',
        severity: a.severity,
      });
    }
    ctx.repo.updateTicket(ticket.id, { status: 'escalated', severity: a.severity, diagnosis: a.diagnosis });
    ctx.repo.appendTicketAction(ticket.id, 'escalated', a.triedSoFar);
    const icon = { low: 'ℹ️', normal: '⚠️', high: '🚨', critical: '🔥' }[a.severity];
    await notifyAdmins(
      ctx,
      `${icon} *Ticket #${ticket.id}* (${a.severity}) von ${userLabel(ctx.user)}\n\n*Problem:* ${a.summary}\n*Diagnose:* ${a.diagnosis}\n*Versucht:* ${a.triedSoFar}\n\nAntworte mir hier, um es zu besprechen oder dem Nutzer etwas auszurichten.`,
    );
    return { ok: true, ticketId: ticket.id, note: 'Admin ist informiert.' };
  },
});

export const myTickets = defineTool({
  name: 'my_tickets',
  description: 'Zeigt die letzten Tickets/Problemmeldungen des Nutzers mit Status.',
  schema: z.object({}),
  async run(_a, ctx) {
    return ctx.repo.listTickets({ userId: ctx.user.id, limit: 8 }).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      created: t.created_at,
      resolution: t.resolution,
    }));
  },
});

// ---------------------------------------------------------------- memory

export const rememberFact = defineTool({
  name: 'remember_fact',
  description:
    'Speichert eine dauerhafte Info über den Nutzer im Langzeitgedächtnis (z.B. Name, Geräte/Apps, Lieblingsgenres, bevorzugte Sprache/Untertitel, wiederkehrende Probleme). Keine Passwörter oder sensiblen Daten.',
  schema: z.object({ fact: z.string().max(300) }),
  async run({ fact }, ctx) {
    const existing = ctx.repo.listFacts(ctx.user.id);
    if (existing.some((f) => f.fact.toLowerCase() === fact.toLowerCase())) return { ok: true, note: 'schon bekannt' };
    if (existing.length >= 60) throw new ToolError('Gedächtnis voll – erst veraltete Fakten mit forget_fact löschen.');
    return { ok: true, factId: ctx.repo.addFact(ctx.user.id, fact) };
  },
});

export const forgetFact = defineTool({
  name: 'forget_fact',
  description: 'Löscht einen veralteten/falschen Fakt aus dem Gedächtnis (ID steht im Kontext).',
  schema: z.object({ factId: z.number().int() }),
  async run({ factId }, ctx) {
    return { ok: ctx.repo.deleteFact(ctx.user.id, factId) };
  },
});

export const serviceStatus = defineTool({
  name: 'service_status',
  description: 'Prüft, ob die Server-Dienste (Jellyfin, Plex, Anfragesystem, Downloader) erreichbar sind.',
  schema: z.object({}),
  async run(_a, ctx) {
    const res = await pingAll(ctx.services);
    if (ctx.isAdmin) return res;
    return Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.startsWith('ok') ? 'online' : 'gestört']));
  },
});

export const userTools: Tool[] = [
  searchMedia,
  requestMedia,
  myRequests,
  checkLibrary,
  reportProblem,
  diagnoseMedia,
  checkPlayback,
  checkDownloads,
  fixMedia,
  escalateToAdmin,
  myTickets,
  rememberFact,
  forgetFact,
  serviceStatus,
] as unknown as Tool[];
