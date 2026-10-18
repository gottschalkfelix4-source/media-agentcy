import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  Bot,
  Brain,
  CheckCircle2,
  Clapperboard,
  Hand,
  Inbox,
  LifeBuoy,
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  Save,
  Send,
  Shield,
  Sparkles,
  Trash2,
  UserCog,
  BarChart3,
} from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { api, queryClient, type Message, type User, type UserDetail } from '../api';
import { ChatTranscript } from '../components/Chat';
import {
  Avatar,
  Badge,
  BarChart,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  IconButton,
  Input,
  KeyValue,
  Loading,
  RelTime,
  RuntimeChip,
  SEVERITY,
  Segmented,
  Select,
  Stat,
  StatusBadge,
  TICKET_STATUS,
  Tabs,
  Textarea,
  Toggle,
  USER_STATUS,
  categoryLabel,
  cx,
  fmtDateTime,
  fmtDuration,
  fmtNum,
  fmtTokens,
  toast,
  toastError,
} from '../components/ui';
import { Link, navigate, setQuery, useLocation } from '../router';

type Tab = 'chat' | 'memory' | 'profile' | 'tickets' | 'requests' | 'usage' | 'playback';
const PAGE = 60;

const invalidateUser = (id: number) => {
  void queryClient.invalidateQueries({ queryKey: ['user', id] });
  void queryClient.invalidateQueries({ queryKey: ['users'] });
  void queryClient.invalidateQueries({ queryKey: ['overview'] });
};

