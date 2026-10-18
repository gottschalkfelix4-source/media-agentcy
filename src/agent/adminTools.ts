import { z } from 'zod';
import type { User } from '../db/repo.js';
import { pingAll } from '../integrations/index.js';
import { userLabel } from './context.js';
import { defineTool, ToolError, type Tool, type ToolContext } from './tool.js';
import {
  checkDownloads,
  checkLibrary,
  diagnoseMedia,
  fixMedia,
  forgetFact,
  playbackInfo,
  rememberFact,
  requestMedia,
  searchMedia,
} from './userTools.js';

const userRef = z.string().describe('Nutzer: ID (#3), Telefonnummer oder Name');

function resolveUser(ctx: ToolContext, ref: string): User {
  const u = ctx.repo.findUser(ref);
  if (!u) throw new ToolError(`Kein Nutzer gefunden für "${ref}". Nutze list_users.`);
  return u;
}

function userOverview(u: User) {
  return {
    id: u.id,
    name: u.display_name ?? u.push_name,
    phone: u.wa_id,
    status: u.status,
    role: u.role,
    jellyfin: u.jellyfin_username,
    plex: u.plex_username,
    seerrUserId: u.seerr_user_id,
    ombi: u.ombi_username,
    lastSeen: u.last_seen_at,
  };
}

const listUsers = defineTool({
  name: 'list_users',
  description: 'Listet alle WhatsApp-Nutzer (optional nach Status gefiltert).',
  schema: z.object({ status: z.enum(['pending', 'active', 'blocked']).optional() }),
  async run({ status }, ctx) {
    return ctx.repo.listUsers(status).map(userOverview);
  },
});

const userDetails = defineTool({
  name: 'user_details',
  description: 'Alles über einen Nutzer: Profil, Gedächtnis (Fakten + Zusammenfassung), Tickets, Anfragen, letzte Nachrichten.',
  schema: z.object({ user: userRef }),
  async run({ user }, ctx) {
    const u = resolveUser(ctx, user);
    return {
      profile: userOverview(u),
      summary: u.summary,
      facts: ctx.repo.listFacts(u.id).map((f) => ({ id: f.id, fact: f.fact })),
      tickets: ctx.repo.listTickets({ userId: u.id, limit: 5 }).map((t) => ({ id: t.id, title: t.title, status: t.status })),
      requests: ctx.repo.botRequestsForUser(u.id, 5).map((r) => ({ title: r.title, at: r.created_at, available: !!r.notified_at })),
      recentMessages: ctx.repo.recentMessages(u.id, 10).map((m) => `${m.role}: ${m.content.slice(0, 200)}`),
    };
  },
});

const setUserStatus = defineTool({
  name: 'set_user_status',
  description: 'Schaltet einen Nutzer frei (active), sperrt ihn (blocked) oder setzt ihn auf pending. Bei Freischaltung bekommt der Nutzer eine Begrüßung.',
  schema: z.object({
    user: userRef,
    status: z.enum(['active', 'blocked', 'pending']),
    displayName: z.string().optional(),
  }),
  async run({ user, status, displayName }, ctx) {
    const u = resolveUser(ctx, user);
    if (u.role === 'admin' && status !== 'active') throw new ToolError('Admins können nicht gesperrt werden.');
    ctx.repo.updateUser(u.id, { status, ...(displayName ? { display_name: displayName } : {}) });
    if (status === 'active' && u.status !== 'active') {
      ctx.dispatchEvent(
        u.id,
        `Der Admin hat dich gerade freigeschaltet. Begrüße den Nutzer kurz${displayName ? ` (Name: ${displayName})` : ''}, stell dich vor und erkläre in 2-3 Sätzen, wobei du helfen kannst (Filme/Serien anfragen, Probleme melden, Benachrichtigung wenn Anfragen fertig sind). Beantworte ggf. auch seine erste Nachricht aus dem Verlauf.`,
      );
    }
    return { ok: true, user: userLabel(ctx.repo.getUser(u.id)!) };
  },
});

