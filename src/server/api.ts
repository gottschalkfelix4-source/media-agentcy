import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { App } from '../app.js';
import { blockedBy, limitStatus, resetLimits } from '../agent/abuse.js';
import { userLabel } from '../agent/context.js';
import type { Config } from '../config.js';
import type { TicketStatus, User, UserPatch } from '../db/repo.js';
import { bus, type AppEvent } from '../events.js';
import { createServices, enabledServices, pingAll, type Services } from '../integrations/index.js';
import { createProvider } from '../llm/index.js';
import { recentLogs } from '../logger.js';
import { GROUPS } from '../settings/registry.js';
import type { WhatsAppClient } from '../whatsapp/client.js';
import { SESSION_COOKIE, type WebAuth } from './auth.js';
import { syncRequests } from '../notifier/requestSync.js';
import { mergeAccounts, normalizePhone, type MediaAccountLists } from './userImport.js';

export interface ApiDeps {
  app: App;
  auth: WebAuth;
  whatsapp?: WhatsAppClient;
  startedAt: Date;
  version: string;
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}

const TICKET_STATUSES = ['open', 'auto_fixing', 'escalated', 'resolved', 'closed'] as const;
const ACTIVE_TICKETS: TicketStatus[] = ['open', 'auto_fixing', 'escalated'];

const importWelcomeEvent = (adminName: string, displayName?: string | null) =>
  `${adminName} hat dich gerade für diesen Nutzer${displayName ? ` (Name: ${displayName})` : ''} eingerichtet. Der Nutzer hat dir noch nie geschrieben und kennt dich noch nicht. Schreib ihm eine kurze erste Nachricht: wer du bist, dass ${adminName} dich eingerichtet hat, und in 2-3 Sätzen, wobei du helfen kannst (Filme/Serien anfragen, Probleme melden, Benachrichtigung wenn Anfragen fertig sind).`;

const welcomeEvent = (displayName?: string | null) =>
  `Der Admin hat dich gerade freigeschaltet. Begrüße den Nutzer kurz${displayName ? ` (Name: ${displayName})` : ''}, stell dich vor und erkläre in 2-3 Sätzen, wobei du helfen kannst (Filme/Serien anfragen, Probleme melden, Benachrichtigung wenn Anfragen fertig sind). Beantworte ggf. auch seine erste Nachricht aus dem Verlauf.`;

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const raw = await c.req.json().catch(() => {
    throw new HttpError(400, 'Ungültiges JSON');
  });
  const res = schema.safeParse(raw);
  if (!res.success) throw new HttpError(400, z.prettifyError(res.error));
  return res.data;
}

const idParam = (c: Context, name = 'id') => {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Ungültige ID');
  return n;
};

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

async function testService(target: string, cfg: Config): Promise<string> {
  if (target === 'llm') {
    const llm = createProvider(cfg);
    const started = Date.now();
    const res = await llm.complete({
      model: cfg.llm.model,
      messages: [
        { role: 'system', content: 'Du bist ein Verbindungstest. Antworte nur mit dem Wort OK.' },
        { role: 'user', content: 'Test' },
      ],
    });
    return `Antwort von ${cfg.llm.model} in ${((Date.now() - started) / 1000).toFixed(1)} s: „${(res.content ?? '').trim().slice(0, 60)}“`;
  }
  const s = createServices(cfg)[target as keyof Services];
  if (!s) throw new Error('URL und API-Key/Token ausfüllen');
  switch (target) {
    case 'jellyfin': {
      const jf = s as NonNullable<Services['jellyfin']>;
      const info = await jf.systemInfo();
      const users = await jf.users();
      return `Verbunden: Jellyfin ${info.Version}, ${users.length} Benutzer`;
    }
    case 'plex': {
      const plex = s as NonNullable<Services['plex']>;
      const r = await plex.ping();
      const sections = await plex.sections();
      return `Verbunden: Plex ${r.version}, ${sections.length} Bibliotheken`;
    }
    case 'seerr': {
      const seerr = s as NonNullable<Services['seerr']>;
      const r = await seerr.ping();
      const users = await seerr.users();
      return `Verbunden: Version ${r.version}, ${users.length} Benutzer`;
    }
    case 'sonarr':
    case 'radarr': {
      const arr = s as NonNullable<Services['radarr']>;
      const r = await arr.ping();
      const health = await arr.health();
      return `Verbunden: Version ${r.version}${health.length ? `, ${health.length} Warnung(en): ${health[0].message}` : ', keine Warnungen'}`;
    }
    default: {
      await s.ping();
      return 'Verbunden';
    }
  }
}

