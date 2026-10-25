import { ApiClient, seg } from './http.js';

/** Works for both Jellyseerr and Overseerr (same API). */

export const MEDIA_STATUS: Record<number, string> = {
  1: 'unbekannt',
  2: 'angefragt (wartet)',
  3: 'wird bearbeitet / Download',
  4: 'teilweise verfügbar',
  5: 'verfügbar',
  6: 'gesperrt/gelöscht',
};

export const REQUEST_STATUS: Record<number, string> = {
  1: 'wartet auf Freigabe',
  2: 'freigegeben',
  3: 'abgelehnt',
  4: 'fehlgeschlagen',
  5: 'abgeschlossen',
};

export const TMDB_POSTER = 'https://image.tmdb.org/t/p/w500';

export interface MediaCard {
  title: string;
  /** YYYY-MM-DD release date (movie) or first air date (series). */
  date?: string;
  posterUrl?: string;
  overview?: string;
  seasons?: number;
  /** Seerr media status, if known (5 = available). */
  status?: number;
}

interface SeerrSearchResult {
  id: number;
  mediaType: 'movie' | 'tv' | 'person';
  title?: string;
  name?: string;
  originalTitle?: string;
  releaseDate?: string;
  firstAirDate?: string;
  overview?: string;
  mediaInfo?: { status: number; requests?: { id: number; status: number }[] };
}

export interface SeerrRequest {
  id: number;
  status: number;
  type: 'movie' | 'tv';
  createdAt: string;
  updatedAt: string;
  media: { id: number; tmdbId: number; tvdbId?: number; status: number; mediaType: 'movie' | 'tv'; updatedAt?: string; mediaAddedAt?: string };
  requestedBy: { id: number; displayName?: string; username?: string; jellyfinUsername?: string; plexUsername?: string };
  seasons?: { seasonNumber: number; status: number }[];
}

export class SeerrClient {
  readonly api: ApiClient;
  private titleCache = new Map<string, string>();

  constructor(
    baseUrl: string,
    apiKey: string,
    readonly publicUrl?: string,
  ) {
    this.api = new ApiClient({ service: 'Seerr', baseUrl: `${baseUrl}/api/v1`, headers: { 'X-Api-Key': apiKey } });
  }

  async ping() {
    const s = await this.api.get<{ version: string }>('/status');
    return { ok: true, version: s.version };
  }

  async search(query: string, language = 'de') {
    // Seerr rejects "+" encoded spaces in some versions, so build the query manually.
    const res = await this.api.get<{ results: SeerrSearchResult[] }>(`/search?query=${encodeURIComponent(query)}&page=1&language=${language}`);
    return res.results
      .filter((r) => r.mediaType !== 'person')
      .slice(0, 8)
      .map((r) => ({
        tmdbId: r.id,
        mediaType: r.mediaType as 'movie' | 'tv',
        title: r.title ?? r.name ?? r.originalTitle ?? '?',
        year: (r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4) || undefined,
        overview: r.overview?.slice(0, 200),
        status: r.mediaInfo ? MEDIA_STATUS[r.mediaInfo.status] : 'nicht vorhanden',
        statusCode: r.mediaInfo?.status ?? 0,
      }));
  }

  async details(mediaType: 'movie' | 'tv', tmdbId: number, language = 'de') {
    return this.api.get<{
      id: number;
      title?: string;
      name?: string;
      posterPath?: string;
      releaseDate?: string;
      firstAirDate?: string;
      overview?: string;
      numberOfSeasons?: number;
      seasons?: { seasonNumber: number; episodeCount: number; name: string }[];
      mediaInfo?: {
        status: number;
        seasons?: { seasonNumber: number; status: number }[];
        requests?: { id: number; status: number; createdAt: string; requestedBy?: { id: number } }[];
      };
    }>(`/${seg(mediaType)}/${seg(tmdbId)}`, { language });
  }

  /** What the user sees before confirming a request: title, date, poster. */
  async card(mediaType: 'movie' | 'tv', tmdbId: number): Promise<MediaCard> {
    const d = await this.details(mediaType, tmdbId);
    return {
      title: d.title ?? d.name ?? `TMDB ${tmdbId}`,
      date: (mediaType === 'movie' ? d.releaseDate : d.firstAirDate) || undefined,
      posterUrl: d.posterPath ? `${TMDB_POSTER}${d.posterPath}` : undefined,
      overview: d.overview || undefined,
      seasons: d.numberOfSeasons,
      status: d.mediaInfo?.status,
    };
  }

  async title(mediaType: 'movie' | 'tv', tmdbId: number) {
    const key = `${mediaType}:${tmdbId}`;
    const cached = this.titleCache.get(key);
    if (cached) return cached;
    const d = await this.details(mediaType, tmdbId);
    const t = d.title ?? d.name ?? `TMDB ${tmdbId}`;
    this.titleCache.set(key, t);
    return t;
  }

  async request(opts: { mediaType: 'movie' | 'tv'; tmdbId: number; seasons?: number[] | 'all'; asUserId?: number }) {
    const body: Record<string, unknown> = { mediaType: opts.mediaType, mediaId: opts.tmdbId, is4k: false };
    if (opts.mediaType === 'tv') body.seasons = opts.seasons ?? 'all';
    return this.api.post<SeerrRequest>('/request', body, undefined, opts.asUserId ? { 'X-Api-User': String(opts.asUserId) } : undefined);
  }

  async userRequests(seerrUserId: number, take = 20) {
    const res = await this.api.get<{ results: SeerrRequest[] }>(`/user/${seg(seerrUserId)}/requests`, { take, skip: 0 });
    return res.results;
  }

  async getRequest(id: number) {
    return this.api.get<SeerrRequest>(`/request/${seg(id)}`);
  }

  /** Sends a failed request to Radarr/Sonarr again. */
  async retryRequest(id: number) {
    return this.api.post<SeerrRequest>(`/request/${seg(id)}/retry`);
  }

  async recentRequests(filter: 'all' | 'available' | 'processing' | 'pending' = 'all', take = 100) {
    const res = await this.api.get<{ results: SeerrRequest[] }>('/request', { take, skip: 0, filter, sort: 'modified' });
    return res.results;
  }

  /** All requests, newest first. Used to import requests made on the website. */
  async allRequests(maxPages = 20, take = 100) {
    const out: SeerrRequest[] = [];
    for (let page = 0; page < maxPages; page++) {
      const res = await this.api.get<{ results: SeerrRequest[] }>('/request', { take, skip: page * take, filter: 'all', sort: 'added' });
      out.push(...res.results);
      if (res.results.length < take) break;
    }
    return out;
  }

  async users() {
    const res = await this.api.get<{
      results: { id: number; displayName?: string; email?: string; username?: string; jellyfinUsername?: string; plexUsername?: string }[];
    }>('/user', { take: 200, skip: 0 });
    return res.results;
  }

  /** Creates Seerr users for Jellyfin accounts (only works when Seerr uses Jellyfin/Emby as media server). */
  async importFromJellyfin(jellyfinUserIds: string[]) {
    return this.api.post<{ id: number; jellyfinUsername?: string }[]>('/user/import-from-jellyfin', { jellyfinUserIds });
  }

  async findUserByName(name: string) {
    const n = name.toLowerCase();
    const users = await this.users();
    return users.find((u) =>
      [u.jellyfinUsername, u.plexUsername, u.username, u.displayName, u.email].some((v) => v?.toLowerCase() === n),
    );
  }
}
