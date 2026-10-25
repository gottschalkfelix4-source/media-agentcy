import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import QRCode from 'qrcode';
import type { App } from '../app.js';
import { createApi } from './api.js';
import { hermesCallback } from '../agent/hermes.js';
import { SESSION_COOKIE, WebAuth, safeEqual } from './auth.js';
import type { WhatsAppClient } from '../whatsapp/client.js';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Built web UI: dist/web next to the compiled server, or after `npm run build:web` when running from src. */
function findWebDir() {
  const here = import.meta.dirname;
  return [path.resolve(here, '../web'), path.resolve(here, '../../dist/web')].find((d) => existsSync(path.join(d, 'index.html')));
}

/**
 * HTTP server:
 *   /api/*                       – web UI API (password login)
 *   /                            – web UI
 *   GET  /health                 – liveness + WhatsApp state
 *   GET  /qr?token=…             – WhatsApp login QR code as a plain page (token or web session)
 *   POST /webhook/seerr?token=…  – Jellyseerr/Overseerr webhook → triggers an immediate notification check
 *   POST /webhook/hermes         – status reports from the Hermes Agent (Bearer = per-handoff token)
 */
export function createHttpApp(deps: { app: App; whatsapp?: WhatsAppClient; version: string }) {
  const { app, whatsapp } = deps;
  const { config, logger } = app.ctx;
  const auth = new WebAuth(app.repo, config, logger);
  auth.init();

  const web = new Hono();
  const tokenMatches = (c: Context) => {
    const given = c.req.query('token') ?? c.req.header('authorization')?.replace(/^Bearer /, '');
    return !!config.HTTP_TOKEN && !!given && safeEqual(given, config.HTTP_TOKEN);
  };
  const tokenOk = (c: Context) => !config.HTTP_TOKEN || tokenMatches(c);

  web.get('/health', (c) => c.json({ ok: true, whatsapp: whatsapp?.state ?? 'disabled' }));

  // Whoever scans this QR first owns the bot's WhatsApp, so it needs the token or a web login – never open.
  web.get('/qr', async (c) => {
    if (!tokenMatches(c) && !auth.validSession(getCookie(c, SESSION_COOKIE))) return c.text('unauthorized – erst in der Web-Oberfläche anmelden oder ?token=… anhängen', 401);
    const qr = whatsapp?.latestQr;
    const content = qr
      ? `<img src="${await QRCode.toDataURL(qr, { width: 360, margin: 2 })}" alt="QR"><p>WhatsApp → Verknüpfte Geräte → Gerät hinzufügen. Seite lädt alle 10 s neu.</p>`
      : `<p>Status: <b>${escapeHtml(whatsapp?.state ?? 'deaktiviert')}</b>${whatsapp?.state === 'open' ? ' – bereits verbunden ✅' : ' – noch kein QR-Code, Seite lädt neu…'}</p>`;
    return c.html(
      `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>${escapeHtml(config.BOT_NAME)} Login</title><body style="font-family:sans-serif;text-align:center;padding:2rem"><h2>${escapeHtml(config.BOT_NAME)} – WhatsApp Login</h2>${content}</body>`,
    );
  });

  web.post('/webhook/seerr', (c) => {
    if (!tokenOk(c)) return c.text('unauthorized', 401);
    setTimeout(() => void app.poller.runOnce(), 5000);
    return c.json({ ok: true });
  });

  web.post('/webhook/hermes', async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const r = await hermesCallback(app.ctx, c.req.header('authorization'), raw);
    if (r.status === 401) logger.warn('Hermes-Rückmeldung mit unbekanntem Token abgelehnt');
    if (r.recheck) setTimeout(() => void app.poller.runOnce(), 5000);
    return c.json(r.body, r.status as 200);
  });

  web.route('/api', createApi({ app, auth, whatsapp, startedAt: new Date(), version: deps.version }));
  web.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  const webDir = findWebDir();
  if (webDir) {
    const root = path.relative(process.cwd(), webDir) || '.';
    // Hashed bundles never change; everything else (index.html) must be revalidated so updates show up immediately.
    web.use('*', async (c, next) => {
      await next();
      c.header('cache-control', c.req.path.startsWith('/assets/') && c.res.ok ? 'public, max-age=31536000, immutable' : 'no-cache');
    });
    web.use('*', serveStatic({ root }));
    web.get('/assets/*', (c) => c.text('not found', 404));
    // SPA fallback: client-side routes get index.html.
    web.get('*', (c) => c.html(readFileSync(path.join(webDir, 'index.html'), 'utf8')));
  } else {
    logger.warn('Web-Oberfläche nicht gebaut (npm run build:web) – nur API verfügbar');
    web.get('/', (c) => c.text('Web-Oberfläche nicht gebaut. Bitte "npm run build:web" ausführen.'));
  }

  return web;
}

export function startHttpServer(deps: { app: App; whatsapp?: WhatsAppClient; version: string }) {
  const { config, logger } = deps.app.ctx;
  const web = createHttpApp(deps);
  return serve({ fetch: web.fetch, port: config.HTTP_PORT }, () =>
    logger.info(`Web-Oberfläche: http://<host>:${config.HTTP_PORT}  (API, /health, /qr, /webhook/seerr, /webhook/hermes)`),
  );
}
