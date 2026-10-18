import type { EnvKey } from '../config.js';

export type SettingType = 'text' | 'textarea' | 'secret' | 'url' | 'bool' | 'int' | 'float' | 'select' | 'list';

export interface SettingDef {
  key: EnvKey;
  group: string;
  label: string;
  help?: string;
  type: SettingType;
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** Default shown in the UI when neither env nor UI set a value. */
  default?: string;
  /** Only effective after a container restart. */
  restart?: boolean;
  /** Shown, but can only be changed via environment variable. */
  readOnly?: boolean;
}

export interface SettingGroup {
  id: string;
  label: string;
  description?: string;
  /** Service whose connection can be tested from this group. */
  test?: 'llm' | 'jellyfin' | 'plex' | 'seerr' | 'ombi' | 'sonarr' | 'radarr';
}

export const GROUPS: SettingGroup[] = [
  { id: 'general', label: 'Allgemein', description: 'Wie sich der Bot nennt und wen er als Admin kennt.' },
  { id: 'access', label: 'Zugang', description: 'Wer mit dem Bot schreiben darf.' },
  { id: 'llm', label: 'KI-Anbieter', description: 'Modell und Anbieter, mit denen der Bot denkt.', test: 'llm' },
  { id: 'prompt', label: 'Persönlichkeit', description: 'Zusätzliche Anweisungen, die der Bot in jedem Nutzer-Gespräch befolgt.' },
  { id: 'jellyfin', label: 'Jellyfin', test: 'jellyfin' },
  { id: 'plex', label: 'Plex', test: 'plex' },
  { id: 'seerr', label: 'Jellyseerr / Overseerr', test: 'seerr' },
  { id: 'ombi', label: 'Ombi', test: 'ombi' },
  { id: 'sonarr', label: 'Sonarr', test: 'sonarr' },
  { id: 'radarr', label: 'Radarr', test: 'radarr' },
  { id: 'autofix', label: 'Anfragen & Auto-Fix', description: 'Limits und was der Bot selbstständig reparieren darf.' },
  { id: 'notify', label: 'Benachrichtigungen' },
  { id: 'tuning', label: 'Feintuning', description: 'Gedächtnis und Verarbeitung. Normalerweise nicht nötig.' },
  { id: 'system', label: 'System', description: 'Server und Sicherheit.' },
];

const PROVIDERS = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai', label: 'OpenAI (API-Key)' },
  { value: 'chatgpt', label: 'ChatGPT-Login (experimentell)' },
  { value: 'custom', label: 'Eigener Endpoint (OpenAI-kompatibel)' },
];

