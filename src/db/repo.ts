import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { bus } from '../events.js';

export type UserStatus = 'pending' | 'active' | 'blocked';
export type UserRole = 'user' | 'admin';

export interface User {
  id: number;
  wa_id: string;
  wa_jid: string | null;
  display_name: string | null;
  push_name: string | null;
  status: UserStatus;
  role: UserRole;
  jellyfin_user_id: string | null;
  jellyfin_username: string | null;
  plex_username: string | null;
  seerr_user_id: number | null;
  ombi_username: string | null;
  summary: string | null;
  admin_notified_at: string | null;
  created_at: string;
  last_seen_at: string | null;
  bot_paused: number;
}

export interface StoredMessage {
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
  user_id: number;
  fact: string;
  source: string;
  created_at: string;
}

export type TicketStatus = 'open' | 'auto_fixing' | 'escalated' | 'resolved' | 'closed';

export interface Ticket {
  id: number;
  user_id: number;
  status: TicketStatus;
  severity: string;
  category: string;
  title: string;
  description: string;
  media_ref: string | null;
  diagnosis: string | null;
  actions: string;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface BotRequest {
  id: number;
  user_id: number;
  source: 'seerr' | 'ombi';
  external_id: string | null;
  tmdb_id: number | null;
  media_type: 'movie' | 'tv';
  title: string;
  notified_at: string | null;
  created_at: string;
  /** NULL = asked the bot, 'web' = imported from the Jellyseerr/Ombi website. */
  via: 'web' | null;
}

export interface Watch {
  id: number;
  user_id: number;
  ticket_id: number | null;
  kind: 'radarr_movie' | 'sonarr_episodes';
  ref: string;
  label: string;
  done: number;
  created_at: string;
}

export interface UserOverview extends User {
  message_count: number;
  last_message_at: string | null;
  last_message: string | null;
  last_message_role: string | null;
  open_tickets: number;
  request_count: number;
  tokens_30d: number;
}

export interface ActionLogEntry {
  id: number;
  user_id: number | null;
  ticket_id: number | null;
  action: string;
  details: string | null;
  created_at: string;
  user_name: string | null;
}

const USER_FIELDS = [
  'wa_jid',
  'display_name',
  'push_name',
  'status',
  'role',
  'jellyfin_user_id',
  'jellyfin_username',
  'plex_username',
  'seerr_user_id',
  'ombi_username',
  'summary',
  'admin_notified_at',
  'last_seen_at',
  'bot_paused',
] as const;

export type UserPatch = Partial<Pick<User, (typeof USER_FIELDS)[number]>>;

export class Repo {
  constructor(private readonly db: DatabaseSync) {}

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  // ---------- users ----------

  getUser(id: number) {
    return this.get<User>('SELECT * FROM users WHERE id = ?', id);
  }

  getUserByWaId(waId: string) {
    return this.get<User>('SELECT * FROM users WHERE wa_id = ?', waId);
  }

  createUser(waId: string, init: UserPatch = {}): User {
    const res = this.run('INSERT INTO users (wa_id) VALUES (?)', waId);
    const id = Number(res.lastInsertRowid);
    if (Object.keys(init).length) this.updateUser(id, init);
    bus.emitEvent({ type: 'user', userId: id });
    return this.getUser(id)!;
  }

  updateUser(id: number, patch: UserPatch) {
    const keys = Object.keys(patch).filter((k) => (USER_FIELDS as readonly string[]).includes(k));
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (patch as Record<string, SQLInputValue>)[k] ?? null);
    this.run(`UPDATE users SET ${sets} WHERE id = ?`, ...values, id);
    // last_seen_at alone changes on every message; the message event covers that.
    if (keys.some((k) => k !== 'last_seen_at' && k !== 'wa_jid' && k !== 'push_name')) bus.emitEvent({ type: 'user', userId: id });
  }

  listUsers(status?: UserStatus) {
    return status
      ? this.all<User>('SELECT * FROM users WHERE status = ? ORDER BY id', status)
      : this.all<User>('SELECT * FROM users ORDER BY id');
  }

  listAdmins() {
    return this.all<User>("SELECT * FROM users WHERE role = 'admin' AND status = 'active'");
  }

