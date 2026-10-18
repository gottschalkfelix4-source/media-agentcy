import { ApiClient, formatBytes, titleScore } from './http.js';

interface ArrMediaInfo {
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  audioLanguages?: string;
  subtitles?: string;
  resolution?: string;
  runTime?: string;
}

interface ArrFile {
  id: number;
  relativePath?: string;
  path?: string;
  size?: number;
  quality?: { quality?: { name?: string } };
  languages?: { name: string }[];
  mediaInfo?: ArrMediaInfo;
  dateAdded?: string;
}

interface QueueRecord {
  id: number;
  movieId?: number;
  seriesId?: number;
  episodeId?: number;
  title: string;
  status: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
  errorMessage?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  estimatedCompletionTime?: string;
  episode?: { seasonNumber: number; episodeNumber: number };
}

function fileInfo(f?: ArrFile) {
  if (!f) return undefined;
  return {
    fileId: f.id,
    file: f.relativePath ?? f.path,
    size: formatBytes(f.size),
    quality: f.quality?.quality?.name,
    languages: f.languages?.map((l) => l.name),
    video: f.mediaInfo ? `${f.mediaInfo.videoCodec ?? '?'} ${f.mediaInfo.resolution ?? ''}`.trim() : undefined,
    audio: f.mediaInfo ? `${f.mediaInfo.audioCodec ?? '?'} ${f.mediaInfo.audioChannels ?? ''}ch [${f.mediaInfo.audioLanguages ?? '?'}]` : undefined,
    subtitles: f.mediaInfo?.subtitles || undefined,
    runtime: f.mediaInfo?.runTime,
    added: f.dateAdded,
  };
}

function queueInfo(q: QueueRecord) {
  const progress = q.size ? Math.round(((q.size - (q.sizeleft ?? 0)) / q.size) * 100) : undefined;
  return {
    queueId: q.id,
    title: q.title,
    episode: q.episode ? `S${q.episode.seasonNumber}E${q.episode.episodeNumber}` : undefined,
    status: q.status,
    state: q.trackedDownloadState,
    health: q.trackedDownloadStatus,
    progress: progress !== undefined ? `${progress}%` : undefined,
    timeLeft: q.timeleft,
    problems: [q.errorMessage, ...(q.statusMessages ?? []).flatMap((m) => [m.title, ...(m.messages ?? [])])].filter(Boolean),
  };
}

abstract class ArrBase {
  readonly api: ApiClient;
  constructor(service: string, baseUrl: string, apiKey: string) {
    this.api = new ApiClient({ service, baseUrl: `${baseUrl}/api/v3`, headers: { 'X-Api-Key': apiKey } });
  }

  async ping() {
    const s = await this.api.get<{ version: string }>('/system/status');
    return { ok: true, version: s.version };
  }

  async health() {
    const h = await this.api.get<{ source: string; type: string; message: string }[]>('/health');
    return h.map((x) => ({ type: x.type, source: x.source, message: x.message }));
  }

  async diskSpace() {
    const d = await this.api.get<{ path: string; freeSpace: number; totalSpace: number }[]>('/diskspace');
    return d.map((x) => ({ path: x.path, free: formatBytes(x.freeSpace), total: formatBytes(x.totalSpace) }));
  }

  command(name: string, body: Record<string, unknown> = {}) {
    return this.api.post<{ id: number; name: string; status: string }>('/command', { name, ...body });
  }
}

interface RadarrMovie {
  id: number;
  title: string;
  originalTitle?: string;
  year: number;
  tmdbId: number;
  monitored: boolean;
  hasFile: boolean;
  isAvailable?: boolean;
  status?: string;
  movieFile?: ArrFile;
  alternateTitles?: { title: string }[];
}

export class RadarrClient extends ArrBase {
  private cache?: { at: number; movies: RadarrMovie[] };

  constructor(baseUrl: string, apiKey: string) {
    super('Radarr', baseUrl, apiKey);
  }

  private async allMovies() {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.movies;
    const movies = await this.api.get<RadarrMovie[]>('/movie');
    this.cache = { at: Date.now(), movies };
    return movies;
  }

