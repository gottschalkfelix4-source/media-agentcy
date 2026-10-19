import { z } from 'zod';
import type { User } from '../db/repo.js';
import { pingAll } from '../integrations/index.js';
import { limitStatus, resetLimits } from './abuse.js';
import { userLabel } from './context.js';
import { onboardOnApproval, onboardUser, type OnboardResult } from './onboarding.js';
import { handToHermes, hermesAuto, hermesEnabled } from './hermes.js';
import { getOutage, setMaintenance } from '../notifier/outage.js';
import { collectNew, digestRecipients, digestText, sendDigest } from '../notifier/digest.js';
import { checkRequest, requestFix } from './requestTools.js';
import { defineTool, ToolError, type Tool, type ToolContext } from './tool.js';
import {
  checkDownloads,
  checkLibrary,
  diagnoseMedia,
  fixMedia,
  forgetFact,
  playbackInfo,
  rememberFact,
  confirmMedia,
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
      limits24h: limitStatus(ctx, u.id),
    };
  },
});

const resetUserLimits = defineTool({
  name: 'reset_user_limits',
  description: 'Hebt die Missbrauchs-Pause eines Nutzers auf (themenfremde Anfragen, Nachrichten- und Token-Tageslimit). Der Zähler beginnt neu.',
  schema: z.object({ user: userRef }),
  async run({ user }, ctx) {
    const u = resolveUser(ctx, user);
    resetLimits(ctx, u.id);
    return { ok: true, user: userLabel(u), limits: limitStatus(ctx, u.id) };
  },
});

const setUserStatus = defineTool({
  name: 'set_user_status',
  description:
    'Schaltet einen Nutzer frei (active), sperrt ihn (blocked) oder setzt ihn auf pending. Bei Freischaltung bekommt der Nutzer eine Begrüßung und – wenn eingestellt oder createAccount=true – automatisch ein Jellyfin-Konto samt Zugangsdaten.',
  schema: z.object({
    user: userRef,
    status: z.enum(['active', 'blocked', 'pending']),
    displayName: z.string().optional(),
    createAccount: z.boolean().optional().describe('Jellyfin-Konto anlegen (überschreibt die Einstellung). Weglassen = Einstellung "Neue Nutzer".'),
  }),
  async run({ user, status, displayName, createAccount }, ctx) {
    const u = resolveUser(ctx, user);
    if (u.role === 'admin' && status !== 'active') throw new ToolError('Admins können nicht gesperrt werden.');
    ctx.repo.updateUser(u.id, { status, ...(displayName ? { display_name: displayName } : {}) });
    let onboarding: OnboardResult | undefined;
    if (status === 'active' && u.status !== 'active') {
      onboarding = await onboardOnApproval(ctx, ctx.repo.getUser(u.id)!, createAccount);
      ctx.dispatchEvent(
        u.id,
        `Der Admin hat dich gerade freigeschaltet. Begrüße den Nutzer kurz${displayName ? ` (Name: ${displayName})` : ''}, stell dich vor und erkläre in 2-3 Sätzen, wobei du helfen kannst (Filme/Serien anfragen, Probleme melden, Benachrichtigung wenn Anfragen fertig sind). Beantworte ggf. auch seine erste Nachricht aus dem Verlauf.${onboarding?.note ? ` ${onboarding.note}` : ''}`,
      );
    }
    return { ok: true, user: userLabel(ctx.repo.getUser(u.id)!), ...(onboarding ? { onboarding: onboardSummary(onboarding) } : {}) };
  },
});

/** What the admin (and the LLM) sees about an onboarding – never the password. */
function onboardSummary(r: OnboardResult) {
  return {
    jellyfinUser: r.jellyfin?.username,
    seerrUserId: r.seerrUserId,
    credentialsSent: !!r.jellyfin && !r.errors.some((e) => e.startsWith('Zugangsdaten')),
    errors: r.errors.length ? r.errors : undefined,
  };
}

const setMaintenanceTool = defineTool({
  name: 'set_maintenance',
  description:
    'Setzt einen Wartungshinweis (z.B. "Server-Umbau, heute bis ca. 22 Uhr"): Nutzer, die schreiben, bekommen ihn höchstens alle 2 Stunden als feste Nachricht und eine Entwarnung, wenn er aufgehoben wird. off=true hebt ihn auf.',
  schema: z.object({
    message: z.string().max(500).optional().describe('Text für die Nutzer, kurz und freundlich'),
    hours: z.number().positive().max(168).optional().describe('Hebt sich danach von selbst auf'),
    off: z.boolean().optional(),
  }),
  async run({ message, hours, off }, ctx) {
    if (!off && !message?.trim()) throw new ToolError('Text für den Wartungshinweis fehlt (oder off=true zum Aufheben).');
    const r = await setMaintenance(ctx, off ? null : message!, hours);
    return { ok: true, maintenance: r.maintenance ?? 'aufgehoben', usersNotified: r.notified, detectedOutage: getOutage(ctx.repo) ?? null };
  },
});

const digestTool = defineTool({
  name: 'weekly_digest',
  description:
    'Wochenrückblick ("Neu auf dem Server"): preview=true zeigt dir den Text und die Empfänger, preview=false verschickt ihn jetzt an alle, die ihn nicht abbestellt haben.',
  schema: z.object({ preview: z.boolean().default(true) }),
  async run({ preview }, ctx) {
    if (preview) {
      const text = digestText(await collectNew(ctx.services));
      return { text: text ?? '(diese Woche nichts Neues – es würde nichts verschickt)', recipients: digestRecipients(ctx).length, scheduled: ctx.config.DIGEST_ENABLED ? `${ctx.config.DIGEST_DAY} ab ${ctx.config.DIGEST_HOUR} Uhr` : 'aus' };
    }
    if (ctx.turn.quiet) throw new ToolError('Aus der Web-Konsole wird nichts an Nutzer verschickt.');
    const r = await sendDigest(ctx);
    return { sent: r.sent, nothingNew: !r.text };
  },
});

