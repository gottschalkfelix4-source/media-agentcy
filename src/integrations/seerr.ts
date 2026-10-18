import { ApiClient } from './http.js';

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
  media: { id: number; tmdbId: number; tvdbId?: number; status: number; mediaType: 'movie' | 'tv' };
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
      seasons?: { seasonNumber: number; episodeCount: number; name: string }[];
      mediaInfo?: { status: number; seasons?: { seasonNumber: number; status: number }[] };
    }>(`/${mediaType}/${tmdbId}`, { language });
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
    const res = await this.api.get<{ results: SeerrRequest[] }>(`/user/${seerrUserId}/requests`, { take, skip: 0 });
    return res.results;
  }

  async getRequest(id: number) {
    return this.api.get<SeerrRequest>(`/request/${id}`);
  }

  async recentRequests(filter: 'all' | 'available' | 'processing' | 'pending' = 'all', take = 100) {
    const res = await this.api.get<{ results: SeerrRequest[] }>('/request', { take, skip: 0, filter, sort: 'modified' });
    return res.results;
  }

  async users() {
    const res = await this.api.get<{
      results: { id: number; displayName?: string; email?: string; username?: string; jellyfinUsername?: string; plexUsername?: string }[];
    }>('/user', { take: 200, skip: 0 });
    return res.results;
  }

  async findUserByName(name: string) {
    const n = name.toLowerCase();
    const users = await this.users();
    return users.find((u) =>
      [u.jellyfinUsername, u.plexUsername, u.username, u.displayName, u.email].some((v) => v?.toLowerCase() === n),
    );
  }
}
