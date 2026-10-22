import type { User, UserPatch } from '../db/repo.js';

/** Accounts as the integrations return them (only the fields the import needs). */
export interface MediaAccountLists {
  jellyfin?: { id: string; name: string; disabled: boolean; admin: boolean; lastActivity?: string }[];
  plex?: { id: number; username: string; email?: string; owner: boolean }[];
  seerr?: { id: number; displayName?: string; username?: string; email?: string; jellyfinUsername?: string; plexUsername?: string }[];
}

/** One person across all media servers, ready to be imported with a phone number. */
export interface ImportCandidate {
  key: string;
  name: string;
  email?: string;
  jellyfin?: { id: string; name: string; disabled: boolean; admin: boolean; lastActivity?: string };
  plex?: { username: string; owner: boolean };
  seerr?: { id: number; name: string };
  /** Bot user that is already linked to one of these accounts. */
  existing?: { id: number; name: string; wa_id: string };
}

const norm = (s?: string | null) => s?.trim().toLowerCase() || undefined;

/**
 * Merges the account lists into one candidate per person. Jellyseerr knows the Jellyfin and Plex
 * names of its users, so it is merged second and acts as the bridge between the two servers.
 * Otherwise accounts are matched by equal user name or e-mail.
 */
export function mergeAccounts(lists: MediaAccountLists, users: User[]): ImportCandidate[] {
  type Draft = ImportCandidate & { aliases: Set<string> };
  const drafts: Draft[] = [];
  const place = <K extends 'jellyfin' | 'plex' | 'seerr'>(slot: K, key: string, rawAliases: (string | undefined)[], data: Draft[K], name: string, email?: string) => {
    const aliases = rawAliases.map(norm).filter((a): a is string => !!a);
    let d = drafts.find((c) => !c[slot] && aliases.some((a) => c.aliases.has(a)));
    if (!d) {
      d = { key, name, aliases: new Set() };
      drafts.push(d);
    }
    d[slot] = data;
    for (const a of aliases) d.aliases.add(a);
    d.email ??= email;
  };

  for (const j of lists.jellyfin ?? []) place('jellyfin', `jellyfin:${j.id}`, [j.name], j, j.name);
  for (const s of lists.seerr ?? []) {
    const name = s.displayName || s.username || s.jellyfinUsername || s.plexUsername || s.email || `#${s.id}`;
    place('seerr', `seerr:${s.id}`, [s.jellyfinUsername, s.plexUsername, s.username, s.displayName, s.email], { id: s.id, name }, name, s.email);
    // The Jellyseerr display name is usually the nicest one.
    const d = drafts.find((c) => c.seerr?.id === s.id)!;
    if (s.displayName) d.name = s.displayName;
  }
  for (const p of lists.plex ?? []) place('plex', `plex:${p.id}`, [p.username, p.email], { username: p.username, owner: p.owner }, p.username, p.email);

  return drafts
    .map(({ aliases: _, ...c }) => {
      const u = findLinkedUser(c, users);
      return u ? { ...c, existing: { id: u.id, name: u.display_name ?? u.push_name ?? `+${u.wa_id}`, wa_id: u.wa_id } } : c;
    })
    .sort((a, b) => Number(!!a.existing) - Number(!!b.existing) || a.name.localeCompare(b.name, 'de'));
}

/**
 * The bot user behind a candidate: same account id, or the same user name on Jellyfin or Plex
 * (like the merge above, equal names count as the same person across servers). This also finds
 * users that were only linked to Plex once Plex is gone and just their Jellyfin account is left.
 */
function findLinkedUser(c: ImportCandidate, users: User[]) {
  const names = new Set([c.jellyfin?.name, c.plex?.username].map(norm).filter(Boolean));
  return (
    users.find((u) => (c.jellyfin && u.jellyfin_user_id === c.jellyfin.id) || (c.seerr && u.seerr_user_id === c.seerr.id)) ??
    users.find((u) => [u.jellyfin_username, u.plex_username].some((n) => names.has(norm(n))))
  );
}

/**
 * Account links a known bot user is still missing (e.g. users imported from Plex who also have a
 * Jellyfin account). Only fills empty fields and skips accounts another user already has.
 */
export function missingLinks(candidates: ImportCandidate[], users: User[]): { userId: number; patch: Pick<UserPatch, 'jellyfin_user_id' | 'jellyfin_username' | 'seerr_user_id'> }[] {
  const out: ReturnType<typeof missingLinks> = [];
  for (const c of candidates) {
    const u = c.existing && users.find((x) => x.id === c.existing!.id);
    if (!u) continue;
    const others = users.filter((x) => x.id !== u.id);
    const patch: (typeof out)[number]['patch'] = {};
    if (c.jellyfin && !u.jellyfin_user_id && !u.jellyfin_username && !others.some((x) => x.jellyfin_user_id === c.jellyfin!.id || norm(x.jellyfin_username) === norm(c.jellyfin!.name))) {
      patch.jellyfin_user_id = c.jellyfin.id;
      patch.jellyfin_username = c.jellyfin.name;
    }
    if (c.seerr && u.seerr_user_id == null && !others.some((x) => x.seerr_user_id === c.seerr!.id)) patch.seerr_user_id = c.seerr.id;
    if (Object.keys(patch).length) out.push({ userId: u.id, patch });
  }
  return out;
}

/**
 * Turns user input into WhatsApp digits ("+49 151 1234-567", "0049…" → "491511234567").
 * Local numbers with a single leading 0 are rejected because the country code is unknown.
 */
export function normalizePhone(raw: string): { phone: string } | { error: string } {
  let v = raw.trim().replace(/[\s\-()/.]/g, '');
  if (v.startsWith('+')) v = v.slice(1);
  else if (v.startsWith('00')) v = v.slice(2);
  else if (v.startsWith('0')) return { error: 'Bitte mit Ländervorwahl angeben, z. B. +49 151 …' };
  if (!/^\d+$/.test(v)) return { error: 'Nur Ziffern, Leerzeichen und + erlaubt' };
  if (v.length < 8 || v.length > 15) return { error: 'Telefonnummer hat nicht die richtige Länge' };
  return { phone: v };
}