  /** Resolve a user from an id, phone number or (partial) name. */
  findUser(ref: string | number): User | undefined {
    const s = String(ref).trim();
    if (/^#?\d{1,6}$/.test(s)) {
      const byId = this.getUser(Number(s.replace('#', '')));
      if (byId) return byId;
    }
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 7) {
      const byPhone = this.get<User>('SELECT * FROM users WHERE wa_id = ? OR wa_id LIKE ?', digits, `%${digits.slice(-9)}`);
      if (byPhone) return byPhone;
    }
    const like = `%${s.toLowerCase()}%`;
    return this.get<User>(
      `SELECT * FROM users WHERE lower(display_name) = ? OR lower(push_name) = ? OR lower(jellyfin_username) = ? OR lower(plex_username) = ?
       UNION ALL
       SELECT * FROM users WHERE lower(display_name) LIKE ? OR lower(push_name) LIKE ? OR lower(jellyfin_username) LIKE ? OR lower(plex_username) LIKE ?
       LIMIT 1`,
      s.toLowerCase(), s.toLowerCase(), s.toLowerCase(), s.toLowerCase(),
      like, like, like, like,
    );
  }

  usersBySeerrId(seerrId: number) {
    return this.all<User>("SELECT * FROM users WHERE seerr_user_id = ? AND status = 'active'", seerrId);
  }

  usersByOmbiName(name: string) {
    return this.all<User>("SELECT * FROM users WHERE lower(ombi_username) = lower(?) AND status = 'active'", name);
  }

  // ---------- messages / memory ----------

  addMessage(userId: number, role: StoredMessage['role'], content: string, via?: 'admin') {
    this.run('INSERT INTO messages (user_id, role, content, via) VALUES (?, ?, ?, ?)', userId, role, content, via ?? null);
    bus.emitEvent({ type: 'message', userId });
  }

  recentMessages(userId: number, limit: number) {
    return this.all<StoredMessage>(
      'SELECT * FROM (SELECT * FROM messages WHERE user_id = ? AND summarized = 0 ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
      userId,
      limit,
    );
  }

  countMessages(userId: number) {
    return this.get<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE user_id = ?', userId)!.c;
  }

  countMessagesSince(userId: number, role: string, sinceSql: string) {
    return this.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND role = ? AND via IS NULL AND created_at >= datetime('now', ?)`,
      userId,
      role,
      sinceSql,
    )!.c;
  }

  unsummarizedCount(userId: number) {
    return this.get<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND summarized = 0', userId)!.c;
  }

  oldestUnsummarized(userId: number, count: number) {
    return this.all<StoredMessage>(
      'SELECT * FROM messages WHERE user_id = ? AND summarized = 0 ORDER BY id ASC LIMIT ?',
      userId,
      count,
    );
  }

  markSummarized(userId: number, upToId: number) {
    this.run('UPDATE messages SET summarized = 1 WHERE user_id = ? AND id <= ?', userId, upToId);
  }

  clearHistory(userId: number) {
    this.run('UPDATE messages SET summarized = 1 WHERE user_id = ?', userId);
  }

  addFact(userId: number, fact: string, source = 'agent') {
    const res = this.run('INSERT INTO facts (user_id, fact, source) VALUES (?, ?, ?)', userId, fact, source);
    return Number(res.lastInsertRowid);
  }

  listFacts(userId: number) {
    return this.all<Fact>('SELECT * FROM facts WHERE user_id = ? ORDER BY id', userId);
  }

  deleteFact(userId: number, factId: number) {
    return this.run('DELETE FROM facts WHERE id = ? AND user_id = ?', factId, userId).changes > 0;
  }

  // ---------- tickets ----------

  createTicket(t: Pick<Ticket, 'user_id' | 'title' | 'description' | 'category' | 'severity'> & { media_ref?: unknown }) {
    const res = this.run(
      'INSERT INTO tickets (user_id, title, description, category, severity, media_ref) VALUES (?, ?, ?, ?, ?, ?)',
      t.user_id,
      t.title,
      t.description,
      t.category,
      t.severity,
      t.media_ref ? JSON.stringify(t.media_ref) : null,
    );
    const id = Number(res.lastInsertRowid);
    bus.emitEvent({ type: 'ticket', ticketId: id, userId: t.user_id });
    return this.getTicket(id)!;
  }

  getTicket(id: number) {
    return this.get<Ticket>('SELECT * FROM tickets WHERE id = ?', id);
  }

  updateTicket(id: number, patch: Partial<Pick<Ticket, 'status' | 'severity' | 'diagnosis' | 'resolution' | 'title'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k] ?? null);
    const resolved = patch.status === 'resolved' || patch.status === 'closed' ? ", resolved_at = datetime('now')" : '';
    this.run(`UPDATE tickets SET ${sets}, updated_at = datetime('now')${resolved} WHERE id = ?`, ...values, id);
    bus.emitEvent({ type: 'ticket', ticketId: id });
  }

  appendTicketAction(id: number, action: string, result: string) {
    const t = this.getTicket(id);
    if (!t) return;
    const actions = JSON.parse(t.actions) as unknown[];
    actions.push({ at: new Date().toISOString(), action, result });
    this.run("UPDATE tickets SET actions = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(actions), id);
    bus.emitEvent({ type: 'ticket', ticketId: id, userId: t.user_id });
  }

  listTickets(opts: { userId?: number; statuses?: TicketStatus[]; limit?: number } = {}) {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.userId) {
      where.push('user_id = ?');
      params.push(opts.userId);
    }
    if (opts.statuses?.length) {
      where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`);
      params.push(...opts.statuses);
    }
    const sql = `SELECT * FROM tickets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return this.all<Ticket>(sql, ...params, opts.limit ?? 20);
  }

  // ---------- requests / notifications ----------

  addBotRequest(r: Omit<BotRequest, 'id' | 'notified_at' | 'created_at' | 'via'> & Partial<Pick<BotRequest, 'notified_at' | 'created_at' | 'via'>>) {
    this.run(
      "INSERT INTO bot_requests (user_id, source, external_id, tmdb_id, media_type, title, via, notified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))",
      r.user_id,
      r.source,
      r.external_id,
      r.tmdb_id,
      r.media_type,
      r.title,
      r.via ?? null,
      r.notified_at ?? null,
      r.created_at ?? null,
    );
    bus.emitEvent({ type: 'request', userId: r.user_id });
  }

  /** Same request already tracked for this user (by request id, or by title id when the id differs, e.g. a bot request re-imported). */
  hasBotRequest(userId: number, source: string, externalId: string, tmdbId: number | null, mediaType: string) {
    return !!this.get(
      'SELECT 1 FROM bot_requests WHERE user_id = ? AND ((source = ? AND external_id = ?) OR (tmdb_id IS NOT NULL AND tmdb_id = ? AND media_type = ?))',
      userId,
      source,
      externalId,
      tmdbId,
      mediaType,
    );
  }

  pendingBotRequests() {
    return this.all<BotRequest>('SELECT * FROM bot_requests WHERE notified_at IS NULL');
  }

  botRequestsForUser(userId: number, limit = 20) {
    return this.all<BotRequest>('SELECT * FROM bot_requests WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit);
  }

  markBotRequestNotified(id: number) {
    this.run("UPDATE bot_requests SET notified_at = datetime('now') WHERE id = ?", id);
  }

  wasNotified(source: string, externalId: string, userId: number) {
    return !!this.get('SELECT 1 FROM notified WHERE source = ? AND external_id = ? AND user_id = ?', source, externalId, userId);
  }

  markNotified(source: string, externalId: string, userId: number) {
    this.run('INSERT OR IGNORE INTO notified (source, external_id, user_id) VALUES (?, ?, ?)', source, externalId, userId);
  }

  // ---------- watches ----------

  addWatch(w: Pick<Watch, 'user_id' | 'ticket_id' | 'kind' | 'label'> & { ref: unknown }) {
    this.run(
      'INSERT INTO watches (user_id, ticket_id, kind, ref, label) VALUES (?, ?, ?, ?, ?)',
      w.user_id,
      w.ticket_id,
      w.kind,
      JSON.stringify(w.ref),
      w.label,
    );
  }

  openWatches() {
    return this.all<Watch>('SELECT * FROM watches WHERE done = 0');
  }

  closeWatch(id: number) {
    this.run('UPDATE watches SET done = 1 WHERE id = ?', id);
  }

  closeWatchesForTicket(ticketId: number) {
    this.run('UPDATE watches SET done = 1 WHERE ticket_id = ?', ticketId);
  }

  // ---------- action log / kv ----------

  logAction(userId: number | null, ticketId: number | null, action: string, details: unknown) {
    this.run(
      'INSERT INTO action_log (user_id, ticket_id, action, details) VALUES (?, ?, ?, ?)',
      userId,
      ticketId,
      action,
      JSON.stringify(details),
    );
    bus.emitEvent({ type: 'activity', userId });
  }

  countActionsSince(userId: number, action: string, sinceSql: string) {
    return this.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM action_log WHERE user_id = ? AND action = ? AND created_at >= datetime('now', ?)`,
      userId,
      action,
      sinceSql,
    )!.c;
  }

  getKv(key: string) {
    return this.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value;
  }

  setKv(key: string, value: string) {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  // ---------- settings (web UI overrides of env vars) ----------

  listSettings() {
    return this.all<{ key: string; value: string; updated_at: string }>('SELECT * FROM settings ORDER BY key');
  }

  setSetting(key: string, value: string) {
    this.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
      key,
      value,
    );
  }

  deleteSetting(key: string) {
    this.run('DELETE FROM settings WHERE key = ?', key);
  }

  // ---------- LLM usage ----------

  addUsage(u: { userId: number | null; kind: string; model?: string; input?: number; output?: number; durationMs?: number }) {
    this.run(
      'INSERT INTO llm_usage (user_id, kind, model, input_tokens, output_tokens, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
      u.userId,
      u.kind,
      u.model ?? null,
      u.input ?? 0,
      u.output ?? 0,
      u.durationMs ?? null,
    );
  }

  usageTotals(sinceSql: string, userId?: number) {
    return this.get<{ calls: number; input: number; output: number; avg_ms: number | null }>(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, AVG(duration_ms) AS avg_ms
       FROM llm_usage WHERE created_at >= datetime('now', ?) ${userId ? 'AND user_id = ?' : ''}`,
      sinceSql,
      ...(userId ? [userId] : []),
    )!;
  }

  usageByDay(days: number, userId?: number) {
    return this.all<{ day: string; input: number; output: number; calls: number }>(
      `SELECT date(created_at) AS day, SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS calls
       FROM llm_usage WHERE created_at >= datetime('now', ?) ${userId ? 'AND user_id = ?' : ''}
       GROUP BY day ORDER BY day`,
      `-${days} days`,
      ...(userId ? [userId] : []),
    );
  }

  usageByModel(sinceSql: string) {
    return this.all<{ model: string; input: number; output: number; calls: number }>(
      `SELECT COALESCE(model, '?') AS model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS calls
       FROM llm_usage WHERE created_at >= datetime('now', ?) GROUP BY model ORDER BY SUM(input_tokens + output_tokens) DESC`,
      sinceSql,
    );
  }

  // ---------- web sessions ----------

  addSession(tokenHash: string, expiresAt: string, userAgent?: string) {
    this.run('INSERT INTO web_sessions (token_hash, expires_at, user_agent) VALUES (?, ?, ?)', tokenHash, expiresAt, userAgent ?? null);
  }

  getSession(tokenHash: string) {
    return this.get<{ token_hash: string; expires_at: string }>(
      "SELECT * FROM web_sessions WHERE token_hash = ? AND expires_at > datetime('now')",
      tokenHash,
    );
  }

  deleteSession(tokenHash: string) {
    this.run('DELETE FROM web_sessions WHERE token_hash = ?', tokenHash);
  }

  deleteAllSessions() {
    this.run('DELETE FROM web_sessions');
  }

  pruneSessions() {
    this.run("DELETE FROM web_sessions WHERE expires_at <= datetime('now')");
  }

  // ---------- web UI queries ----------

  /** All users with the numbers the user list needs. */
  userOverview() {
    return this.all<UserOverview>(`
      SELECT u.*,
        (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS message_count,
        (SELECT created_at FROM messages m WHERE m.user_id = u.id ORDER BY id DESC LIMIT 1) AS last_message_at,
        (SELECT content FROM messages m WHERE m.user_id = u.id ORDER BY id DESC LIMIT 1) AS last_message,
        (SELECT role FROM messages m WHERE m.user_id = u.id ORDER BY id DESC LIMIT 1) AS last_message_role,
        (SELECT COUNT(*) FROM tickets t WHERE t.user_id = u.id AND t.status IN ('open', 'auto_fixing', 'escalated')) AS open_tickets,
        (SELECT COUNT(*) FROM bot_requests r WHERE r.user_id = u.id) AS request_count,
        (SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM llm_usage l WHERE l.user_id = u.id AND l.created_at >= datetime('now', '-30 days')) AS tokens_30d
      FROM users u
      ORDER BY COALESCE(last_message_at, u.created_at) DESC
    `);
  }

  /** Full message history (including summarized messages), newest last. */
  messagePage(userId: number, opts: { beforeId?: number; limit: number }) {
    return this.all<StoredMessage>(
      `SELECT * FROM (SELECT * FROM messages WHERE user_id = ? ${opts.beforeId ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
      userId,
      ...(opts.beforeId ? [opts.beforeId] : []),
      opts.limit,
    );
  }

  countUsersByStatus() {
    return this.all<{ status: string; c: number }>('SELECT status, COUNT(*) AS c FROM users GROUP BY status');
  }

  countTicketsByStatus() {
    return this.all<{ status: string; c: number }>('SELECT status, COUNT(*) AS c FROM tickets GROUP BY status');
  }

  messagesByDay(days: number) {
    return this.all<{ day: string; incoming: number; outgoing: number }>(
      `SELECT date(created_at) AS day,
         SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS incoming,
         SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS outgoing
       FROM messages WHERE created_at >= datetime('now', ?) GROUP BY day ORDER BY day`,
      `-${days} days`,
    );
  }

  countSince(table: 'messages' | 'bot_requests' | 'tickets', sinceSql: string, extraWhere = '') {
    return this.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE created_at >= datetime('now', ?) ${extraWhere}`, sinceSql)!.c;
  }

  listTicketsWithUser(opts: { statuses?: TicketStatus[]; userId?: number; limit?: number }) {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.userId) {
      where.push('t.user_id = ?');
      params.push(opts.userId);
    }
    if (opts.statuses?.length) {
      where.push(`t.status IN (${opts.statuses.map(() => '?').join(',')})`);
      params.push(...opts.statuses);
    }
    return this.all<Ticket & { user_name: string | null }>(
      `SELECT t.*, COALESCE(u.display_name, u.push_name, u.wa_id) AS user_name FROM tickets t JOIN users u ON u.id = t.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`,
      ...params,
      opts.limit ?? 200,
    );
  }

  listBotRequests(opts: { userId?: number; limit?: number } = {}) {
    return this.all<BotRequest & { user_name: string | null }>(
      `SELECT r.*, COALESCE(u.display_name, u.push_name, u.wa_id) AS user_name FROM bot_requests r JOIN users u ON u.id = r.user_id
       ${opts.userId ? 'WHERE r.user_id = ?' : ''} ORDER BY r.id DESC LIMIT ?`,
      ...(opts.userId ? [opts.userId] : []),
      opts.limit ?? 200,
    );
  }

  listActions(opts: { userId?: number; ticketId?: number; limit?: number } = {}) {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.userId) {
      where.push('a.user_id = ?');
      params.push(opts.userId);
    }
    if (opts.ticketId) {
      where.push('a.ticket_id = ?');
      params.push(opts.ticketId);
    }
    return this.all<ActionLogEntry>(
      `SELECT a.*, COALESCE(u.display_name, u.push_name, u.wa_id) AS user_name FROM action_log a LEFT JOIN users u ON u.id = a.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`,
      ...params,
      opts.limit ?? 100,
    );
  }

  watchesForTicket(ticketId: number) {
    return this.all<Watch>('SELECT * FROM watches WHERE ticket_id = ? ORDER BY id', ticketId);
  }

  /** Permanently removes a user and everything stored about them. */
  deleteUser(id: number) {
    this.db.exec('BEGIN');
    try {
      for (const table of ['messages', 'facts', 'watches', 'bot_requests', 'tickets']) this.run(`DELETE FROM ${table} WHERE user_id = ?`, id);
      this.run('DELETE FROM notified WHERE user_id = ?', id);
      this.run('UPDATE action_log SET user_id = NULL WHERE user_id = ?', id);
      this.run('UPDATE llm_usage SET user_id = NULL WHERE user_id = ?', id);
      this.run('DELETE FROM users WHERE id = ?', id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    bus.emitEvent({ type: 'user', userId: id });
  }
}
