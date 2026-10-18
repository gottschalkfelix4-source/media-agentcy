import { useMutation, useQuery } from '@tanstack/react-query';
import { Import, LifeBuoy, Plus, Search, Shield, Users as UsersIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, queryClient, type User, type UserListItem } from '../api';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  RuntimeChip,
  Segmented,
  Select,
  USER_STATUS,
  StatusBadge,
  fmtRelative,
  fmtTokens,
  toast,
  toastError,
  useNow,
} from '../components/ui';
import { Link, navigate, setQuery, useLocation } from '../router';

type Filter = 'all' | 'active' | 'pending' | 'blocked' | 'busy';

function AddUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState('active');
  const create = useMutation({
    mutationFn: () => api<User>('/users', { body: { phone, display_name: name || undefined, status } }),
    onSuccess: (u) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      toast('Nutzer angelegt');
      onClose();
      navigate(`/users/${u.id}`);
    },
    onError: toastError,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nutzer hinzufügen"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!phone} onClick={() => create.mutate()}>
            Anlegen
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="WhatsApp-Nummer" help="Mit Ländervorwahl, z. B. 49 151 12345678 – Leerzeichen und + werden ignoriert.">
          <Input autoFocus inputMode="tel" placeholder="+49 151 12345678" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Name" help="Optional – sonst wird der WhatsApp-Name übernommen.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Aktiv – Bot antwortet sofort</option>
            <option value="pending">Wartet auf Freigabe</option>
            <option value="blocked">Gesperrt</option>
          </Select>
        </Field>
        <p className="text-xs text-fg-3">Der Nutzer bekommt erst eine Nachricht, wenn er dem Bot selbst schreibt.</p>
      </div>
    </Modal>
  );
}

export function UsersPage() {
  const { query } = useLocation();
  const filter = (query.get('filter') as Filter) ?? 'all';
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const now = useNow();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<UserListItem[]>('/users'), refetchInterval: 30_000 });

  const counts = useMemo(() => {
    const c = { all: 0, active: 0, pending: 0, blocked: 0, busy: 0 };
    for (const u of q.data ?? []) {
      c.all++;
      c[u.status]++;
      if (u.runtime.state !== 'idle') c.busy++;
    }
    return c;
  }, [q.data]);

  const users = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter((u) => (filter === 'all' ? true : filter === 'busy' ? u.runtime.state !== 'idle' : u.status === filter))
      .filter((u) => !s || [u.display_name, u.push_name, u.wa_id, u.jellyfin_username, u.plex_username].some((v) => v?.toLowerCase().includes(s)))
      .sort((a, b) => {
        // busy first, then pending, then by last activity
        const rank = (u: UserListItem) => (u.runtime.state !== 'idle' ? 0 : u.status === 'pending' ? 1 : 2);
        return rank(a) - rank(b) || (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at);
      });
  }, [q.data, filter, search]);

  return (
    <>
      <PageHeader
        title="Nutzer"
        subtitle="Jeder Nutzer hat seinen eigenen Bot-Verlauf und eigenes Gedächtnis"
        actions={
          <>
            <Button icon={<Import className="size-4" />} onClick={() => navigate('/users/import')}>
              Aus Medienserver importieren
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              Nutzer hinzufügen
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented<Filter>
          value={filter}
          onChange={(v) => setQuery({ filter: v === 'all' ? null : v })}
          options={[
            { value: 'all', label: `Alle ${counts.all}` },
            { value: 'active', label: `Aktiv ${counts.active}` },
            { value: 'pending', label: `Wartend ${counts.pending}` },
            { value: 'blocked', label: `Gesperrt ${counts.blocked}` },
            { value: 'busy', label: `Bot aktiv ${counts.busy}` },
          ]}
        />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <Input placeholder="Name, Nummer, Konto …" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {q.isError && <ErrorBox error={q.error} />}
      <Card padded={false}>
        {q.isPending ? (
          <Loading />
        ) : users.length === 0 ? (
          <EmptyState icon={<UsersIcon className="size-6" />} title={q.data?.length ? 'Keine Treffer' : 'Noch keine Nutzer'}>
            {!q.data?.length && 'Sobald jemand dem Bot schreibt, taucht er hier auf.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {users.map((u) => {
              const name = u.display_name ?? u.push_name ?? 'Unbekannt';
              return (
                <li key={u.id}>
                  <Link to={`/users/${u.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
                    <Avatar name={name} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate text-[13px] font-semibold">{name}</span>
                        {u.role === 'admin' && (
                          <Badge tone="violet">
                            <Shield className="size-3" /> Admin
                          </Badge>
                        )}
                        {u.status !== 'active' && <StatusBadge map={USER_STATUS} value={u.status} />}
                        {u.open_tickets > 0 && (
                          <Badge tone="info">
                            <LifeBuoy className="size-3" /> {u.open_tickets}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-fg-3">
                        {u.last_message ? (
                          <>
                            {u.last_message_role === 'assistant' ? 'Bot: ' : u.last_message_role === 'event' ? 'System: ' : ''}
                            {u.last_message}
                          </>
                        ) : (
                          <>{u.wa_id.startsWith('lid:') ? u.wa_id : `+${u.wa_id}`}</>
                        )}
                      </p>
                    </div>
                    <div className="hidden shrink-0 flex-col items-end gap-1 text-xs text-fg-3 md:flex">
                      <span>{[u.jellyfin_username && 'Jellyfin', u.plex_username && 'Plex', u.seerr_user_id && 'Seerr'].filter(Boolean).join(' · ') || 'kein Konto verknüpft'}</span>
                      <span className="tabular-nums">
                        {u.message_count} Nachr. · {fmtTokens(u.tokens_30d)} Tokens
                      </span>
                    </div>
                    <div className="flex w-28 shrink-0 flex-col items-end gap-1">
                      <RuntimeChip runtime={u.runtime} paused={!!u.bot_paused} compact />
                      <span className="text-xs text-fg-3">{fmtRelative(u.last_message_at ?? u.last_seen_at, now)}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <AddUserModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