export function createApi(deps: ApiDeps) {
  const { app, auth, whatsapp } = deps;
  const { repo, router, poller, settings, ctx } = app;
  const api = new Hono();

  let serviceCache: { at: number; data: Record<string, string> } | undefined;
  async function serviceStatus(force = false) {
    if (!force && serviceCache && Date.now() - serviceCache.at < 30_000) return serviceCache.data;
    const data = await pingAll(ctx.services);
    serviceCache = { at: Date.now(), data };
    return data;
  }

  const getUserOr404 = (id: number) => {
    const u = repo.getUser(id);
    if (!u) throw new HttpError(404, 'Nutzer nicht gefunden');
    return u;
  };

  const consoleAdmin = (): User => {
    app.ensureAdminUsers();
    const admin = repo.listAdmins()[0];
    if (!admin) throw new HttpError(409, 'Keine Admin-Nummer eingetragen. Lege sie unter Einstellungen → Allgemein fest.');
    return admin;
  };

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    ctx.logger.error({ err, path: c.req.path }, 'API-Fehler');
    return c.json({ error: errText(err) }, 500);
  });

  // ---------------------------------------------------------------- auth

  api.get('/auth/me', (c) => c.json({ authenticated: auth.validSession(getCookie(c, SESSION_COOKIE)), passwordFromEnv: auth.passwordFromEnv, botName: ctx.config.BOT_NAME }));

  api.post('/auth/login', async (c) => {
    const { password } = await body(c, z.object({ password: z.string().min(1) }));
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ?? '?';
    const res = auth.login(password, ip, c.req.header('user-agent'));
    if (!res.ok) return c.json({ error: res.error }, 401);
    setCookie(c, SESSION_COOKIE, res.token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: res.maxAge, secure: c.req.url.startsWith('https:') });
    return c.json({ ok: true });
  });

  api.post('/auth/logout', (c) => {
    auth.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // Everything below needs a session.
  api.use('*', async (c, next) => {
    if (!auth.validSession(getCookie(c, SESSION_COOKIE))) return c.json({ error: 'Nicht angemeldet' }, 401);
    // CSRF: the cookie is SameSite=Strict; additionally require JSON for requests that could be sent by a plain HTML form.
    // (Cross-origin DELETE/PATCH/PUT always need a CORS preflight, which we never grant.)
    if (c.req.method === 'POST' && !c.req.header('content-type')?.includes('application/json')) {
      return c.json({ error: 'Content-Type muss application/json sein' }, 415);
    }
    await next();
  });

  api.post('/auth/password', async (c) => {
    const { current, next } = await body(c, z.object({ current: z.string(), next: z.string() }));
    const err = auth.changePassword(current, next);
    if (err) throw new HttpError(400, err);
    const res = auth.login(next, 'local', c.req.header('user-agent'));
    if (res.ok) setCookie(c, SESSION_COOKIE, res.token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: res.maxAge });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- live events (SSE)

  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let logPending = false;
      const off = bus.onEvent((e: AppEvent) => {
        if (e.type === 'log') {
          if (logPending) return;
          logPending = true;
          setTimeout(() => {
            logPending = false;
            void stream.writeSSE({ data: JSON.stringify(e) }).catch(() => undefined);
          }, 1000);
          return;
        }
        void stream.writeSSE({ data: JSON.stringify(e) }).catch(() => undefined);
      });
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }).catch(() => undefined), 25_000);
      await stream.writeSSE({ event: 'hello', data: '{}' });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      off();
    }),
  );

  // ---------------------------------------------------------------- overview

  api.get('/overview', async (c) => {
    const byStatus = Object.fromEntries(repo.countUsersByStatus().map((r) => [r.status, r.c]));
    const tickets = Object.fromEntries(repo.countTicketsByStatus().map((r) => [r.status, r.c]));
    const runtime = router.runtimeSnapshot();
    const busy = Object.entries(runtime)
      .filter(([, r]) => r.state !== 'idle')
      .map(([id, r]) => {
        const u = repo.getUser(Number(id));
        return { userId: Number(id), name: u ? (u.display_name ?? u.push_name ?? u.wa_id) : `#${id}`, ...r };
      });
    return c.json({
      bot: {
        name: ctx.config.BOT_NAME,
        version: deps.version,
        startedAt: deps.startedAt.toISOString(),
        llm: { provider: ctx.config.llm.provider, model: ctx.config.llm.model, adminModel: ctx.config.llm.adminModel },
        whatsapp: whatsapp ? { state: whatsapp.state, me: whatsapp.me, connectedSince: whatsapp.connectedSince } : { state: 'disabled' },
        poller: { busy: poller.busy, lastRun: poller.lastRun, intervalMinutes: ctx.config.NOTIFY_POLL_MINUTES },
        services: enabledServices(ctx.services),
        adminNumbers: ctx.config.ADMIN_NUMBERS.length,
      },
      users: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), active: byStatus.active ?? 0, pending: byStatus.pending ?? 0, blocked: byStatus.blocked ?? 0 },
      tickets: { ...tickets, active: ACTIVE_TICKETS.reduce((a, s) => a + (tickets[s] ?? 0), 0) },
      messages: {
        today: repo.countSince('messages', 'start of day', "AND role = 'user'"),
        week: repo.countSince('messages', '-7 days', "AND role = 'user'"),
        byDay: repo.messagesByDay(14),
      },
      requests: { week: repo.countSince('bot_requests', '-7 days'), total: repo.countSince('bot_requests', '-100 years'), pending: repo.pendingBotRequests().length },
      usage: { today: repo.usageTotals('start of day'), month: repo.usageTotals('-30 days') },
      busy,
      pendingUsers: repo.listUsers('pending').map((u) => ({ id: u.id, name: u.display_name ?? u.push_name, wa_id: u.wa_id, created_at: u.created_at })),
      escalated: repo.listTicketsWithUser({ statuses: ['escalated'], limit: 10 }),
      activity: repo.listActions({ limit: 12 }),
    });
  });

  api.get('/services', async (c) => c.json(await serviceStatus(c.req.query('refresh') === '1')));

  api.get('/now-playing', async (c) => {
    const { jellyfin, plex } = ctx.services;
    const users = repo.listUsers();
    const byJf = new Map(users.filter((u) => u.jellyfin_username).map((u) => [u.jellyfin_username!.toLowerCase(), u]));
    const byPlex = new Map(users.filter((u) => u.plex_username).map((u) => [u.plex_username!.toLowerCase(), u]));
    const out: { server: string; user?: string; userId?: number; title?: string; device?: string; method?: string; paused?: boolean }[] = [];
    const errors: string[] = [];
    if (jellyfin) {
      try {
        for (const s of await jellyfin.sessions()) {
          if (!s.nowPlaying) continue;
          const u = s.user ? byJf.get(s.user.toLowerCase()) : undefined;
          out.push({ server: 'Jellyfin', user: s.user, userId: u?.id, title: s.nowPlaying, device: [s.client, s.device].filter(Boolean).join(' · '), method: s.playMethod });
        }
      } catch (err) {
        errors.push(`Jellyfin: ${errText(err)}`);
      }
    }
    if (plex) {
      try {
        for (const s of await plex.sessions()) {
          const u = s.user ? byPlex.get(s.user.toLowerCase()) : undefined;
          out.push({ server: 'Plex', user: s.user, userId: u?.id, title: s.title, device: s.player, method: s.video, paused: s.state === 'paused' });
        }
      } catch (err) {
        errors.push(`Plex: ${errText(err)}`);
      }
    }
    return c.json({ sessions: out, errors });
  });

  // ---------------------------------------------------------------- users

  api.get('/users', (c) => {
    const runtime = router.runtimeSnapshot();
    return c.json(
      repo.userOverview().map((u) => ({
        ...u,
        summary: undefined,
        last_message: u.last_message?.slice(0, 140) ?? null,
        runtime: runtime[u.id] ?? { state: 'idle', queued: 0 },
      })),
    );
  });

  api.post('/users', async (c) => {
    const b = await body(
      c,
      z.object({
        phone: z.string(),
        display_name: z.string().trim().min(1).optional(),
        status: z.enum(['active', 'pending', 'blocked']).default('active'),
      }),
    );
    const p = normalizePhone(b.phone);
    if ('error' in p) throw new HttpError(400, p.error);
    if (repo.getUserByWaId(p.phone)) throw new HttpError(409, 'Diese Nummer gibt es schon');
    const u = repo.createUser(p.phone, { display_name: b.display_name ?? null, status: b.status });
    repo.logAction(u.id, null, 'web_user_created', { phone: p.phone });
    return c.json(u);
  });

  api.get('/users/:id', (c) => {
    const u = getUserOr404(idParam(c));
    return c.json({
      user: u,
      label: userLabel(u),
      runtime: router.runtimeFor(u.id),
      facts: repo.listFacts(u.id),
      tickets: repo.listTicketsWithUser({ userId: u.id, limit: 50 }),
      requests: repo.listBotRequests({ userId: u.id, limit: 50 }),
      usage: { month: repo.usageTotals('-30 days', u.id), total: repo.usageTotals('-100 years', u.id), byDay: repo.usageByDay(30, u.id) },
      stats: {
        messages: repo.countMessages(u.id),
        unsummarized: repo.unsummarizedCount(u.id),
        requestsToday: repo.countActionsSince(u.id, 'request_media', '-1 day'),
      },
      limits: { ...limitStatus(ctx, u.id), blocked: blockedBy(ctx, u) ?? null },
      isAdminNumber: ctx.config.ADMIN_NUMBERS.includes(u.wa_id),
    });
  });

  api.patch('/users/:id', async (c) => {
    const id = idParam(c);
    const before = getUserOr404(id);
    const b = await body(
      c,
      z.object({
        display_name: z.string().trim().nullable().optional(),
        status: z.enum(['active', 'pending', 'blocked']).optional(),
        role: z.enum(['user', 'admin']).optional(),
        jellyfin_username: z.string().trim().nullable().optional(),
        jellyfin_user_id: z.string().trim().nullable().optional(),
        plex_username: z.string().trim().nullable().optional(),
        seerr_user_id: z.number().int().nullable().optional(),
        ombi_username: z.string().trim().nullable().optional(),
        summary: z.string().nullable().optional(),
        bot_paused: z.boolean().optional(),
        welcome: z.boolean().optional(),
      }),
    );
    if (before.role === 'admin' && b.status && b.status !== 'active' && ctx.config.ADMIN_NUMBERS.includes(before.wa_id)) {
      throw new HttpError(400, 'Admin-Nummern können nicht gesperrt werden – erst aus den Admin-Nummern entfernen.');
    }
    const { welcome, bot_paused, ...rest } = b;
    const patch: UserPatch = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v === '' ? null : v;
    if (bot_paused !== undefined) patch.bot_paused = bot_paused ? 1 : 0;
    // Jellyfin name given without id → look up the id.
    if (patch.jellyfin_username && b.jellyfin_user_id === undefined && ctx.services.jellyfin) {
      const jf = (await ctx.services.jellyfin.users().catch(() => [])).find((x) => x.name.toLowerCase() === patch.jellyfin_username!.toLowerCase());
      patch.jellyfin_user_id = jf?.id ?? null;
    }
    if (patch.jellyfin_username === null) patch.jellyfin_user_id = null;
    repo.updateUser(id, patch);
    repo.logAction(id, null, 'web_user_updated', { fields: Object.keys(patch) });
    if (b.status === 'active' && before.status !== 'active' && welcome !== false) {
      ctx.dispatchEvent(id, welcomeEvent(patch.display_name ?? before.display_name));
    }
    return c.json(repo.getUser(id));
  });

  api.delete('/users/:id', (c) => {
    const u = getUserOr404(idParam(c));
    if (ctx.config.ADMIN_NUMBERS.includes(u.wa_id)) throw new HttpError(400, 'Admin-Nummern können nicht gelöscht werden');
    repo.deleteUser(u.id);
    repo.logAction(null, null, 'web_user_deleted', { user: userLabel(u) });
    return c.json({ ok: true });
  });

  api.get('/users/:id/messages', (c) => {
    const id = idParam(c);
    getUserOr404(id);
    const before = Number(c.req.query('before')) || undefined;
    const limit = Math.min(200, Number(c.req.query('limit')) || 60);
    return c.json(repo.messagePage(id, { beforeId: before, limit }));
  });

  api.post('/users/:id/messages', async (c) => {
    const u = getUserOr404(idParam(c));
    const { text, mode } = await body(c, z.object({ text: z.string().trim().min(1).max(4000), mode: z.enum(['direct', 'ai']).default('direct') }));
    if (u.status !== 'active') throw new HttpError(400, `Nutzer ist ${u.status}`);
    if (mode === 'ai') {
      ctx.dispatchEvent(u.id, `Der Admin (${ctx.config.ADMIN_NAME}) möchte dem Nutzer Folgendes mitteilen: "${text}". Richte es freundlich in deinem Stil aus.`);
      return c.json({ ok: true, queued: true });
    }
    try {
      await ctx.messenger.sendText(u, text);
    } catch (err) {
      throw new HttpError(502, `Senden fehlgeschlagen: ${errText(err)}`);
    }
    repo.addMessage(u.id, 'assistant', text, 'admin');
    repo.logAction(u.id, null, 'web_message', { length: text.length });
    return c.json({ ok: true });
  });

  api.post('/users/:id/reset-history', (c) => {
    const u = getUserOr404(idParam(c));
    repo.clearHistory(u.id);
    repo.logAction(u.id, null, 'web_reset_history', {});
    return c.json({ ok: true });
  });

  api.post('/users/:id/reset-limits', (c) => {
    const u = getUserOr404(idParam(c));
    resetLimits(ctx, u.id);
    return c.json({ ok: true });
  });

  api.post('/users/:id/facts', async (c) => {
    const u = getUserOr404(idParam(c));
    const { fact } = await body(c, z.object({ fact: z.string().trim().min(1).max(300) }));
    return c.json({ id: repo.addFact(u.id, fact, 'admin') });
  });

  api.delete('/users/:id/facts/:factId', (c) => {
    const u = getUserOr404(idParam(c));
    if (!repo.deleteFact(u.id, idParam(c, 'factId'))) throw new HttpError(404, 'Eintrag nicht gefunden');
    return c.json({ ok: true });
  });

  api.get('/users/:id/playback', async (c) => {
    const u = getUserOr404(idParam(c));
    const { jellyfin, plex } = ctx.services;
    const safe = async <T>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (err) {
        return { error: errText(err) };
      }
    };
    return c.json({
      configured: { jellyfin: !!jellyfin, plex: !!plex },
      jellyfin: jellyfin && u.jellyfin_user_id ? { sessions: await safe(() => jellyfin.sessions(u.jellyfin_user_id!)), activity: await safe(() => jellyfin.activity({ userId: u.jellyfin_user_id!, limit: 40 }).then((a) => a.slice(0, 15))) } : null,
      plex: plex && u.plex_username ? { sessions: await safe(() => plex.sessions(u.plex_username!)) } : null,
    });
  });

  api.get('/media-accounts', async (c) => {
    const { jellyfin, seerr } = ctx.services;
    const out: { jellyfin?: { id: string; name: string }[]; seerr?: { id: number; name: string }[]; errors: string[] } = { errors: [] };
    if (jellyfin) {
      try {
        out.jellyfin = (await jellyfin.users()).map((u) => ({ id: u.id, name: u.name }));
      } catch (err) {
        out.errors.push(`Jellyfin: ${errText(err)}`);
      }
    }
    if (seerr) {
      try {
        out.seerr = (await seerr.users()).map((u) => ({ id: u.id, name: u.displayName ?? u.username ?? u.jellyfinUsername ?? u.plexUsername ?? u.email ?? `#${u.id}` }));
      } catch (err) {
        out.errors.push(`Jellyseerr: ${errText(err)}`);
      }
    }
    return c.json(out);
  });

  // ---------------------------------------------------------------- user import

  api.get('/user-import/candidates', async (c) => {
    const { jellyfin, plex, seerr } = ctx.services;
    const lists: MediaAccountLists = {};
    const errors: string[] = [];
    await Promise.all([
      jellyfin && jellyfin.users().then((l) => (lists.jellyfin = l), (err) => errors.push(`Jellyfin: ${errText(err)}`)),
      plex && plex.users().then((l) => (lists.plex = l), (err) => errors.push(`Plex: ${errText(err)}`)),
      seerr && seerr.users().then((l) => (lists.seerr = l), (err) => errors.push(`Jellyseerr: ${errText(err)}`)),
    ]);
    return c.json({
      sources: { jellyfin: !!jellyfin, plex: !!plex, seerr: !!seerr },
      candidates: mergeAccounts(lists, repo.listUsers()),
      errors,
    });
  });

  api.post('/user-import', async (c) => {
    const b = await body(
      c,
      z.object({
        users: z
          .array(
            z.object({
              phone: z.string(),
              display_name: z.string().trim().max(80).nullish(),
              jellyfin_user_id: z.string().trim().nullish(),
              jellyfin_username: z.string().trim().nullish(),
              plex_username: z.string().trim().nullish(),
              seerr_user_id: z.number().int().nullish(),
            }),
          )
          .min(1)
          .max(500),
        status: z.enum(['active', 'pending']).default('active'),
        welcome: z.boolean().default(false),
      }),
    );
    const seen = new Set<string>();
    const results: { phone: string; ok: boolean; action?: 'created' | 'updated'; userId?: number; error?: string }[] = [];
    for (const row of b.users) {
      const p = normalizePhone(row.phone);
      if ('error' in p) {
        results.push({ phone: row.phone, ok: false, error: p.error });
        continue;
      }
      if (seen.has(p.phone)) {
        results.push({ phone: row.phone, ok: false, error: 'Nummer kommt doppelt vor' });
        continue;
      }
      seen.add(p.phone);

      const links: UserPatch = {};
      if (row.jellyfin_username) Object.assign(links, { jellyfin_username: row.jellyfin_username, jellyfin_user_id: row.jellyfin_user_id ?? null });
      if (row.plex_username) links.plex_username = row.plex_username;
      if (row.seerr_user_id != null) links.seerr_user_id = row.seerr_user_id;

      const existing = repo.getUserByWaId(p.phone);
      // An account may belong to only one bot user.
      const taken = repo
        .listUsers()
        .find(
          (u) =>
            u.id !== existing?.id &&
            ((links.jellyfin_username && u.jellyfin_username?.toLowerCase() === links.jellyfin_username.toLowerCase()) ||
              (links.plex_username && u.plex_username?.toLowerCase() === links.plex_username.toLowerCase()) ||
              (links.seerr_user_id != null && u.seerr_user_id === links.seerr_user_id)),
        );
      if (taken) {
        results.push({ phone: row.phone, ok: false, error: `Konto ist schon mit ${userLabel(taken)} verknüpft` });
        continue;
      }

      let userId: number;
      let activated = false;
      if (existing) {
        const patch: UserPatch = { ...links };
        if (!existing.display_name && row.display_name) patch.display_name = row.display_name;
        if (existing.status === 'pending' && b.status === 'active') {
          patch.status = 'active';
          activated = true;
        }
        repo.updateUser(existing.id, patch);
        userId = existing.id;
      } else {
        userId = repo.createUser(p.phone, { ...links, display_name: row.display_name || null, status: b.status }).id;
        activated = b.status === 'active';
      }
      repo.logAction(userId, null, 'web_user_imported', { phone: p.phone, accounts: Object.keys(links), updated: !!existing });
      if (b.welcome && activated) {
        const u = repo.getUser(userId)!;
        ctx.dispatchEvent(userId, existing ? welcomeEvent(u.display_name) : importWelcomeEvent(ctx.config.ADMIN_NAME, u.display_name));
      }
      results.push({ phone: row.phone, ok: true, action: existing ? 'updated' : 'created', userId });
    }
    return c.json({ results });
  });

  // ---------------------------------------------------------------- tickets

  api.get('/tickets', (c) => {
    const status = c.req.query('status');
    const statuses = status === 'active' ? ACTIVE_TICKETS : status ? (status.split(',').filter((s) => (TICKET_STATUSES as readonly string[]).includes(s)) as TicketStatus[]) : undefined;
    return c.json(repo.listTicketsWithUser({ statuses, userId: Number(c.req.query('userId')) || undefined, limit: 300 }));
  });

  api.get('/tickets/:id', (c) => {
    const t = repo.getTicket(idParam(c));
    if (!t) throw new HttpError(404, 'Ticket nicht gefunden');
    const u = repo.getUser(t.user_id);
    return c.json({
      ticket: { ...t, actions: JSON.parse(t.actions), media_ref: t.media_ref ? JSON.parse(t.media_ref) : null },
      user: u ? { id: u.id, label: userLabel(u), name: u.display_name ?? u.push_name ?? u.wa_id } : null,
      watches: repo.watchesForTicket(t.id),
      log: repo.listActions({ ticketId: t.id, limit: 50 }),
    });
  });

  api.patch('/tickets/:id', async (c) => {
    const id = idParam(c);
    const t = repo.getTicket(id);
    if (!t) throw new HttpError(404, 'Ticket nicht gefunden');
    const b = await body(
      c,
      z.object({
        status: z.enum(TICKET_STATUSES).optional(),
        severity: z.enum(['low', 'normal', 'high', 'critical']).optional(),
        diagnosis: z.string().optional(),
        resolution: z.string().optional(),
        notifyUser: z.boolean().default(false),
        messageToUser: z.string().optional(),
      }),
    );
    const { notifyUser, messageToUser, ...patch } = b;
    repo.updateTicket(id, patch);
    repo.appendTicketAction(id, 'admin (Web)', Object.entries(patch).map(([k, v]) => `${k}: ${v}`).join(', ') || 'Notiz');
    if (patch.status === 'resolved' || patch.status === 'closed') repo.closeWatchesForTicket(id);
    if (notifyUser) {
      const done = patch.status === 'resolved' || patch.status === 'closed';
      ctx.dispatchEvent(
        t.user_id,
        done
          ? `Dein Problem-Ticket #${t.id} ("${t.title}") wurde vom Admin gelöst.${patch.resolution ? ` Lösung: ${patch.resolution}.` : ''}${messageToUser ? ` Hinweis vom Admin: ${messageToUser}` : ''} Informiere den Nutzer kurz und frag, ob jetzt alles klappt.`
          : `Update zu Problem-Ticket #${t.id} ("${t.title}") vom Admin: ${messageToUser ?? patch.diagnosis ?? `Status jetzt ${patch.status ?? t.status}`}. Informiere den Nutzer kurz.`,
      );
    }
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- requests / activity / logs / usage

  api.post('/requests/sync', async (c) => {
    if (!ctx.services.seerr && !ctx.services.ombi) throw new HttpError(400, 'Weder Jellyseerr noch Ombi ist eingerichtet.');
    return c.json(await syncRequests(ctx, { full: true }));
  });

  api.get('/requests', (c) => c.json(repo.listBotRequests({ userId: Number(c.req.query('userId')) || undefined, limit: 300 })));

  api.get('/activity', (c) => c.json(repo.listActions({ userId: Number(c.req.query('userId')) || undefined, limit: Math.min(500, Number(c.req.query('limit')) || 200) })));

  api.get('/logs', (c) =>
    c.json(recentLogs({ afterId: Number(c.req.query('after')) || 0, minLevel: Number(c.req.query('level')) || 0, limit: Math.min(1000, Number(c.req.query('limit')) || 300) })),
  );

  api.get('/usage', (c) => {
    const users = repo.userOverview().filter((u) => u.tokens_30d > 0).sort((a, b) => b.tokens_30d - a.tokens_30d).slice(0, 10);
    return c.json({
      today: repo.usageTotals('start of day'),
      week: repo.usageTotals('-7 days'),
      month: repo.usageTotals('-30 days'),
      byDay: repo.usageByDay(30),
      byModel: repo.usageByModel('-30 days'),
      topUsers: users.map((u) => ({ id: u.id, name: u.display_name ?? u.push_name ?? u.wa_id, tokens: u.tokens_30d })),
    });
  });

  // ---------------------------------------------------------------- admin console & broadcast

  api.get('/console', (c) => {
    const admin = consoleAdmin();
    return c.json({ admin: { id: admin.id, label: userLabel(admin) }, runtime: router.runtimeFor(admin.id), messages: repo.messagePage(admin.id, { limit: 80 }) });
  });

  api.post('/console', async (c) => {
    const admin = consoleAdmin();
    const { text } = await body(c, z.object({ text: z.string().trim().min(1).max(4000) }));
    const reply = await router.ask(admin.id, text);
    return c.json({ reply });
  });

  api.post('/broadcast', async (c) => {
    const { text } = await body(c, z.object({ text: z.string().trim().min(1).max(4000) }));
    const users = repo.listUsers('active').filter((u) => u.role !== 'admin');
    repo.logAction(null, null, 'web_broadcast', { recipients: users.length, text: text.slice(0, 200) });
    void (async () => {
      let sent = 0;
      for (const u of users) {
        try {
          await ctx.messenger.sendText(u, text);
          repo.addMessage(u.id, 'assistant', text, 'admin');
          sent++;
        } catch (err) {
          ctx.logger.warn({ err, user: u.id }, 'Broadcast an Nutzer fehlgeschlagen');
        }
      }
      ctx.logger.info({ sent, total: users.length }, 'Broadcast abgeschlossen');
    })();
    return c.json({ ok: true, recipients: users.length });
  });

  api.post('/poll', async (c) => {
    await poller.runOnce();
    return c.json({ ok: true, lastRun: poller.lastRun });
  });

  // ---------------------------------------------------------------- WhatsApp

  api.get('/whatsapp', async (c) => {
    if (!whatsapp) return c.json({ state: 'disabled' });
    return c.json({
      state: whatsapp.state,
      me: whatsapp.me,
      connectedSince: whatsapp.connectedSince,
      qr: whatsapp.latestQr ? await QRCode.toDataURL(whatsapp.latestQr, { width: 320, margin: 1 }) : null,
    });
  });

  api.post('/whatsapp/logout', async (c) => {
    if (!whatsapp) throw new HttpError(400, 'WhatsApp ist deaktiviert');
    await whatsapp.logout();
    repo.logAction(null, null, 'web_whatsapp_logout', {});
    return c.json({ ok: true });
  });

  api.post('/whatsapp/restart', async (c) => {
    if (!whatsapp) throw new HttpError(400, 'WhatsApp ist deaktiviert');
    await whatsapp.restart();
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- settings

  const settingsView = () => ({ groups: GROUPS, settings: settings.view(), passwordFromEnv: auth.passwordFromEnv });

  api.get('/settings', (c) => c.json(settingsView()));

  const patchSchema = z.object({ values: z.record(z.string(), z.string().nullable()) });

  api.put('/settings', async (c) => {
    const { values } = await body(c, patchSchema);
    const res = settings.update(values);
    if (!res.ok) throw new HttpError(400, res.error);
    app.applySettings(res.changed);
    serviceCache = undefined;
    if (res.changed.includes('ADMIN_NUMBERS')) app.ensureAdminUsers();
    if (res.changed.length) repo.logAction(null, null, 'web_settings', { changed: res.changed });
    return c.json({ ...settingsView(), changed: res.changed });
  });

  api.post('/settings/test', async (c) => {
    const { target, values } = await body(c, z.object({ target: z.enum(['llm', 'jellyfin', 'plex', 'seerr', 'ombi', 'sonarr', 'radarr']), values: patchSchema.shape.values.default({}) }));
    const preview = settings.preview(values);
    if (!preview.ok) return c.json({ ok: false, message: preview.error });
    try {
      return c.json({ ok: true, message: await testService(target, preview.config) });
    } catch (err) {
      return c.json({ ok: false, message: errText(err) });
    }
  });

  api.post('/settings/models', async (c) => {
    const { values } = await body(c, patchSchema);
    const preview = settings.preview(values);
    if (!preview.ok) return c.json({ models: [], error: preview.error });
    const { llm } = preview.config;
    if (llm.provider === 'chatgpt') return c.json({ models: ['gpt-5', 'gpt-5-codex', 'gpt-5-mini'], note: 'Beim ChatGPT-Login gibt es keine Modell-Liste – das sind übliche Namen.' });
    try {
      const res = await fetch(`${llm.baseUrl}/models`, { headers: llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data?: { id: string; supported_parameters?: string[] }[] };
      const all = data.data ?? [];
      // OpenRouter tells which models support tools – only those work for the agent.
      const withTools = all.filter((m) => !m.supported_parameters || m.supported_parameters.includes('tools'));
      return c.json({ models: withTools.map((m) => m.id).sort() });
    } catch (err) {
      return c.json({ models: [], error: `Modell-Liste nicht abrufbar: ${errText(err)}` });
    }
  });

  return api;
}
