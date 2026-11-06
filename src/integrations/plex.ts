import { ApiClient, normalizeTitle, type RecentItem, seg } from './http.js';
import type { WatchState } from './jellyfin.js';

interface PlexMetadata {
  ratingKey: string;
  title: string;
  type: string;
  year?: number;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  addedAt?: number;
  librarySectionID?: number;
  grandparentRatingKey?: string;
  Guid?: { id: string }[];
  Media?: {
    videoResolution?: string;
    videoCodec?: string;
    audioCodec?: string;
    audioChannels?: number;
    container?: string;
    Part?: { file?: string; size?: number; Stream?: { streamType: number; codec?: string; languageCode?: string; displayTitle?: string }[] }[];
  }[];
}

export class PlexClient {
  readonly api: ApiClient;
  /** plex.tv account API – the local server does not know who it is shared with. */
  readonly tv: ApiClient;

  constructor(baseUrl: string, token: string, tvUrl = 'https://plex.tv') {
    const headers = { 'X-Plex-Token': token, 'X-Plex-Client-Identifier': 'media-agentcy', 'X-Plex-Product': 'Media Agentcy' };
    this.api = new ApiClient({ service: 'Plex', baseUrl, headers });
    this.tv = new ApiClient({ service: 'plex.tv', baseUrl: tvUrl, headers });
  }

  async ping() {
    const res = await this.api.get<{ MediaContainer: { version: string; machineIdentifier: string } }>('/identity');
    return { ok: true, version: res.MediaContainer.version };
  }

  async search(query: string, limit = 8) {
    const res = await this.api.get<{ MediaContainer: { Hub?: { type: string; Metadata?: PlexMetadata[] }[] } }>('/hubs/search', {
      query,
      limit,
    });
    const items = (res.MediaContainer.Hub ?? [])
      .filter((h) => ['movie', 'show', 'episode'].includes(h.type))
      .flatMap((h) => h.Metadata ?? []);
    return items.map((m) => summarize(m));
  }

  async item(ratingKey: string) {
    const res = await this.api.get<{ MediaContainer: { Metadata?: PlexMetadata[] } }>(`/library/metadata/${seg(ratingKey)}`);
    const m = res.MediaContainer.Metadata?.[0];
    return m ? summarize(m, true) : undefined;
  }

  async refreshItem(ratingKey: string) {
    await this.api.put(`/library/metadata/${seg(ratingKey)}/refresh`);
  }

  /** Movies and episodes added since `since`, newest first (Plex type 1 = movie, 4 = episode). */
  async recentlyAdded(since: Date, limit = 300): Promise<RecentItem[]> {
    const sections = (await this.sections()).filter((s) => s.type === 'movie' || s.type === 'show');
    const lists = await Promise.all(
      sections.map((s) =>
        this.api.get<{ MediaContainer: { Metadata?: PlexMetadata[] } }>(`/library/sections/${seg(s.key)}/all`, {
          type: s.type === 'movie' ? 1 : 4,
          sort: 'addedAt:desc',
          'X-Plex-Container-Start': 0,
          'X-Plex-Container-Size': limit,
        }),
      ),
    );
    const cutoff = since.getTime() / 1000;
    return lists
      .flatMap((l) => l.MediaContainer.Metadata ?? [])
      .filter((m) => (m.addedAt ?? 0) >= cutoff)
      .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
      .map((m) => ({
        type: m.type === 'movie' ? 'movie' : 'episode',
        title: m.type === 'episode' ? (m.grandparentTitle ?? m.title) : m.title,
        year: m.year,
        season: m.type === 'episode' ? m.parentIndex : undefined,
        added: new Date((m.addedAt ?? 0) * 1000).toISOString(),
      }));
  }

  async sections() {
    const res = await this.api.get<{ MediaContainer: { Directory?: { key: string; title: string; type: string }[] } }>('/library/sections');
    return res.MediaContainer.Directory ?? [];
  }

  async scanLibrary(sectionKey?: string) {
    const keys = sectionKey ? [sectionKey] : (await this.sections()).map((s) => s.key);
    for (const k of keys) await this.api.get(`/library/sections/${seg(k)}/refresh`);
  }

  /**
   * Owner plus friends and managed users of the token's plex.tv account. `username` is what sessions report as User.title.
   * Friends come from the v1 endpoint: plex.tv answers /api/v2/friends with 410 Gone.
   */
  async users() {
    const [owner, friends] = await Promise.all([this.tv.get<TvUser>('/api/v2/user'), this.tv.get<unknown>('/api/users')]);
    return [{ ...owner, owner: true }, ...parseTvUsers(friends).map((f) => ({ ...f, owner: false }))]
      .filter((u) => u.title || u.username)
      .map((u) => ({ id: u.id, username: (u.title || u.username)!, email: u.email || undefined, owner: u.owner }));
  }