function usePatchUser(id: number) {
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<User>(`/users/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => invalidateUser(id),
    onError: toastError,
  });
}

function useResetLimits(id: number) {
  return useMutation({
    mutationFn: () => api(`/users/${id}/reset-limits`, { body: {} }),
    onSuccess: () => {
      toast('Limits zurückgesetzt, der Bot antwortet wieder');
      invalidateUser(id);
    },
    onError: toastError,
  });
}

const LIMIT_REASON = {
  off_topic: 'wiederholt themenfremde Anfragen',
  messages: 'Nachrichten-Tageslimit erreicht',
  tokens: 'Token-Tageslimit erreicht',
} as const;

// ---------------------------------------------------------------- chat

function ChatTab({ d }: { d: UserDetail }) {
  const id = d.user.id;
  const latest = useQuery({ queryKey: ['messages', id], queryFn: () => api<Message[]>(`/users/${id}/messages?limit=${PAGE}`) });
  const [older, setOlder] = useState<Message[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'direct' | 'ai'>('direct');
  const patch = usePatchUser(id);

  useEffect(() => {
    setOlder([]);
    setHasOlder(true);
  }, [id]);

  const messages = useMemo(() => {
    const map = new Map<number, Message>();
    for (const m of [...older, ...(latest.data ?? [])]) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.id - b.id);
  }, [older, latest.data]);

  const loadOlder = async () => {
    if (!messages.length) return;
    setLoadingOlder(true);
    try {
      const page = await api<Message[]>(`/users/${id}/messages?limit=${PAGE}&before=${messages[0].id}`);
      setOlder((o) => [...page, ...o]);
      if (page.length < PAGE) setHasOlder(false);
    } catch (err) {
      toastError(err);
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = useMutation({
    mutationFn: () => api<{ queued?: boolean }>(`/users/${id}/messages`, { body: { text, mode } }),
    onSuccess: (r) => {
      setText('');
      if (r.queued) toast('Der Bot formuliert die Nachricht und schickt sie gleich', 'info');
      void queryClient.invalidateQueries({ queryKey: ['messages', id] });
    },
    onError: toastError,
  });

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (text.trim() && !send.isPending) send.mutate();
    }
  };

  const resetLimits = useResetLimits(id);
  const paused = !!d.user.bot_paused;
  const rt = d.runtime;
  const typing = rt.state === 'working' ? 'Bot schreibt …' : rt.state === 'collecting' ? 'Bot wartet auf weitere Nachrichten …' : undefined;
  const canSend = d.user.status === 'active';

  return (
    <div className="flex h-[calc(100vh-17rem)] min-h-[420px] flex-col overflow-hidden rounded-xl border border-line shadow-card">
      <div className={cx('flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5', paused ? 'bg-warn-soft' : 'bg-surface')}>
        <Hand className={cx('size-4', paused ? 'text-warn' : 'text-fg-3')} />
        <div className="min-w-0 flex-1 text-[13px]">
          {paused ? (
            <>
              <strong className="text-warn">Du hast übernommen.</strong> <span className="text-fg-2">Der Bot liest mit, antwortet aber nicht. Systembenachrichtigungen gehen weiter raus.</span>
            </>
          ) : (
            <span className="text-fg-2">Der Bot antwortet automatisch. Übernimm, um selbst zu schreiben, ohne dass der Bot dazwischenfunkt.</span>
          )}
        </div>
        <Button size="sm" variant={paused ? 'primary' : 'secondary'} loading={patch.isPending} icon={paused ? <Play className="size-3.5" /> : <Hand className="size-3.5" />} onClick={() => patch.mutate({ bot_paused: !paused })}>
          {paused ? 'An Bot zurückgeben' : 'Übernehmen'}
        </Button>
      </div>

      {d.limits.blocked && (
        <div className="flex flex-wrap items-center gap-3 border-b border-danger/30 bg-danger-soft px-4 py-2 text-[13px]">
          <Ban className="size-4 text-danger" />
          <span className="min-w-0 flex-1 text-danger">
            <strong>Bot pausiert</strong> ({LIMIT_REASON[d.limits.blocked]}). Neue Nachrichten werden nur gespeichert, bis zu 24 h lang.
          </span>
          <Button size="sm" variant="secondary" loading={resetLimits.isPending} icon={<RotateCcw className="size-3.5" />} onClick={() => resetLimits.mutate()}>
            Limits aufheben
          </Button>
        </div>
      )}

      <ChatTranscript
        className="flex-1"
        messages={messages}
        hasOlder={hasOlder && (latest.data?.length ?? 0) >= PAGE}
        loadingOlder={loadingOlder}
        onLoadOlder={loadOlder}
        typing={!paused ? typing : undefined}
        empty={latest.isPending ? <Loading /> : <EmptyState icon={<MessageSquare className="size-6" />} title="Noch keine Nachrichten" />}
      />

      {rt.lastError && (!rt.lastReplyAt || rt.lastError.at > rt.lastReplyAt) && (
        <div className="border-t border-danger/30 bg-danger-soft px-4 py-2 text-xs text-danger">
          Letzter Fehler ({fmtDateTime(rt.lastError.at)}): {rt.lastError.message}
        </div>
      )}

      <div className="border-t border-line bg-surface p-3">
        {!canSend ? (
          <p className="py-2 text-center text-[13px] text-fg-3">Nachrichten kannst du nur an aktive Nutzer schicken.</p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'direct', label: 'Direkt senden' },
                  { value: 'ai', label: 'Bot formulieren lassen' },
                ]}
              />
              <span className="text-xs text-fg-3">{mode === 'direct' ? 'Geht wortwörtlich als Nachricht vom Bot-Konto raus.' : 'Der Bot richtet es freundlich in seinem Stil aus.'}</span>
            </div>
            <div className="flex items-end gap-2">
              <Textarea
                rows={2}
                className="max-h-40 min-h-11 resize-y"
                placeholder={mode === 'direct' ? 'Nachricht an den Nutzer … (Enter sendet, Shift+Enter = neue Zeile)' : 'Was soll der Bot ausrichten?'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
              />
              <Button variant="primary" className="h-11" loading={send.isPending} disabled={!text.trim()} onClick={() => send.mutate()} icon={mode === 'ai' ? <Sparkles className="size-4" /> : <Send className="size-4" />}>
                <span className="hidden sm:inline">Senden</span>
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- memory

function MemoryTab({ d }: { d: UserDetail }) {
  const id = d.user.id;
  const [summary, setSummary] = useState(d.user.summary ?? '');
  const [fact, setFact] = useState('');
  const patch = usePatchUser(id);
  useEffect(() => setSummary(d.user.summary ?? ''), [d.user.summary]);

  const addFact = useMutation({
    mutationFn: () => api(`/users/${id}/facts`, { body: { fact } }),
    onSuccess: () => {
      setFact('');
      invalidateUser(id);
    },
    onError: toastError,
  });
  const delFact = useMutation({ mutationFn: (fid: number) => api(`/users/${id}/facts/${fid}`, { method: 'DELETE' }), onSuccess: () => invalidateUser(id), onError: toastError });

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card
        title="Zusammenfassung"
        actions={
          <Button size="sm" variant="primary" disabled={summary === (d.user.summary ?? '')} loading={patch.isPending} icon={<Save className="size-3.5" />} onClick={() => patch.mutate({ summary: summary || null }, { onSuccess: () => toast('Gespeichert') })}>
            Speichern
          </Button>
        }
      >
        <p className="mb-3 text-xs text-fg-3">
          Der Bot fasst ältere Gespräche automatisch hier zusammen ({d.stats.unsummarized} Nachrichten noch nicht zusammengefasst). Du kannst den Text korrigieren.
        </p>
        <Textarea rows={12} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Noch keine Zusammenfassung." />
      </Card>
      <Card title={`Gemerkte Fakten (${d.facts.length})`} padded={false}>
        <form
          className="flex gap-2 border-b border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (fact.trim()) addFact.mutate();
          }}
        >
          <Input placeholder="z. B. Schaut am liebsten auf dem Fire TV im Wohnzimmer" value={fact} onChange={(e) => setFact(e.target.value)} />
          <Button type="submit" loading={addFact.isPending} disabled={!fact.trim()} icon={<Plus className="size-4" />}>
            Merken
          </Button>
        </form>
        {d.facts.length === 0 ? (
          <EmptyState icon={<Brain className="size-6" />} title="Noch nichts gemerkt">
            Der Bot merkt sich Vorlieben, Geräte und Hinweise selbstständig.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {d.facts.map((f) => (
              <li key={f.id} className="group flex items-start gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px]">{f.fact}</p>
                  <p className="text-[11px] text-fg-3">
                    {f.source === 'admin' ? 'von dir' : 'vom Bot'} · <RelTime value={f.created_at} />
                  </p>
                </div>
                <IconButton label="Vergessen" className="opacity-60 group-hover:opacity-100" onClick={() => delFact.mutate(f.id)}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- profile & accounts

interface MediaAccounts {
  jellyfin?: { id: string; name: string }[];
  seerr?: { id: number; name: string }[];
  errors: string[];
}

function ProfileTab({ d }: { d: UserDetail }) {
  const u = d.user;
  const accounts = useQuery({ queryKey: ['media-accounts'], queryFn: () => api<MediaAccounts>('/media-accounts'), staleTime: 300_000 });
  const initial = useMemo(
    () => ({
      display_name: u.display_name ?? '',
      role: u.role,
      jellyfin_username: u.jellyfin_username ?? '',
      plex_username: u.plex_username ?? '',
      seerr_user_id: u.seerr_user_id === null ? '' : String(u.seerr_user_id),
      ombi_username: u.ombi_username ?? '',
    }),
    [u],
  );
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  const patch = usePatchUser(u.id);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = () =>
    patch.mutate(
      {
        display_name: form.display_name || null,
        role: form.role,
        jellyfin_username: form.jellyfin_username || null,
        plex_username: form.plex_username || null,
        seerr_user_id: form.seerr_user_id ? Number(form.seerr_user_id) : null,
        ombi_username: form.ombi_username || null,
      },
      { onSuccess: () => toast('Profil gespeichert') },
    );

  const jf = accounts.data?.jellyfin;
  const seerr = accounts.data?.seerr;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card
        className="lg:col-span-2"
        title="Profil & Medienkonten"
        actions={
          <Button size="sm" variant="primary" disabled={!dirty} loading={patch.isPending} icon={<Save className="size-3.5" />} onClick={save}>
            Speichern
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Anzeigename" help={u.push_name ? `WhatsApp-Name: ${u.push_name}` : undefined}>
            <Input value={form.display_name} onChange={(e) => set('display_name')(e.target.value)} placeholder={u.push_name ?? ''} />
          </Field>
          <Field label="Rolle" help={d.isAdminNumber ? 'Steht in den Admin-Nummern – Rolle wird dort verwaltet.' : 'Admins dürfen den Admin-Agenten nutzen und bekommen Eskalationen.'}>
            <Select value={form.role} disabled={d.isAdminNumber} onChange={(e) => set('role')(e.target.value)}>
              <option value="user">Nutzer</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
          <Field label="Jellyfin-Konto" help={u.jellyfin_user_id ? `ID: ${u.jellyfin_user_id}` : 'Damit sieht der Bot Wiedergaben und Fehler dieses Nutzers.'}>
            {jf ? (
              <Select value={form.jellyfin_username} onChange={(e) => set('jellyfin_username')(e.target.value)}>
                <option value="">– nicht verknüpft –</option>
                {jf.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
                {form.jellyfin_username && !jf.some((a) => a.name === form.jellyfin_username) && <option value={form.jellyfin_username}>{form.jellyfin_username} (nicht gefunden)</option>}
              </Select>
            ) : (
              <Input value={form.jellyfin_username} onChange={(e) => set('jellyfin_username')(e.target.value)} placeholder="Benutzername" />
            )}
          </Field>
          <Field label="Plex-Benutzer">
            <Input value={form.plex_username} onChange={(e) => set('plex_username')(e.target.value)} placeholder="Plex-Benutzername" />
          </Field>
          <Field label="Jellyseerr-/Overseerr-Konto" help="Anfragen werden in seinem Namen gestellt.">
            {seerr ? (
              <Select value={form.seerr_user_id} onChange={(e) => set('seerr_user_id')(e.target.value)}>
                <option value="">– Bot-Konto verwenden –</option>
                {seerr.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name} (#{a.id})
                  </option>
                ))}
              </Select>
            ) : (
              <Input inputMode="numeric" value={form.seerr_user_id} onChange={(e) => set('seerr_user_id')(e.target.value.replace(/\D/g, ''))} placeholder="Benutzer-ID" />
            )}
          </Field>
          <Field label="Ombi-Benutzer">
            <Input value={form.ombi_username} onChange={(e) => set('ombi_username')(e.target.value)} />
          </Field>
        </div>
        {accounts.data?.errors.map((e) => (
          <p key={e} className="mt-3 text-xs text-danger">
            {e}
          </p>
        ))}
      </Card>
      <Card title="Details">
        <KeyValue
          items={[
            ['Interne ID', `#${u.id}`],
            ['WhatsApp', u.wa_id.startsWith('lid:') ? u.wa_id : `+${u.wa_id}`],
            ['Angelegt', fmtDateTime(u.created_at)],
            ['Zuletzt gesehen', <RelTime value={u.last_seen_at} />],
            ['Nachrichten', fmtNum(d.stats.messages)],
            ['Anfragen heute', d.stats.requestsToday],
          ]}
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- tickets / requests / usage / playback

