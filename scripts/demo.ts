/**
 * Demo server for the web UI: seeded sample data, no WhatsApp, no real LLM.
 * Data lives in a throw-away temp directory; nothing is sent anywhere.
 *
 *   npm run build:web && npm run demo     → http://localhost:8090  (password: demo)
 *
 * Alongside `npm run dev:web` the Vite dev server proxies /api to this port.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

Object.assign(process.env, {
  DATA_DIR: mkdtempSync(path.join(tmpdir(), 'media-agentcy-demo-')),
  WEB_PASSWORD: process.env.DEMO_PASSWORD ?? 'demo',
  HTTP_PORT: process.env.DEMO_PORT ?? '8090',
  ADMIN_NUMBERS: '4915100000001',
  ADMIN_NAME: 'Felix',
  BOT_NAME: 'Kino-Bot',
  LLM_PROVIDER: 'custom',
  LLM_BASE_URL: 'http://demo.invalid/v1',
  LLM_MODEL: 'demo-model',
  DEBOUNCE_MS: '500',
});

const { createApp } = await import('../src/app.js');
const { startHttpServer } = await import('../src/server/http.js');
const { bus } = await import('../src/events.js');

const app = createApp({
  async sendText(user, text) {
    app.ctx.logger.info({ to: user.wa_id, text }, 'Demo: Nachricht (nicht gesendet)');
  },
});
app.ctx.llm = {
  name: 'demo',
  async complete() {
    await new Promise((r) => setTimeout(r, 1200));
    return { content: 'Das ist eine Demo-Antwort – im Demo-Modus ist kein echtes Sprachmodell angebunden. 🙂', toolCalls: [] };
  },
};
app.ensureAdminUsers();

const repo = app.repo;
const db = (repo as unknown as { db: DatabaseSync }).db;
/** Moves a row back in time so lists, charts and day separators look realistic. */
const backdate = (table: string, column: string, id: number | bigint, minutesAgo: number) =>
  db.prepare(`UPDATE ${table} SET ${column} = datetime('now', ?) WHERE id = ?`).run(`-${Math.round(minutesAgo)} minutes`, id);
const lastId = (table: string) => (db.prepare(`SELECT max(id) AS id FROM ${table}`).get() as { id: number }).id;

const H = 60;
const D = 24 * H;

// ---------- users ----------
const anna = repo.createUser('4915112345678', { status: 'active', display_name: 'Anna', push_name: 'Anna 🌻', jellyfin_username: 'anna', seerr_user_id: 3 });
const ben = repo.createUser('4917698765432', { status: 'active', display_name: 'Ben', push_name: 'Ben', plex_username: 'benflix', summary: 'Ben schaut viel Anime, meldet gerne Untertitel-Probleme.' });
const clara = repo.createUser('4915223344556', { status: 'active', display_name: 'Clara', push_name: 'Clara', jellyfin_username: 'clara', bot_paused: 1 });
const dave = repo.createUser('4916011122233', { status: 'pending', push_name: 'Dave' });
const eve = repo.createUser('4917155566677', { status: 'pending', push_name: 'Eve M.' });
const spam = repo.createUser('4915999900000', { status: 'blocked', push_name: 'Gewinnspiel' });
for (const [u, ago] of [[anna, 12], [ben, 3 * H], [clara, 25], [dave, 40], [eve, 2 * D], [spam, 6 * D]] as const) {
  db.prepare("UPDATE users SET last_seen_at = datetime('now', ?), created_at = datetime('now', '-20 days') WHERE id = ?").run(`-${ago} minutes`, u.id);
}

