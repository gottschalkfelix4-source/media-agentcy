import type { Config } from '../config.js';
import type { Repo, User } from '../db/repo.js';
import type { Services } from '../integrations/index.js';
import type { LLMProvider } from '../llm/index.js';
import type { Logger } from '../logger.js';

/** Transport for outgoing messages (WhatsApp, console, ...). */
export interface Messenger {
  sendText(user: User, text: string): Promise<void>;
  /** Image from a URL with a caption. Optional: without it the caption goes out as text. */
  sendImage?(user: User, url: string, caption: string): Promise<void>;
  setTyping?(user: User, typing: boolean): Promise<void>;
}

export interface AppContext {
  config: Config;
  repo: Repo;
  services: Services;
  llm: LLMProvider;
  messenger: Messenger;
  logger: Logger;
  /** Queue a system event for a user; the agent writes a message to them about it. */
  dispatchEvent(userId: number, eventText: string): void;
}

/**
 * Sends a message to all admins and stores it in their chat history so the
 * admin agent has the context when the admin replies.
 */
export async function notifyAdmins(ctx: AppContext, text: string) {
  const admins = ctx.repo.listAdmins();
  if (!admins.length) {
    ctx.logger.warn({ text }, 'Keine Admins registriert – Admin-Nachricht nicht zugestellt (ADMIN_NUMBERS setzen und einmal an den Bot schreiben)');
    return;
  }
  for (const admin of admins) {
    try {
      await ctx.messenger.sendText(admin, text);
      ctx.repo.addMessage(admin.id, 'assistant', text);
    } catch (err) {
      ctx.logger.error({ err, admin: admin.id }, 'Admin-Benachrichtigung fehlgeschlagen');
    }
  }
}

export function userLabel(u: User) {
  const name = u.display_name ?? u.push_name ?? 'Unbekannt';
  const phone = u.wa_id.startsWith('lid:') ? u.wa_id : `+${u.wa_id}`;
  return `${name} (#${u.id}, ${phone})`;
}
