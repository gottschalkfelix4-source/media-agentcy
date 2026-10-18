import { notifyAdmins, userLabel, type AppContext } from '../agent/context.js';
import type { BotRequest, Watch } from '../db/repo.js';
import { normalizeTitle } from '../integrations/http.js';
import type { SeerrRequest } from '../integrations/seerr.js';
import { syncRequests } from './requestSync.js';
import { maybeSendDigest } from './digest.js';
import { checkDisruptions } from './outage.js';
import { checkStuckRequests } from './stuck.js';

const WATCH_TIMEOUT_HOURS = 72;
const AVAILABLE = 5;
const PARTIAL = 4;

/**
 * Periodically checks:
 * - requests (made via the bot or by linked users on the website) that became available
 * - auto-fix watches (replaced/searched files) that have a file again
 */
export class Poller {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  start() {
    const ms = Math.max(1, this.ctx.config.NOTIFY_POLL_MINUTES) * 60_000;
    setTimeout(() => void this.runOnce(), 15_000);
    this.timer = setInterval(() => void this.runOnce(), ms);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Applies a changed interval. */
  restart() {
    this.stop();
    this.timer = setInterval(() => void this.runOnce(), Math.max(1, this.ctx.config.NOTIFY_POLL_MINUTES) * 60_000);
  }

  get busy() {
    return this.running;
  }

