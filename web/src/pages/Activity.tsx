import { useQuery } from '@tanstack/react-query';
import { Activity as ActivityIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type ActionEntry } from '../api';
import { Card, EmptyState, ErrorBox, Input, Loading, PageHeader, RelTime, cx } from '../components/ui';
import { Link } from '../router';

/** Human-readable names for action_log entries. */
const ACTIONS: Record<string, string> = {
  request_media: 'Medium angefragt',
  replace_file: 'Auto-Fix: Datei ersetzen',
  search_missing: 'Auto-Fix: Fehlendes suchen',
  rescan: 'Auto-Fix: Bibliothek gescannt',
  refresh_metadata: 'Auto-Fix: Metadaten aktualisiert',
  web_user_created: 'Nutzer angelegt (Web)',
  web_user_updated: 'Nutzer geändert (Web)',
  web_user_deleted: 'Nutzer gelöscht (Web)',
  web_message: 'Admin-Nachricht (Web)',
  web_reset_history: 'Verlauf zurückgesetzt (Web)',
  web_broadcast: 'Rundnachricht (Web)',
  web_settings: 'Einstellungen geändert',
  web_whatsapp_logout: 'WhatsApp abgemeldet',
  web_user_imported: 'Nutzer importiert (Web)',
  request_fix: 'Anfrage angestoßen',
  stuck_autofix: 'Hängende Anfrage angestoßen',
  limits_reset: 'Limits aufgehoben',
  off_topic: 'Themenfremde Anfrage',
  jellyfin_account_created: 'Jellyfin-Konto angelegt',
  maintenance_set: 'Wartungshinweis gesetzt',
  maintenance_cleared: 'Wartungshinweis aufgehoben',
  outage_detected: 'Störung erkannt',
  outage_resolved: 'Störung behoben',
  digest_sent: 'Wochenrückblick verschickt',
  digest_skipped: 'Wochenrückblick übersprungen',
  digest_preference: 'Wochenrückblick an/ab',
  voice_transcribed: 'Sprachnachricht umgewandelt',
  hermes_handoff: 'An Hermes übergeben',
  hermes_send_failed: 'Hermes nicht erreicht',
  hermes_failed: 'Hermes: nicht lösbar',
  hermes_working: 'Hermes: Zwischenstand',
  hermes_fixed: 'Hermes: behoben',
  hermes_needs_admin: 'Hermes: braucht dich',
};

const actionLabel = (a: string) => ACTIONS[a] ?? a.replace(/_/g, ' ');
const actionTone = (a: string) =>
  a === 'replace_file' || a === 'search_missing' || a === 'rescan' || a === 'refresh_metadata' ? 'bg-violet' : a.includes('request') ? 'bg-info' : a.startsWith('web_') ? 'bg-fg-3' : 'bg-accent';

function detailsText(details: string | null) {
  if (!details) return '';
  try {
    const d = JSON.parse(details) as Record<string, unknown>;
    return Object.entries(d)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' · ');
  } catch {
    return details;
  }
}

export function ActivityList({ items, compact }: { items: ActionEntry[]; compact?: boolean }) {
  if (!items.length) return <EmptyState icon={<ActivityIcon className="size-6" />} title="Noch keine Aktivität" />;
  return (
    <ul className="divide-y divide-line">
      {items.map((a) => {
        const d = detailsText(a.details);
        return (
          <li key={a.id} className="flex items-start gap-3 px-4 py-2.5">
            <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', actionTone(a.action))} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px]">
                <span className="font-medium">{actionLabel(a.action)}</span>
                {a.user_name && a.user_id && (
                  <>
                    {' · '}
                    <Link to={`/users/${a.user_id}`} className="text-accent-text hover:underline">
                      {a.user_name}
                    </Link>
                  </>
                )}
                {a.ticket_id && (
                  <>
                    {' · '}
                    <Link to={`/tickets?id=${a.ticket_id}`} className="text-accent-text hover:underline">
                      Ticket #{a.ticket_id}
                    </Link>
                  </>
                )}
              </p>
              {d && <p className={cx('text-xs text-fg-3', compact ? 'truncate' : 'break-words')}>{d}</p>}
            </div>
            <RelTime value={a.created_at} className="shrink-0 text-xs text-fg-3" />
          </li>
        );
      })}
    </ul>
  );
}

export function ActivityPage() {
  const q = useQuery({ queryKey: ['activity'], queryFn: () => api<ActionEntry[]>('/activity?limit=500') });
  const [filter, setFilter] = useState('');
  const items = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return q.data ?? [];
    return (q.data ?? []).filter((a) => `${actionLabel(a.action)} ${a.action} ${a.user_name ?? ''} ${a.details ?? ''}`.toLowerCase().includes(f));
  }, [q.data, filter]);

  return (
    <>
      <PageHeader title="Aktivität" subtitle="Was der Bot und du zuletzt getan habt" actions={<Input placeholder="Filtern …" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56" />} />
      {q.isError && <ErrorBox error={q.error} />}
      <Card padded={false}>{q.isPending ? <Loading /> : <ActivityList items={items} />}</Card>
    </>
  );
}
