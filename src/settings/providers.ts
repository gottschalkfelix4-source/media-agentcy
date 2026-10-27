import { randomUUID } from 'node:crypto';
import type { Repo } from '../db/repo.js';
import type { SettingsPatch, SettingsStore } from './store.js';

/**
 * AI providers as a list: OpenAI, Anthropic and OpenRouter (API key), the ChatGPT and Grok plans (sign-in) and any number
 * of custom OpenAI-compatible endpoints. Each keeps its own URL, key and models, so switching never means typing
 * them again. Exactly one is active; its values are what the LLM_* settings hold.
 * Stored in the database (API keys included, never sent to the browser).
 */

export const PROVIDER_KINDS = ['openai', 'anthropic', 'openrouter', 'chatgpt', 'grok', 'custom'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const VALUE_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_MODEL_ADMIN', 'LLM_TEMPERATURE', 'LLM_VISION'] as const;
type ValueKey = (typeof VALUE_KEYS)[number];
export type ProviderValues = Partial<Record<ValueKey, string>>;

const KV_KEY = 'llm_providers';
const OLD_PROFILES_KEY = 'llm_profiles';

/** Built-in entries, always present. Their id is their kind. */
export const BUILTIN: { kind: Exclude<ProviderKind, 'custom'>; name: string }[] = [
  { kind: 'openai', name: 'OpenAI' },
  { kind: 'anthropic', name: 'Anthropic' },
  { kind: 'openrouter', name: 'OpenRouter' },
  { kind: 'chatgpt', name: 'ChatGPT-Abo' },
  { kind: 'grok', name: 'Grok-Abo' },
];

interface Entry {
  id: string;
  kind: ProviderKind;
  name: string;
  values: ProviderValues;
}

interface Stored {
  active?: string;
  providers: Entry[];
}

export interface ProviderView {
  id: string;
  kind: ProviderKind;
  name: string;
  builtin: boolean;
  active: boolean;
  /** Has what it needs to answer (key / URL / sign-in). */
  configured: boolean;
  baseUrl?: string;
  model?: string;
  adminModel?: string;
  temperature?: string;
  vision?: string;
  keySet: boolean;
  keyHint?: string;
}

/** Patch from the UI: string = set, null = clear, missing = keep (API key stays unless typed anew). */
export type ProviderPatch = Partial<Record<ValueKey, string | null>>;

export class LlmProviders {
  constructor(
    private readonly repo: Repo,
    private readonly settings: SettingsStore,
    /** Whether a plan (ChatGPT, Grok) is signed in – that's its "configured". */
    private readonly signedIn: (kind: 'chatgpt' | 'grok') => boolean,
  ) {}

  list(): { active: string; providers: ProviderView[] } {
    const s = this.read();
    return { active: s.active!, providers: s.providers.map((e) => this.view(e, s.active)) };
  }

  get(id: string) {
    return this.read().providers.find((e) => e.id === id);
  }

  create(name: string): ProviderView {
    const s = this.read();
    const entry: Entry = { id: randomUUID(), kind: 'custom', name, values: {} };
    this.write({ ...s, providers: [...s.providers, entry] });
    return this.view(entry, s.active);
  }

  /** Saves a provider's values. Returns the settings patch to apply when it's the active one. */
  update(id: string, patch: ProviderPatch, name?: string): { view: ProviderView; livePatch?: SettingsPatch } {
    const s = this.read();
    const entry = s.providers.find((e) => e.id === id);
    if (!entry) throw new Error('not found');
    const values: ProviderValues = { ...entry.values };
    for (const k of VALUE_KEYS) {
      if (!(k in patch)) continue;
      const v = patch[k]?.trim();
      if (v) values[k] = v;
      else delete values[k];
    }
    const next: Entry = { ...entry, values, name: entry.kind === 'custom' && name?.trim() ? name.trim() : entry.name };
    this.write({ ...s, providers: s.providers.map((e) => (e.id === id ? next : e)) });
    return { view: this.view(next, s.active), livePatch: s.active === id ? settingsPatch(next) : undefined };
  }

  /** The settings this provider would run with (optionally with unsaved edits) – for activation, tests and model lists. */
  patchFor(id: string, draft: ProviderPatch = {}): SettingsPatch | undefined {
    const e = this.get(id);
    if (!e) return undefined;
    const values = { ...e.values };
    for (const k of VALUE_KEYS) {
      if (!(k in draft)) continue;
      const v = draft[k]?.trim();
      if (v) values[k] = v;
      else delete values[k];
    }
    return settingsPatch({ ...e, values });
  }

  setActive(id: string) {
    const s = this.read();
    this.write({ ...s, active: id });
  }

  remove(id: string): 'ok' | 'not_found' | 'builtin' | 'active' {
    const s = this.read();
    const e = s.providers.find((x) => x.id === id);
    if (!e) return 'not_found';
    if (e.kind !== 'custom') return 'builtin';
    if (s.active === id) return 'active';
    this.write({ ...s, providers: s.providers.filter((x) => x.id !== id) });
    return 'ok';
  }

  private view(e: Entry, active?: string): ProviderView {
    const key = e.values.LLM_API_KEY;
    return {
      id: e.id,
      kind: e.kind,
      name: e.name,
      builtin: e.kind !== 'custom',
      active: e.id === active,
      configured: e.kind === 'chatgpt' || e.kind === 'grok' ? this.signedIn(e.kind) : e.kind === 'custom' ? !!e.values.LLM_BASE_URL : !!key,
      baseUrl: e.values.LLM_BASE_URL,
      model: e.values.LLM_MODEL,
      adminModel: e.values.LLM_MODEL_ADMIN,
      temperature: e.values.LLM_TEMPERATURE,
      vision: e.values.LLM_VISION,
      keySet: !!key,
      keyHint: key && key.length > 8 ? `…${key.slice(-4)}` : undefined,
    };
  }

  /** Reads the list; on first use it is seeded from the current settings (and saved profiles from the older version). */
  private read(): Stored {
    let s: Stored | undefined;
    try {
      const raw = this.repo.getKv(KV_KEY);
      if (raw) s = JSON.parse(raw) as Stored;
    } catch {
      s = undefined;
    }
    if (s && BUILTIN.every((b) => s!.providers.some((e) => e.id === b.kind)) && s.active && s.providers.some((e) => e.id === s!.active)) return s;
    s = this.seed(s);
    this.write(s);
    return s;
  }

  private seed(existing?: Stored): Stored {
    const providers: Entry[] = existing?.providers ?? [];
    for (const b of BUILTIN) if (!providers.some((e) => e.id === b.kind)) providers.push({ id: b.kind, kind: b.kind, name: b.name, values: {} });

    // The settings that run right now become their provider's values.
    const current = this.settings.effective(['LLM_PROVIDER', ...VALUE_KEYS]);
    const kind = (PROVIDER_KINDS as readonly string[]).includes(current.LLM_PROVIDER ?? '') ? (current.LLM_PROVIDER as ProviderKind) : 'openrouter';
    const values = Object.fromEntries(VALUE_KEYS.filter((k) => current[k]).map((k) => [k, current[k]])) as ProviderValues;
    let active = existing?.active;
    if (!active || !providers.some((e) => e.id === active)) {
      if (kind === 'custom') {
        const match = providers.find((e) => e.kind === 'custom' && e.values.LLM_BASE_URL === values.LLM_BASE_URL);
        if (match) active = match.id;
        else {
          const entry: Entry = { id: randomUUID(), kind: 'custom', name: hostName(values.LLM_BASE_URL) ?? 'Eigener Anbieter', values };
          providers.push(entry);
          active = entry.id;
        }
      } else {
        const builtin = providers.find((e) => e.id === kind)!;
        if (!Object.keys(builtin.values).length) builtin.values = values;
        active = kind;
      }
    }

    // Profiles saved with the previous version: custom ones become entries, others fill empty built-ins.
    try {
      const old = JSON.parse(this.repo.getKv(OLD_PROFILES_KEY) ?? '[]') as { name: string; values: Record<string, string> }[];
      for (const p of old) {
        const pv = Object.fromEntries(VALUE_KEYS.filter((k) => p.values[k]).map((k) => [k, p.values[k]])) as ProviderValues;
        const pk = p.values.LLM_PROVIDER ?? 'openrouter';
        if (pk === 'custom') providers.push({ id: randomUUID(), kind: 'custom', name: p.name, values: pv });
        else {
          const b = providers.find((e) => e.id === pk);
          if (b && !Object.keys(b.values).length) b.values = pv;
        }
      }
      if (old.length) this.repo.setKv(OLD_PROFILES_KEY, '[]');
    } catch {
      // Unreadable old profiles are just skipped.
    }
    return { active, providers };
  }

  private write(s: Stored) {
    this.repo.setKv(KV_KEY, JSON.stringify(s));
  }
}

/** Settings for a provider. Keys it doesn't have are cleared ('' overrides the environment), not kept from another one. */
function settingsPatch(e: Entry): SettingsPatch {
  return { LLM_PROVIDER: e.kind, ...Object.fromEntries(VALUE_KEYS.map((k) => [k, e.values[k] ?? ''])) };
}

function hostName(url?: string) {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}
