import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Download, ExternalLink, LogOut, Plug, Plus, Save, Trash2, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, queryClient, type AiProvider, type AiProvidersResponse, type ChatGPTStatus, type ProviderKind } from '../api';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, Textarea, Toggle, cx, toast, toastError } from '../components/ui';
import { setQuery, useLocation } from '../router';

/**
 * Settings → KI-Anbieter: every provider has its own page (sidebar on the left), keeps its own key, URL and
 * models, and "Verwenden" switches the bot over. Replaces the old provider dropdown.
 */

const KIND: Record<ProviderKind, { subtitle: string; intro: ReactNode; key?: { label: string; help: ReactNode; required: boolean }; url?: boolean; temperature: boolean; modelPlaceholder: string }> = {
  openai: {
    subtitle: 'API-Key',
    intro: 'GPT-Modelle direkt bei OpenAI, abgerechnet pro Token über deinen API-Key.',
    key: { label: 'API-Key', help: <ExtLink href="https://platform.openai.com/api-keys">platform.openai.com/api-keys</ExtLink>, required: true },
    temperature: true,
    modelPlaceholder: 'gpt-4.1-mini',
  },
  anthropic: {
    subtitle: 'API-Key',
    intro: (
      <>
        Claude direkt über die Messages API, abgerechnet pro Token. Ein Claude-Pro/Max-Abo lässt sich hier nicht nutzen – Anthropic erlaubt die Abo-Anmeldung nur in den eigenen Apps.
      </>
    ),
    key: { label: 'API-Key', help: <ExtLink href="https://platform.claude.com/">platform.claude.com</ExtLink>, required: true },
    temperature: false,
    modelPlaceholder: 'claude-opus-5-5',
  },
  openrouter: {
    subtitle: 'API-Key',
    intro: 'Viele Modelle verschiedener Hersteller über einen Key. In der Modell-Liste stehen nur Modelle mit Tool-Calling.',
    key: { label: 'API-Key', help: <ExtLink href="https://openrouter.ai/keys">openrouter.ai/keys</ExtLink>, required: true },
    temperature: true,
    modelPlaceholder: 'openai/gpt-4.1-mini',
  },
  chatgpt: {
    subtitle: 'Abo-Login',
    intro: 'Dein ChatGPT-Plus/Pro-Abo statt API-Key. Die Nutzung zählt auf dein Abo-Limit.',
    temperature: false,
    modelPlaceholder: 'leer = erstes Modell des Kontos',
  },
  custom: {
    subtitle: 'OpenAI-kompatibel',
    intro: 'Jeder OpenAI-kompatible Endpoint: Ollama, LM Studio, LiteLLM, vLLM, Groq …',
    key: { label: 'API-Key', help: 'Nur falls der Endpoint einen verlangt.', required: false },
    url: true,
    temperature: true,
    modelPlaceholder: 'qwen3:14b',
  },
};

const GROUPS: { label: string; filter: (p: AiProvider) => boolean }[] = [
  { label: 'Mit API-Key', filter: (p) => p.kind === 'openai' || p.kind === 'anthropic' || p.kind === 'openrouter' },
  { label: 'Mit Abo', filter: (p) => p.kind === 'chatgpt' },
  { label: 'Eigene Anbieter', filter: (p) => p.kind === 'custom' },
];

export function AiProviders() {
  const { query } = useLocation();
  const q = useQuery({ queryKey: ['llm-providers'], queryFn: () => api<AiProvidersResponse>('/llm/providers') });
  const [dirty, setDirty] = useState(false);
  const add = useMutation({
    mutationFn: () => api<AiProvider>('/llm/providers', { body: { name: 'Neuer Anbieter' } }),
    onSuccess: (p) => {
      void queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
      select(p.id);
    },
    onError: toastError,
  });

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} />;

  const { providers, active } = q.data;
  const selectedId = providers.some((p) => p.id === query.get('provider')) ? query.get('provider')! : active;
  const selected = providers.find((p) => p.id === selectedId)!;
  function select(id: string) {
    if (dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
    setDirty(false);
    setQuery({ provider: id });
  }

  return (
    // Container queries: the settings page already has two sidebars, so the window width says little about the space here.
    <div className="@container">
      <div className="grid gap-5 @3xl:grid-cols-[12rem_minmax(0,1fr)]">
        <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 @3xl:mx-0 @3xl:flex-col @3xl:self-start @3xl:overflow-visible @3xl:px-0" aria-label="KI-Anbieter">
          {GROUPS.map((g) => {
            const items = providers.filter(g.filter);
            return (
              <div key={g.label} className="flex shrink-0 gap-1 @3xl:flex-col">
                <p className="hidden px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-fg-3 uppercase @3xl:block">{g.label}</p>
                {items.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => select(p.id)}
                    className={cx(
                      'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
                      p.id === selectedId ? 'bg-surface text-fg shadow-card ring-1 ring-line' : 'text-fg-3 hover:bg-surface-2 hover:text-fg-2',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{p.name}</span>
                      <span className="hidden text-[11px] text-fg-3 @3xl:block">{KIND[p.kind].subtitle}</span>
                    </span>
                    {p.active ? (
                      <Badge tone="ok">aktiv</Badge>
                    ) : (
                      <span className={cx('size-1.5 rounded-full', p.configured ? 'bg-ok' : 'bg-line-strong')} title={p.configured ? 'Eingerichtet' : 'Nicht eingerichtet'} />
                    )}
                  </button>
                ))}
                {g.label === 'Eigene Anbieter' && (
                  <button
                    type="button"
                    onClick={() => add.mutate()}
                    disabled={add.isPending}
                    className="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-2"
                  >
                    <Plus className="size-4" /> Anbieter hinzufügen
                  </button>
                )}
              </div>
            );
          })}
        </nav>
        <ProviderPage key={selected.id} provider={selected} onDirty={setDirty} onDeleted={() => setQuery({ provider: null })} />
      </div>
    </div>
  );
}

