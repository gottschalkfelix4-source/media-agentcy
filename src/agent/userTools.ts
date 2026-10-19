import { z } from 'zod';
import { pingAll } from '../integrations/index.js';
import { MEDIA_STATUS, REQUEST_STATUS } from '../integrations/seerr.js';
import { titleScore } from '../integrations/http.js';
import { collectNew } from '../notifier/digest.js';
import { notifyAdmins, userLabel } from './context.js';
import { offTopic } from './abuse.js';
import { handToHermes, hermesAuto } from './hermes.js';
import { checkRequest, requestFix } from './requestTools.js';
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

const CONFIRM_TTL_MS = 2 * 3_600_000;
const confirmKey = (userId: number) => `media_confirm:${userId}`;

/** Titles whose cover the user was shown recently (key "movie:123", at = when it was sent). */
function shownCards(ctx: ToolContext): { key: string; at: number }[] {
  try {
    const list = JSON.parse(ctx.repo.getKv(confirmKey(ctx.user.id)) ?? '[]') as { key: string; at: number }[];
    return list.filter((c) => Date.now() - c.at < CONFIRM_TTL_MS);
  } catch {
    return [];
  }
}

const germanDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('.');

export const confirmMedia = defineTool({
  name: 'confirm_media',
  description:
    'Schickt dem Nutzer Cover, Titel und Erscheinungsdatum eines Suchtreffers als Bild, damit er bestätigen kann, dass es der richtige Titel ist. Pflicht vor request_media. Bei mehreren möglichen Treffern höchstens 3 nacheinander zeigen.',
  schema: z.object({ tmdbId: z.number().int(), mediaType }),
  async run({ tmdbId, mediaType }, ctx) {
    const { seerr, ombi } = ctx.services;
    const source = seerr ?? ombi;
    if (!source) throw new ToolError('Kein Anfragesystem (Jellyseerr/Ombi) konfiguriert.');
    if (ctx.turn.sent.filter((s) => s.startsWith('🖼️')).length >= 3) throw new ToolError('Schon 3 Cover gezeigt. Frag jetzt, welcher Titel gemeint ist.');
    const card = await source.card(mediaType, tmdbId);
    if (card.status === 5) return { alreadyAvailable: true, title: card.title, note: 'Der Titel ist schon auf dem Server. Sag das, statt anzufragen.' };

    const kind = mediaType === 'movie' ? 'Film' : card.seasons ? `Serie, ${card.seasons} ${card.seasons === 1 ? 'Staffel' : 'Staffeln'}` : 'Serie';
    const released = card.date && card.date.slice(0, 10) <= new Date().toISOString().slice(0, 10);
    const dateLine = card.date
      ? `📅 ${released ? (mediaType === 'movie' ? 'Erschienen' : 'Erstausstrahlung') : 'Erscheint'} am ${germanDate(card.date)}`
      : '📅 Erscheinungsdatum unbekannt';
    const overview = card.overview ? `\n\n${card.overview.length > 220 ? `${card.overview.slice(0, 220).trimEnd()}…` : card.overview}` : '';
    const caption = `${mediaType === 'movie' ? '🎬' : '📺'} *${card.title}* (${kind})\n${dateLine}${overview}`;

    if (!ctx.turn.quiet) {
      if (card.posterUrl && ctx.messenger.sendImage) {
        await ctx.messenger.sendImage(ctx.user, card.posterUrl, caption).catch(async (err: unknown) => {
          ctx.logger.warn({ err, tmdbId }, 'Cover konnte nicht gesendet werden, sende nur Text');
          await ctx.messenger.sendText(ctx.user, caption);
        });
      } else {
        await ctx.messenger.sendText(ctx.user, caption);
      }
    }
    ctx.turn.sent.push(`🖼️ ${caption}`);
    const key = `${mediaType}:${tmdbId}`;
    ctx.repo.setKv(confirmKey(ctx.user.id), JSON.stringify([...shownCards(ctx).filter((c) => c.key !== key), { key, at: Date.now() }].slice(-5)));
    return {
      sent: true,
      title: card.title,
      date: card.date,
      instruction:
        'Cover, Titel und Datum sind beim Nutzer. Frag jetzt in einem kurzen Satz, ob das der richtige Titel ist (Titel und Datum nicht wiederholen). request_media erst, wenn er in seiner nächsten Nachricht zustimmt. Sagt er nein: nach weiteren Details fragen oder den nächsten Treffer zeigen.',
    };
  },
});

