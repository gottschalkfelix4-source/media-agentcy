import { blockedBy, capLength, handleBlocked } from '../agent/abuse.js';
import type { Agent } from '../agent/agent.js';
import { notifyAdmins, userLabel, type AppContext } from '../agent/context.js';
import type { User } from '../db/repo.js';
import { bus } from '../events.js';
import { pingAll } from '../integrations/index.js';
import type { ImageInput } from '../llm/index.js';

export interface IncomingMessage {
  /** Phone number digits, or "lid:<id>" when the number is unknown. */
  waId: string;
  /** Chat JID to reply to. */
  jid?: string;
  pushName?: string;
  text: string;
  images?: ImageInput[];
}

interface Pending {
  texts: string[];
  images: ImageInput[];
  timer?: NodeJS.Timeout;
}

/** Live processing state of a user's conversation, shown in the web UI. */
export interface ConversationRuntime {
  state: 'idle' | 'collecting' | 'working';
  /** Jobs waiting behind the current one. */
  queued: number;
  since?: string;
  lastReplyAt?: string;
  lastDurationMs?: number;
  lastError?: { at: string; message: string };
}

/**
 * Routes incoming messages: user lookup/onboarding, access control, slash
 * commands, debouncing of message bursts and strictly sequential processing
 * per user.
 */
