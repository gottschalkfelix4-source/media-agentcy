import { createApp } from './app.js';
import { config } from './config.js';
import { enabledServices, pingAll } from './integrations/index.js';
import { logger } from './logger.js';
import { startHttpServer } from './server/http.js';
import { WhatsAppClient } from './whatsapp/client.js';

async function main() {
  const whatsapp = new WhatsAppClient(config, logger);
  const { router, poller, services } = createApp(whatsapp);

  logger.info(
    { llm: `${config.llm.provider}/${config.llm.model}`, services: enabledServices(services), admins: config.ADMIN_NUMBERS },
    `${config.BOT_NAME} startet`,
  );
  if (!config.ADMIN_NUMBERS.length) logger.warn('ADMIN_NUMBERS ist leer – Eskalationen können niemanden erreichen!');
  pingAll(services).then((r) => logger.info(r, 'Dienste-Check'));

  whatsapp.onMessage = (msg) => router.onIncoming(msg);
  await whatsapp.start();
  poller.start();
  const server = startHttpServer({ config, logger, whatsapp, poller });

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