  async find(opts: { title?: string; tmdbId?: number; year?: number }) {
    if (opts.tmdbId) {
      const res = await this.api.get<RadarrMovie[]>('/movie', { tmdbId: opts.tmdbId });
      return res.map((m) => this.summary(m));
    }
    const movies = await this.allMovies();
    return movies
      .map((m) => ({
        m,
        s: Math.max(
          titleScore(opts.title ?? '', m.title),
          titleScore(opts.title ?? '', m.originalTitle ?? ''),
          ...(m.alternateTitles ?? []).map((a) => titleScore(opts.title ?? '', a.title) * 0.95),
        ) + (opts.year && m.year === opts.year ? 0.1 : 0),
      }))
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
      .map((x) => this.summary(x.m));
  }

  async get(id: number) {
    this.cache = undefined;
    return this.summary(await this.api.get<RadarrMovie>(`/movie/${id}`));
  }

  private summary(m: RadarrMovie) {
    return {
      radarrId: m.id,
      title: m.title,
      year: m.year,
      tmdbId: m.tmdbId,
      monitored: m.monitored,
      hasFile: m.hasFile,
      status: m.status,
      file: fileInfo(m.movieFile),
    };
  }

  async queue(movieId?: number) {
    const res = await this.api.get<{ records: QueueRecord[] }>('/queue', { pageSize: 100, includeMovie: false });
    return res.records.filter((q) => !movieId || q.movieId === movieId).map(queueInfo);
  }

  async history(movieId: number, limit = 8) {
    const res = await this.api.get<{ eventType: string; date: string; sourceTitle?: string; data?: Record<string, string> }[]>(
      '/history/movie',
      { movieId },
    );
    return res.slice(0, limit).map((h) => ({ event: h.eventType, date: h.date, release: h.sourceTitle, reason: h.data?.message ?? h.data?.reason }));
  }

  async search(movieId: number) {
    return this.command('MoviesSearch', { movieIds: [movieId] });
  }

  async rescan(movieId: number) {
    return this.command('RescanMovie', { movieId });
  }

  async refresh(movieId: number) {
    return this.command('RefreshMovie', { movieIds: [movieId] });
  }

  /** Deletes the current file and searches for a new release. */
  async replaceFile(movieId: number) {
    const movie = await this.api.get<RadarrMovie>(`/movie/${movieId}`);
    if (movie.movieFile) await this.api.delete(`/moviefile/${movie.movieFile.id}`);
    this.cache = undefined;
    await this.search(movieId);
    return { deletedFile: movie.movieFile?.relativePath ?? null };
  }
}

interface SonarrSeries {
  id: number;
  title: string;
  year: number;
  tvdbId: number;
  tmdbId?: number;
  monitored: boolean;
  status?: string;
  alternateTitles?: { title: string }[];
  seasons?: { seasonNumber: number; monitored: boolean; statistics?: { episodeFileCount: number; episodeCount: number; totalEpisodeCount: number } }[];
  statistics?: { episodeFileCount: number; episodeCount: number; totalEpisodeCount: number; percentOfEpisodes: number };
}

interface SonarrEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  hasFile: boolean;
  monitored: boolean;
  episodeFileId?: number;
  airDateUtc?: string;
}

export class SonarrClient extends ArrBase {
  private cache?: { at: number; series: SonarrSeries[] };

  constructor(baseUrl: string, apiKey: string) {
    super('Sonarr', baseUrl, apiKey);
  }

  private async allSeries() {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.series;
    const series = await this.api.get<SonarrSeries[]>('/series');
    this.cache = { at: Date.now(), series };
    return series;
  }

