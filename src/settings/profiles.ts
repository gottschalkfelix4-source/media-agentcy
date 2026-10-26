import { randomUUID } from 'node:crypto';
import type { Repo } from '../db/repo.js';
import type { SettingsPatch, SettingsStore } from './store.js';

/**
 * Saved AI providers ("profiles"): a named snapshot of the LLM settings, so switching between e.g.
 * OpenRouter, a local Ollama and Anthropic doesn't mean typing URL, key and model again each time.
 * Stored in the database next to the other settings (API keys included, never sent to the browser).
 */

export const PROFILE_KEYS = ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_MODEL_ADMIN', 'LLM_TEMPERATURE', 'LLM_VISION'] as const;
const KV_KEY = 'llm_profiles';

interface Profile {
  id: string;
  name: string;
  values: Partial<Record<(typeof PROFILE_KEYS)[number], string>>;
  createdAt: string;
}

export interface ProfileView {
  id: string;
  name: string;
  provider: string;
  baseUrl?: string;
  model?: string;
  adminModel?: string;
  keyHint?: string;
  active: boolean;
  createdAt: string;
}

export class LlmProfiles {
  constructor(
    private readonly repo: Repo,
    private readonly settings: SettingsStore,
  ) {}

  list(): ProfileView[] {
    const current = this.settings.effective(PROFILE_KEYS);
    return this.read().map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.values.LLM_PROVIDER ?? 'openrouter',
      baseUrl: p.values.LLM_BASE_URL,
      model: p.values.LLM_MODEL,
      adminModel: p.values.LLM_MODEL_ADMIN,
      keyHint: p.values.LLM_API_KEY ? `…${p.values.LLM_API_KEY.slice(-4)}` : undefined,
      active: PROFILE_KEYS.every((k) => (p.values[k] ?? '') === (current[k] ?? '')),
      createdAt: p.createdAt,
    }));
  }

  /** Saves the current settings (plus unsaved edits from the page) under a name; the same name is overwritten. */
  save(name: string, draft: SettingsPatch = {}): ProfileView {
    const values = Object.fromEntries(Object.entries(this.settings.effective(PROFILE_KEYS, draft)).filter(([, v]) => v)) as Profile['values'];
    const all = this.read();
    const existing = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const profile: Profile = { id: existing?.id ?? randomUUID(), name, values, createdAt: new Date().toISOString() };
    this.write(existing ? all.map((p) => (p.id === existing.id ? profile : p)) : [...all, profile]);
    return this.list().find((p) => p.id === profile.id)!;
  }

  /** The settings patch that switches to a profile. Keys the profile doesn't have are cleared, not left from the previous one. */
  patchFor(id: string): SettingsPatch | undefined {
    const p = this.read().find((x) => x.id === id);
    if (!p) return undefined;
    return Object.fromEntries(PROFILE_KEYS.map((k) => [k, p.values[k] ?? '']));
  }

  remove(id: string) {
    const all = this.read();
    if (!all.some((p) => p.id === id)) return false;
    this.write(all.filter((p) => p.id !== id));
    return true;
  }

  private read(): Profile[] {
    try {
      return JSON.parse(this.repo.getKv(KV_KEY) ?? '[]') as Profile[];
    } catch {
      return [];
    }
  }

  private write(profiles: Profile[]) {
    this.repo.setKv(KV_KEY, JSON.stringify(profiles));
  }
}