export const requestMedia = defineTool({
  name: 'request_media',
  description:
    'Fragt einen Film/eine Serie im Namen des Nutzers an (Jellyseerr bevorzugt, sonst Ombi). Nur nach search_media und nachdem der Nutzer den Titel per confirm_media gesehen und bestätigt hat. Der Nutzer wird automatisch benachrichtigt, sobald der Titel verfügbar ist.',
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
    const key = `${mediaType}:${tmdbId}`;
    if (ctx.config.REQUEST_CONFIRM) {
      const shown = shownCards(ctx).find((c) => c.key === key);
      if (!shown) throw new ToolError('Erst confirm_media aufrufen: Der Nutzer muss Cover, Titel und Datum sehen und bestätigen, bevor angefragt wird.');
      if (shown.at >= ctx.turn.startedAt) {
        throw new ToolError('Der Nutzer hat das Cover gerade erst bekommen und noch nicht geantwortet. Frag, ob es der richtige Titel ist, und warte auf seine Antwort.');
      }
    }
    const forget = () => ctx.repo.setKv(confirmKey(ctx.user.id), JSON.stringify(shownCards(ctx).filter((c) => c.key !== key)));
    if (seerr) {
      try {
        const req = await seerr.request({ mediaType, tmdbId, seasons: seasons?.length ? seasons : 'all', asUserId: ctx.user.seerr_user_id ?? undefined });
        ctx.repo.addBotRequest({ user_id: ctx.user.id, source: 'seerr', external_id: String(req.id), tmdb_id: tmdbId, media_type: mediaType, title });
        ctx.repo.logAction(ctx.user.id, null, 'request_media', { tmdbId, mediaType, title, requestId: req.id });
        forget();
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
      forget();
      return { ok: true, message: res?.message ?? 'Angefragt über Ombi.' };
    }
    throw new ToolError('Kein Anfragesystem (Jellyseerr/Ombi) konfiguriert.');
  },
});

export const myRequests = defineTool({
  name: 'my_requests',
  description: 'Listet die Medienanfragen des Nutzers mit aktuellem Status. Für Details oder wenn eine Anfrage hängt: check_request.',
  schema: z.object({}),
  async run(_args, ctx) {
    const { seerr } = ctx.services;
    if (seerr && ctx.user.seerr_user_id) {
      const reqs = await seerr.userRequests(ctx.user.seerr_user_id, 15);
      return Promise.all(
        reqs.map(async (r) => ({
          title: await seerr.title(r.media.mediaType, r.media.tmdbId).catch(() => `TMDB ${r.media.tmdbId}`),
          type: r.media.mediaType,
          tmdbId: r.media.tmdbId,
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
        return { title: r.title, type: r.media_type, tmdbId: r.tmdb_id, requested: r.created_at.slice(0, 10), status };
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
    severity: z
      .enum(['low', 'normal', 'high', 'critical'])
      .describe('high = etwas Wichtiges geht für den Nutzer gar nicht mehr (Streaming, Login, App verbindet nicht); critical = betrifft vermutlich alle'),
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
    const hermes = hermesAuto(ctx.config, a.severity) ? await handToHermes(ctx, { ticket: ctx.repo.getTicket(ticket.id)! }) : undefined;
    const icon = { low: 'ℹ️', normal: '⚠️', high: '🚨', critical: '🔥' }[a.severity];
    const hermesLine = !hermes ? '' : hermes.ok ? '\n\n🤖 An Hermes übergeben – ich melde mich mit seinem Ergebnis.' : `\n\n⚠️ Übergabe an Hermes fehlgeschlagen: ${hermes.error}`;
    await notifyAdmins(
      ctx,
      `${icon} *Ticket #${ticket.id}* (${a.severity}) von ${userLabel(ctx.user)}\n\n*Problem:* ${a.summary}\n*Diagnose:* ${a.diagnosis}\n*Versucht:* ${a.triedSoFar}${hermesLine}\n\nAntworte mir hier, um es zu besprechen oder dem Nutzer etwas auszurichten.`,
    );
    if (hermes?.ok) {
      return {
        ok: true,
        ticketId: ticket.id,
        note: 'Admin ist informiert und die Technik schaut sich das jetzt direkt an. Sag dem Nutzer, dass sich jemand darum kümmert und er automatisch Bescheid bekommt, sobald es behoben ist.',
      };
    }
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

export const whatsNew = defineTool({
  name: 'whats_new',
  description: 'Was ist neu auf dem Server? Liefert die in den letzten Tagen hinzugefügten Filme und Serien(-folgen). Für Fragen wie "Was gibt es Neues?" oder Empfehlungen aus den Neuzugängen.',
  schema: z.object({ days: z.number().int().min(1).max(30).default(7) }),
  async run({ days }, ctx) {
    const n = await collectNew(ctx.services, days).catch((err: Error) => {
      throw new ToolError(err.message);
    });
    return { days, movies: n.movies.slice(0, 30), series: n.series.slice(0, 20), more: Math.max(0, n.movies.length - 30) + Math.max(0, n.series.length - 20) };
  },
});

export const setDigest = defineTool({
  name: 'set_digest',
  description: 'Wochenrückblick ("Neu auf dem Server", einmal pro Woche) für diesen Nutzer an- oder abbestellen, z.B. bei "Wochenrückblick aus".',
  schema: z.object({ enabled: z.boolean() }),
  async run({ enabled }, ctx) {
    ctx.repo.updateUser(ctx.user.id, { digest: enabled ? 1 : 0 });
    ctx.repo.logAction(ctx.user.id, null, 'digest_preference', { enabled });
    return { ok: true, enabled, digestActive: ctx.config.DIGEST_ENABLED };
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
  confirmMedia,
  requestMedia,
  myRequests,
  checkRequest,
  requestFix,
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
  whatsNew,
  setDigest,
  offTopic,
] as unknown as Tool[];
