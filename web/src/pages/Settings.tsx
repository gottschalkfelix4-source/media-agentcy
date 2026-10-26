import { useMutation, useQuery } from '@tanstack/react-query';
import { Bookmark, CheckCircle2, Download, ExternalLink, KeyRound, LogOut, Plug, RotateCcw, Save, Trash2, X, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { api, queryClient, type ChatGPTStatus, type LlmProfile, type SettingDef, type SettingsResponse } from '../api';
import { Badge, Button, Card, ErrorBox, Field, IconButton, Input, Loading, Modal, PageHeader, Select, Textarea, Toggle, cx, toast, toastError } from '../components/ui';
import { setQuery, useLocation } from '../router';

/** Unsaved edits: string = new value, null = reset to env/default. */
type Draft = Record<string, string | null>;

const SOURCE: Record<SettingDef['source'], { label: string; tone: 'accent' | 'info' | 'neutral'; title: string }> = {
  ui: { label: 'Web', tone: 'accent', title: 'In der Web-Oberfläche festgelegt' },
  env: { label: 'ENV', tone: 'info', title: 'Aus der Umgebungsvariable (Docker-Template)' },
  default: { label: 'Standard', tone: 'neutral', title: 'Standardwert' },
};

function ListInput({ value, onChange, placeholder, disabled }: { value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  const items = value.split(/[,; ]+/).filter(Boolean);
  const [text, setText] = useState('');
  const add = () => {
    const v = text.replace(/[^\d]/g, '');
    if (v && !items.includes(v)) onChange([...items, v].join(','));
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !text && items.length) {
      onChange(items.slice(0, -1).join(','));
    }
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 py-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
      {items.map((it) => (
        <span key={it} className="inline-flex items-center gap-1 rounded-md bg-surface-3 py-0.5 pr-1 pl-2 text-xs font-medium">
          +{it}
          {!disabled && (
            <button type="button" aria-label={`${it} entfernen`} className="rounded p-0.5 text-fg-3 hover:text-danger" onClick={() => onChange(items.filter((x) => x !== it).join(','))}>
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      <input
        className="h-7 min-w-32 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-3"
        placeholder={items.length ? 'weitere Nummer …' : placeholder}
        value={text}
        disabled={disabled}
        inputMode="tel"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
      />
    </div>
  );
}

function SettingField({
  def,
  draft,
  setDraft,
  models,
}: {
  def: SettingDef;
  draft: Draft;
  setDraft: (key: string, v: string | null | undefined) => void;
  models?: string[];
}) {
  const edited = def.key in draft;
  const d = draft[def.key];
  // What the field shows: the draft, or (after a reset) the env value, or the stored value.
  const value = edited ? (d ?? def.envValue ?? '') : (def.value ?? '');
  const placeholder = def.placeholder ?? (def.default ? `Standard: ${def.default}` : undefined);
  const disabled = def.readOnly;
  const src = SOURCE[edited ? (d === null ? (def.envValue ? 'env' : 'default') : 'ui') : def.source];
  const canReset = !def.readOnly && ((def.source === 'ui' && !edited) || (edited && d !== null));
  // Typing the saved value back drops the draft, so an env value doesn't get pinned as a UI override.
  const set = (v: string) => setDraft(def.key, v === (def.value ?? '') ? undefined : v);

  let control;
  switch (def.type) {
    case 'bool': {
      const on = (value || def.default || 'false') === 'true';
      const saved = (def.value || def.default || 'false') === 'true';
      control = (
        <div className="flex h-9 items-center">
          <Toggle checked={on} disabled={disabled} label={def.label} onChange={(v) => setDraft(def.key, v === saved ? undefined : String(v))} />
          <span className="ml-2 text-[13px] text-fg-2">{on ? 'An' : 'Aus'}</span>
        </div>
      );
      break;
    }
    case 'select':
      control = (
        <Select value={value || def.default || ''} disabled={disabled} onChange={(e) => set(e.target.value)}>
          {def.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
      break;
    case 'textarea':
      control = <Textarea rows={6} value={value} disabled={disabled} placeholder={placeholder} onChange={(e) => set(e.target.value)} />;
      break;
    case 'list':
      control = <ListInput value={value} disabled={disabled} placeholder={def.placeholder} onChange={set} />;
      break;
    case 'secret':
      control = (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="new-password"
            disabled={disabled}
            value={edited && d !== null ? (d ?? '') : ''}
            placeholder={edited && d === null ? (def.source === 'env' ? 'wird auf ENV-Wert zurückgesetzt' : 'wird gelöscht') : def.isSet ? `gesetzt ${def.hint ?? ''} – zum Ändern neu eingeben` : 'nicht gesetzt'}
            onChange={(e) => setDraft(def.key, e.target.value === '' ? undefined : e.target.value)}
          />
          {def.isSet && !edited && <CheckCircle2 className="size-4 shrink-0 text-ok" aria-label="gesetzt" />}
        </div>
      );
      break;
    default:
      control = (
        <>
          <Input
            type={def.type === 'int' || def.type === 'float' ? 'number' : def.type === 'url' ? 'url' : 'text'}
            step={def.type === 'float' ? 'any' : undefined}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            list={models ? `models-${def.key}` : undefined}
            onChange={(e) => set(e.target.value)}
          />
          {models && (
            <datalist id={`models-${def.key}`}>
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
        </>
      );
  }

  return (
    <Field
      label={
        <span className="inline-flex items-center gap-2">
          {def.label}
          {edited && <span className="size-1.5 rounded-full bg-warn" title="Ungespeichert" />}
        </span>
      }
      help={def.help}
      aside={
        <span className="flex items-center gap-1.5">
          {def.restart && <Badge tone="warn">Neustart nötig</Badge>}
          <Badge tone={src.tone} title={src.title}>
            {src.label}
          </Badge>
          {canReset && (
            <button
              type="button"
              title={def.envValue || def.type === 'secret' ? 'Auf ENV-/Standardwert zurücksetzen' : 'Auf Standard zurücksetzen'}
              className="rounded p-0.5 text-fg-3 hover:text-fg"
              onClick={() => setDraft(def.key, def.source === 'ui' ? null : undefined)}
            >
              <RotateCcw className="size-3.5" />
            </button>
          )}
          {edited && d === null && (
            <button type="button" className="text-[11px] text-fg-3 underline" onClick={() => setDraft(def.key, undefined)}>
              rückgängig
            </button>
          )}
        </span>
      }
    >
      {control}
    </Field>
  );
}

function TestButton({ target, draft }: { target: string; draft: Draft }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>('/settings/test', { body: { target, values: draft } }),
    onMutate: () => setResult(null),
    onSuccess: setResult,
    onError: (err) => setResult({ ok: false, message: err instanceof Error ? err.message : String(err) }),
  });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" loading={test.isPending} icon={<Plug className="size-3.5" />} onClick={() => test.mutate()}>
        Verbindung testen
      </Button>
      {result && (
        <span className={cx('inline-flex items-center gap-1.5 text-xs', result.ok ? 'text-ok' : 'text-danger')}>
          {result.ok ? <CheckCircle2 className="size-3.5 shrink-0" /> : <XCircle className="size-3.5 shrink-0" />}
          {result.message}
        </span>
      )}
    </div>
  );
}

const PROFILE_KEYS = ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_MODEL_ADMIN', 'LLM_TEMPERATURE', 'LLM_VISION'];

/** Saved AI providers: snapshot the current LLM settings under a name and switch back with one click. */
function ProfilesCard({ draft, providers, onApplied }: { draft: Draft; providers: Map<string, string>; onApplied: (res: SettingsResponse) => void }) {
  const q = useQuery({ queryKey: ['llm-profiles'], queryFn: () => api<LlmProfile[]>('/llm-profiles') });
  const [name, setName] = useState('');
  const llmDraft = Object.fromEntries(Object.entries(draft).filter(([k]) => PROFILE_KEYS.includes(k)));
  const save = useMutation({
    mutationFn: () => api<LlmProfile>('/llm-profiles', { body: { name, values: llmDraft } }),
    onSuccess: (p) => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['llm-profiles'] });
      toast(`„${p.name}“ gespeichert`);
    },
    onError: toastError,
  });
  const activate = useMutation({
    mutationFn: (p: LlmProfile) => api<SettingsResponse>(`/llm-profiles/${p.id}/activate`, { body: {} }),
    onSuccess: (res, p) => {
      onApplied(res);
      void queryClient.invalidateQueries({ queryKey: ['llm-profiles'] });
      toast(`„${p.name}“ ist jetzt aktiv`);
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (p: LlmProfile) => api(`/llm-profiles/${p.id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['llm-profiles'] }),
    onError: toastError,
  });

  return (
    <Card title={<span className="inline-flex items-center gap-2"><Bookmark className="size-4" /> Gespeicherte Anbieter</span>}>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <div className="space-y-4">
          {q.data.length ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {q.data.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] font-medium">
                      {p.name}
                      {p.active && <Badge tone="ok">aktiv</Badge>}
                    </div>
                    <p className="truncate text-xs text-fg-3">
                      {providers.get(p.provider) ?? p.provider}
                      {p.model ? ` · ${p.model}` : ''}
                      {p.baseUrl ? ` · ${p.baseUrl}` : ''}
                      {p.keyHint ? ` · Key ${p.keyHint}` : ''}
                    </p>
                  </div>
                  <Button size="sm" variant={p.active ? 'ghost' : 'secondary'} disabled={p.active} loading={activate.isPending && activate.variables?.id === p.id} onClick={() => activate.mutate(p)}>
                    {p.active ? 'Aktiv' : 'Übernehmen'}
                  </Button>
                  <IconButton label="Löschen" onClick={() => remove.mutate(p)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-fg-3">Noch keine gespeichert. Richte oben einen Anbieter ein, teste ihn und speichere ihn hier unter einem Namen – dann reicht beim nächsten Wechsel ein Klick.</p>
          )}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Field label="Aktuelle Einstellungen speichern als" help={Object.keys(llmDraft).length ? 'Inklusive der noch nicht gespeicherten Änderungen oben.' : 'Anbieter, Endpoint, API-Key, Modelle, Temperatur und Bilder.'}>
              <Input value={name} maxLength={60} placeholder="z. B. Ollama zuhause" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button type="submit" variant="secondary" loading={save.isPending} disabled={!name.trim()} icon={<Save className="size-4" />}>
              Speichern
            </Button>
          </form>
          <p className="text-xs text-fg-3">„Übernehmen“ ersetzt die KI-Einstellungen sofort; Felder, die das Profil nicht hat, werden geleert. Gleicher Name überschreibt.</p>
        </div>
      )}
    </Card>
  );
}

const USAGE_URL = 'https://chatgpt.com/settings/usage';

/**
 * "Sign in with ChatGPT" for the ChatGPT plan. OpenAI only allows a 127.0.0.1 callback, which never reaches
 * this server – so after approving, the admin copies the (not loading) callback address and pastes it here.
 */
function ChatGPTCard() {
  const q = useQuery({ queryKey: ['chatgpt'], queryFn: () => api<ChatGPTStatus>('/chatgpt') });
  const [pending, setPending] = useState<string | null>(null);
  const [callback, setCallback] = useState('');
  const [welcome, setWelcome] = useState(false);
  const start = useMutation({
    mutationFn: (consent: boolean) => api<{ url: string }>('/chatgpt/login', { body: { consent } }),
    onSuccess: (r) => {
      setPending(r.url);
      setCallback('');
      window.open(r.url, '_blank', 'noopener');
    },
    onError: toastError,
  });
  const finish = useMutation({
    mutationFn: () => api<{ status: ChatGPTStatus; firstPlanSignIn: boolean }>('/chatgpt/callback', { body: { url: callback } }),
    onSuccess: (r) => {
      queryClient.setQueryData(['chatgpt'], r.status);
      setPending(null);
      setCallback('');
      if (r.firstPlanSignIn) setWelcome(true);
      else toast(r.status.planUsage ? 'ChatGPT verbunden' : 'Angemeldet – aber ohne Erlaubnis, das ChatGPT-Abo zu nutzen', r.status.planUsage ? 'ok' : 'info');
    },
    onError: toastError,
  });
  const logout = useMutation({
    mutationFn: () => api<{ revoked: boolean; status: ChatGPTStatus }>('/chatgpt/logout', { body: {} }),
    onSuccess: (r) => {
      queryClient.setQueryData(['chatgpt'], r.status);
      toast(r.revoked ? 'ChatGPT getrennt' : 'Lokal getrennt – der Widerruf bei OpenAI wurde nicht bestätigt. In ChatGPT unter Einstellungen → Apps trennen.', r.revoked ? 'ok' : 'info');
    },
    onError: toastError,
  });

  const s = q.data;
  return (
    <Card title="ChatGPT-Abo nutzen" actions={s?.planUsage && <Badge tone="ok">Using ChatGPT plan</Badge>}>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <div className="space-y-4 text-[13px]">
          {s!.connected ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className={cx('size-4', s!.planUsage ? 'text-ok' : 'text-warn')} />
                Verbunden{s!.email ? <> als <strong>{s!.email}</strong></> : null}
              </span>
              <a className="inline-flex items-center gap-1 text-accent-text hover:underline" href={USAGE_URL} target="_blank" rel="noreferrer">
                Manage usage <ExternalLink className="size-3" />
              </a>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" loading={start.isPending} onClick={() => start.mutate(false)}>
                Neu anmelden
              </Button>
              <Button size="sm" variant="ghost" icon={<LogOut className="size-3.5" />} loading={logout.isPending} onClick={() => logout.mutate()}>
                Trennen
              </Button>
            </div>
          ) : (
            <p className="text-fg-2">
              Beantworte Nachrichten mit den Modellen und dem Kontingent deines ChatGPT-Abos statt mit einem API-Key. Die Nutzung zählt auf dein Abo-Limit (bei Plus geteilt mit allen anderen Apps); Limits pro App stellst du in ChatGPT ein.
            </p>
          )}
          {s!.connected && !s!.planUsage && (
            <div className="rounded-lg bg-warn-soft p-3 text-fg-2">
              Die Anmeldung erlaubt <strong>nicht</strong>, dein ChatGPT-Abo zu nutzen – der Bot kann so nicht antworten.{' '}
              <Button size="sm" variant="secondary" className="ml-1" loading={start.isPending} onClick={() => start.mutate(true)}>
                Abo-Nutzung aktivieren
              </Button>
            </div>
          )}
          {!s!.connected && !pending && (
            <Button variant="primary" loading={start.isPending} onClick={() => start.mutate(false)}>
              Continue with ChatGPT
            </Button>
          )}
          {pending && (
            <div className="space-y-3 rounded-lg bg-surface-2 p-3">
              <ol className="list-decimal space-y-1 pl-5 text-fg-2">
                <li>
                  Im neuen Tab bei ChatGPT anmelden und zustimmen.{' '}
                  <a className="text-accent-text hover:underline" href={pending} target="_blank" rel="noreferrer">
                    Tab nicht aufgegangen?
                  </a>
                </li>
                <li>
                  Danach landet der Browser auf <code className="rounded bg-surface px-1">127.0.0.1:1455/auth/callback…</code> und die Seite lädt nicht – das ist richtig.
                </li>
                <li>Die komplette Adresse aus der Adressleiste kopieren und hier einfügen:</li>
              </ol>
              <Textarea rows={3} value={callback} placeholder="http://127.0.0.1:1455/auth/callback?code=…" onChange={(e) => setCallback(e.target.value)} />
              <div className="flex gap-2">
                <Button variant="primary" loading={finish.isPending} disabled={!callback.trim()} onClick={() => finish.mutate()}>
                  Verbinden
                </Button>
                <Button variant="ghost" onClick={() => setPending(null)}>
                  Abbrechen
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      <Modal
        open={welcome}
        onClose={() => setWelcome(false)}
        title="You're using your ChatGPT plan"
        footer={
          <Button variant="primary" onClick={() => setWelcome(false)}>
            Got it
          </Button>
        }
      >
        <p className="text-[13px] text-fg-2">
          Antworten des Bots laufen jetzt über dein ChatGPT-Abo und zählen auf dessen Nutzungslimit. Verbrauch und Limits für diese App verwaltest du in den{' '}
          <a className="text-accent-text hover:underline" href={USAGE_URL} target="_blank" rel="noreferrer">
            ChatGPT-Einstellungen
          </a>
          .
        </p>
      </Modal>
    </Card>
  );
}

function PasswordCard({ fromEnv }: { fromEnv: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const change = useMutation({
    mutationFn: () => api('/auth/password', { body: { current, next } }),
    onSuccess: () => {
      toast('Passwort geändert – andere Sitzungen wurden abgemeldet');
      setCurrent('');
      setNext('');
      setRepeat('');
    },
    onError: toastError,
  });
  return (
    <Card title={<span className="inline-flex items-center gap-2"><KeyRound className="size-4" /> Passwort der Web-Oberfläche</span>}>
      {fromEnv ? (
        <p className="text-[13px] text-fg-2">
          Das Passwort kommt aus der Umgebungsvariable <code className="rounded bg-surface-2 px-1">WEB_PASSWORD</code> und kann nur dort geändert werden.
        </p>
      ) : (
        <form
          className="grid gap-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <Field label="Aktuelles Passwort">
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="Neues Passwort" help="Mindestens 8 Zeichen">
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Wiederholen">
            <Input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </Field>
          <div className="flex items-center gap-3 sm:col-span-3">
            <Button type="submit" variant="primary" loading={change.isPending} disabled={!current || next.length < 8 || next !== repeat}>
              Passwort ändern
            </Button>
            {repeat && next !== repeat && <span className="text-xs text-danger">Passwörter stimmen nicht überein</span>}
          </div>
        </form>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const { query } = useLocation();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsResponse>('/settings'), staleTime: Infinity });
  const [draft, setDraftState] = useState<Draft>({});
  const [models, setModels] = useState<string[]>();
  const groupId = query.get('group') ?? 'general';

  const setDraft = (key: string, v: string | null | undefined) =>
    setDraftState((d) => {
      const next = { ...d };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return next;
    });
  const dirtyCount = Object.keys(draft).length;

  useEffect(() => {
    if (!dirtyCount) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyCount]);

  const save = useMutation({
    mutationFn: () => api<SettingsResponse>('/settings', { method: 'PUT', body: { values: draft } }),
    onSuccess: (res) => {
      queryClient.setQueryData(['settings'], res);
      setDraftState({});
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['services'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      toast(res.changed?.length ? `Gespeichert und sofort aktiv (${res.changed.length} geändert)` : 'Gespeichert');
    },
    onError: toastError,
  });

  const loadModels = useMutation({
    mutationFn: () => api<{ models: string[]; error?: string; note?: string }>('/settings/models', { body: { values: draft } }),
    onSuccess: (r) => {
      if (r.error) toast(r.error, 'danger');
      else {
        setModels(r.models);
        toast(r.note ?? `${r.models.length} Modelle mit Tool-Unterstützung geladen – tippe ins Modell-Feld`, 'info');
      }
    },
    onError: toastError,
  });

  const byGroup = useMemo(() => {
    const m = new Map<string, SettingDef[]>();
    for (const s of q.data?.settings ?? []) m.set(s.group, [...(m.get(s.group) ?? []), s]);
    return m;
  }, [q.data]);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} />;

  const groups = q.data.groups;
  const group = groups.find((g) => g.id === groupId) ?? groups[0];
  const fields = byGroup.get(group.id) ?? [];
  const groupDirty = (id: string) => (byGroup.get(id) ?? []).some((s) => s.key in draft);
  const configured = (id: string) => {
    const f = byGroup.get(id) ?? [];
    const url = f.find((s) => s.type === 'url' && s.key.endsWith('_URL') && !s.key.includes('PUBLIC'));
    return url ? url.isSet : undefined;
  };
  const llmProvider = draft.LLM_PROVIDER ?? q.data.settings.find((s) => s.key === 'LLM_PROVIDER')?.value ?? 'openrouter';
  const hidden = (s: SettingDef) => (s.key === 'CHATGPT_AUTH_FILE' && llmProvider !== 'chatgpt') || (s.key === 'LLM_BASE_URL' && llmProvider !== 'custom' && !s.isSet);

  return (
    <>
      <PageHeader title="Einstellungen" subtitle="Änderungen gelten sofort – ohne Neustart. Werte aus der Web-Oberfläche haben Vorrang vor Umgebungsvariablen." />
      <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:sticky lg:top-20 lg:mx-0 lg:flex-col lg:self-start lg:overflow-visible lg:px-0">
          {groups.map((g) => {
            const c = configured(g.id);
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => setQuery({ group: g.id === 'general' ? null : g.id })}
                className={cx(
                  'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors',
                  g.id === group.id ? 'bg-surface text-fg shadow-card ring-1 ring-line' : 'text-fg-3 hover:bg-surface-2 hover:text-fg-2',
                )}
              >
                <span className="flex-1">{g.label}</span>
                {groupDirty(g.id) && <span className="size-1.5 rounded-full bg-warn" title="Ungespeicherte Änderungen" />}
                {c !== undefined && <span className={cx('size-1.5 rounded-full', c ? 'bg-ok' : 'bg-line-strong')} title={c ? 'Eingerichtet' : 'Nicht eingerichtet'} />}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 space-y-5">
          <Card title={group.label} actions={group.test && <span className="hidden sm:block"><TestButton key={group.id} target={group.test} draft={draft} /></span>}>
            {group.description && <p className="-mt-1 mb-5 text-[13px] text-fg-3">{group.description}</p>}
            <div className="grid gap-5 md:grid-cols-2">
              {fields
                .filter((s) => !hidden(s))
                .map((s) => (
                  <div key={s.key} className={cx(s.type === 'textarea' || s.type === 'list' ? 'md:col-span-2' : undefined)}>
                    <SettingField def={s} draft={draft} setDraft={setDraft} models={s.key.startsWith('LLM_MODEL') ? models : undefined} />
                    {s.key === 'LLM_MODEL' && (
                      <Button size="sm" variant="ghost" className="mt-1.5 -ml-2" loading={loadModels.isPending} icon={<Download className="size-3.5" />} onClick={() => loadModels.mutate()}>
                        Modelle vom Anbieter laden
                      </Button>
                    )}
                  </div>
                ))}
            </div>
            {group.test && (
              <div className="mt-5 border-t border-line pt-4 sm:hidden">
                <TestButton key={group.id} target={group.test} draft={draft} />
              </div>
            )}
            {group.id === 'seerr' && (
              <div className="mt-5 rounded-lg bg-surface-2 p-3 text-xs leading-relaxed text-fg-2">
                <strong>Optional – sofortige Benachrichtigungen:</strong> In Jellyseerr unter Einstellungen → Benachrichtigungen → Webhook diese URL eintragen:
                <code className="mt-1 block break-all rounded bg-surface px-2 py-1 font-mono">
                  {location.origin}/webhook/seerr?token=&lt;HTTP_TOKEN&gt;
                </code>
                Ohne Webhook prüft der Bot regelmäßig selbst (Intervall unter „Benachrichtigungen“).
              </div>
            )}
          </Card>
          {group.id === 'llm' && llmProvider === 'chatgpt' && <ChatGPTCard />}
          {group.id === 'llm' && (
            <ProfilesCard
              draft={draft}
              providers={new Map((q.data.settings.find((s) => s.key === 'LLM_PROVIDER')?.options ?? []).map((o) => [o.value, o.label]))}
              onApplied={(res) => {
                queryClient.setQueryData(['settings'], res);
                setDraftState((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !PROFILE_KEYS.includes(k))));
                void queryClient.invalidateQueries({ queryKey: ['overview'] });
              }}
            />
          )}
          {group.id === 'system' && <PasswordCard fromEnv={q.data.passwordFromEnv} />}
        </div>
      </div>

      {dirtyCount > 0 && (
        <div className="animate-slide-in sticky bottom-4 z-20 mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg">
          <span className="size-2 rounded-full bg-warn" />
          <span className="flex-1 text-[13px]">
            {dirtyCount} ungespeicherte Änderung{dirtyCount === 1 ? '' : 'en'}
            <span className="ml-2 text-xs text-fg-3">
              {groups
                .filter((g) => groupDirty(g.id))
                .map((g) => g.label)
                .join(', ')}
            </span>
          </span>
          <Button variant="ghost" onClick={() => setDraftState({})}>
            Verwerfen
          </Button>
          <Button variant="primary" loading={save.isPending} icon={<Save className="size-4" />} onClick={() => save.mutate()}>
            Speichern
          </Button>
        </div>
      )}
    </>
  );
}
