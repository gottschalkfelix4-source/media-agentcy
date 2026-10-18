import { Agent } from './agent/agent.js';
import type { AppContext, Messenger } from './agent/context.js';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { Repo } from './db/repo.js';
import { createServices } from './integrations/index.js';
import { createProvider } from './llm/index.js';
import { logger } from './logger.js';
import { Router } from './messaging/router.js';
import { Poller } from './notifier/poller.js';

/** Wires up all components around a given messenger (WhatsApp or console). */
export function createApp(messenger: Messenger) {
  const repo = new Repo(openDatabase(config.dbFile));
  const services = createServices(config);
  const llm = createProvider(config);

  let router: Router | undefined;
  const ctx: AppContext = {
    config,
    repo,
    services,
    llm,
    messenger,
    logger,
    dispatchEvent: (userId, text) => router?.dispatchEvent(userId, text),
  };
  const agent = new Agent(ctx);
  router = new Router(ctx, agent);
  const poller = new Poller(ctx);

  return { ctx, agent, router, poller, repo, services };
}