function TicketsTab({ d }: { d: UserDetail }) {
  if (!d.tickets.length) return <Card><EmptyState icon={<LifeBuoy className="size-6" />} title="Keine Tickets" /></Card>;
  return (
    <Card padded={false}>
      <ul className="divide-y divide-line">
        {d.tickets.map((t) => (
          <li key={t.id}>
            <Link to={`/tickets?id=${t.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
              <span className="w-10 text-xs text-fg-3">#{t.id}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{t.title}</p>
                <p className="truncate text-xs text-fg-3">{categoryLabel(t.category)} · <RelTime value={t.updated_at} /></p>
              </div>
              <StatusBadge map={SEVERITY} value={t.severity} />
              <StatusBadge map={TICKET_STATUS} value={t.status} />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RequestsTab({ d }: { d: UserDetail }) {
  if (!d.requests.length) return <Card><EmptyState icon={<Inbox className="size-6" />} title="Noch nichts angefragt" /></Card>;
  return (
    <Card padded={false}>
      <ul className="divide-y divide-line">
        {d.requests.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-4 py-3">
            <Badge tone={r.media_type === 'movie' ? 'info' : 'violet'}>{r.media_type === 'movie' ? 'Film' : 'Serie'}</Badge>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.title}</span>
            {r.notified_at ? <Badge tone="ok">Verfügbar & benachrichtigt</Badge> : <Badge tone="warn">Wartet</Badge>}
            <RelTime value={r.created_at} className="w-24 text-right text-xs text-fg-3" />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function LimitsCard({ d }: { d: UserDetail }) {
  const reset = useResetLimits(d.user.id);
  const l = d.limits;
  const rows: [string, { used: number; limit: number }, (n: number) => string][] = [
    ['Themenfremde Anfragen', l.offTopic, fmtNum],
    ['Nachrichten', l.messages, fmtNum],
    ['Tokens', l.tokens, fmtTokens],
  ];
  return (
    <Card
      title="Missbrauchsschutz (letzte 24 h)"
      actions={
        <Button size="sm" variant="secondary" loading={reset.isPending} icon={<RotateCcw className="size-3.5" />} onClick={() => reset.mutate()}>
          Zähler zurücksetzen
        </Button>
      }
    >
      {d.user.role === 'admin' && <p className="mb-3 text-xs text-fg-3">Für Admins gelten keine Limits.</p>}
      <div className="space-y-3">
        {rows.map(([label, x, fmt]) => {
          const pct = x.limit > 0 ? Math.min(100, (x.used / x.limit) * 100) : 0;
          return (
            <div key={label}>
              <div className="mb-1 flex justify-between text-[13px]">
                <span>{label}</span>
                <span className="text-fg-3">
                  {fmt(x.used)} / {x.limit > 0 ? fmt(x.limit) : 'unbegrenzt'}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className={cx('h-full rounded-full', pct >= 100 ? 'bg-danger' : pct >= 75 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function UsageTab({ d }: { d: UserDetail }) {
  const m = d.usage.month;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Tokens (30 Tage)" value={fmtTokens(m.input + m.output)} hint={`${fmtTokens(m.input)} rein · ${fmtTokens(m.output)} raus`} />
        <Stat label="LLM-Aufrufe (30 Tage)" value={fmtNum(m.calls)} />
        <Stat label="Antwortzeit Ø" value={m.avg_ms ? fmtDuration(Math.round(m.avg_ms)) : '–'} />
        <Stat label="Tokens gesamt" value={fmtTokens(d.usage.total.input + d.usage.total.output)} hint={`${fmtNum(d.usage.total.calls)} Aufrufe`} />
      </div>
      <LimitsCard d={d} />
      <Card title="Token-Verbrauch pro Tag">
        <BarChart
          days={30}
          data={d.usage.byDay}
          series={[
            { key: 'input', label: 'Eingabe', color: 'var(--info)' },
            { key: 'output', label: 'Ausgabe', color: 'var(--accent)' },
          ]}
        />
      </Card>
    </div>
  );
}

interface Playback {
  configured: { jellyfin: boolean; plex: boolean };
  jellyfin: {
    sessions: { user?: string; client?: string; device?: string; lastActivity?: string; nowPlaying?: string; playMethod?: string; transcodeReasons?: string[] }[] | { error: string };
    activity: { date: string; type: string; severity: string; name: string; detail?: string }[] | { error: string };
  } | null;
  plex: { sessions: { title: string; player: string; state?: string; video: string; audio: string }[] | { error: string } } | null;
}

function PlaybackTab({ d }: { d: UserDetail }) {
  const q = useQuery({ queryKey: ['playback', d.user.id], queryFn: () => api<Playback>(`/users/${d.user.id}/playback`), refetchInterval: 30_000 });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const { jellyfin, plex, configured } = q.data;
  if (!configured.jellyfin && !configured.plex)
    return (
      <Card>
        <EmptyState icon={<Clapperboard className="size-6" />} title="Jellyfin/Plex nicht eingerichtet">
          Trage unter <Link to="/settings?group=jellyfin" className="text-accent hover:underline">Einstellungen → Jellyfin</Link> bzw. Plex die Zugangsdaten ein.
        </EmptyState>
      </Card>
    );
  if (!jellyfin && !plex)
    return (
      <Card>
        <EmptyState icon={<Clapperboard className="size-6" />} title="Kein Medienkonto verknüpft">
          Wähle unter „Profil & Konten“ ein Jellyfin-Konto aus der Liste oder trage einen Plex-Benutzer ein.
        </EmptyState>
      </Card>
    );
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {jellyfin && (
        <>
          <Card title="Jellyfin – Geräte (letzte 30 min)" padded={false}>
            {'error' in jellyfin.sessions ? (
              <div className="p-4"><ErrorBox error={jellyfin.sessions.error} /></div>
            ) : jellyfin.sessions.length === 0 ? (
              <EmptyState title="Gerade nicht aktiv" />
            ) : (
              <ul className="divide-y divide-line">
                {jellyfin.sessions.map((s, i) => (
                  <li key={i} className="px-4 py-2.5 text-[13px]">
                    <p className="font-medium">{s.nowPlaying ?? <span className="text-fg-3">Nichts in Wiedergabe</span>}</p>
                    <p className="text-xs text-fg-3">
                      {[s.client, s.device, s.playMethod].filter(Boolean).join(' · ')}
                      {s.transcodeReasons?.length ? ` · Transcoding: ${s.transcodeReasons.join(', ')}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Jellyfin – Aktivitätsprotokoll" padded={false}>
            {'error' in jellyfin.activity ? (
              <div className="p-4"><ErrorBox error={jellyfin.activity.error} /></div>
            ) : jellyfin.activity.length === 0 ? (
              <EmptyState title="Keine Einträge" />
            ) : (
              <ul className="divide-y divide-line">
                {jellyfin.activity.map((a, i) => (
                  <li key={i} className="flex gap-3 px-4 py-2.5 text-[13px]">
                    <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', a.severity === 'Error' ? 'bg-danger' : a.severity === 'Warning' ? 'bg-warn' : 'bg-fg-3')} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{a.name}</p>
                      {a.detail && <p className="truncate text-xs text-fg-3">{a.detail}</p>}
                    </div>
                    <RelTime value={a.date} className="shrink-0 text-xs text-fg-3" />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
      {plex && (
        <Card title="Plex – aktuelle Wiedergabe" padded={false}>
          {'error' in plex.sessions ? (
            <div className="p-4"><ErrorBox error={plex.sessions.error} /></div>
          ) : plex.sessions.length === 0 ? (
            <EmptyState title="Gerade nicht aktiv" />
          ) : (
            <ul className="divide-y divide-line">
              {plex.sessions.map((s, i) => (
                <li key={i} className="px-4 py-2.5 text-[13px]">
                  <p className="font-medium">{s.title}</p>
                  <p className="text-xs text-fg-3">
                    {s.player} · Video: {s.video} · Audio: {s.audio}
                    {s.state === 'paused' ? ' · pausiert' : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- page

export function UserDetailPage({ id }: { id: number }) {
  const { query } = useLocation();
  const tab = (query.get('tab') as Tab) ?? 'chat';
  const q = useQuery({ queryKey: ['user', id], queryFn: () => api<UserDetail>(`/users/${id}`), refetchInterval: 30_000 });
  const patch = usePatchUser(id);
  const [confirm, setConfirm] = useState<'reset' | 'delete' | 'block' | null>(null);

  const reset = useMutation({
    mutationFn: () => api(`/users/${id}/reset-history`, { body: {} }),
    onSuccess: () => {
      toast('Verlauf zurückgesetzt');
      setConfirm(null);
      invalidateUser(id);
      void queryClient.invalidateQueries({ queryKey: ['messages', id] });
    },
    onError: toastError,
  });
  const del = useMutation({
    mutationFn: () => api(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Nutzer gelöscht');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      navigate('/users', { replace: true });
    },
    onError: toastError,
  });

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const d = q.data;
  const u = d.user;
  const name = u.display_name ?? u.push_name ?? 'Unbekannt';

  const tabs: { id: Tab; label: React.ReactNode; count?: number }[] = [
    { id: 'chat', label: <><MessageSquare className="size-3.5" /> Chat</>, count: d.stats.messages },
    { id: 'memory', label: <><Brain className="size-3.5" /> Gedächtnis</>, count: d.facts.length },
    { id: 'profile', label: <><UserCog className="size-3.5" /> Profil & Konten</> },
    { id: 'tickets', label: <><LifeBuoy className="size-3.5" /> Tickets</>, count: d.tickets.length },
    { id: 'requests', label: <><Inbox className="size-3.5" /> Anfragen</>, count: d.requests.length },
    { id: 'usage', label: <><BarChart3 className="size-3.5" /> Nutzung</> },
    { id: 'playback', label: <><Clapperboard className="size-3.5" /> Wiedergabe</> },
  ];

  return (
    <>
      <Link to="/users" className="mb-3 inline-flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
        <ArrowLeft className="size-4" /> Alle Nutzer
      </Link>

      <div className="mb-5 flex flex-wrap items-start gap-4">
        <Avatar name={name} className="size-12 text-base" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{name}</h1>
            {u.role === 'admin' && (
              <Badge tone="violet">
                <Shield className="size-3" /> Admin
              </Badge>
            )}
            <StatusBadge map={USER_STATUS} value={u.status} />
            <RuntimeChip runtime={d.runtime} paused={!!u.bot_paused} />
          </div>
          <p className="mt-0.5 text-[13px] text-fg-3">
            {u.wa_id.startsWith('lid:') ? u.wa_id : `+${u.wa_id}`} · zuletzt aktiv <RelTime value={u.last_seen_at} />
            {d.runtime.lastReplyAt && (
              <>
                {' '}
                · letzte Bot-Antwort <RelTime value={d.runtime.lastReplyAt} />
                {d.runtime.lastDurationMs ? ` (${fmtDuration(d.runtime.lastDurationMs)})` : ''}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {u.status === 'pending' && (
            <>
              <Button variant="primary" loading={patch.isPending} icon={<CheckCircle2 className="size-4" />} onClick={() => patch.mutate({ status: 'active' }, { onSuccess: () => toast('Freigeschaltet – der Bot begrüßt den Nutzer') })}>
                Freischalten
              </Button>
              <Button variant="danger-ghost" icon={<Ban className="size-4" />} onClick={() => setConfirm('block')}>
                Ablehnen
              </Button>
            </>
          )}
          {u.status === 'blocked' && (
            <Button loading={patch.isPending} icon={<CheckCircle2 className="size-4" />} onClick={() => patch.mutate({ status: 'active', welcome: false }, { onSuccess: () => toast('Entsperrt') })}>
              Entsperren
            </Button>
          )}
          {u.status === 'active' && (
            <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px]" title="Wenn aus, antwortet der Bot diesem Nutzer nicht">
              <Bot className="size-4 text-fg-3" />
              Bot antwortet
              <Toggle checked={!u.bot_paused} onChange={(v) => patch.mutate({ bot_paused: !v })} label="Bot antwortet" />
            </label>
          )}
          <IconButton label="Verlauf zurücksetzen" onClick={() => setConfirm('reset')}>
            <RotateCcw className="size-4" />
          </IconButton>
          {u.status === 'active' && !d.isAdminNumber && (
            <IconButton label="Sperren" onClick={() => setConfirm('block')}>
              <Ban className="size-4" />
            </IconButton>
          )}
          {!d.isAdminNumber && (
            <IconButton label="Nutzer löschen" className="hover:text-danger" onClick={() => setConfirm('delete')}>
              <Trash2 className="size-4" />
            </IconButton>
          )}
        </div>
      </div>

      <div className="mb-5">
        <Tabs tabs={tabs} value={tab} onChange={(t) => setQuery({ tab: t === 'chat' ? null : t })} />
      </div>

      {tab === 'chat' && <ChatTab d={d} />}
      {tab === 'memory' && <MemoryTab d={d} />}
      {tab === 'profile' && <ProfileTab d={d} />}
      {tab === 'tickets' && <TicketsTab d={d} />}
      {tab === 'requests' && <RequestsTab d={d} />}
      {tab === 'usage' && <UsageTab d={d} />}
      {tab === 'playback' && <PlaybackTab d={d} />}

      <ConfirmDialog open={confirm === 'reset'} title="Verlauf zurücksetzen?" confirmLabel="Zurücksetzen" danger loading={reset.isPending} onConfirm={() => reset.mutate()} onClose={() => setConfirm(null)}>
        Der Bot vergisst den bisherigen Gesprächsverlauf und fängt frisch an. Die Nachrichten bleiben hier sichtbar; Zusammenfassung, gemerkte Fakten, Tickets und Anfragen bleiben erhalten.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'block'}
        title={`${name} sperren?`}
        confirmLabel="Sperren"
        danger
        loading={patch.isPending}
        onConfirm={() => patch.mutate({ status: 'blocked' }, { onSuccess: () => { toast('Gesperrt'); setConfirm(null); } })}
        onClose={() => setConfirm(null)}
      >
        Der Bot ignoriert alle Nachrichten dieses Nutzers. Du kannst ihn jederzeit wieder entsperren.
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'delete'} title={`${name} endgültig löschen?`} confirmLabel="Endgültig löschen" danger loading={del.isPending} onConfirm={() => del.mutate()} onClose={() => setConfirm(null)}>
        Alle Nachrichten, Fakten, Tickets und Anfragen dieses Nutzers werden gelöscht. Schreibt er erneut, wird er als neuer Nutzer angelegt. Das lässt sich nicht rückgängig machen.
      </ConfirmDialog>
    </>
  );
}
