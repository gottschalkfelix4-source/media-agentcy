import { ApiClient, type RecentItem } from './http.js';

interface JfMediaStream {
  Type: string;
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  IsDefault?: boolean;
  IsExternal?: boolean;
  Height?: number;
  Channels?: number;
}

interface JfItem {
  Id: string;
  Name: string;
  Type: string;
  ProductionYear?: number;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  Path?: string;
  ProviderIds?: Record<string, string>;
  DateCreated?: string;
  MediaSources?: { Path?: string; Container?: string; Size?: number; Bitrate?: number; MediaStreams?: JfMediaStream[] }[];
  MediaStreams?: JfMediaStream[];
}

export class JellyfinClient {
  readonly api: ApiClient;

  constructor(
    baseUrl: string,
    apiKey: string,
    readonly publicUrl?: string,
  ) {
    this.api = new ApiClient({
      service: 'Jellyfin',
      baseUrl,
      headers: { authorization: `MediaBrowser Client="media-agentcy", Device="server", DeviceId="media-agentcy", Version="0.1.0", Token="${apiKey}"` },
    });
  }

  async ping() {
    const info = await this.api.get<{ ServerName: string; Version: string }>('/System/Info/Public');
    return { ok: true, name: info.ServerName, version: info.Version };
  }

  async systemInfo() {
    const info = await this.api.get<{ Version: string; HasPendingRestart: boolean; HasUpdateAvailable: boolean; OperatingSystem?: string }>(
      '/System/Info',
    );
    return info;
  }

  async search(term: string, types = 'Movie,Series,Episode', limit = 8) {
    const res = await this.api.get<{ Items: JfItem[] }>('/Items', {
      searchTerm: term,
      Recursive: true,
      IncludeItemTypes: types,
      Limit: limit,
      Fields: 'Path,ProviderIds,DateCreated,MediaSources',
    });
    return res.Items.map((it) => summarizeItem(it));
  }

  async item(id: string) {
    const res = await this.api.get<{ Items: JfItem[] }>('/Items', { Ids: id, Fields: 'Path,ProviderIds,MediaSources,MediaStreams,DateCreated' });
    const it = res.Items[0];
    return it ? summarizeItem(it, true) : undefined;
  }

  /** Movies, series and episodes added since `since`, newest first. */
  async recentlyAdded(since: Date, limit = 500): Promise<RecentItem[]> {
    const res = await this.api.get<{ Items: JfItem[] }>('/Items', {
      Recursive: true,
      IncludeItemTypes: 'Movie,Series,Episode',
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Limit: limit,
      Fields: 'DateCreated',
    });
    return res.Items.filter((it) => it.DateCreated && Date.parse(it.DateCreated) >= since.getTime()).map((it) => ({
      type: it.Type === 'Movie' ? 'movie' : it.Type === 'Series' ? 'series' : 'episode',
      title: it.Type === 'Episode' ? (it.SeriesName ?? it.Name) : it.Name,
      year: it.ProductionYear,
      season: it.Type === 'Episode' ? it.ParentIndexNumber : undefined,
      added: it.DateCreated!,
    }));
  }

  async episodes(seriesId: string, season?: number) {
    const res = await this.api.get<{ Items: JfItem[] }>(`/Shows/${seriesId}/Episodes`, {
      season,
      Fields: 'Path,MediaSources',
    });
    return res.Items.map((e) => summarizeItem(e));
  }

  async refreshItem(id: string) {
    await this.api.post(`/Items/${id}/Refresh`, undefined, {
      Recursive: true,
      MetadataRefreshMode: 'FullRefresh',
      ImageRefreshMode: 'FullRefresh',
      ReplaceAllMetadata: false,
      ReplaceAllImages: false,
    });
  }

  async scanLibrary() {
    await this.api.post('/Library/Refresh');
  }

  async users() {
    const users = await this.api.get<{ Id: string; Name: string; LastActivityDate?: string; Policy?: { IsDisabled?: boolean; IsAdministrator?: boolean } }[]>(
      '/Users',
    );
    return users.map((u) => ({
      id: u.Id,
      name: u.Name,
      lastActivity: u.LastActivityDate,
      disabled: u.Policy?.IsDisabled ?? false,
      admin: u.Policy?.IsAdministrator ?? false,
    }));
  }

  /** New local user; libraries follow the server's default policy for new users. */
  async createUser(name: string, password: string) {
    const u = await this.api.post<{ Id: string; Name: string }>('/Users/New', { Name: name, Password: password });
    return { id: u.Id, name: u.Name };
  }

  async sessions(userId?: string) {
    const sessions = await this.api.get<
      {
        UserId?: string;
        UserName?: string;
        Client?: string;
        DeviceName?: string;
        LastActivityDate?: string;
        NowPlayingItem?: { Name: string; SeriesName?: string };
        PlayState?: { PlayMethod?: string; IsPaused?: boolean };
        TranscodingInfo?: { TranscodeReasons?: string[]; VideoCodec?: string; AudioCodec?: string; IsVideoDirect?: boolean };
      }[]
    >('/Sessions', { activeWithinSeconds: 1800 });
    return sessions
      .filter((s) => !userId || s.UserId === userId)
      .map((s) => ({
        user: s.UserName,
        client: s.Client,
        device: s.DeviceName,
        lastActivity: s.LastActivityDate,
        nowPlaying: s.NowPlayingItem ? [s.NowPlayingItem.SeriesName, s.NowPlayingItem.Name].filter(Boolean).join(' - ') : undefined,
        playMethod: s.PlayState?.PlayMethod,
        transcodeReasons: s.TranscodingInfo?.TranscodeReasons,
      }));
  }

  async activity(opts: { userId?: string; limit?: number; minDate?: string } = {}) {
    const res = await this.api.get<{
      Items: { Name: string; Type: string; Severity: string; Date: string; ShortOverview?: string; Overview?: string; UserId?: string }[];
    }>('/System/ActivityLog/Entries', { limit: opts.limit ?? 30, minDate: opts.minDate, hasUserId: opts.userId ? true : undefined });
    return res.Items.filter((e) => !opts.userId || e.UserId?.replace(/-/g, '') === opts.userId.replace(/-/g, '')).map((e) => ({
      date: e.Date,
      type: e.Type,
      severity: e.Severity,
      name: e.Name,
      detail: e.ShortOverview ?? e.Overview,
    }));
  }
}

function summarizeItem(it: JfItem, detailed = false) {
  const src = it.MediaSources?.[0];
  const streams = src?.MediaStreams ?? it.MediaStreams ?? [];
  return {
    id: it.Id,
    type: it.Type,
    name: it.Type === 'Episode' ? `${it.SeriesName} S${it.ParentIndexNumber}E${it.IndexNumber} - ${it.Name}` : it.Name,
    year: it.ProductionYear,
    tmdbId: it.ProviderIds?.Tmdb,
    added: it.DateCreated,
    path: detailed ? (src?.Path ?? it.Path) : undefined,
    container: src?.Container,
    sizeBytes: src?.Size,
    ...(detailed
      ? {
          video: streams.filter((s) => s.Type === 'Video').map((s) => `${s.Codec} ${s.Height ?? ''}p`.trim()),
          audio: streams.filter((s) => s.Type === 'Audio').map((s) => `${s.Language ?? 'und'} ${s.Codec} ${s.Channels ?? ''}ch`.trim()),
          subtitles: streams.filter((s) => s.Type === 'Subtitle').map((s) => `${s.Language ?? 'und'} ${s.Codec}${s.IsExternal ? ' (extern)' : ''}`),
        }
      : {}),
  };
}
