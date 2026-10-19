import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

if (existsSync('.env')) process.loadEnvFile('.env');

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const url = optStr.transform((v) => v?.replace(/\/+$/, ''));

const schema = z.object({
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.string().default('info'),

  BOT_NAME: z.string().default('MediaBot'),
  ADMIN_NAME: z.string().default('Admin'),
  SERVER_NAME: z.string().default('unser Mediaserver'),
  ADMIN_NUMBERS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(/[,; ]+/)
        .map((n) => n.replace(/\D/g, ''))
        .filter(Boolean),
    ),
  UNKNOWN_USER_POLICY: z.enum(['approval', 'open', 'ignore']).default('approval'),
  ONBOARD_JELLYFIN: bool(false),
  ONBOARD_GUIDE: optStr,

  LLM_PROVIDER: z.enum(['openrouter', 'openai', 'chatgpt', 'custom']).default('openrouter'),
  LLM_BASE_URL: url,
  LLM_API_KEY: optStr,
  LLM_MODEL: z.string().default('openai/gpt-4.1-mini'),
  LLM_MODEL_ADMIN: optStr,
  LLM_TEMPERATURE: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseFloat(v) : undefined)),
  LLM_VISION: bool(true),
  VOICE_ENABLED: bool(false),
  STT_BASE_URL: url,
  STT_API_KEY: optStr,
  STT_MODEL: z.string().default('whisper-1'),
  VOICE_MAX_SECONDS: int(120),
  CHATGPT_AUTH_FILE: optStr,

  JELLYFIN_URL: url,
  JELLYFIN_API_KEY: optStr,
  JELLYFIN_PUBLIC_URL: url,
  PLEX_URL: url,
  PLEX_TOKEN: optStr,
  SEERR_URL: url,
  SEERR_API_KEY: optStr,
  SEERR_PUBLIC_URL: url,
  OMBI_URL: url,
  OMBI_API_KEY: optStr,
  SONARR_URL: url,
  SONARR_API_KEY: optStr,
  RADARR_URL: url,
  RADARR_API_KEY: optStr,

  REQUESTS_PER_DAY: int(10),
  REQUEST_CONFIRM: bool(true),
  MESSAGES_PER_DAY: int(60),
  TOKENS_PER_DAY: int(500000),
  MAX_MESSAGE_CHARS: int(1500),
  OFF_TOPIC_LIMIT: int(3),
  AUTOFIX_REPLACE_FILE: bool(true),
  AUTOFIX_MAX_REPLACEMENTS_PER_DAY: int(3),
  ADMIN_NOTIFY_AUTOFIX: bool(true),
  STUCK_REQUEST_DAYS: int(3),
  OUTAGE_DETECTION: bool(true),

  HERMES_WEBHOOK_URL: url,
  HERMES_WEBHOOK_SECRET: optStr,
  HERMES_CALLBACK_URL: url,
  HERMES_MIN_SEVERITY: z.enum(['low', 'normal', 'high', 'critical']).default('high'),
  HERMES_OUTAGES: bool(true),
  HERMES_TIMEOUT_HOURS: int(6),

  NOTIFY_POLL_MINUTES: int(5),
  NOTIFY_STYLE: z.enum(['ai', 'template']).default('ai'),
  DIGEST_ENABLED: bool(false),
  DIGEST_DAY: z.enum(['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so']).default('fr'),
  DIGEST_HOUR: int(18),

  HTTP_PORT: int(8080),
  HTTP_TOKEN: optStr,
  WEB_PASSWORD: optStr,

  PROMPT_EXTRA: optStr,

  DEBOUNCE_MS: int(2500),
  HISTORY_LIMIT: int(20),
  SUMMARIZE_AFTER: int(40),
  MAX_TOOL_ROUNDS: int(8),
});

export const configSchema = schema;
export type EnvKey = keyof z.input<typeof schema>;
type Env = z.output<typeof schema>;

const defaultBaseUrl: Record<Env['LLM_PROVIDER'], string | undefined> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  chatgpt: 'https://chatgpt.com/backend-api/codex',
  custom: undefined,
};

function derive(env: Env) {
  const dataDir = path.resolve(env.DATA_DIR);
  return {
    ...env,
    dataDir,
    dbFile: path.join(dataDir, 'media-agentcy.db'),
    waAuthDir: path.join(dataDir, 'whatsapp-auth'),
    llm: {
      provider: env.LLM_PROVIDER,
      baseUrl: env.LLM_BASE_URL ?? defaultBaseUrl[env.LLM_PROVIDER],
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL,
      adminModel: env.LLM_MODEL_ADMIN ?? env.LLM_MODEL,
      temperature: env.LLM_TEMPERATURE,
      vision: env.LLM_VISION,
      chatgptAuthFile: env.CHATGPT_AUTH_FILE ?? path.join(dataDir, 'codex-auth.json'),
    },
  };
}

export type Config = ReturnType<typeof derive>;

/** Builds a config from raw string values (env vars, optionally overlaid with settings from the web UI). */
export function buildConfig(source: Record<string, string | undefined>): { ok: true; config: Config } | { ok: false; error: string } {
  // Empty values count as unset (Unraid and docker-compose pass blank template fields as "").
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== '')));
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const c = derive(parsed.data);
  if (c.llm.provider === 'custom' && !c.llm.baseUrl) {
    return { ok: false, error: 'LLM_PROVIDER=custom braucht LLM_BASE_URL (OpenAI-kompatibler Endpoint, z.B. http://ollama:11434/v1)' };
  }
  for (const k of ['DEBOUNCE_MS', 'HISTORY_LIMIT', 'SUMMARIZE_AFTER', 'MAX_TOOL_ROUNDS', 'REQUESTS_PER_DAY', 'MESSAGES_PER_DAY', 'TOKENS_PER_DAY', 'MAX_MESSAGE_CHARS', 'OFF_TOPIC_LIMIT', 'NOTIFY_POLL_MINUTES', 'AUTOFIX_MAX_REPLACEMENTS_PER_DAY', 'STUCK_REQUEST_DAYS', 'DIGEST_HOUR', 'VOICE_MAX_SECONDS', 'HERMES_TIMEOUT_HOURS'] as const) {
    if (!Number.isFinite(c[k]) || c[k] < 0) return { ok: false, error: `${k} muss eine Zahl ≥ 0 sein` };
  }
  if (c.DIGEST_HOUR > 23) return { ok: false, error: 'DIGEST_HOUR muss zwischen 0 und 23 liegen' };
  return { ok: true, config: c };
}

const initial = buildConfig(process.env);
if (!initial.ok) {
  console.error('Ungültige Konfiguration:\n' + initial.error);
  process.exit(1);
}

/**
 * The live config. It is mutated in place when settings change in the web UI,
 * so always read values at use time (config.X) instead of copying them.
 */
export const config: Config = initial.config;

export function replaceConfig(next: Config) {
  Object.assign(config, next);
}
