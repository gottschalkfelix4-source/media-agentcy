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
import { LLM_KEYS, SERVICE_KEYS } from './settings/registry.js';
import { SettingsStore } from './settings/store.js';

export interface AppOptions {
  /** Non-persistent setting overrides on top of env + web UI settings (used by the local test chat). */
  runtimeOverrides?: Record<string, string>;
}

/** Wires up all components around a given messenger (WhatsApp or console). */
export function createApp(messenger: Messenger, opts: AppOptions = {}) {
  const repo = new Repo(openDatabase(config.dbFile));
  const settings = new SettingsStore(repo, opts.runtimeOverrides);
  const settingsError = settings.applyStartup();
  if (settingsError) logger.error({ error: settingsError }, 'Gespeicherte Einstellungen ungültig – nutze nur .env-Werte');
  logger.level = config.LOG_LEVEL;

  let router: Router | undefined;
  const ctx: AppContext = {
    config,
    repo,
    services: createServices(config),
    llm: createProvider(config),
    messenger,
    logger,
    dispatchEvent: (userId, text) => router?.dispatchEvent(userId, text),
  };
  const agent = new Agent(ctx);
  router = new Router(ctx, agent);
  const poller = new Poller(ctx);

  /** Applies changed settings to the running components. */
  function applySettings(changed: string[]) {
    const keys = new Set(changed);
    if (changed.some((k) => SERVICE_KEYS.has(k))) ctx.services = createServices(config);
    if (changed.some((k) => LLM_KEYS.has(k))) ctx.llm = createProvider(config);
    if (keys.has('NOTIFY_POLL_MINUTES')) poller.restart();
    if (keys.has('LOG_LEVEL')) logger.level = config.LOG_LEVEL;
    if (changed.length) logger.info({ changed }, 'Einstellungen übernommen');
  }

  /** Makes sure the admin numbers exist as active admin users (needed for the web console and escalations). */
  function ensureAdminUsers() {
    for (const n of config.ADMIN_NUMBERS) {
      const u = repo.getUserByWaId(n);
      if (!u) repo.createUser(n, { status: 'active', role: 'admin', display_name: config.ADMIN_NAME });
      else if (u.role !== 'admin' || u.status !== 'active') repo.updateUser(u.id, { role: 'admin', status: 'active' });
    }
  }

  return { ctx, agent, router, poller, repo, settings, applySettings, ensureAdminUsers };
}

export type App = ReturnType<typeof createApp>;