const linkUser = defineTool({
  name: 'link_user',
  description:
    'Verknüpft einen WhatsApp-Nutzer mit seinen Konten (Jellyfin-/Plex-Benutzername, Jellyseerr-User-ID, Ombi-Name). Jellyfin-ID und Seerr-ID werden automatisch über den Namen gesucht.',
  schema: z.object({
    user: userRef,
    displayName: z.string().optional(),
    jellyfinUsername: z.string().optional(),
    plexUsername: z.string().optional(),
    seerrUserId: z.number().int().optional(),
    ombiUsername: z.string().optional(),
  }),
  async run(a, ctx) {
    const u = resolveUser(ctx, a.user);
    const patch: Parameters<typeof ctx.repo.updateUser>[1] = {};
    const notes: string[] = [];
    if (a.displayName) patch.display_name = a.displayName;
    if (a.plexUsername) patch.plex_username = a.plexUsername;
    if (a.ombiUsername) patch.ombi_username = a.ombiUsername;
    if (a.jellyfinUsername) {
      patch.jellyfin_username = a.jellyfinUsername;
      if (ctx.services.jellyfin) {
        const jf = (await ctx.services.jellyfin.users()).find((x) => x.name.toLowerCase() === a.jellyfinUsername!.toLowerCase());
        if (jf) patch.jellyfin_user_id = jf.id;
        else notes.push(`Jellyfin-User "${a.jellyfinUsername}" nicht gefunden`);
      }
    }
    if (a.seerrUserId) patch.seerr_user_id = a.seerrUserId;
    else if (ctx.services.seerr && (a.jellyfinUsername || a.plexUsername)) {
      const su = await ctx.services.seerr.findUserByName((a.jellyfinUsername ?? a.plexUsername)!);
      if (su) patch.seerr_user_id = su.id;
      else notes.push('Kein passender Jellyseerr-User gefunden');
    }
    ctx.repo.updateUser(u.id, patch);
    return { ok: true, user: userOverview(ctx.repo.getUser(u.id)!), notes };
  },
});

const listMediaAccounts = defineTool({
  name: 'list_media_accounts',
  description: 'Listet die Konten in Jellyfin und Jellyseerr (hilfreich zum Verknüpfen von Nutzern).',
  schema: z.object({}),
  async run(_a, ctx) {
    const { jellyfin, seerr } = ctx.services;
    return {
      jellyfin: jellyfin ? await jellyfin.users().catch((e: Error) => e.message) : undefined,
      seerr: seerr
        ? await seerr
            .users()
            .then((us) => us.map((x) => ({ id: x.id, name: x.displayName, jellyfin: x.jellyfinUsername, plex: x.plexUsername, email: x.email })))
            .catch((e: Error) => e.message)
        : undefined,
    };
  },
});

const listTickets = defineTool({
  name: 'list_tickets',
  description: 'Listet Tickets. Standard: alle offenen (open, auto_fixing, escalated).',
  schema: z.object({
    status: z.array(z.enum(['open', 'auto_fixing', 'escalated', 'resolved', 'closed'])).optional(),
    user: userRef.optional(),
  }),
  async run({ status, user }, ctx) {
    const u = user ? resolveUser(ctx, user) : undefined;
    return ctx.repo.listTickets({ statuses: status ?? ['open', 'auto_fixing', 'escalated'], userId: u?.id, limit: 30 }).map((t) => ({
      id: t.id,
      user: userLabel(ctx.repo.getUser(t.user_id)!),
      title: t.title,
      status: t.status,
      severity: t.severity,
      created: t.created_at,
    }));
  },
});

const ticketDetails = defineTool({
  name: 'ticket_details',
  description: 'Vollständige Details eines Tickets inkl. Diagnose und Aktionsverlauf.',
  schema: z.object({ ticketId: z.number().int() }),
  async run({ ticketId }, ctx) {
    const t = ctx.repo.getTicket(ticketId);
    if (!t) throw new ToolError('Ticket nicht gefunden');
    return { ...t, actions: JSON.parse(t.actions), media_ref: t.media_ref ? JSON.parse(t.media_ref) : null, user: userLabel(ctx.repo.getUser(t.user_id)!) };
  },
});