  lastRun?: { at: string; ok: boolean };

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const results = [
        await this.step('health', () => checkDisruptions(this.ctx)),
        await this.step('request-sync', () => this.syncRequests()),
        await this.step('bot-requests', () => this.checkBotRequests()),
        await this.step('seerr', () => this.checkSeerr()),
        await this.step('ombi', () => this.checkOmbi()),
        await this.step('watches', () => this.checkWatches()),
        await this.step('stuck-requests', () => this.stuckRequests()),
        await this.step('digest', () => maybeSendDigest(this.ctx)),
      ];
      this.lastRun = { at: new Date().toISOString(), ok: results.every(Boolean) };
    } finally {
      this.running = false;
    }
  }

  private async step(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      return true;
    } catch (err) {
      this.ctx.logger.warn({ err, step: name }, 'Poller-Schritt fehlgeschlagen');
      return false;
    }
  }

  private notify(userId: number, event: string, template: string) {
    const { config, repo, messenger } = this.ctx;
    if (config.NOTIFY_STYLE === 'ai') {
      this.ctx.dispatchEvent(userId, event);
      return;
    }
    const user = repo.getUser(userId);
    if (!user || user.status !== 'active') return;
    void messenger
      .sendText(user, template)
      .then(() => repo.addMessage(userId, 'assistant', template))
      .catch((err: unknown) => this.ctx.logger.warn({ err }, 'Benachrichtigung fehlgeschlagen'));
  }

  /** Deliberately the same for Jellyfin and Plex users: the bot never names a specific media server here. */
  private availableEvent(title: string, type: string, partial: boolean) {
    const neutral = 'Nenne dabei keinen bestimmten Mediaserver (weder Jellyfin noch Plex), sag einfach, dass es jetzt zum Schauen bereitsteht.';
    return partial
      ? {
          event: `Die angefragte Serie "${title}" ist jetzt *teilweise* verfügbar (erste Folgen/Staffeln sind da, der Rest folgt). Sag dem Nutzer kurz Bescheid. ${neutral}`,
          template: `📺 Gute Nachrichten: Die ersten Folgen von *${title}* sind jetzt da, der Rest folgt!`,
        }
      : {
          event: `Die Anfrage "${title}" (${type === 'movie' ? 'Film' : 'Serie'}) ist abgeschlossen und jetzt verfügbar. Sag dem Nutzer kurz und freundlich Bescheid (viel Spaß wünschen). ${neutral}`,
          template: `🎬 *${title}* ist jetzt verfügbar. Viel Spaß beim Schauen!`,
        };
  }

  /** Hängende Anfragen, at most once an hour (each request itself only once a day). */
  private async stuckRequests() {
    const last = this.ctx.repo.getKv('stuck_last_run');
    if (last && Date.now() - Date.parse(last) < 3_600_000) return;
    this.ctx.repo.setKv('stuck_last_run', new Date().toISOString());
    await checkStuckRequests(this.ctx);
  }

  /**
   * Website requests → bot_requests (before the checks, so already finished requests of newly linked users are
   * stored as done instead of being announced). A full pass hourly and whenever account links changed,
   * otherwise only the newest 100.
   */
  private async syncRequests() {
    const { repo } = this.ctx;
    const lastFull = repo.getKv('requests_full_sync');
    const links = repo
      .listUsers('active')
      .map((u) => [u.id, u.seerr_user_id, u.ombi_username, u.jellyfin_username, u.plex_username].join('|'))
      .join(',');
    const full = !lastFull || Date.now() - Date.parse(lastFull) > 3_600_000 || repo.getKv('requests_sync_links') !== links;
    const res = await syncRequests(this.ctx, { full });
    if (full && !res.errors.length) {
      repo.setKv('requests_full_sync', new Date().toISOString());
      repo.setKv('requests_sync_links', links);
    }
    if (res.errors.length) throw new Error(res.errors.join('; '));
  }

  private async checkBotRequests() {
    const { seerr, ombi } = this.ctx.services;
    const pending = this.ctx.repo.pendingBotRequests();
    if (!pending.length) return;
    let ombiMovies: Awaited<ReturnType<NonNullable<typeof ombi>['movieRequests']>> | undefined;
    let ombiTv: Awaited<ReturnType<NonNullable<typeof ombi>['tvRequests']>> | undefined;

    for (const r of pending) {
      let status: number | undefined;
      if (r.source === 'seerr' && seerr && r.tmdb_id) {
        const d = await seerr.details(r.media_type, r.tmdb_id).catch(() => undefined);
        status = d?.mediaInfo?.status;
      } else if (r.source === 'ombi' && ombi) {
        status = await this.ombiStatus(r, async () => (ombiMovies ??= await ombi.movieRequests()), async () => (ombiTv ??= await ombi.tvRequests()));
      }
      if (status === AVAILABLE) {
        const { event, template } = this.availableEvent(r.title, r.media_type, false);
        this.ctx.repo.markBotRequestNotified(r.id);
        if (r.external_id) this.ctx.repo.markNotified(r.source, r.external_id, r.user_id);
        this.notify(r.user_id, event, template);
      } else if (status === PARTIAL && r.media_type === 'tv' && !this.ctx.repo.wasNotified('partial', String(r.id), r.user_id)) {
        const { event, template } = this.availableEvent(r.title, r.media_type, true);
        this.ctx.repo.markNotified('partial', String(r.id), r.user_id);
        this.notify(r.user_id, event, template);
      }
    }
  }

  private async ombiStatus(
    r: BotRequest,
    movies: () => Promise<{ theMovieDbId: number; title: string; available: boolean }[]>,
    tv: () => Promise<{ title: string; childRequests?: { available: boolean }[] }[]>,
  ) {
    if (r.media_type === 'movie') {
      const m = (await movies()).find((x) => x.theMovieDbId === r.tmdb_id || normalizeTitle(x.title) === normalizeTitle(r.title));
      return m?.available ? AVAILABLE : undefined;
    }
    const t = (await tv()).find((x) => normalizeTitle(x.title) === normalizeTitle(r.title));
    if (!t?.childRequests?.length) return undefined;
    if (t.childRequests.every((c) => c.available)) return AVAILABLE;
    if (t.childRequests.some((c) => c.available)) return PARTIAL;
    return undefined;
  }

  /** Requests made on the Jellyseerr website by linked users. */
  private async checkSeerr() {
    const { seerr } = this.ctx.services;
    if (!seerr) return;
    const { repo } = this.ctx;
    const requests = await seerr.recentRequests('available', 100);
    const bootstrap = !repo.getKv('seerr_bootstrapped');
    const botRequestIds = new Set(repo.pendingBotRequests().filter((b) => b.source === 'seerr').map((b) => b.external_id));

    for (const req of requests as SeerrRequest[]) {
      if (req.media.status !== AVAILABLE) continue;
      const users = repo.usersBySeerrId(req.requestedBy.id);
      for (const u of users) {
        const key = String(req.id);
        if (repo.wasNotified('seerr', key, u.id)) continue;
        repo.markNotified('seerr', key, u.id);
        if (bootstrap || botRequestIds.has(key)) continue; // handled by checkBotRequests / old history
        const title = await seerr.title(req.media.mediaType, req.media.tmdbId).catch(() => 'deine Anfrage');
        const { event, template } = this.availableEvent(title, req.media.mediaType, false);
        this.notify(u.id, event, template);
      }
    }
    if (bootstrap) repo.setKv('seerr_bootstrapped', new Date().toISOString());
  }

  /** Requests made on the Ombi website by linked users. */
  private async checkOmbi() {
    const { ombi } = this.ctx.services;
    if (!ombi) return;
    const { repo } = this.ctx;
    const bootstrap = !repo.getKv('ombi_bootstrapped');
    const movies = await ombi.movieRequests();
    for (const m of movies) {
      if (!m.available || !m.requestedUser?.userName) continue;
      for (const u of repo.usersByOmbiName(m.requestedUser.userName)) {
        const key = `movie:${m.id}`;
        if (repo.wasNotified('ombi', key, u.id)) continue;
        repo.markNotified('ombi', key, u.id);
        if (bootstrap || repo.botRequestsForUser(u.id, 50).some((b) => b.tmdb_id === m.theMovieDbId)) continue;
        const { event, template } = this.availableEvent(m.title, 'movie', false);
        this.notify(u.id, event, template);
      }
    }
    const tv = await ombi.tvRequests();
    for (const t of tv) {
      for (const c of t.childRequests ?? []) {
        if (!c.available || !c.requestedUser?.userName) continue;
        for (const u of repo.usersByOmbiName(c.requestedUser.userName)) {
          const key = `tv:${c.id}`;
          if (repo.wasNotified('ombi', key, u.id)) continue;
          repo.markNotified('ombi', key, u.id);
          if (bootstrap || repo.botRequestsForUser(u.id, 50).some((b) => normalizeTitle(b.title) === normalizeTitle(t.title))) continue;
          const { event, template } = this.availableEvent(t.title, 'tv', false);
          this.notify(u.id, event, template);
        }
      }
    }
    if (bootstrap) repo.setKv('ombi_bootstrapped', new Date().toISOString());
  }

  /** Auto-fix follow-up: notify the user when the replaced/missing file is there again. */
  private async checkWatches() {
    const { radarr, sonarr } = this.ctx.services;
    const { repo } = this.ctx;
    for (const w of repo.openWatches()) {
      const ref = JSON.parse(w.ref) as { movieId?: number; seriesId?: number; episodeIds?: number[] };
      let done = false;
      if (w.kind === 'radarr_movie' && radarr && ref.movieId) {
        done = (await radarr.get(ref.movieId)).hasFile;
      } else if (w.kind === 'sonarr_episodes' && sonarr && ref.seriesId && ref.episodeIds) {
        done = await sonarr.episodesHaveFiles(ref.seriesId, ref.episodeIds);
      }

      if (done) {
        repo.closeWatch(w.id);
        if (w.ticket_id) {
          repo.updateTicket(w.ticket_id, { status: 'resolved', resolution: 'Neue Datei automatisch heruntergeladen' });
          repo.appendTicketAction(w.ticket_id, 'watch_done', 'Neue Datei ist da');
        }
        this.notify(
          w.user_id,
          `Die neue Version von "${w.label}" ist heruntergeladen${w.ticket_id ? ` (Ticket #${w.ticket_id})` : ''}. Es kann ein paar Minuten dauern, bis sie in der App auftaucht. Sag dem Nutzer Bescheid und bitte ihn, kurz Rückmeldung zu geben, ob es jetzt klappt.`,
          `✅ Die neue Version von *${w.label}* ist da (kann ein paar Minuten dauern, bis sie in der App auftaucht). Sag mir gern, ob jetzt alles klappt!`,
        );
      } else if (this.expired(w)) {
        repo.closeWatch(w.id);
        if (w.ticket_id) repo.updateTicket(w.ticket_id, { status: 'escalated' });
        const user = repo.getUser(w.user_id);
        await notifyAdmins(
          this.ctx,
          `⏰ Auto-Fix ohne Erfolg: Für "${w.label}"${w.ticket_id ? ` (Ticket #${w.ticket_id})` : ''} von ${user ? userLabel(user) : '?'} wurde nach ${WATCH_TIMEOUT_HOURS}h keine neue Datei gefunden. Bitte manuell prüfen.`,
        );
        this.notify(
          w.user_id,
          `Für "${w.label}" wurde nach ${WATCH_TIMEOUT_HOURS} Stunden noch keine neue Version gefunden. Der Admin wurde informiert und kümmert sich. Sag dem Nutzer kurz Bescheid.`,
          `Kurzes Update zu *${w.label}*: Ich habe leider noch keine neue Version gefunden. ${this.ctx.config.ADMIN_NAME} ist informiert und kümmert sich darum.`,
        );
      }
    }
  }

  private expired(w: Watch) {
    return Date.now() - new Date(w.created_at.replace(' ', 'T') + 'Z').getTime() > WATCH_TIMEOUT_HOURS * 3600_000;
  }
}
