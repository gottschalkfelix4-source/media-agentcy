import { randomInt } from 'node:crypto';
import type { User } from '../db/repo.js';
import type { AppContext } from './context.js';

/**
 * New users: create a Jellyfin account, link it (and a Jellyseerr account imported from it) and send the
 * login data with a short guide. The password goes straight to WhatsApp, never through the LLM, and the
 * stored chat history only keeps a redacted copy.
 */

const PASSWORD_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function password() {
  return Array.from({ length: 12 }, () => PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)]).join('');
}

/** "Jörg Müller" → "joerg.mueller" */
export function usernameFor(user: User) {
  const base = (user.display_name ?? user.push_name ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 24);
  return base.length >= 2 ? base : `nutzer${user.id}`;
}

export interface OnboardResult {
  jellyfin?: { username: string; created: boolean };
  seerrUserId?: number;
  /** Text for the welcome event, so the bot knows what the user already got. */
  note?: string;
  errors: string[];
}

export async function onboardUser(ctx: AppContext, user: User): Promise<OnboardResult> {
  const { services, repo, config, messenger, logger } = ctx;
  const result: OnboardResult = { errors: [] };
  const { jellyfin, seerr } = services;
  if (!jellyfin) return { errors: ['Jellyfin ist nicht konfiguriert'] };
  if (user.jellyfin_user_id || user.jellyfin_username) return { errors: ['Nutzer hat schon ein Jellyfin-Konto verknüpft'] };

  const taken = new Set((await jellyfin.users()).map((u) => u.name.toLowerCase()));
  const base = usernameFor(user);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  const pw = password();

  const created = await jellyfin.createUser(name, pw);
  repo.updateUser(user.id, { jellyfin_username: created.name, jellyfin_user_id: created.id });
  repo.logAction(user.id, null, 'jellyfin_account_created', { username: created.name });
  result.jellyfin = { username: created.name, created: true };

  if (seerr && !user.seerr_user_id) {
    try {
      const imported = await seerr.importFromJellyfin([created.id]);
      const su = imported.find((u) => u.jellyfinUsername?.toLowerCase() === created.name.toLowerCase()) ?? imported[0] ?? (await seerr.findUserByName(created.name));
      if (su) {
        repo.updateUser(user.id, { seerr_user_id: su.id });
        result.seerrUserId = su.id;
      }
    } catch (err) {
      result.errors.push(`Jellyseerr-Import: ${(err as Error).message}`);
    }
  }

  const server = config.JELLYFIN_PUBLIC_URL ?? jellyfin.publicUrl;
  const lines = [
    '🎟️ *Dein Zugang ist da!*',
    '',
    ...(server ? [`Server: ${server}`] : []),
    `Benutzer: ${created.name}`,
    `Passwort: ${pw}`,
    '',
    '📱 So geht’s: Lade die App *Jellyfin* (App Store, Play Store oder auf dem Fernseher), gib die Server-Adresse ein und melde dich an. Im Browser geht es auch direkt über die Adresse.',
    ...(result.seerrUserId && config.SEERR_PUBLIC_URL ? ['', `🎬 Filme und Serien wünschen kannst du dir hier bei mir oder auf ${config.SEERR_PUBLIC_URL} (gleiche Anmeldedaten).`] : []),
    '',
    'Bitte ändere das Passwort nach der ersten Anmeldung (Einstellungen → Profil).',
    ...(config.ONBOARD_GUIDE ? ['', config.ONBOARD_GUIDE] : []),
  ];
  const text = lines.join('\n');
  try {
    await messenger.sendText(user, text);
    repo.addMessage(user.id, 'assistant', text.replace(`Passwort: ${pw}`, 'Passwort: •••••• (nur per WhatsApp verschickt)'));
  } catch (err) {
    logger.warn({ err, user: user.id }, 'Zugangsdaten konnten nicht gesendet werden');
    result.errors.push(`Zugangsdaten nicht zugestellt (${(err as Error).message}). Passwort im Jellyfin-Dashboard neu setzen.`);
  }

  result.note = `Der Nutzer hat gerade automatisch ein Jellyfin-Konto (Benutzer "${created.name}") bekommen und die Zugangsdaten samt kurzer Anleitung schon per Nachricht erhalten. Wiederhole die Zugangsdaten nicht, biete aber Hilfe bei der Einrichtung der App an.`;
  return result;
}

/** At approval: onboard if enabled, never fails the approval itself. */
export async function onboardOnApproval(ctx: AppContext, user: User, force?: boolean) {
  const enabled = force ?? ctx.config.ONBOARD_JELLYFIN;
  if (!enabled || !ctx.services.jellyfin || user.jellyfin_user_id || user.jellyfin_username) return undefined;
  try {
    return await onboardUser(ctx, user);
  } catch (err) {
    ctx.logger.warn({ err, user: user.id }, 'Jellyfin-Konto konnte nicht angelegt werden');
    return { errors: [`Jellyfin-Konto: ${(err as Error).message}`] } satisfies OnboardResult;
  }
}
