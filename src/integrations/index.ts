import type { Config } from '../config.js';
import { RadarrClient, SonarrClient } from './arr.js';
import { JellyfinClient } from './jellyfin.js';
import { OmbiClient } from './ombi.js';
import { PlexClient } from './plex.js';
import { SeerrClient } from './seerr.js';

export interface Services {
  jellyfin?: JellyfinClient;
  plex?: PlexClient;
  seerr?: SeerrClient;
  ombi?: OmbiClient;
  sonarr?: SonarrClient;
  radarr?: RadarrClient;
}

export function createServices(c: Config): Services {
  return {
    jellyfin: c.JELLYFIN_URL && c.JELLYFIN_API_KEY ? new JellyfinClient(c.JELLYFIN_URL, c.JELLYFIN_API_KEY, c.JELLYFIN_PUBLIC_URL) : undefined,
    plex: c.PLEX_URL && c.PLEX_TOKEN ? new PlexClient(c.PLEX_URL, c.PLEX_TOKEN) : undefined,
    seerr: c.SEERR_URL && c.SEERR_API_KEY ? new SeerrClient(c.SEERR_URL, c.SEERR_API_KEY, c.SEERR_PUBLIC_URL) : undefined,
    ombi: c.OMBI_URL && c.OMBI_API_KEY ? new OmbiClient(c.OMBI_URL, c.OMBI_API_KEY) : undefined,
    sonarr: c.SONARR_URL && c.SONARR_API_KEY ? new SonarrClient(c.SONARR_URL, c.SONARR_API_KEY) : undefined,
    radarr: c.RADARR_URL && c.RADARR_API_KEY ? new RadarrClient(c.RADARR_URL, c.RADARR_API_KEY) : undefined,
  };
}

export function enabledServices(s: Services) {
  return (Object.keys(s) as (keyof Services)[]).filter((k) => s[k]);
}

export async function pingAll(s: Services) {
  const out: Record<string, string> = {};
  await Promise.all(
    enabledServices(s).map(async (k) => {
      try {
        const r = await s[k]!.ping();
        out[k] = 'version' in r && r.version ? `ok (v${r.version})` : 'ok';
      } catch (err) {
        out[k] = `FEHLER: ${(err as Error).message.slice(0, 150)}`;
      }
    }),
  );
  return out;
}