// ---------- conversations ----------
function chat(userId: number, lines: [role: 'user' | 'assistant' | 'event', text: string, minutesAgo: number, via?: 'admin'][]) {
  for (const [role, text, ago, via] of lines) {
    repo.addMessage(userId, role, text, via);
    backdate('messages', 'created_at', lastId('messages'), ago);
  }
}
chat(anna.id, [
  ['user', 'Hi! Kannst du mir *Dune: Part Two* besorgen?', 2 * D + 30],
  ['assistant', 'Klar! Ich habe *Dune: Part Two (2024)* angefragt. Ich sag dir Bescheid, sobald er verfügbar ist. 🎬', 2 * D + 29],
  ['event', 'Benachrichtigung: „Dune: Part Two“ ist jetzt verfügbar.', D + 3 * H],
  ['assistant', 'Gute Nachrichten: *Dune: Part Two* ist jetzt auf Jellyfin verfügbar! 🍿', D + 3 * H],
  ['user', 'Bei Folge 3 von The Bear ruckelt es ständig und der Ton ist asynchron', 20],
  ['assistant', 'Danke für die Meldung! Ich habe die Datei geprüft: Sie ist ein HEVC-Remux, der beim Transcodieren Probleme macht. Ich habe eine neue Version gesucht – das dauert meist ein paar Minuten.', 19],
  ['user', 'Super, danke!', 12],
  ['assistant', 'Gern! Ich melde mich, sobald die neue Datei da ist.', 12],
]);
chat(ben.id, [
  ['user', 'Die Untertitel bei Frieren sind komplett verschoben', 3 * D],
  ['assistant', 'Ich habe die Untertitel neu einlesen lassen. Kannst du es nochmal versuchen?', 3 * D - 2],
  ['user', 'Immer noch kaputt :(', 3 * H + 5],
  ['assistant', 'Das konnte ich leider nicht automatisch beheben – ich habe Felix informiert, er kümmert sich darum.', 3 * H + 4],
  ['assistant', 'Hey Ben, ich schau mir das heute Abend an. – Felix', 3 * H, 'admin'],
]);
chat(clara.id, [
  ['user', 'Wann kommt die neue Staffel Severance?', 50],
  ['assistant', 'Die zweite Staffel ist bereits angefragt und wird geladen, sobald sie erscheint.', 49],
  ['user', 'Kann ich auch meinen Freund freischalten lassen?', 25],
]);
chat(dave.id, [['user', 'Hallo, Anna hat mir die Nummer gegeben – kann ich auch Filme schauen?', 40]]);
chat(eve.id, [['user', 'Hi 👋', 2 * D]]);
chat(spam.id, [['user', 'Sie haben gewonnen!!! Klicken Sie hier …', 6 * D]]);

// ---------- memory ----------
repo.addFact(anna.id, 'Schaut am liebsten Sci-Fi und Dokus', 'agent');
repo.addFact(anna.id, 'Nutzt Jellyfin auf dem Fire TV im Wohnzimmer', 'agent');
repo.addFact(ben.id, 'Bevorzugt japanischen Ton mit deutschen Untertiteln', 'agent');
repo.addFact(ben.id, 'Hat Plex-Zugang über Felix’ Server', 'admin');
repo.addFact(clara.id, 'Wartet auf Severance Staffel 2', 'agent');

// ---------- tickets ----------
const t1 = repo.createTicket({ user_id: anna.id, title: 'The Bear S02E03 ruckelt, Ton asynchron', description: 'Wiedergabe ruckelt und Ton läuft auseinander.', category: 'playback', severity: 'normal', media_ref: { title: 'The Bear', season: 2, episode: 3 } });
repo.appendTicketAction(t1.id, 'diagnose', 'HEVC Remux 4K, Transcoding am Limit');
repo.appendTicketAction(t1.id, 'replace_file', 'Sonarr: Suche nach neuer Version gestartet');
repo.updateTicket(t1.id, { status: 'auto_fixing', diagnosis: 'Datei transcodiert schlecht (HEVC 4K Remux).' });
backdate('tickets', 'created_at', t1.id, 20);

const t2 = repo.createTicket({ user_id: ben.id, title: 'Frieren: Untertitel verschoben', description: 'Untertitel laufen bei allen Folgen ca. 3 s zu spät.', category: 'audio_subtitles', severity: 'low', media_ref: { title: 'Frieren' } });
repo.appendTicketAction(t2.id, 'refresh_metadata', 'Metadaten und Untertitel neu eingelesen');
repo.appendTicketAction(t2.id, 'escalate', 'Automatische Behebung erfolglos');
repo.updateTicket(t2.id, { status: 'escalated', diagnosis: 'Untertiteldatei hat falsches Timing.' });
backdate('tickets', 'created_at', t2.id, 3 * D);