const createJellyfinAccount = defineTool({
  name: 'create_jellyfin_account',
  description:
    'Legt für einen Nutzer ein Jellyfin-Konto an (Benutzername aus seinem Namen, zufälliges Passwort), verknüpft es (auch mit Jellyseerr) und schickt ihm die Zugangsdaten mit kurzer Anleitung direkt per WhatsApp. Du siehst das Passwort nicht.',
  schema: z.object({ user: userRef }),
  async run({ user }, ctx) {
    if (!ctx.services.jellyfin) throw new ToolError('Jellyfin ist nicht konfiguriert.');
    const u = resolveUser(ctx, user);
    if (u.jellyfin_user_id || u.jellyfin_username) throw new ToolError(`${userLabel(u)} hat schon ein Jellyfin-Konto (${u.jellyfin_username ?? u.jellyfin_user_id}).`);
    const r = await onboardUser(ctx, u);
    if (!r.jellyfin) throw new ToolError(r.errors.join('; ') || 'Konto konnte nicht angelegt werden.');
    return { ok: true, user: userLabel(ctx.repo.getUser(u.id)!), ...onboardSummary(r) };
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

const createTicket = defineTool({
  name: 'create_ticket',
  description:
    'Legt ein neues Ticket an, z. B. wenn der Admin ein Problem selbst bemerkt oder für einen Nutzer festhalten will. Ohne user läuft es auf den Admin. Ab der eingestellten Schwere bekommt Hermes es automatisch (falls eingerichtet).',
  schema: z.object({
    title: z.string().describe('Kurzer Titel, z. B. "Jellyfin: TV-Streaming bricht ab"'),
    description: z.string().describe('Was genau los ist, inkl. Gerät/App/Fehlermeldung, falls bekannt'),
    category: z.enum(['playback', 'missing_media', 'quality', 'audio_subtitles', 'metadata', 'download', 'account', 'server', 'other']),
    severity: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
    user: userRef.optional().describe('Für welchen Nutzer (bekommt beim Lösen Bescheid). Leer = Admin selbst'),
    media: z
      .object({
        title: z.string(),
        type: z.enum(['movie', 'tv']),
        season: z.number().int().optional(),
        episode: z.number().int().optional(),
      })
      .optional(),
    hermes: z.boolean().optional().describe('An Hermes übergeben. Leer = automatisch je nach Schwere'),
  }),
  async run({ title, description, category, severity, user, media, hermes }, ctx) {
    const owner = user ? resolveUser(ctx, user) : ctx.user;
    const t = ctx.repo.createTicket({ user_id: owner.id, title, description, category, severity, media_ref: media });
    ctx.repo.appendTicketAction(t.id, 'admin_created', 'Vom Admin angelegt');
    const toHermes = hermes ?? hermesAuto(ctx.config, severity);
    if (!toHermes) return { ticketId: t.id, for: userLabel(owner), status: t.status };
    if (!hermesEnabled(ctx.config)) return { ticketId: t.id, for: userLabel(owner), status: t.status, hermes: 'Hermes ist nicht eingerichtet' };
    const r = await handToHermes(ctx, { ticket: ctx.repo.getTicket(t.id)! });
    if (r.ok) ctx.repo.updateTicket(t.id, { status: 'escalated' });
    return { ticketId: t.id, for: userLabel(owner), status: r.ok ? 'escalated' : t.status, hermes: r.ok ? 'übergeben' : `fehlgeschlagen: ${r.error}` };
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

const handToHermesTool = defineTool({
  name: 'hand_to_hermes',
  description:
    'Gibt ein Ticket an den Hermes Agent des Admins weiter: Hermes sucht die Ursache, repariert und meldet sich zurück; der Nutzer bekommt dann automatisch Bescheid. Für Tickets, die nicht schon automatisch übergeben wurden.',
  schema: z.object({
    ticketId: z.number().int(),
    note: z.string().optional().describe('Hinweis des Admins an Hermes, z. B. Vermutung oder was er nicht anfassen soll'),
  }),
  async run({ ticketId, note }, ctx) {
    const t = ctx.repo.getTicket(ticketId);
    if (!t) throw new ToolError('Ticket nicht gefunden');
    if (t.status === 'resolved' || t.status === 'closed') throw new ToolError('Ticket ist schon erledigt.');
    const r = await handToHermes(ctx, { ticket: t, note });
    if (!r.ok) throw new ToolError(r.error);
    if (t.status !== 'escalated') ctx.repo.updateTicket(t.id, { status: 'escalated' });
    return { ok: true, note: 'Hermes hat das Ticket. Du meldest dem Admin sein Ergebnis, sobald es kommt (passiert automatisch).' };
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
  createJellyfinAccount,
  setMaintenanceTool,
  digestTool,
  // shared media tools (run without per-user limits for admins)
  searchMedia,
  confirmMedia,
  requestMedia,
  checkRequest,
  requestFix,
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
  resetUserLimits,
  linkUser,
  listMediaAccounts,
  createTicket,
  listTickets,
  ticketDetails,
  updateTicket,
  resolveTicket,
  handToHermesTool,
  messageUser,
  broadcast,
  rememberAboutUser,
  forgetUserFact,
  userPlayback,
  systemHealth,
  serverActivity,
] as unknown as Tool[];
