import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bot, Clapperboard, Coins, LifeBuoy, MessageSquare, RefreshCw, Users } from 'lucide-react';
import { api, type Overview } from '../api';
import { WA_STATE } from '../components/Layout';
import { ActivityList } from './Activity';
import {
  Avatar,
  Badge,
  BarChart,
  Button,
  Card,
  Dot,
  EmptyState,
  ErrorBox,
  KeyValue,
  Loading,
  PageHeader,
  RelTime,
  RuntimeChip,
  SEVERITY,
  Stat,
  StatusBadge,
  fmtDuration,
  fmtNum,
  fmtRelative,
  fmtTokens,
  parseDate,
  toast,
  toastError,
  useNow,
} from '../components/ui';
import { Link } from '../router';

const SERVICE_NAMES: Record<string, string> = { jellyfin: 'Jellyfin', plex: 'Plex', seerr: 'Jellyseerr', ombi: 'Ombi', sonarr: 'Sonarr', radarr: 'Radarr' };

interface NowPlaying {
  sessions: { server: string; user?: string; userId?: number; title?: string; device?: string; method?: string; paused?: boolean }[];
  errors: string[];
}

function ServicesCard() {
  const q = useQuery({ queryKey: ['services'], queryFn: () => api<Record<string, string>>('/services'), refetchInterval: 60_000 });
  const refresh = useMutation({
    mutationFn: () => api<Record<string, string>>('/services?refresh=1'),
    onSuccess: (data) => {
      q.refetch();
      toast(Object.values(data).every((v) => v === 'ok') ? 'Alle Dienste erreichbar' : 'Mindestens ein Dienst hat ein Problem', Object.values(data).every((v) => v === 'ok') ? 'ok' : 'danger');
    },
    onError: toastError,
  });
  const entries = Object.entries(q.data ?? {});
  return (
    <Card
      title="Dienste"
      actions={
        <Button size="sm" variant="ghost" loading={refresh.isPending} icon={<RefreshCw className="size-3.5" />} onClick={() => refresh.mutate()}>
          Prüfen
        </Button>
      }
    >
      {q.isPending ? (
        <Loading />
      ) : entries.length === 0 ? (
        <EmptyState title="Keine Dienste eingerichtet">
          <Link to="/settings?group=jellyfin" className="text-accent-text underline">
            Jellyfin, Plex, Seerr & Co. verbinden
          </Link>
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {entries.map(([name, status]) => (
            <li key={name} className="flex items-center gap-2.5 text-[13px]">
              <Dot tone={status === 'ok' ? 'ok' : 'danger'} />
              <span className="font-medium">{SERVICE_NAMES[name] ?? name}</span>
              <span className="ml-auto truncate text-xs text-fg-3" title={status}>
                {status === 'ok' ? 'erreichbar' : status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NowPlayingCard() {
  const q = useQuery({ queryKey: ['now-playing'], queryFn: () => api<NowPlaying>('/now-playing'), refetchInterval: 30_000 });
  const sessions = q.data?.sessions ?? [];
  return (
    <Card title={`Läuft gerade${sessions.length ? ` (${sessions.length})` : ''}`} padded={false}>
      {q.isPending ? (
        <Loading />
      ) : sessions.length === 0 ? (
        <EmptyState icon={<Clapperboard className="size-6" />} title="Niemand schaut gerade">
          {q.data?.errors.map((e) => (
            <span key={e} className="block text-danger">
              {e}
            </span>
          ))}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {sessions.map((s, i) => (
            <li key={i} className="flex items-start gap-3 px-4 py-2.5">
              <Clapperboard className="mt-0.5 size-4 shrink-0 text-fg-3" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{s.title ?? '?'}</p>
                <p className="truncate text-xs text-fg-3">
                  {s.userId ? (
                    <Link to={`/users/${s.userId}`} className="text-accent-text hover:underline">
                      {s.user}
                    </Link>
                  ) : (
                    s.user
                  )}
                  {s.device ? ` · ${s.device}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge>{s.server}</Badge>
                {s.method && <span className="text-[11px] text-fg-3">{s.method}</span>}
                {s.paused && <Badge tone="warn">Pausiert</Badge>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Dashboard() {
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/overview'), refetchInterval: 60_000 });
  const now = useNow();
  const poll = useMutation({ mutationFn: () => api('/poll', { body: {} }), onSuccess: () => toast('Benachrichtigungs-Check ausgeführt'), onError: toastError });

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const o = q.data;
  const wa = WA_STATE[o.bot.whatsapp.state] ?? WA_STATE.starting;
  const usageMonth = o.usage.month.input + o.usage.month.output;

  return (
    <>
      <PageHeader title="Übersicht" subtitle={`${o.bot.name} läuft seit ${fmtDuration(now - parseDate(o.bot.startedAt).getTime())}`} />

      {(o.bot.whatsapp.state !== 'open' || o.bot.adminNumbers === 0) && (
        <div className="mb-5 space-y-2">
          {o.bot.whatsapp.state !== 'open' && (
            <Link to="/whatsapp" className="flex items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[13px] text-warn hover:opacity-90">
              <AlertTriangle className="size-4 shrink-0" />
              <span>
                WhatsApp: <strong>{wa.label}</strong>. Der Bot kann gerade keine Nachrichten empfangen.{o.bot.whatsapp.state === 'qr' && ' Jetzt QR-Code scannen →'}
              </span>
            </Link>
          )}
          {o.bot.adminNumbers === 0 && (
            <Link to="/settings?group=general" className="flex items-center gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger hover:opacity-90">
              <AlertTriangle className="size-4 shrink-0" />
              <span>Keine Admin-Nummer eingetragen – Eskalationen erreichen niemanden. Jetzt eintragen →</span>
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Nutzer" value={o.users.active} hint={`${o.users.pending} warten · ${o.users.blocked} gesperrt`} icon={<Users className="size-3.5" />} tone="accent" />
        <Stat label="Nachrichten heute" value={fmtNum(o.messages.today)} hint={`${fmtNum(o.messages.week)} in 7 Tagen`} icon={<MessageSquare className="size-3.5" />} tone="info" />
        <Stat
          label="Offene Tickets"
          value={o.tickets.active}
          hint={o.tickets.escalated ? `${o.tickets.escalated} eskaliert` : `${o.tickets.resolved ?? 0} gelöst insgesamt`}
          icon={<LifeBuoy className="size-3.5" />}
          tone={o.tickets.escalated ? 'danger' : 'violet'}
        />
        <Stat label="Tokens (30 Tage)" value={fmtTokens(usageMonth)} hint={`${fmtNum(o.usage.month.calls)} LLM-Aufrufe · heute ${fmtTokens(o.usage.today.input + o.usage.today.output)}`} icon={<Coins className="size-3.5" />} tone="warn" />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Nachrichten pro Tag">
            <BarChart
              days={14}
              data={o.messages.byDay}
              series={[
                { key: 'incoming', label: 'Von Nutzern', color: 'var(--info)' },
                { key: 'outgoing', label: 'Vom Bot', color: 'var(--accent)' },
              ]}
            />
          </Card>

          <Card title="Bots gerade aktiv" padded={false}>
            {o.busy.length === 0 ? (
              <EmptyState icon={<Bot className="size-6" />} title="Alle Bots im Leerlauf" />
            ) : (
              <ul className="divide-y divide-line">
                {o.busy.map((b) => (
                  <li key={b.userId}>
                    <Link to={`/users/${b.userId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                      <Avatar name={b.name} className="size-8 text-xs" />
                      <span className="flex-1 truncate text-[13px] font-medium">{b.name}</span>
                      <RuntimeChip runtime={b} />
                      {b.since && <span className="text-xs text-fg-3 tabular-nums">{fmtDuration(Math.max(0, now - parseDate(b.since).getTime()))}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {(o.pendingUsers.length > 0 || o.escalated.length > 0) && (
            <div className="grid gap-5 md:grid-cols-2">
              {o.pendingUsers.length > 0 && (
                <Card title="Warten auf Freigabe" padded={false}>
                  <ul className="divide-y divide-line">
                    {o.pendingUsers.map((u) => (
                      <li key={u.id}>
                        <Link to={`/users/${u.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                          <Avatar name={u.name ?? u.wa_id} className="size-8 text-xs" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium">{u.name ?? 'Unbekannt'}</p>
                            <p className="text-xs text-fg-3">+{u.wa_id}</p>
                          </div>
                          <span className="text-xs text-fg-3">{fmtRelative(u.created_at, now)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {o.escalated.length > 0 && (
                <Card title="Eskalierte Tickets" padded={false}>
                  <ul className="divide-y divide-line">
                    {o.escalated.map((t) => (
                      <li key={t.id}>
                        <Link to={`/tickets?id=${t.id}`} className="block px-4 py-2.5 hover:bg-surface-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-fg-3">#{t.id}</span>
                            <span className="flex-1 truncate text-[13px] font-medium">{t.title}</span>
                            <StatusBadge map={SEVERITY} value={t.severity} />
                          </div>
                          <p className="mt-0.5 text-xs text-fg-3">
                            {t.user_name} · {fmtRelative(t.updated_at, now)}
                          </p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          )}

          <Card
            title="Letzte Aktivität"
            padded={false}
            actions={
              <Link to="/activity" className="text-xs font-medium text-accent-text hover:underline">
                Alle anzeigen
              </Link>
            }
          >
            <ActivityList items={o.activity} compact />
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Bot">
            <KeyValue
              items={[
                ['Modell', <span className="font-mono text-xs">{o.bot.llm.model}</span>],
                ['Admin-Modell', <span className="font-mono text-xs">{o.bot.llm.adminModel}</span>],
                ['Anbieter', o.bot.llm.provider],
                [
                  'WhatsApp',
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <Dot tone={wa.tone} /> {wa.label}
                    {o.bot.whatsapp.me && <span className="text-fg-3">· +{o.bot.whatsapp.me.id.split(/[:@]/)[0]}</span>}
                  </span>,
                ],
                ['Antwortzeit Ø', o.usage.month.avg_ms ? fmtDuration(Math.round(o.usage.month.avg_ms)) : null],
                ['Anfragen', `${o.requests.week} diese Woche · ${o.requests.pending} offen`],
                [
                  'Benachrichtigungen',
                  <span>
                    alle {o.bot.poller.intervalMinutes} min
                    {o.bot.poller.lastRun && (
                      <span className="text-fg-3">
                        {' '}
                        · zuletzt <RelTime value={o.bot.poller.lastRun.at} />
                        {!o.bot.poller.lastRun.ok && <Badge tone="danger" className="ml-1">Fehler</Badge>}
                      </span>
                    )}
                  </span>,
                ],
              ]}
            />
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" loading={poll.isPending || o.bot.poller.busy} icon={<RefreshCw className="size-3.5" />} onClick={() => poll.mutate()}>
                Jetzt auf fertige Medien prüfen
              </Button>
            </div>
          </Card>
          <ServicesCard />
          <NowPlayingCard />
        </div>
      </div>
    </>
  );
}