const updateTicket = defineTool({
  name: 'update_ticket',
  description: 'Ändert Status/Schwere eines Tickets oder fügt eine Notiz hinzu (ohne den Nutzer zu benachrichtigen).',
  schema: z.object({
    ticketId: z.number().int(),
    status: z.enum(['open', 'auto_fixing', 'escalated', 'resolved', 'closed']).optional(),
    severity: z.enum(['low', 'normal', 'high', 'critical']).optional(),
    note: z.string().optional(),
  }),
  async run({ ticketId, status, severity, note }, ctx) {
    if (!ctx.repo.getTicket(ticketId)) throw new ToolError('Ticket nicht gefunden');
    ctx.repo.updateTicket(ticketId, { ...(status ? { status } : {}), ...(severity ? { severity } : {}) });
    if (note) ctx.repo.appendTicketAction(ticketId, 'admin_note', note);
    return { ok: true };
  },
});

const resolveTicket = defineTool({
  name: 'resolve_ticket',
  description: 'Schließt ein Ticket als gelöst. Optional wird der Nutzer informiert (der Bot formuliert die Nachricht).',
  schema: z.object({
    ticketId: z.number().int(),
    resolution: z.string().describe('Was war die Lösung'),
    notifyUser: z.boolean().default(true),
    messageToUser: z.string().optional().describe('Zusätzlicher Hinweis des Admins an den Nutzer'),
  }),
  async run({ ticketId, resolution, notifyUser, messageToUser }, ctx) {
    const t = ctx.repo.getTicket(ticketId);
    if (!t) throw new ToolError('Ticket nicht gefunden');
    ctx.repo.updateTicket(ticketId, { status: 'resolved', resolution });
    ctx.repo.closeWatchesForTicket(ticketId);
    if (notifyUser) {
      ctx.dispatchEvent(
        t.user_id,
        `Dein Problem-Ticket #${t.id} ("${t.title}") wurde vom Admin gelöst. Lösung: ${resolution}.${messageToUser ? ` Hinweis vom Admin: ${messageToUser}` : ''} Informiere den Nutzer kurz und frag, ob jetzt alles klappt.`,
      );
    }
    return { ok: true, userNotified: notifyUser };
  },
});

const messageUser = defineTool({
  name: 'message_user',
  description:
    'Schickt einem Nutzer eine Nachricht. verbatim=true: exakt dieser Text. verbatim=false: der Bot formuliert die Info im Gespräch mit dem Nutzer selbst (empfohlen).',
  schema: z.object({ user: userRef, message: z.string(), verbatim: z.boolean().default(false) }),
  async run({ user, message, verbatim }, ctx) {
    const u = resolveUser(ctx, user);
    if (u.status !== 'active') throw new ToolError(`Nutzer ist ${u.status}`);
    if (verbatim) {
      await ctx.messenger.sendText(u, message);
      ctx.repo.addMessage(u.id, 'assistant', message);
    } else {
      ctx.dispatchEvent(u.id, `Der Admin (${ctx.config.ADMIN_NAME}) möchte dem Nutzer Folgendes mitteilen: "${message}". Richte es freundlich in deinem Stil aus.`);
    }
    return { ok: true, to: userLabel(u) };
  },
});

const broadcast = defineTool({
  name: 'broadcast',
  description: 'Schickt eine Nachricht wörtlich an ALLE aktiven Nutzer (z.B. Wartungsankündigung). Nur mit confirm=true, nachdem der Admin den Text bestätigt hat.',
  schema: z.object({ message: z.string(), confirm: z.boolean() }),
  async run({ message, confirm }, ctx) {
    if (!confirm) return { ok: false, note: 'Bitte Text vom Admin bestätigen lassen und mit confirm=true erneut aufrufen.' };
    const users = ctx.repo.listUsers('active').filter((u) => u.role !== 'admin');
    let sent = 0;
    for (const u of users) {
      try {
        await ctx.messenger.sendText(u, message);
        ctx.repo.addMessage(u.id, 'assistant', message);
        sent++;
      } catch (err) {
        ctx.logger.warn({ err, user: u.id }, 'Broadcast fehlgeschlagen');
      }
    }
    return { ok: true, sent, total: users.length };
  },
});

