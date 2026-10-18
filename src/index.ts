import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { config } from './config.js';
import { enabledServices, pingAll } from './integrations/index.js';
import { logger } from './logger.js';
import { startHttpServer } from './server/http.js';
import { WhatsAppClient } from './whatsapp/client.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

async function main() {
  const whatsapp = new WhatsAppClient(config, logger);
  const app = createApp(whatsapp);
  const { router, poller, ctx } = app;
  app.ensureAdminUsers();

  logger.info(
    { llm: `${config.llm.provider}/${config.llm.model}`, services: enabledServices(ctx.services), admins: config.ADMIN_NUMBERS },
    `${config.BOT_NAME} ${pkg.version} startet`,
  );
  if (!config.ADMIN_NUMBERS.length) logger.warn('Keine Admin-Nummer eingetragen – Eskalationen können niemanden erreichen! (Web-Oberfläche → Einstellungen)');
  pingAll(ctx.services).then((r) => logger.info(r, 'Dienste-Check'));

  const server = startHttpServer({ app, whatsapp, version: pkg.version });
  whatsapp.onMessage = (msg) => router.onIncoming(msg);
  await whatsapp.start();
  poller.start();

  const shutdown = async (signal: string) => {
    logger.info(`${signal} empfangen – fahre herunter`);
    poller.stop();
    server.close();
    await whatsapp.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Start fehlgeschlagen');
  process.exit(1);
});