export const SETTINGS: SettingDef[] = [
  { key: 'BOT_NAME', group: 'general', label: 'Name des Bots', type: 'text', default: 'MediaBot' },
  { key: 'SERVER_NAME', group: 'general', label: 'Name des Servers', type: 'text', default: 'unser Mediaserver', help: 'So nennt der Bot deinen Server gegenüber Nutzern.' },
  { key: 'ADMIN_NAME', group: 'general', label: 'Dein Name (Admin)', type: 'text', default: 'Admin' },
  {
    key: 'ADMIN_NUMBERS',
    group: 'general',
    label: 'Admin-Nummern',
    type: 'list',
    placeholder: '4917612345678',
    help: 'WhatsApp-Nummern mit Ländervorwahl, ohne +. Diese Nummern sprechen mit dem Admin-Agenten und bekommen Eskalationen.',
  },

  {
    key: 'UNKNOWN_USER_POLICY',
    group: 'access',
    label: 'Unbekannte Nummern',
    type: 'select',
    default: 'approval',
    options: [
      { value: 'approval', label: 'Freischaltung durch Admin' },
      { value: 'open', label: 'Jeder darf schreiben' },
      { value: 'ignore', label: 'Ignorieren' },
    ],
  },
  { key: 'REQUESTS_PER_DAY', group: 'access', label: 'Medienanfragen pro Nutzer und Tag', type: 'int', default: '10' },

  { key: 'LLM_PROVIDER', group: 'llm', label: 'Anbieter', type: 'select', options: PROVIDERS, default: 'openrouter' },
  { key: 'LLM_BASE_URL', group: 'llm', label: 'Endpoint-URL', type: 'url', placeholder: 'http://ollama:11434/v1', help: 'Nur für „Eigener Endpoint“ nötig. Leer = Standard des Anbieters.' },
  { key: 'LLM_API_KEY', group: 'llm', label: 'API-Key', type: 'secret', help: 'Nicht nötig beim ChatGPT-Login.' },
  { key: 'LLM_MODEL', group: 'llm', label: 'Modell', type: 'text', default: 'openai/gpt-4.1-mini', help: 'Muss Tool-Calling können.' },
  { key: 'LLM_MODEL_ADMIN', group: 'llm', label: 'Modell für den Admin-Chat', type: 'text', help: 'Optional, z. B. ein stärkeres Modell. Leer = wie oben.' },
  { key: 'LLM_TEMPERATURE', group: 'llm', label: 'Temperatur', type: 'float', placeholder: 'Standard des Modells' },
  { key: 'LLM_VISION', group: 'llm', label: 'Bilder an das Modell geben', type: 'bool', default: 'true', help: 'Für Screenshots von Fehlermeldungen. Das Modell muss Vision können.' },
  { key: 'CHATGPT_AUTH_FILE', group: 'llm', label: 'ChatGPT auth.json', type: 'text', placeholder: '/data/codex-auth.json', help: 'Pfad zur auth.json aus „npx @openai/codex login“.' },

  {
    key: 'PROMPT_EXTRA',
    group: 'prompt',
    label: 'Eigene Anweisungen',
    type: 'textarea',
    placeholder: 'z. B. „Keine Anfragen für 4K-Remuxe annehmen. Am Wochenende antworte ich erst abends.“',
  },

  { key: 'JELLYFIN_URL', group: 'jellyfin', label: 'URL (intern)', type: 'url', placeholder: 'http://192.168.1.10:8096' },
  { key: 'JELLYFIN_API_KEY', group: 'jellyfin', label: 'API-Key', type: 'secret', help: 'Dashboard → API-Schlüssel' },
  { key: 'JELLYFIN_PUBLIC_URL', group: 'jellyfin', label: 'Öffentliche Adresse', type: 'url', help: 'Wird Nutzern genannt, falls sie fragen.' },
  { key: 'PLEX_URL', group: 'plex', label: 'URL (intern)', type: 'url', placeholder: 'http://192.168.1.10:32400' },
  { key: 'PLEX_TOKEN', group: 'plex', label: 'X-Plex-Token', type: 'secret' },
  { key: 'SEERR_URL', group: 'seerr', label: 'URL (intern)', type: 'url', placeholder: 'http://192.168.1.10:5055' },
  { key: 'SEERR_API_KEY', group: 'seerr', label: 'API-Key', type: 'secret', help: 'Einstellungen → Allgemein' },
  { key: 'SEERR_PUBLIC_URL', group: 'seerr', label: 'Öffentliche Adresse', type: 'url' },
  { key: 'OMBI_URL', group: 'ombi', label: 'URL (intern)', type: 'url' },
  { key: 'OMBI_API_KEY', group: 'ombi', label: 'API-Key', type: 'secret' },
  { key: 'SONARR_URL', group: 'sonarr', label: 'URL (intern)', type: 'url', placeholder: 'http://192.168.1.10:8989' },
  { key: 'SONARR_API_KEY', group: 'sonarr', label: 'API-Key', type: 'secret', help: 'Settings → General' },
  { key: 'RADARR_URL', group: 'radarr', label: 'URL (intern)', type: 'url', placeholder: 'http://192.168.1.10:7878' },
  { key: 'RADARR_API_KEY', group: 'radarr', label: 'API-Key', type: 'secret', help: 'Settings → General' },

  { key: 'AUTOFIX_REPLACE_FILE', group: 'autofix', label: 'Defekte Dateien selbst ersetzen', type: 'bool', default: 'true', help: 'Löscht die Datei und sucht eine neue. Höchstens einmal pro Ticket.' },
  { key: 'AUTOFIX_MAX_REPLACEMENTS_PER_DAY', group: 'autofix', label: 'Max. Ersetzungen pro Nutzer und Tag', type: 'int', default: '3' },
  { key: 'ADMIN_NOTIFY_AUTOFIX', group: 'autofix', label: 'Mich bei jedem Ersetzen informieren', type: 'bool', default: 'true' },

  { key: 'NOTIFY_POLL_MINUTES', group: 'notify', label: 'Prüfintervall (Minuten)', type: 'int', default: '5', help: 'Wie oft auf fertige Anfragen und Auto-Fixes geprüft wird.' },
  {
    key: 'NOTIFY_STYLE',
    group: 'notify',
    label: 'Stil der Benachrichtigungen',
    type: 'select',
    default: 'ai',
    options: [
      { value: 'ai', label: 'Persönlich (KI formuliert)' },
      { value: 'template', label: 'Feste Texte (spart Tokens)' },
    ],
  },

  { key: 'DEBOUNCE_MS', group: 'tuning', label: 'Nachrichten bündeln (ms)', type: 'int', default: '2500', help: 'Wartezeit, um schnell hintereinander geschickte Nachrichten zusammenzufassen.' },
  { key: 'HISTORY_LIMIT', group: 'tuning', label: 'Kurzzeitgedächtnis (Nachrichten)', type: 'int', default: '20' },
  { key: 'SUMMARIZE_AFTER', group: 'tuning', label: 'Zusammenfassen ab (Nachrichten)', type: 'int', default: '40' },
  { key: 'MAX_TOOL_ROUNDS', group: 'tuning', label: 'Max. Tool-Runden pro Antwort', type: 'int', default: '8' },

  {
    key: 'LOG_LEVEL',
    group: 'system',
    label: 'Log-Level',
    type: 'select',
    default: 'info',
    options: ['debug', 'info', 'warn', 'error'].map((v) => ({ value: v, label: v })),
  },
  { key: 'HTTP_TOKEN', group: 'system', label: 'Token für /qr und Webhook', type: 'secret', help: 'Schützt die Webhook-URL (…/webhook/seerr?token=…).' },
  { key: 'HTTP_PORT', group: 'system', label: 'HTTP-Port', type: 'int', readOnly: true, restart: true, help: 'Nur per Umgebungsvariable änderbar.' },
  { key: 'DATA_DIR', group: 'system', label: 'Datenverzeichnis', type: 'text', readOnly: true, restart: true, help: 'Nur per Umgebungsvariable änderbar.' },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export const SERVICE_KEYS = new Set<string>(SETTINGS.filter((s) => ['jellyfin', 'plex', 'seerr', 'ombi', 'sonarr', 'radarr'].includes(s.group)).map((s) => s.key));
export const LLM_KEYS = new Set<string>(SETTINGS.filter((s) => s.group === 'llm').map((s) => s.key));
