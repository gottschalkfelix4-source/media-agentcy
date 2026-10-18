import { ApiClient } from './http.js';
import { TMDB_POSTER, type MediaCard } from './seerr.js';

/**
 * Ombi v4 API (best effort – Ombi's API is less stable than Seerr's).
 * Requests are made on behalf of a user via the "UserName" header.
 */

export interface OmbiMovieRequest {
  id: number;
  title: string;
  theMovieDbId: number;
  available: boolean;
  approved: boolean;
  denied?: boolean;
  requestedDate: string;
  requestedUser?: { userName?: string };
}

export interface OmbiTvRequest {
  id: number;
  title: string;
  tvDbId?: number;
  externalProviderId?: number;
  childRequests?: { id: number; available: boolean; approved: boolean; denied?: boolean; requestedUser?: { userName?: string } }[];
}

export class OmbiClient {
  readonly api: ApiClient;

  constructor(baseUrl: string, apiKey: string) {
    this.api = new ApiClient({ service: 'Ombi', baseUrl: `${baseUrl}/api`, headers: { ApiKey: apiKey } });
  }

  async ping() {
    await this.api.get('/v1/Status');
    return { ok: true };
  }

  async search(query: string) {
    const res = await this.api.post<
      { id: number; mediaType?: string; title?: string; overview?: string; available?: boolean; requested?: boolean }[]
    >(`/v2/Search/multi/${encodeURIComponent(query)}`, { movies: true, tvShows: true, music: false, people: false });
    return (res ?? []).slice(0, 8).map((r) => ({
      tmdbId: r.id,
      mediaType: (r.mediaType === 'tv' ? 'tv' : 'movie') as 'movie' | 'tv',
      title: r.title ?? '?',
      overview: r.overview?.slice(0, 200),
      status: r.available ? 'verfügbar' : r.requested ? 'angefragt' : 'nicht vorhanden',
    }));
  }

  /** Title, date and poster of a TMDB title (best effort, field names differ between Ombi versions). */
  async card(mediaType: 'movie' | 'tv', tmdbId: number): Promise<MediaCard> {
    const d = await this.api.get<{
      title?: string;
      releaseDate?: string;
      firstAired?: string;
      posterPath?: string;
      banner?: string;
      overview?: string;
      seasonRequests?: unknown[];
    }>(mediaType === 'movie' ? `/v2/Search/movie/${tmdbId}` : `/v2/Search/tv/moviedb/${tmdbId}`);
    const poster = d?.posterPath;
    return {
      title: d?.title ?? `TMDB ${tmdbId}`,
      date: (mediaType === 'movie' ? d?.releaseDate : d?.firstAired)?.slice(0, 10) || undefined,
      posterUrl: poster ? (poster.startsWith('http') ? poster : `${TMDB_POSTER}${poster.startsWith('/') ? '' : '/'}${poster}`) : undefined,
      overview: d?.overview || undefined,
      seasons: d?.seasonRequests?.length || undefined,
    };
  }

  async request(opts: { mediaType: 'movie' | 'tv'; tmdbId: number; asUserName?: string }) {
    const headers = opts.asUserName ? { UserName: opts.asUserName } : undefined;
    const res =
      opts.mediaType === 'movie'
        ? await this.api.post<{ result: boolean; message?: string; errorMessage?: string; requestId?: number }>(
            '/v1/Request/movie',
            { theMovieDbId: opts.tmdbId, languageCode: 'de', is4KRequest: false },
            undefined,
            headers,
          )
        : await this.api.post<{ result: boolean; message?: string; errorMessage?: string; requestId?: number }>(
            '/v2/Requests/tv',
            { theMovieDbId: opts.tmdbId, requestAll: true, latestSeason: false, firstSeason: false, seasons: [] },
            undefined,
            headers,
          );
    if (res && res.result === false) throw new Error(`Ombi: ${res.errorMessage ?? res.message ?? 'Anfrage abgelehnt'}`);
    return res;
  }

  async movieRequests() {
    return (await this.api.get<OmbiMovieRequest[]>('/v1/Request/movie')) ?? [];
  }

  async tvRequests() {
    return (await this.api.get<OmbiTvRequest[]>('/v1/Request/tv')) ?? [];
  }
}
