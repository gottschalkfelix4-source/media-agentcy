import { ApiClient } from './http.js';

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

  constructor(baseUrl: string, token: string) {
    this.api = new ApiClient({ service: 'Plex', baseUrl, headers: { 'X-Plex-Token': token, 'X-Plex-Client-Identifier': 'media-agentcy' } });
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
    const res = await this.api.get<{ MediaContainer: { Metadata?: PlexMetadata[] } }>(`/library/metadata/${ratingKey}`);
    const m = res.MediaContainer.Metadata?.[0];
    return m ? summarize(m, true) : undefined;
  }

  async refreshItem(ratingKey: string) {
    await this.api.put(`/library/metadata/${ratingKey}/refresh`);
  }

  async sections() {
    const res = await this.api.get<{ MediaContainer: { Directory?: { key: string; title: string; type: string }[] } }>('/library/sections');
    return res.MediaContainer.Directory ?? [];
  }

  async scanLibrary(sectionKey?: string) {
    const keys = sectionKey ? [sectionKey] : (await this.sections()).map((s) => s.key);
    for (const k of keys) await this.api.get(`/library/sections/${k}/refresh`);
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
