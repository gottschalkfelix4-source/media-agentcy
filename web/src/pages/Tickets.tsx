import { useMutation, useQuery } from '@tanstack/react-query';
import { LifeBuoy, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, queryClient, type Ticket, type TicketDetail, type TicketStatus } from '../api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  KeyValue,
  Loading,
  Modal,
  PageHeader,
  RelTime,
  SEVERITY,
  Segmented,
  Select,
  StatusBadge,
  TICKET_STATUS,
  Textarea,
  Toggle,
  categoryLabel,
  fmtDateTime,
  toast,
  toastError,
} from '../components/ui';
import { Link, setQuery, useLocation } from '../router';

type Filter = 'active' | 'escalated' | 'resolved' | 'all';

function TicketModal({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api<TicketDetail>(`/tickets/${id}`) });
  const [status, setStatus] = useState<TicketStatus>('open');
  const [severity, setSeverity] = useState('normal');
  const [resolution, setResolution] = useState('');
  const [message, setMessage] = useState('');
  const [notify, setNotify] = useState(true);

  useEffect(() => {
    if (!q.data) return;
    setStatus(q.data.ticket.status);
    setSeverity(q.data.ticket.severity);
    setResolution(q.data.ticket.resolution ?? '');
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      const t = q.data!.ticket;
      const body: Record<string, unknown> = { notifyUser: notify && (status !== t.status || !!message.trim()) };
      if (status !== t.status) body.status = status;
      if (severity !== t.severity) body.severity = severity;
      if (resolution !== (t.resolution ?? '')) body.resolution = resolution;
      if (message.trim()) body.messageToUser = message.trim();
      return api(`/tickets/${id}`, { method: 'PATCH', body });
    },
    onSuccess: () => {
      toast(notify ? 'Gespeichert – der Nutzer wird informiert' : 'Gespeichert');
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['ticket', id] });
      onClose();
    },
    onError: toastError,
  });

  const t = q.data?.ticket;
  const dirty = !!t && (status !== t.status || severity !== t.severity || resolution !== (t.resolution ?? '') || !!message.trim());

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={t ? `Ticket #${t.id}: ${t.title}` : `Ticket #${id}`}
      footer={
        t && (
          <>
            <label className="mr-auto flex items-center gap-2 text-[13px] text-fg-2">
              <Toggle checked={notify} onChange={setNotify} label="Nutzer informieren" /> Nutzer per WhatsApp informieren
            </label>
            <Button variant="ghost" onClick={onClose}>
              Schließen
            </Button>
            <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Speichern
            </Button>
          </>
        )
      }
    >
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <KeyValue
              items={[
                ['Nutzer', q.data.user ? <Link to={`/users/${q.data.user.id}`} className="text-accent-text hover:underline">{q.data.user.name}</Link> : null],
                ['Kategorie', categoryLabel(t!.category)],
                ['Erstellt', fmtDateTime(t!.created_at)],
                ['Aktualisiert', fmtDateTime(t!.updated_at)],
                ['Gelöst', t!.resolved_at ? fmtDateTime(t!.resolved_at) : null],
                ['Medium', t!.media_ref ? mediaLabel(t!.media_ref) : null],
              ]}
            />
            <div className="grid grid-cols-2 gap-3 self-start">
              <Field label="Status">
                <Select value={status} onChange={(e) => setStatus(e.target.value as TicketStatus)}>
                  {Object.entries(TICKET_STATUS).map(([v, s]) => (
                    <option key={v} value={v}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Dringlichkeit">
                <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                  {Object.entries(SEVERITY).map(([v, s]) => (
                    <option key={v} value={v}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>

          <div>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-fg-3 uppercase">Beschreibung</h3>
            <p className="text-[13px] whitespace-pre-wrap">{t!.description}</p>
          </div>
          {t!.diagnosis && (
            <div>
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-fg-3 uppercase">Diagnose des Bots</h3>
              <p className="rounded-lg bg-surface-2 p-3 text-[13px] whitespace-pre-wrap">{t!.diagnosis}</p>
            </div>
          )}

          {t!.actions.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-3 uppercase">Verlauf</h3>
              <ol className="space-y-2 border-l-2 border-line pl-4">
                {t!.actions.map((a, i) => (
                  <li key={i} className="relative text-[13px]">
                    <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-accent" />
                    <span className="font-medium">{a.action}</span>
                    {a.result && <span className="text-fg-2"> – {a.result}</span>}
                    <span className="block text-[11px] text-fg-3">{fmtDateTime(a.at)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {q.data.watches.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-3 uppercase">Beobachtet</h3>
              <ul className="space-y-1 text-[13px]">
                {q.data.watches.map((w) => (
                  <li key={w.id} className="flex items-center gap-2">
                    <Badge tone={w.done ? 'ok' : 'warn'}>{w.done ? 'Erledigt' : 'Wartet'}</Badge> {w.label}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Lösung" help="Wird im Ticket gespeichert.">
              <Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="z. B. Datei ersetzt, neu gescannt" />
            </Field>
            <Field label="Nachricht an den Nutzer" help="Optional – der Bot richtet sie aus.">
              <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="z. B. Sollte jetzt wieder laufen, probier's nochmal!" />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function TicketsPage() {
  const { query } = useLocation();
  const filter = (query.get('filter') as Filter) ?? 'active';
  const openId = Number(query.get('id')) || null;
  const [search, setSearch] = useState('');
  const statusParam = filter === 'all' ? '' : filter === 'resolved' ? 'resolved,closed' : filter;
  const q = useQuery({ queryKey: ['tickets', filter], queryFn: () => api<Ticket[]>(`/tickets${statusParam ? `?status=${statusParam}` : ''}`) });

  const tickets = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((t) => !s || `${t.title} ${t.description} ${t.user_name ?? ''} ${t.category} ${categoryLabel(t.category)} #${t.id}`.toLowerCase().includes(s));
  }, [q.data, search]);

  return (
    <>
      <PageHeader title="Tickets" subtitle="Problem-Meldungen, Auto-Fixes und Eskalationen" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented<Filter>
          value={filter}
          onChange={(v) => setQuery({ filter: v === 'active' ? null : v })}
          options={[
            { value: 'active', label: 'Offen' },
            { value: 'escalated', label: 'Eskaliert' },
            { value: 'resolved', label: 'Erledigt' },
            { value: 'all', label: 'Alle' },
          ]}
        />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <Input placeholder="Suchen …" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      {q.isError && <ErrorBox error={q.error} />}
      <Card padded={false}>
        {q.isPending ? (
          <Loading />
        ) : tickets.length === 0 ? (
          <EmptyState icon={<LifeBuoy className="size-6" />} title={filter === 'active' ? 'Keine offenen Tickets 🎉' : 'Keine Tickets'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="border-b border-line text-left text-xs text-fg-3">
                <tr>
                  <th className="px-4 py-2.5 font-medium">#</th>
                  <th className="px-2 py-2.5 font-medium">Problem</th>
                  <th className="px-2 py-2.5 font-medium">Nutzer</th>
                  <th className="px-2 py-2.5 font-medium">Dringlichkeit</th>
                  <th className="px-2 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Aktualisiert</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tickets.map((t) => (
                  <tr key={t.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setQuery({ id: String(t.id) })}>
                    <td className="px-4 py-2.5 text-fg-3 tabular-nums">{t.id}</td>
                    <td className="max-w-xs px-2 py-2.5">
                      <p className="truncate font-medium">{t.title}</p>
                      <p className="truncate text-xs text-fg-3">{categoryLabel(t.category)}</p>
                    </td>
                    <td className="px-2 py-2.5">
                      <Link to={`/users/${t.user_id}`} onClick={(e) => e.stopPropagation()} className="text-accent-text hover:underline">
                        {t.user_name ?? `#${t.user_id}`}
                      </Link>
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusBadge map={SEVERITY} value={t.severity} />
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusBadge map={TICKET_STATUS} value={t.status} />
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-fg-3">
                      <RelTime value={t.updated_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {openId && <TicketModal id={openId} onClose={() => setQuery({ id: null })} />}
    </>
  );
}

/** "The Bear · S02E03" from the agent's media reference (falls back to raw JSON for unknown shapes). */
function mediaLabel(ref: unknown) {
  const m = ref as { title?: string; season?: number; episode?: number } | null;
  if (!m?.title) return <code className="text-xs">{JSON.stringify(ref)}</code>;
  const pad = (n: number) => String(n).padStart(2, '0');
  const ep = m.season != null ? ` · S${pad(m.season)}${m.episode != null ? `E${pad(m.episode)}` : ''}` : '';
  return `${m.title}${ep}`;
}