export class Router {
  private pending = new Map<number, Pending>();
  private chains = new Map<number, Promise<void>>();
  private runtime = new Map<number, ConversationRuntime>();
  private lastErrorAlert = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly agent: Agent,
  ) {}

  async onIncoming(msg: IncomingMessage) {
    const { repo, config, logger } = this.ctx;
    const isAdminNumber = config.ADMIN_NUMBERS.includes(msg.waId);
    let user = repo.getUserByWaId(msg.waId);
    const isNew = !user;

    if (!user) {
      if (!isAdminNumber && config.UNKNOWN_USER_POLICY === 'ignore') {
        logger.info({ waId: msg.waId }, 'Nachricht von unbekannter Nummer ignoriert');
        return;
      }
      user = repo.createUser(msg.waId, {
        push_name: msg.pushName ?? null,
        status: isAdminNumber || config.UNKNOWN_USER_POLICY === 'open' ? 'active' : 'pending',
        role: isAdminNumber ? 'admin' : 'user',
      });
      logger.info({ user: user.id, waId: msg.waId, status: user.status }, 'Neuer Nutzer');
    }

    repo.updateUser(user.id, {
      wa_jid: msg.jid ?? user.wa_jid,
      push_name: msg.pushName ?? user.push_name,
      last_seen_at: new Date().toISOString(),
      ...(isAdminNumber && (user.role !== 'admin' || user.status !== 'active') ? { role: 'admin', status: 'active' } : {}),
    });
    user = repo.getUser(user.id)!;

    if (user.status === 'blocked') return;

    if (user.bot_paused && user.status === 'active') {
      // Admin took over this chat: keep the message for the web UI and the bot's context, but don't answer.
      repo.addMessage(user.id, 'user', msg.images?.length ? `${msg.text}
[${msg.images.length} Bild(er) gesendet]` : msg.text);
      return;
    }

    if (user.status === 'pending') {
      if (!user.admin_notified_at) {
        repo.updateUser(user.id, { admin_notified_at: new Date().toISOString() });
        repo.addMessage(user.id, 'user', msg.text);
        await this.send(
          user,
          `Hi${msg.pushName ? ' ' + msg.pushName : ''}! 👋 Ich bin ${config.BOT_NAME}, der Assistent für ${config.SERVER_NAME}. Ich kenne deine Nummer noch nicht – ich habe ${config.ADMIN_NAME} Bescheid gegeben, dass du Zugang möchtest. Sobald du freigeschaltet bist, melde ich mich!`,
        );
        await notifyAdmins(
          this.ctx,
          `🆕 Neue Nummer möchte den Bot nutzen: ${userLabel(user)}\nErste Nachricht: "${msg.text.slice(0, 300)}"\n\nSag z.B. "schalte #${user.id} frei, das ist Max, Jellyfin-User max" – oder "sperre #${user.id}".`,
        );
      }
      return;
    }

    if (isNew && user.role !== 'admin') {
      void notifyAdmins(this.ctx, `🆕 Neuer Nutzer (automatisch freigeschaltet): ${userLabel(user)}`);
    }

    if (await this.handleCommand(user, msg.text)) return;
    this.buffer(user.id, msg.text, msg.images);
  }

  /** Live state of all conversations that are not idle, plus the last result per user. */
  runtimeSnapshot(): Record<number, ConversationRuntime> {
    return Object.fromEntries(this.runtime);
  }

  runtimeFor(userId: number): ConversationRuntime {
    return this.runtime.get(userId) ?? { state: 'idle', queued: 0 };
  }

  private setRuntime(userId: number, patch: Partial<ConversationRuntime>) {
    const next = { ...this.runtimeFor(userId), ...patch };
    this.runtime.set(userId, next);
    bus.emitEvent({ type: 'runtime', userId });
  }

  /**
   * Runs a message through the agent in the user's queue and returns the reply
   * without sending it anywhere (web console for the admin agent).
   */
  ask(userId: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.enqueue(
        userId,
        async () => {
          const user = this.ctx.repo.getUser(userId);
          if (!user) throw new Error('Nutzer nicht gefunden');
          resolve(await this.agent.handleMessage(user, text, undefined, 'console'));
        },
        { onError: reject, silent: true },
      );
    });
  }

  /** Queue a system event for a user (notifications, admin messages). */
  dispatchEvent(userId: number, eventText: string) {
    this.enqueue(userId, async () => {
      const user = this.ctx.repo.getUser(userId);
      if (!user || user.status !== 'active') return;
      const reply = await this.agent.handleEvent(user, eventText);
      await this.send(user, reply);
    });
  }

  private async handleCommand(user: User, text: string): Promise<boolean> {
    const cmd = text.trim().toLowerCase();
    if (!cmd.startsWith('/')) return false;
    switch (cmd.split(/\s+/)[0]) {
      case '/reset':
        this.ctx.repo.clearHistory(user.id);
        await this.send(user, '🧹 Gesprächsverlauf zurückgesetzt. Was ich mir dauerhaft über dich gemerkt habe, bleibt erhalten.');
        return true;
      case '/hilfe':
      case '/help':
        await this.send(
          user,
          `Ich bin ${this.ctx.config.BOT_NAME} 🤖 Schreib mir einfach ganz normal, z.B.:\n- "Kannst du Dune 2 besorgen?"\n- "Bei The Office S3E5 hängt der Ton"\n- "Was ist mit meinen Anfragen?"\n\nBefehle: /reset (Verlauf leeren)${user.role === 'admin' ? ', /status (Dienste prüfen)' : ''}`,
        );
        return true;
      case '/status':
        if (user.role !== 'admin') return false;
        await this.send(user, Object.entries(await pingAll(this.ctx.services)).map(([k, v]) => `*${k}*: ${v}`).join('\n') || 'Keine Dienste konfiguriert.');
        return true;
      default:
        return false;
    }
  }

  private buffer(userId: number, text: string, images?: ImageInput[]) {
    let p = this.pending.get(userId);
    if (!p) {
      p = { texts: [], images: [] };
      this.pending.set(userId, p);
    }
    if (text) p.texts.push(text);
    if (images?.length) p.images.push(...images);
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.flush(userId), this.ctx.config.DEBOUNCE_MS);
    if (this.runtimeFor(userId).state === 'idle') this.setRuntime(userId, { state: 'collecting', since: new Date().toISOString() });
  }

  private flush(userId: number) {
    const p = this.pending.get(userId);
    this.pending.delete(userId);
    if (!p || (!p.texts.length && !p.images.length)) return;
    const text = p.texts.join('\n') || '(Bild ohne Text)';
    const images = p.images.slice(0, 4);
    this.enqueue(userId, async () => {
      const user = this.ctx.repo.getUser(userId);
      if (!user || user.status !== 'active') return;
      const blocked = blockedBy(this.ctx, user);
      if (blocked) return handleBlocked(this.ctx, user, text, blocked, (t) => this.send(user, t));
      const reply = await this.agent.handleMessage(user, capLength(this.ctx, user, text), images.length ? images : undefined);
      await this.send(user, reply);
    });
  }

  private enqueue(userId: number, job: () => Promise<void>, opts: { onError?: (err: unknown) => void; silent?: boolean } = {}) {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const rt = this.runtimeFor(userId);
    if (rt.state === 'working') this.setRuntime(userId, { queued: rt.queued + 1 });
    const next = prev.then(async () => {
      const user = this.ctx.repo.getUser(userId);
      const started = Date.now();
      const cur = this.runtimeFor(userId);
      this.setRuntime(userId, { state: 'working', since: new Date(started).toISOString(), queued: cur.state === 'working' ? Math.max(0, cur.queued - 1) : cur.queued });
      if (user && !opts.silent) await this.ctx.messenger.setTyping?.(user, true).catch(() => undefined);
      try {
        await job();
        this.setRuntime(userId, { lastReplyAt: new Date().toISOString(), lastDurationMs: Date.now() - started });
      } catch (err) {
        this.setRuntime(userId, { lastError: { at: new Date().toISOString(), message: (err as Error).message?.slice(0, 300) ?? String(err) } });
        if (opts.onError) opts.onError(err);
        else await this.onError(userId, err);
      } finally {
        if (user && !opts.silent) await this.ctx.messenger.setTyping?.(user, false).catch(() => undefined);
        const after = this.runtimeFor(userId);
        if (after.queued === 0 && !this.pending.has(userId)) this.setRuntime(userId, { state: 'idle', since: undefined });
      }
    });
    this.chains.set(userId, next);
    void next.finally(() => {
      if (this.chains.get(userId) === next) this.chains.delete(userId);
    });
  }

  private async onError(userId: number, err: unknown) {
    this.ctx.logger.error({ err, user: userId }, 'Verarbeitung fehlgeschlagen');
    const user = this.ctx.repo.getUser(userId);
    if (user) {
      await this.send(user, '😕 Da ist bei mir gerade etwas schiefgelaufen. Versuch es bitte gleich nochmal – falls es weiter hakt, sage ich dem Admin Bescheid.').catch(
        () => undefined,
      );
    }
    if (Date.now() - this.lastErrorAlert > 30 * 60_000 && user?.role !== 'admin') {
      this.lastErrorAlert = Date.now();
      await notifyAdmins(this.ctx, `❗ Bot-Fehler bei ${user ? userLabel(user) : `#${userId}`}: ${(err as Error).message?.slice(0, 400)}`);
    }
  }

  private async send(user: User, text: string) {
    await this.ctx.messenger.sendText(user, text);
  }
}
