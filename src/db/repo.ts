import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

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
}

export interface StoredMessage {
  id: number;
  user_id: number;
  role: 'user' | 'assistant' | 'event';
  content: string;
  summarized: number;
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
    return this.getUser(id)!;
  }

  updateUser(id: number, patch: UserPatch) {
    const keys = Object.keys(patch).filter((k) => (USER_FIELDS as readonly string[]).includes(k));
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (patch as Record<string, SQLInputValue>)[k] ?? null);
    this.run(`UPDATE users SET ${sets} WHERE id = ?`, ...values, id);
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

  addMessage(userId: number, role: StoredMessage['role'], content: string) {
    this.run('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)', userId, role, content);
  }

  recentMessages(userId: number, limit: number) {
    return this.all<StoredMessage>(
      'SELECT * FROM (SELECT * FROM messages WHERE user_id = ? AND summarized = 0 ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
      userId,
      limit,
    );
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
    return this.getTicket(Number(res.lastInsertRowid))!;
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
  }

  appendTicketAction(id: number, action: string, result: string) {
    const t = this.getTicket(id);
    if (!t) return;
    const actions = JSON.parse(t.actions) as unknown[];
    actions.push({ at: new Date().toISOString(), action, result });
    this.run("UPDATE tickets SET actions = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(actions), id);
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

  addBotRequest(r: Omit<BotRequest, 'id' | 'notified_at' | 'created_at'>) {
    this.run(
      'INSERT INTO bot_requests (user_id, source, external_id, tmdb_id, media_type, title) VALUES (?, ?, ?, ?, ?, ?)',
      r.user_id,
      r.source,
      r.external_id,
      r.tmdb_id,
      r.media_type,
      r.title,
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
}
