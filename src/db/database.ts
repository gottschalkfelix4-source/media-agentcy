import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL UNIQUE,          -- phone number digits (or "lid:<id>" if unknown)
    wa_jid TEXT,                         -- last chat JID we got a message from (used for replies)
    display_name TEXT,
    push_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | active | blocked
    role TEXT NOT NULL DEFAULT 'user',        -- user | admin
    jellyfin_user_id TEXT,
    jellyfin_username TEXT,
    plex_username TEXT,
    seerr_user_id INTEGER,
    ombi_username TEXT,
    summary TEXT,                        -- rolling conversation summary (long-term memory)
    admin_notified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL,                  -- user | assistant | event
    content TEXT NOT NULL,
    summarized INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_messages_user ON messages(user_id, id);

  CREATE TABLE facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    fact TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'agent',  -- agent | admin | summary
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_facts_user ON facts(user_id);

  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'open',   -- open | auto_fixing | escalated | resolved | closed
    severity TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | critical
    category TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    media_ref TEXT,                        -- JSON
    diagnosis TEXT,
    actions TEXT NOT NULL DEFAULT '[]',    -- JSON array of {at, action, result}
    resolution TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX idx_tickets_user ON tickets(user_id, status);

  CREATE TABLE bot_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    source TEXT NOT NULL,                  -- seerr | ombi
    external_id TEXT,                      -- request id in seerr/ombi
    tmdb_id INTEGER,
    media_type TEXT NOT NULL,              -- movie | tv
    title TEXT NOT NULL,
    notified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE notified (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    notified_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source, external_id, user_id)
  );

  CREATE TABLE watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    ticket_id INTEGER REFERENCES tickets(id),
    kind TEXT NOT NULL,                    -- radarr_movie | sonarr_episodes
    ref TEXT NOT NULL,                     -- JSON
    label TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ticket_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE users ADD COLUMN bot_paused INTEGER NOT NULL DEFAULT 0;  -- admin took over the chat
  ALTER TABLE messages ADD COLUMN via TEXT;                            -- NULL = bot/user, 'admin' = written by the admin
  CREATE INDEX idx_messages_created ON messages(created_at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    kind TEXT NOT NULL,                    -- message | event | summary | console
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_usage_user ON llm_usage(user_id, created_at);

  CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    user_agent TEXT
  );
  `,
  `
  ALTER TABLE bot_requests ADD COLUMN via TEXT;  -- NULL = asked the bot, 'web' = imported from the Jellyseerr/Ombi website
  CREATE INDEX idx_bot_requests_user ON bot_requests(user_id, source, external_id);
  `,
  `
  ALTER TABLE users ADD COLUMN digest INTEGER NOT NULL DEFAULT 1;  -- weekly "new on the server" message, 0 = opted out
  `,
];

export function openDatabase(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
