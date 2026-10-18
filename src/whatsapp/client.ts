import { rmSync } from 'node:fs';
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isLidUser,
  isPnUser,
  jidDecode,
  makeWASocket,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys';
import qrcodeTerminal from 'qrcode-terminal';
import type { Messenger } from '../agent/context.js';
import type { Config } from '../config.js';
import type { User } from '../db/repo.js';
import type { ImageInput } from '../llm/index.js';
import type { Logger } from '../logger.js';
import type { IncomingMessage } from '../messaging/router.js';

export type ConnectionState = 'starting' | 'qr' | 'open' | 'closed' | 'logged_out';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SEND_GAP_MS = 800;

export class WhatsAppClient implements Messenger {
  private sock?: WASocket;
  private sendChain: Promise<unknown> = Promise.resolve();
  private reconnectAttempts = 0;
  state: ConnectionState = 'starting';
  latestQr?: string;
  onMessage?: (msg: IncomingMessage) => Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.config.waAuthDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
      version,
      auth: state,
      logger: this.logger.child({ module: 'baileys' }, { level: 'warn' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      if (u.qr) {
        this.state = 'qr';
        this.latestQr = u.qr;
        this.logger.info(`WhatsApp-Login: QR-Code mit dem Bot-Handy scannen (oder http://<host>:${this.config.HTTP_PORT}/qr öffnen)`);
        qrcodeTerminal.generate(u.qr, { small: true });
      }
      if (u.connection === 'open') {
        this.state = 'open';
        this.latestQr = undefined;
        this.reconnectAttempts = 0;
        this.logger.info({ me: sock.user?.id }, 'WhatsApp verbunden');
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          this.state = 'logged_out';
          this.logger.error('WhatsApp abgemeldet – Login-Daten werden gelöscht, neuer QR-Code folgt.');
          rmSync(this.config.waAuthDir, { recursive: true, force: true });
          setTimeout(() => void this.start(), 2000);
          return;
        }
        this.state = 'closed';
        const delay = Math.min(60_000, 2000 * 2 ** this.reconnectAttempts++);
        this.logger.warn({ code, delay }, 'WhatsApp-Verbindung getrennt – neuer Versuch');
        setTimeout(() => void this.start(), delay);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          await this.handleRaw(m);
        } catch (err) {
          this.logger.error({ err }, 'Eingehende Nachricht konnte nicht verarbeitet werden');
        }
      }
    });
  }

  private async handleRaw(m: WAMessage) {
    const jid = m.key.remoteJid;
    if (!jid || m.key.fromMe) return;
    if (!isPnUser(jid) && !isLidUser(jid)) return; // groups, broadcasts, newsletters

    const content = normalizeMessageContent(m.message);
    if (!content) return;

    let text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ??
      '';
    const images: ImageInput[] = [];

    if (content.imageMessage) {
      const size = Number(content.imageMessage.fileLength ?? 0);
      if (this.config.llm.vision && size <= MAX_IMAGE_BYTES) {
        try {
          const buf = await downloadMediaMessage(m, 'buffer', {});
          images.push({ mime: content.imageMessage.mimetype ?? 'image/jpeg', base64: buf.toString('base64') });
        } catch (err) {
          this.logger.warn({ err }, 'Bild-Download fehlgeschlagen');
        }
      }
      if (!images.length) text = `${text}\n[Der Nutzer hat ein Bild geschickt, das du nicht sehen kannst]`.trim();
    } else if (content.audioMessage) {
      text = '[Der Nutzer hat eine Sprachnachricht geschickt. Du kannst sie nicht anhören – bitte ihn freundlich, es kurz zu schreiben.]';
    } else if (content.videoMessage && !text) {
      text = '[Der Nutzer hat ein Video geschickt, das du nicht ansehen kannst]';
    } else if (content.stickerMessage) {
      text = '[Sticker]';
    } else if (content.locationMessage || content.contactMessage) {
      text = '[Standort/Kontakt geteilt]';
    }
    if (!text && !images.length) return;

    const waId = await this.resolveWaId(jid, m.key.remoteJidAlt);
    await this.sock?.readMessages([m.key]).catch(() => undefined);
    await this.onMessage?.({ waId, jid, pushName: m.pushName ?? undefined, text, images: images.length ? images : undefined });
  }

  /** Maps a chat JID (phone-number or LID based) to the phone number digits. */
  private async resolveWaId(jid: string, alt?: string): Promise<string> {
    if (isPnUser(jid)) return jidDecode(jid)!.user;
    if (alt && isPnUser(alt)) return jidDecode(alt)!.user;
    const pn = await this.sock?.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
    if (pn) return jidDecode(pn)!.user;
    return `lid:${jidDecode(jid)!.user}`;
  }

  private jidFor(user: User) {
    if (user.wa_jid) return user.wa_jid;
    if (user.wa_id.startsWith('lid:')) return `${user.wa_id.slice(4)}@lid`;
    return `${user.wa_id}@s.whatsapp.net`;
  }

  async sendText(user: User, text: string) {
    const job = this.sendChain.then(async () => {
      if (!this.sock || this.state !== 'open') throw new Error('WhatsApp nicht verbunden');
      await this.sock.sendMessage(this.jidFor(user), { text });
      await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    });
    this.sendChain = job.catch(() => undefined);
    await job;
  }

  async setTyping(user: User, typing: boolean) {
    if (!this.sock || this.state !== 'open') return;
    await this.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', this.jidFor(user));
  }

  async stop() {
    this.sock?.end(undefined);
  }
}
