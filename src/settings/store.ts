import { buildConfig, replaceConfig, type Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import { bus } from '../events.js';
import { SETTINGS, SETTINGS_BY_KEY, type SettingDef } from './registry.js';

export interface SettingView extends SettingDef {
  /** Current raw value. Always null for secrets. */
  value: string | null;
  /** Where the effective value comes from. */
  source: 'ui' | 'env' | 'default';
  /** Value from the environment (.env / container), if any. Null for secrets. */
  envValue: string | null;
  /** Secrets only: whether a value is set, and its last characters. */
  isSet: boolean;
  hint?: string;
}

/** Patch from the UI: a string sets the value, null removes the UI override (back to env/default). */
export type SettingsPatch = Record<string, string | null>;

/**
 * Settings edited in the web UI. They are stored in the database and overlay
 * the environment variables, so .env stays the bootstrap and the UI wins.
 */
export class SettingsStore {
  private overrides = new Map<string, string>();

  constructor(
    private readonly repo: Repo,
    /** Non-persistent overrides (e.g. the local test chat). */
    private readonly runtime: Record<string, string> = {},
  ) {
    for (const row of repo.listSettings()) if (SETTINGS_BY_KEY.has(row.key as never)) this.overrides.set(row.key, row.value);
  }

  private source(patch: SettingsPatch = {}) {
    const src: Record<string, string | undefined> = { ...process.env };
    for (const [k, v] of this.overrides) if (!(k in patch)) src[k] = v;
    for (const [k, v] of Object.entries(patch)) src[k] = v === null ? process.env[k] : v;
    Object.assign(src, this.runtime);
    return src;
  }

  /** Builds a config with a draft patch applied, without saving anything. */
  preview(patch: SettingsPatch = {}) {
    return buildConfig(this.source(patch));
  }

  /** Applies env + stored overrides to the live config. Returns an error if stored overrides are invalid. */
  applyStartup(): string | undefined {
    const res = this.preview();
    if (res.ok) {
      replaceConfig(res.config);
      return undefined;
    }
    // Broken overrides must not keep the bot from starting: fall back to env only.
    const envOnly = buildConfig({ ...process.env, ...this.runtime });
    if (envOnly.ok) replaceConfig(envOnly.config);
    return res.error;
  }

  update(patch: SettingsPatch): { ok: true; changed: string[]; config: Config } | { ok: false; error: string } {
    for (const key of Object.keys(patch)) {
      const def = SETTINGS_BY_KEY.get(key as never);
      if (!def) return { ok: false, error: `Unbekannte Einstellung: ${key}` };
      if (def.readOnly) return { ok: false, error: `${def.label} kann nur per Umgebungsvariable geändert werden` };
    }
    const before = this.source();
    const res = this.preview(patch);
    if (!res.ok) return res;

    for (const [k, v] of Object.entries(patch)) {
      if (v === null) {
        this.overrides.delete(k);
        this.repo.deleteSetting(k);
      } else {
        this.overrides.set(k, v);
        this.repo.setSetting(k, v);
      }
    }
    const after = this.source();
    const changed = Object.keys(patch).filter((k) => (before[k] ?? '') !== (after[k] ?? ''));
    replaceConfig(res.config);
    bus.emitEvent({ type: 'settings' });
    return { ok: true, changed, config: res.config };
  }

  view(): SettingView[] {
    return SETTINGS.map((def) => {
      const ui = this.overrides.get(def.key);
      const env = process.env[def.key]?.trim() || undefined;
      const effective = ui ?? env;
      const secret = def.type === 'secret';
      return {
        ...def,
        value: secret ? null : (effective ?? null),
        source: ui !== undefined ? 'ui' : env !== undefined ? 'env' : 'default',
        envValue: secret ? null : (env ?? null),
        isSet: !!effective,
        hint: secret && effective && effective.length > 8 ? `…${effective.slice(-4)}` : undefined,
      };
    });
  }
}
