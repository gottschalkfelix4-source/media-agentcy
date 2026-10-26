import { QueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && (err.status === 401 || err.status === 404)) && count < 2,
    },
  },
});

let onUnauthorized: (() => void) | undefined;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  }
  return data as T;
}

// ---------------------------------------------------------------- types (mirror the server responses)

export interface DisruptionState {
  maintenance: { message: string; since: string; until?: string } | null;
  outage: { services: string[]; since: string; error?: string } | null;
  detection: boolean;
}

export type UserStatus = 'pending' | 'active' | 'blocked';

export interface Runtime {
  state: 'idle' | 'collecting' | 'working';
  queued: number;
  since?: string;
  lastReplyAt?: string;
  lastDurationMs?: number;
  lastError?: { at: string; message: string };
}

export interface User {
  id: number;
  wa_id: string;
  wa_jid: string | null;
  display_name: string | null;
  push_name: string | null;
  status: UserStatus;
  role: 'user' | 'admin';
  jellyfin_user_id: string | null;
  jellyfin_username: string | null;
  plex_username: string | null;
  seerr_user_id: number | null;
  ombi_username: string | null;
  summary: string | null;
  created_at: string;
  last_seen_at: string | null;
  bot_paused: number;
  digest: number;
}

export interface UserListItem extends User {
  message_count: number;
  last_message_at: string | null;
  last_message: string | null;
  last_message_role: string | null;
  open_tickets: number;
  request_count: number;
  tokens_30d: number;
  runtime: Runtime;
}

export interface Message {
  id: number;
  user_id: number;
  role: 'user' | 'assistant' | 'event';
  content: string;
  summarized: number;
  via: string | null;
  created_at: string;
}

export interface Fact {
  id: number;
  fact: string;
  source: string;
  created_at: string;
}

export type TicketStatus = 'open' | 'auto_fixing' | 'escalated' | 'resolved' | 'closed';

export interface Ticket {
  id: number;
  user_id: number;
  user_name?: string | null;
  status: TicketStatus;
  severity: 'low' | 'normal' | 'high' | 'critical';
  category: string;
  title: string;
  description: string;
  diagnosis: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface BotRequest {
  id: number;
  user_id: number;
  user_name: string | null;
  source: 'seerr' | 'ombi';
  external_id: string | null;
  tmdb_id: number | null;
  media_type: 'movie' | 'tv';
  title: string;
  notified_at: string | null;
  created_at: string;
  /** null = asked the bot, 'web' = made on the Jellyseerr/Ombi website */
  via: 'web' | null;
}

export interface ActionEntry {
  id: number;
  user_id: number | null;
  ticket_id: number | null;
  action: string;
  details: string | null;
  created_at: string;
  user_name: string | null;
}

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  avg_ms: number | null;
}

export interface UsageDay {
  day: string;
  input: number;
  output: number;
  calls: number;
}

export interface Overview {
  bot: {
    name: string;
    version: string;
    startedAt: string;
    llm: { provider: string; model: string; adminModel: string };
    whatsapp: { state: string; me?: { id: string; name?: string }; connectedSince?: string };
    poller: { busy: boolean; lastRun?: { at: string; ok: boolean }; intervalMinutes: number };
    services: string[];
    adminNumbers: number;
  };
  users: { total: number; active: number; pending: number; blocked: number };
  tickets: Record<string, number> & { active: number };
  messages: { today: number; week: number; byDay: { day: string; incoming: number; outgoing: number }[] };
  requests: { week: number; total: number; pending: number };
  usage: { today: UsageTotals; month: UsageTotals };
  busy: (Runtime & { userId: number; name: string })[];
  pendingUsers: { id: number; name: string | null; wa_id: string; created_at: string }[];
  escalated: Ticket[];
  activity: ActionEntry[];
}

export interface LimitCount {
  used: number;
  /** 0 = no limit */
  limit: number;
}

export interface UserDetail {
  user: User;
  label: string;
  runtime: Runtime;
  facts: Fact[];
  tickets: Ticket[];
  requests: BotRequest[];
  usage: { month: UsageTotals; total: UsageTotals; byDay: UsageDay[] };
  stats: { messages: number; unsummarized: number; requestsToday: number };
  limits: {
    offTopic: LimitCount;
    messages: LimitCount;
    tokens: LimitCount;
    blocked: 'off_topic' | 'messages' | 'tokens' | null;
  };
  isAdminNumber: boolean;
}

export interface TicketDetail {
  ticket: Ticket & { actions: { at: string; action: string; result: string }[]; media_ref: unknown };
  user: { id: number; label: string; name: string } | null;
  watches: { id: number; kind: string; label: string; done: number; created_at: string }[];
  log: ActionEntry[];
  hermes: { enabled: boolean; handoffs: Handoff[] };
}

export type HandoffStatus = 'sent' | 'working' | 'fixed' | 'failed' | 'needs_admin' | 'send_failed';

export interface Handoff {
  id: number;
  status: HandoffStatus;
  summary: string;
  last_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  help?: string;
  type: 'text' | 'textarea' | 'secret' | 'url' | 'bool' | 'int' | 'float' | 'select' | 'list';
  options?: { value: string; label: string }[];
  placeholder?: string;
  default?: string;
  restart?: boolean;
  readOnly?: boolean;
  value: string | null;
  source: 'ui' | 'env' | 'default';
  envValue: string | null;
  isSet: boolean;
  hint?: string;
}

export interface SettingsResponse {
  groups: { id: string; label: string; description?: string; test?: string }[];
  settings: SettingDef[];
  passwordFromEnv: boolean;
  changed?: string[];
}

export interface LogEntry {
  id: number;
  time: string;
  level: number;
  msg: string;
  data?: Record<string, unknown>;
}

export interface WhatsAppInfo {
  state: string;
  me?: { id: string; name?: string };
  connectedSince?: string;
  qr?: string | null;
}

export interface ChatGPTStatus {
  connected: boolean;
  planUsage: boolean;
  email?: string;
  registered: boolean;
  expiresAt?: string;
  authFile: string;
}

export interface LlmProfile {
  id: string;
  name: string;
  provider: string;
  baseUrl?: string;
  model?: string;
  adminModel?: string;
  keyHint?: string;
  active: boolean;
  createdAt: string;
}