  /** Library entry of a movie or show by TMDB id (guid) or, without guid data, by an unambiguous title. */
  async findByTmdb(type: 'movie' | 'tv', tmdbId: number, title: string) {
    const res = await this.api.get<{ MediaContainer: { Hub?: { type: string; Metadata?: PlexMetadata[] }[] } }>('/hubs/search', {
      query: title,
      limit: 25,
      includeGuids: 1,
    });
    const want = type === 'movie' ? 'movie' : 'show';
    const items = (res.MediaContainer.Hub ?? []).filter((h) => h.type === want).flatMap((h) => h.Metadata ?? []);
    const byGuid = items.find((m) => m.Guid?.some((g) => g.id === `tmdb://${tmdbId}`));
    if (byGuid) return { ratingKey: byGuid.ratingKey };
    const byTitle = items.filter((m) => normalizeTitle(m.title) === normalizeTitle(title));
    return byTitle.length === 1 ? { ratingKey: byTitle[0].ratingKey } : undefined;
  }

  /** plex.tv name (as in sessions/users) → local account id, needed for the play history. */
  private async accountId(username: string) {
    const res = await this.api.get<{ MediaContainer: { Account?: { id: number; name: string }[] } }>('/accounts');
    return res.MediaContainer.Account?.find((a) => a.name.toLowerCase() === username.toLowerCase())?.id;
  }

  /** What one Plex user has watched of a movie or of the regular episodes of a show, from the play history. */
  async watchState(username: string, ratingKey: string, type: 'movie' | 'tv'): Promise<WatchState | undefined> {
    const accountID = await this.accountId(username);
    if (accountID === undefined) return undefined;
    const history = (
      await this.api.get<{ MediaContainer: { Metadata?: PlexMetadata[] } }>('/status/history/all', {
        accountID,
        sort: 'viewedAt:desc',
        'X-Plex-Container-Start': 0,
        'X-Plex-Container-Size': 5000,
      })
    ).MediaContainer.Metadata ?? [];
    if (type === 'movie') return { total: 1, played: history.some((h) => h.ratingKey === ratingKey) ? 1 : 0 };
    const leaves = (
      await this.api.get<{ MediaContainer: { Metadata?: PlexMetadata[] } }>(`/library/metadata/${seg(ratingKey)}/allLeaves`)
    ).MediaContainer.Metadata?.filter((e) => (e.parentIndex ?? 0) > 0) ?? [];
    const seen = new Set(history.filter((h) => h.grandparentRatingKey === ratingKey).map((h) => h.ratingKey));
    return { total: leaves.length, played: leaves.filter((e) => seen.has(e.ratingKey)).length };
  }

  async sessions(username?: string) {
    const res = await this.api.get<{
      MediaContainer: {
        Metadata?: (PlexMetadata & {
          User?: { title?: string };
          Player?: { product?: string; title?: string; state?: string };
          TranscodeSession?: { videoDecision?: string; audioDecision?: string };
        })[];
      };
    }>('/status/sessions');
    return (res.MediaContainer.Metadata ?? [])
      .filter((s) => !username || s.User?.title?.toLowerCase() === username.toLowerCase())
      .map((s) => ({
        user: s.User?.title,
        title: [s.grandparentTitle, s.title].filter(Boolean).join(' - '),
        player: `${s.Player?.product ?? ''} ${s.Player?.title ?? ''}`.trim(),
        state: s.Player?.state,
        video: s.TranscodeSession?.videoDecision ?? 'direct play',
        audio: s.TranscodeSession?.audioDecision ?? 'direct play',
      }));
  }
}

type TvUser = { id: number; title?: string; username?: string; email?: string };

/** /api/users answers with XML (`<User id=… title=… username=… email=…>`), the JSON branch covers a possible switch to JSON. */
export function parseTvUsers(res: unknown): TvUser[] {
  if (typeof res !== 'string') {
    const list = (res as { MediaContainer?: { User?: TvUser[] } } | undefined)?.MediaContainer?.User;
    return Array.isArray(list) ? list : [];
  }
  const decode = (v: string) =>
    v.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (_, e: string) =>
      e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]!,
    );
  return [...res.matchAll(/<User\s([^>]*)>/g)].map((m) => {
    const attr = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])]));
    return { id: Number(attr.id), title: attr.title, username: attr.username, email: attr.email };
  });
}

function summarize(m: PlexMetadata, detailed = false) {
  const media = m.Media?.[0];
  const part = media?.Part?.[0];
  return {
    ratingKey: m.ratingKey,
    type: m.type,
    name: m.type === 'episode' ? `${m.grandparentTitle} S${m.parentIndex}E${m.index} - ${m.title}` : m.title,
    year: m.year,
    added: m.addedAt ? new Date(m.addedAt * 1000).toISOString() : undefined,
    resolution: media?.videoResolution,
    ...(detailed
      ? {
          file: part?.file,
          sizeBytes: part?.size,
          videoCodec: media?.videoCodec,
          audio: part?.Stream?.filter((s) => s.streamType === 2).map((s) => s.displayTitle ?? `${s.languageCode} ${s.codec}`),
          subtitles: part?.Stream?.filter((s) => s.streamType === 3).map((s) => s.displayTitle ?? `${s.languageCode} ${s.codec}`),
        }
      : {}),
  };
}