  async find(opts: { title?: string; tmdbId?: number; tvdbId?: number }) {
    const all = await this.allSeries();
    const matches = opts.tmdbId || opts.tvdbId
      ? all.filter((s) => (opts.tmdbId && s.tmdbId === opts.tmdbId) || (opts.tvdbId && s.tvdbId === opts.tvdbId))
      : all
          .map((s) => ({
            s,
            score: Math.max(titleScore(opts.title ?? '', s.title), ...(s.alternateTitles ?? []).map((a) => titleScore(opts.title ?? '', a.title) * 0.95)),
          }))
          .filter((x) => x.score >= 0.5)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((x) => x.s);
    return matches.map((s) => ({
      sonarrId: s.id,
      title: s.title,
      year: s.year,
      tvdbId: s.tvdbId,
      tmdbId: s.tmdbId,
      monitored: s.monitored,
      status: s.status,
      episodesOnDisk: s.statistics ? `${s.statistics.episodeFileCount}/${s.statistics.episodeCount}` : undefined,
      seasons: s.seasons
        ?.filter((se) => se.seasonNumber > 0)
        .map((se) => ({
          season: se.seasonNumber,
          monitored: se.monitored,
          onDisk: se.statistics ? `${se.statistics.episodeFileCount}/${se.statistics.episodeCount}` : undefined,
        })),
    }));
  }

  async episodes(seriesId: number, season?: number) {
    const eps = await this.api.get<SonarrEpisode[]>('/episode', { seriesId, seasonNumber: season });
    return eps;
  }

  async episodeDetails(seriesId: number, season?: number, episode?: number) {
    const [eps, files] = await Promise.all([
      this.episodes(seriesId, season),
      this.api.get<ArrFile[]>('/episodefile', { seriesId }),
    ]);
    const fileById = new Map(files.map((f) => [f.id, f]));
    return eps
      .filter((e) => e.seasonNumber > 0 && (episode === undefined || e.episodeNumber === episode))
      .map((e) => ({
        episodeId: e.id,
        code: `S${e.seasonNumber}E${e.episodeNumber}`,
        title: e.title,
        aired: e.airDateUtc?.slice(0, 10),
        monitored: e.monitored,
        hasFile: e.hasFile,
        file: episode !== undefined || season !== undefined ? fileInfo(e.episodeFileId ? fileById.get(e.episodeFileId) : undefined) : undefined,
      }));
  }

  async queue(seriesId?: number) {
    const res = await this.api.get<{ records: QueueRecord[] }>('/queue', { pageSize: 100, includeEpisode: true });
    return res.records.filter((q) => !seriesId || q.seriesId === seriesId).map(queueInfo);
  }

  async history(seriesId: number, limit = 10) {
    const res = await this.api.get<
      { eventType: string; date: string; sourceTitle?: string; data?: Record<string, string>; episode?: { seasonNumber: number; episodeNumber: number } }[]
    >('/history/series', { seriesId, includeEpisode: true });
    return res.slice(0, limit).map((h) => ({
      event: h.eventType,
      date: h.date,
      episode: h.episode ? `S${h.episode.seasonNumber}E${h.episode.episodeNumber}` : undefined,
      release: h.sourceTitle,
      reason: h.data?.message ?? h.data?.reason,
    }));
  }

  searchEpisodes(episodeIds: number[]) {
    return this.command('EpisodeSearch', { episodeIds });
  }

  searchSeason(seriesId: number, seasonNumber: number) {
    return this.command('SeasonSearch', { seriesId, seasonNumber });
  }

  searchSeries(seriesId: number) {
    return this.command('SeriesSearch', { seriesId });
  }

  rescan(seriesId: number) {
    return this.command('RescanSeries', { seriesId });
  }

  refresh(seriesId: number) {
    return this.command('RefreshSeries', { seriesId });
  }

  /** Deletes the files of the given episodes and searches for new releases. */
  async replaceEpisodeFiles(seriesId: number, episodeIds: number[]) {
    const eps = (await this.episodes(seriesId)).filter((e) => episodeIds.includes(e.id));
    const fileIds = [...new Set(eps.map((e) => e.episodeFileId).filter((id): id is number => !!id))];
    for (const fid of fileIds) await this.api.delete(`/episodefile/${fid}`);
    await this.searchEpisodes(episodeIds);
    return { deletedFiles: fileIds.length, episodes: eps.map((e) => `S${e.seasonNumber}E${e.episodeNumber}`) };
  }

  async episodesHaveFiles(seriesId: number, episodeIds: number[]) {
    const eps = (await this.episodes(seriesId)).filter((e) => episodeIds.includes(e.id));
    return eps.length > 0 && eps.every((e) => e.hasFile);
  }
}
