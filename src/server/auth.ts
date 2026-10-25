import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';

const HASH_KEY = 'web_password_hash';
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'ma_session';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/** Failed logins per IP; after this long without a new failure the counter starts from zero again. */
const FAILURE_RESET_MS = 60 * 60_000;

function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Async so a flood of login attempts doesn't block the event loop (and with it WhatsApp).
async function verifyHash(password: string, stored: string) {
  const [, saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Password login for the web UI.
 * - WEB_PASSWORD set → that password (can't be changed in the UI).
 * - Otherwise a hash stored in the database. On first start a random password is generated and logged.
 */
export class WebAuth {
  private failures = new Map<string, { count: number; until: number; last: number }>();

  constructor(
    private readonly repo: Repo,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  get passwordFromEnv() {
    return !!this.config.WEB_PASSWORD;
  }

  /** Generates an initial password if none exists. */
  init() {
    this.repo.pruneSessions();
    if (this.passwordFromEnv || this.repo.getKv(HASH_KEY)) return;
    const password = randomBytes(9).toString('base64url');
    this.repo.setKv(HASH_KEY, hashPassword(password));
    this.logger.warn(
      `Web-Oberfläche: Erstes Passwort ist  ${password}  – bitte nach dem Login unter Einstellungen → System ändern (oder WEB_PASSWORD setzen).`,
    );
  }

  async checkPassword(password: string) {
    if (this.config.WEB_PASSWORD) return safeEqual(password, this.config.WEB_PASSWORD);
    const stored = this.repo.getKv(HASH_KEY);
    return !!stored && (await verifyHash(password, stored));
  }

  /** Returns a remaining lockout in seconds, or 0. */
  lockedFor(ip: string) {
    const f = this.failures.get(ip);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }

  async login(password: string, ip: string, userAgent?: string): Promise<{ ok: true; token: string; maxAge: number } | { ok: false; error: string }> {
    const locked = this.lockedFor(ip);
    if (locked) return { ok: false, error: `Zu viele Versuche – bitte ${locked} s warten` };
    if (!(await this.checkPassword(password))) {
      const now = Date.now();
      this.pruneFailures(now);
      const prev = this.failures.get(ip);
      const f = prev && now - prev.last < FAILURE_RESET_MS ? prev : { count: 0, until: 0, last: now };
      f.count++;
      f.last = now;
      if (f.count >= 5) {
        f.until = Date.now() + 60_000 * Math.min(15, 2 ** (f.count - 5));
        this.logger.warn({ ip }, 'Web-Login: zu viele Fehlversuche');
      }
      this.failures.set(ip, f);
      return { ok: false, error: 'Falsches Passwort' };
    }
    this.failures.delete(ip);
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    this.repo.addSession(sha256(token), expires.toISOString().replace('T', ' ').slice(0, 19), userAgent?.slice(0, 200));
    return { ok: true, token, maxAge: SESSION_DAYS * 86_400 };
  }

  /** Keeps the map from growing without bound when attempts come from many addresses. */
  private pruneFailures(now: number) {
    if (this.failures.size < 1000) return;
    for (const [ip, f] of this.failures) if (f.until < now && now - f.last >= FAILURE_RESET_MS) this.failures.delete(ip);
  }

  validSession(token: string | undefined) {
    return !!token && !!this.repo.getSession(sha256(token));
  }

  logout(token: string | undefined) {
    if (token) this.repo.deleteSession(sha256(token));
  }

  async changePassword(current: string, next: string): Promise<string | undefined> {
    if (this.passwordFromEnv) return 'Das Passwort kommt aus WEB_PASSWORD und kann nur dort geändert werden.';
    if (!(await this.checkPassword(current))) return 'Aktuelles Passwort ist falsch';
    if (next.length < 8) return 'Das neue Passwort braucht mindestens 8 Zeichen';
    this.repo.setKv(HASH_KEY, hashPassword(next));
    this.repo.deleteAllSessions();
    return undefined;
  }
}