const rememberAboutUser = defineTool({
  name: 'remember_about_user',
  description: 'Speichert einen Fakt im Gedächtnis eines bestimmten Nutzers (z.B. "zahlt nicht mehr", "nutzt Fire TV Stick").',
  schema: z.object({ user: userRef, fact: z.string().max(300) }),
  async run({ user, fact }, ctx) {
    const u = resolveUser(ctx, user);
    return { ok: true, factId: ctx.repo.addFact(u.id, fact, 'admin') };
  },
});

const forgetUserFact = defineTool({
  name: 'forget_user_fact',
  description: 'Löscht einen Fakt aus dem Gedächtnis eines Nutzers.',
  schema: z.object({ user: userRef, factId: z.number().int() }),
  async run({ user, factId }, ctx) {
    const u = resolveUser(ctx, user);
    return { ok: ctx.repo.deleteFact(u.id, factId) };
  },
});

const userPlayback = defineTool({
  name: 'user_playback',
  description: 'Wiedergabe-Sessions und Jellyfin-Aktivitäten eines bestimmten Nutzers.',
  schema: z.object({ user: userRef }),
  async run({ user }, ctx) {
    const u = resolveUser(ctx, user);
    return playbackInfo(ctx, u.jellyfin_user_id, u.plex_username);
  },
});

const systemHealth = defineTool({
  name: 'system_health',
  description: 'Gesamtzustand: Erreichbarkeit aller Dienste, Radarr/Sonarr Health-Warnungen, Speicherplatz, Jellyfin Updates/Neustart.',
  schema: z.object({}),
  async run(_a, ctx) {
    const { radarr, sonarr, jellyfin } = ctx.services;
    const wrap = async <T>(fn: () => Promise<T>) => fn().catch((e: Error) => e.message);
    return {
      services: await pingAll(ctx.services),
      radarrHealth: radarr ? await wrap(() => radarr.health()) : undefined,
      sonarrHealth: sonarr ? await wrap(() => sonarr.health()) : undefined,
      diskSpace: radarr ? await wrap(() => radarr.diskSpace()) : sonarr ? await wrap(() => sonarr.diskSpace()) : undefined,
      jellyfin: jellyfin
        ? await wrap(async () => {
            const i = await jellyfin.systemInfo();
            return { version: i.Version, pendingRestart: i.HasPendingRestart, updateAvailable: i.HasUpdateAvailable };
          })
        : undefined,
    };
  },
});

const serverActivity = defineTool({
  name: 'server_activity',
  description: 'Letzte Einträge im Jellyfin-Aktivitätsprotokoll (Logins, Wiedergaben, Fehler) serverweit.',
  schema: z.object({ limit: z.number().int().max(100).default(30) }),
  async run({ limit }, ctx) {
    if (!ctx.services.jellyfin) throw new ToolError('Jellyfin nicht konfiguriert');
    return ctx.services.jellyfin.activity({ limit });
  },
});

export const adminTools: Tool[] = [
  // shared media tools (run without per-user limits for admins)
  searchMedia,
  requestMedia,
  checkLibrary,
  diagnoseMedia,
  checkDownloads,
  fixMedia,
  rememberFact,
  forgetFact,
  // admin only
  listUsers,
  userDetails,
  setUserStatus,
  linkUser,
  listMediaAccounts,
  listTickets,
  ticketDetails,
  updateTicket,
  resolveTicket,
  messageUser,
  broadcast,
  rememberAboutUser,
  forgetUserFact,
  userPlayback,
  systemHealth,
  serverActivity,
] as unknown as Tool[];