interface Form {
  name: string;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  LLM_MODEL_ADMIN: string;
  LLM_TEMPERATURE: string;
  /** '' = default (on). */
  LLM_VISION: string;
}

const formOf = (p: AiProvider): Form => ({
  name: p.name,
  LLM_BASE_URL: p.baseUrl ?? '',
  LLM_MODEL: p.model ?? '',
  LLM_MODEL_ADMIN: p.adminModel ?? '',
  LLM_TEMPERATURE: p.temperature ?? '',
  LLM_VISION: p.vision ?? '',
});

function ProviderPage({ provider: p, onDirty, onDeleted }: { provider: AiProvider; onDirty: (d: boolean) => void; onDeleted: () => void }) {
  const kind = KIND[p.kind];
  const saved = formOf(p);
  const [form, setForm] = useState<Form>(saved);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<string[]>();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  /** Only what differs from the saved state; the key only when typed anew or removed. */
  const patch: Record<string, string | null> = {};
  for (const k of ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_MODEL_ADMIN', 'LLM_TEMPERATURE', 'LLM_VISION'] as const) if (form[k] !== saved[k]) patch[k] = form[k] || null;
  if (key.trim()) patch.LLM_API_KEY = key.trim();
  else if (clearKey) patch.LLM_API_KEY = null;
  const nameChanged = p.kind === 'custom' && form.name.trim() !== p.name;
  const dirty = Object.keys(patch).length > 0 || nameChanged;
  const set = (k: keyof Form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    onDirty(true);
  };

  const afterSave = (res: AiProvidersResponse) => {
    queryClient.setQueryData(['llm-providers'], res);
    setKey('');
    setClearKey(false);
    onDirty(false);
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
    void queryClient.invalidateQueries({ queryKey: ['settings'] });
  };
  const save = useMutation({
    mutationFn: () => api<AiProvidersResponse>(`/llm/providers/${p.id}`, { method: 'PUT', body: { name: form.name, values: patch } }),
    onSuccess: (res) => {
      afterSave(res);
      toast(p.active ? 'Gespeichert und sofort aktiv' : 'Gespeichert');
    },
    onError: toastError,
  });
  const activate = useMutation({
    mutationFn: async () => {
      if (dirty) afterSave(await api<AiProvidersResponse>(`/llm/providers/${p.id}`, { method: 'PUT', body: { name: form.name, values: patch } }));
      return api<AiProvidersResponse>(`/llm/providers/${p.id}/activate`, { body: {} });
    },
    onSuccess: (res) => {
      afterSave(res);
      toast(`Der Bot nutzt jetzt ${form.name || p.name}`);
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: () => api<AiProvidersResponse>(`/llm/providers/${p.id}`, { method: 'DELETE' }),
    onSuccess: (res) => {
      queryClient.setQueryData(['llm-providers'], res);
      onDirty(false);
      onDeleted();
    },
    onError: toastError,
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>(`/llm/providers/${p.id}/test`, { body: { values: patch } }),
    onMutate: () => setResult(null),
    onSuccess: setResult,
    onError: (err) => setResult({ ok: false, message: err instanceof Error ? err.message : String(err) }),
  });
  const loadModels = useMutation({
    mutationFn: () => api<{ models: string[]; error?: string }>(`/llm/providers/${p.id}/models`, { body: { values: patch } }),
    onSuccess: (r) => {
      if (r.error) toast(r.error, 'danger');
      else {
        setModels(r.models);
        toast(`${r.models.length} Modelle geladen – tippe ins Modell-Feld`, 'info');
      }
    },
    onError: toastError,
  });

  const vision = (form.LLM_VISION || 'true') === 'true';
  const modelList = models && (
    <datalist id={`models-${p.id}`}>
      {models.map((m) => (
        <option key={m} value={m} />
      ))}
    </datalist>
  );

  return (
    <div className="@container min-w-0 space-y-5">
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            {p.kind === 'custom' ? form.name || 'Eigener Anbieter' : p.name}
            {p.active && <Badge tone="ok">aktiv</Badge>}
          </span>
        }
        actions={
          !p.active && (
            <Button size="sm" variant="primary" loading={activate.isPending} onClick={() => activate.mutate()}>
              Diesen Anbieter verwenden
            </Button>
          )
        }
      >
        <p className="-mt-1 mb-5 text-[13px] text-fg-3">{kind.intro}</p>
        <div className="grid gap-5 @xl:grid-cols-2">
          {p.kind === 'custom' && (
            <Field label="Name">
              <Input value={form.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
            </Field>
          )}
          {kind.url && (
            <Field label="Endpoint-URL" help="Mit /v1 am Ende, z. B. http://ollama:11434/v1">
              <Input type="url" value={form.LLM_BASE_URL} placeholder="http://ollama:11434/v1" onChange={(e) => set('LLM_BASE_URL', e.target.value)} />
            </Field>
          )}
          {kind.key && (
            <Field
              label={kind.key.label}
              help={kind.key.help}
              aside={
                p.keySet && !clearKey && !key ? (
                  <button type="button" className="text-xs text-fg-3 hover:text-danger" onClick={() => (setClearKey(true), onDirty(true))}>
                    entfernen
                  </button>
                ) : undefined
              }
            >
              <Input
                type="password"
                autoComplete="off"
                value={key}
                placeholder={clearKey ? 'wird entfernt' : p.keySet ? `gespeichert ${p.keyHint ?? ''}`.trim() : kind.key.required ? 'nötig' : 'optional'}
                onChange={(e) => {
                  setKey(e.target.value);
                  onDirty(true);
                }}
              />
            </Field>
          )}
          <Field label="Modell" help="Muss Tool-Calling können.">
            <Input value={form.LLM_MODEL} placeholder={kind.modelPlaceholder} list={models ? `models-${p.id}` : undefined} onChange={(e) => set('LLM_MODEL', e.target.value)} />
            <Button size="sm" variant="ghost" className="mt-1.5 -ml-2" loading={loadModels.isPending} icon={<Download className="size-3.5" />} onClick={() => loadModels.mutate()}>
              Modelle vom Anbieter laden
            </Button>
          </Field>
          <Field label="Modell für den Admin-Chat" help="Optional, z. B. ein stärkeres Modell. Leer = wie oben.">
            <Input value={form.LLM_MODEL_ADMIN} list={models ? `models-${p.id}` : undefined} onChange={(e) => set('LLM_MODEL_ADMIN', e.target.value)} />
          </Field>
          {kind.temperature && (
            <Field label="Temperatur" help="Leer = Standard des Modells.">
              <Input inputMode="decimal" value={form.LLM_TEMPERATURE} placeholder="Standard des Modells" onChange={(e) => set('LLM_TEMPERATURE', e.target.value)} />
            </Field>
          )}
          <Field label="Bilder an das Modell geben" help="Für Screenshots von Fehlermeldungen. Das Modell muss Vision können.">
            <div className="flex h-9 items-center">
              <Toggle checked={vision} label="Bilder an das Modell geben" onChange={(v) => set('LLM_VISION', v ? '' : 'false')} />
              <span className="ml-2 text-[13px] text-fg-2">{vision ? 'An' : 'Aus'}</span>
            </div>
          </Field>
        </div>
        {modelList}
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button variant="primary" disabled={!dirty} loading={save.isPending} icon={<Save className="size-4" />} onClick={() => save.mutate()}>
            Speichern
          </Button>
          <Button loading={test.isPending} icon={<Plug className="size-3.5" />} onClick={() => test.mutate()}>
            Verbindung testen
          </Button>
          {result && (
            <span className={cx('inline-flex items-center gap-1.5 text-xs', result.ok ? 'text-ok' : 'text-danger')}>
              {result.ok ? <CheckCircle2 className="size-3.5 shrink-0" /> : <XCircle className="size-3.5 shrink-0" />}
              {result.message}
            </span>
          )}
          <span className="flex-1" />
          {p.kind === 'custom' && !p.active && (
            <Button variant="danger-ghost" loading={remove.isPending} icon={<Trash2 className="size-3.5" />} onClick={() => confirm(`„${p.name}“ löschen?`) && remove.mutate()}>
              Löschen
            </Button>
          )}
        </div>
        {p.active && dirty && <p className="mt-2 text-xs text-fg-3">Das ist der aktive Anbieter – Speichern gilt sofort für den Bot.</p>}
      </Card>
      {p.kind === 'chatgpt' && <ChatGPTCard />}
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="inline-flex items-center gap-1 text-accent-text hover:underline" href={href} target="_blank" rel="noreferrer">
      {children} <ExternalLink className="size-3" />
    </a>
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

