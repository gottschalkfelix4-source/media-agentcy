import { createServer } from 'node:http';
import QRCode from 'qrcode';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Poller } from '../notifier/poller.js';
import type { WhatsAppClient } from '../whatsapp/client.js';

/**
 * Tiny HTTP server:
 *   GET  /health                 – liveness + WhatsApp state
 *   GET  /qr?token=…             – WhatsApp login QR code as a web page
 *   POST /webhook/seerr?token=…  – Jellyseerr/Overseerr webhook → triggers an immediate notification check
 */
export function startHttpServer(deps: { config: Config; logger: Logger; whatsapp?: WhatsAppClient; poller: Poller }) {
  const { config, logger, whatsapp, poller } = deps;

  const authorized = (url: URL, headers: Record<string, string | string[] | undefined>) =>
    !config.HTTP_TOKEN || url.searchParams.get('token') === config.HTTP_TOKEN || headers.authorization === `Bearer ${config.HTTP_TOKEN}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, whatsapp: whatsapp?.state ?? 'disabled' }));
        return;
      }

      if (!authorized(url, req.headers)) {
        res.writeHead(401).end('unauthorized');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/qr') {
        const qr = whatsapp?.latestQr;
        const body = qr
          ? `<img src="${await QRCode.toDataURL(qr, { width: 360, margin: 2 })}" alt="QR"><p>WhatsApp → Verknüpfte Geräte → Gerät hinzufügen. Seite lädt alle 10 s neu.</p>`
          : `<p>Status: <b>${whatsapp?.state ?? 'deaktiviert'}</b>${whatsapp?.state === 'open' ? ' – bereits verbunden ✅' : ' – noch kein QR-Code, Seite lädt neu…'}</p>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>${config.BOT_NAME} Login</title><body style="font-family:sans-serif;text-align:center;padding:2rem"><h2>${config.BOT_NAME} – WhatsApp Login</h2>${body}</body>`,
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/webhook/seerr') {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        setTimeout(() => void poller.runOnce(), 5000);
        return;
      }

      res.writeHead(404).end('not found');
    } catch (err) {
      logger.error({ err }, 'HTTP-Fehler');
      res.writeHead(500).end('error');
    }
  });

  server.listen(config.HTTP_PORT, () => logger.info(`HTTP-Server auf Port ${config.HTTP_PORT} (/health, /qr, /webhook/seerr)`));
  return server;
}