const t3 = repo.createTicket({ user_id: anna.id, title: 'Interstellar fehlt in der Bibliothek', description: 'Film wird nicht gefunden.', category: 'missing_media', severity: 'low' });
repo.appendTicketAction(t3.id, 'rescan', 'Bibliothek „Filme“ neu gescannt');
repo.updateTicket(t3.id, { status: 'resolved', resolution: 'Nach dem Bibliotheks-Scan wieder verfügbar.' });
backdate('tickets', 'created_at', t3.id, 5 * D);

const t4 = repo.createTicket({ user_id: clara.id, title: 'Server nicht erreichbar', description: 'Jellyfin lädt nicht.', category: 'server', severity: 'high' });
repo.updateTicket(t4.id, { status: 'escalated' });
backdate('tickets', 'created_at', t4.id, 4 * H);

// ---------- requests ----------
repo.addBotRequest({ user_id: anna.id, source: 'seerr', external_id: '101', tmdb_id: 693134, media_type: 'movie', title: 'Dune: Part Two' });
db.prepare("UPDATE bot_requests SET notified_at = datetime('now', '-1 day'), created_at = datetime('now', '-2 days') WHERE id = ?").run(lastId('bot_requests'));
repo.addBotRequest({ user_id: clara.id, source: 'seerr', external_id: '102', tmdb_id: 95396, media_type: 'tv', title: 'Severance' });
backdate('bot_requests', 'created_at', lastId('bot_requests'), 49);
repo.addBotRequest({ user_id: ben.id, source: 'ombi', external_id: '7', tmdb_id: 209867, media_type: 'tv', title: 'Frieren: Beyond Journey’s End' });
backdate('bot_requests', 'created_at', lastId('bot_requests'), 8 * D);

// ---------- activity ----------
const acts: [number | null, number | null, string, unknown, number][] = [
  [anna.id, null, 'request_media', { title: 'Dune: Part Two', tmdbId: 693134 }, 2 * D + 29],
  [anna.id, t3.id, 'rescan', { library: 'Filme' }, 5 * D],
  [ben.id, t2.id, 'refresh_metadata', { item: 'Frieren' }, 3 * D - 2],
  [clara.id, null, 'request_media', { title: 'Severance', tmdbId: 95396 }, 49],
  [anna.id, t1.id, 'replace_file', { series: 'The Bear', season: 2, episode: 3 }, 19],
  [ben.id, null, 'web_message', { length: 52 }, 3 * H],
];
for (const [u, t, a, d, ago] of acts) {
  repo.logAction(u, t, a, d);
  backdate('action_log', 'created_at', lastId('action_log'), ago);
}

// ---------- LLM usage (14 days) ----------
const users = [anna.id, ben.id, clara.id];
for (let day = 13; day >= 0; day--) {
  const calls = 3 + ((day * 7) % 9);
  for (let i = 0; i < calls; i++) {
    repo.addUsage({ userId: users[(day + i) % 3], kind: i % 5 === 4 ? 'event' : 'message', model: 'demo-model', input: 1800 + ((i * 337) % 2400), output: 90 + ((i * 53) % 400), durationMs: 900 + ((i * 271) % 3000) });
    backdate('llm_usage', 'created_at', lastId('llm_usage'), day * D + i * 37);
  }
}

// Fake WhatsApp connection so the status pages have something to show.
const whatsapp = {
  state: 'open',
  me: { id: '4915100000099', name: 'Kino-Bot' },
  connectedSince: new Date(Date.now() - 3 * 3600_000).toISOString(),
  latestQr: undefined,
  async logout() {},
  async restart() {},
};

bus.emitEvent({ type: 'user', userId: anna.id });
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
startHttpServer({ app, whatsapp: whatsapp as never, version });
app.ctx.logger.info(`Demo läuft auf http://localhost:${app.ctx.config.HTTP_PORT} – Passwort steht in scripts/demo.ts (WEB_PASSWORD)`);
