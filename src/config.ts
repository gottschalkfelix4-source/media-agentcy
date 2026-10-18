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
  AUTOFIX_REPLACE_FILE: bool(true),
  AUTOFIX_MAX_REPLACEMENTS_PER_DAY: int(3),
  ADMIN_NOTIFY_AUTOFIX: bool(true),

  NOTIFY_POLL_MINUTES: int(5),
  NOTIFY_STYLE: z.enum(['ai', 'template']).default('ai'),

  HTTP_PORT: int(8080),
  HTTP_TOKEN: optStr,

  DEBOUNCE_MS: int(2500),
  HISTORY_LIMIT: int(20),
  SUMMARIZE_AFTER: int(40),
  MAX_TOOL_ROUNDS: int(8),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Ungültige Konfiguration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

const env = parsed.data;

const defaultBaseUrl: Record<typeof env.LLM_PROVIDER, string | undefined> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  chatgpt: 'https://chatgpt.com/backend-api/codex',
  custom: undefined,
};

const dataDir = path.resolve(env.DATA_DIR);

export const config = {
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

export type Config = typeof config;

if (config.llm.provider === 'custom' && !config.llm.baseUrl) {
  console.error('LLM_PROVIDER=custom braucht LLM_BASE_URL (OpenAI-kompatibler Endpoint, z.B. http://ollama:11434/v1)');
  process.exit(1);
}
