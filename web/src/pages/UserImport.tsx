import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, CircleCheck, Import, RefreshCw, Search, Server, Shield } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, queryClient } from '../api';
import { Avatar, Badge, Button, Card, EmptyState, ErrorBox, Input, Loading, PageHeader, Segmented, Select, Toggle, cx, toast, toastError } from '../components/ui';
import { Link } from '../router';

interface Candidate {
  key: string;
  name: string;
  email?: string;
  jellyfin?: { id: string; name: string; disabled: boolean; admin: boolean };
  plex?: { username: string; owner: boolean };
  seerr?: { id: number; name: string };
  existing?: { id: number; name: string; wa_id: string };
}

interface CandidatesResponse {
  sources: { jellyfin: boolean; plex: boolean; seerr: boolean };
  candidates: Candidate[];
  /** Known users whose missing Jellyfin/Seerr accounts were just linked. */
  linked: string[];
  errors: string[];
}

interface ImportResult {
  ok: boolean;
  action?: 'created' | 'updated';
  userId?: number;
  error?: string;
}

/** Same rules as the server (src/server/userImport.ts) for instant feedback. */
function phoneProblem(raw: string) {
  let v = raw.trim().replace(/[\s\-()/.]/g, '');
  if (!v) return null;
  if (v.startsWith('+')) v = v.slice(1);
  else if (v.startsWith('00')) v = v.slice(2);
  else if (v.startsWith('0')) return 'Mit Ländervorwahl, z. B. +49 151 …';
  if (!/^\d+$/.test(v)) return 'Nur Ziffern, Leerzeichen und +';
  if (v.length < 8 || v.length > 15) return 'Nummer zu kurz oder zu lang';
  return null;
}

type Filter = 'new' | 'all';

export function UserImportPage() {
  const q = useQuery({
    queryKey: ['user-import'],
    queryFn: async () => {
      const d = await api<CandidatesResponse>('/user-import/candidates');
      if (d.linked?.length) {
        toast(`Konten nachgetragen für ${d.linked.join(', ')}`);
        void queryClient.invalidateQueries({ queryKey: ['users'] });
      }
      return d;
    },
    staleTime: 60_000,
  });
  const [filter, setFilter] = useState<Filter>('new');
  const [search, setSearch] = useState('');
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, ImportResult>>({});
  const [status, setStatus] = useState<'active' | 'pending'>('active');
  const [welcome, setWelcome] = useState(false);

  const candidates = q.data?.candidates ?? [];
  const newCount = candidates.filter((c) => !c.existing).length;
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return candidates
      .filter((c) => filter === 'all' || !c.existing || results[c.key])
      .filter((c) => !s || [c.name, c.email, c.jellyfin?.name, c.plex?.username, c.seerr?.name].some((v) => v?.toLowerCase().includes(s)));
  }, [candidates, filter, search, results]);

  const ready = candidates.filter((c) => !c.existing && phones[c.key]?.trim() && !phoneProblem(phones[c.key]));
  const invalid = candidates.filter((c) => !c.existing && phones[c.key]?.trim() && phoneProblem(phones[c.key])).length;

  const run = useMutation({
    mutationFn: (list: Candidate[]) =>
      api<{ results: ImportResult[] }>('/user-import', {
        body: {
          status,
          welcome,
          users: list.map((c) => ({
            phone: phones[c.key],
            display_name: (names[c.key] ?? c.name).trim() || null,
            jellyfin_user_id: c.jellyfin?.id,
            jellyfin_username: c.jellyfin?.name,
            plex_username: c.plex?.username,
            seerr_user_id: c.seerr?.id,
          })),
        },
      }),
    onSuccess: ({ results: res }, list) => {
      const byKey: Record<string, ImportResult> = {};
      list.forEach((c, i) => (byKey[c.key] = res[i]));
      setResults((r) => ({ ...r, ...byKey }));
      setPhones((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !byKey[k]?.ok)));
      const created = res.filter((r) => r.action === 'created').length;
      const updated = res.filter((r) => r.action === 'updated').length;
      const failed = res.filter((r) => !r.ok).length;
      toast(
        [created && `${created} angelegt`, updated && `${updated} mit bestehendem Nutzer verbunden`, failed && `${failed} fehlgeschlagen`].filter(Boolean).join(', '),
        failed ? 'danger' : 'ok',
      );
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['user-import'] });
    },
    onError: toastError,
  });

  const sources = q.data?.sources;
  const noSources = sources && !sources.jellyfin && !sources.plex && !sources.seerr;

  return (
    <>
      <Link to="/users" className="mb-3 inline-flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
        <ArrowLeft className="size-4" /> Alle Nutzer
      </Link>
      <PageHeader
        title="Nutzer importieren"
        subtitle="Konten aus Jellyfin, Plex und Jellyseerr übernehmen. Trag die WhatsApp-Nummer ein, nur Zeilen mit Nummer werden importiert."
        actions={
          <Button icon={<RefreshCw className={cx('size-4', q.isFetching && 'animate-spin')} />} onClick={() => void q.refetch()} disabled={q.isFetching}>
            Neu laden
          </Button>
        }
      />

      {q.isError && <ErrorBox error={q.error} />}
      {q.data?.errors.map((e) => <ErrorBox key={e} error={e} />)}

      {q.isPending ? (
        <Card>
          <Loading label="Lade Konten von den Medienservern …" />
        </Card>
      ) : noSources ? (
        <Card>
          <EmptyState icon={<Server className="size-6" />} title="Keine Medienserver eingerichtet">
            Trag zuerst Jellyfin, Plex oder Jellyseerr in den{' '}
            <Link to="/settings?group=jellyfin" className="text-accent hover:underline">
              Einstellungen
            </Link>{' '}
            ein.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Segmented<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'new', label: `Noch nicht angelegt ${newCount}` },
                { value: 'all', label: `Alle ${candidates.length}` },
              ]}
            />
            <div className="flex flex-wrap gap-1.5 text-xs text-fg-3">
              {sources?.jellyfin && <Badge>Jellyfin</Badge>}
              {sources?.plex && <Badge>Plex</Badge>}
              {sources?.seerr && <Badge>Jellyseerr</Badge>}
            </div>
            <div className="relative ml-auto w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
              <Input placeholder="Name, Konto, E-Mail …" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>

          <Card padded={false}>
            {rows.length === 0 ? (
              <EmptyState icon={<CircleCheck className="size-6" />} title={candidates.length ? 'Alle Konten sind schon angelegt' : 'Keine Konten gefunden'}>
                {candidates.length > 0 && filter === 'new' && 'Unter „Alle“ siehst du, welches Konto zu welchem Nutzer gehört.'}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {rows.map((c) => (
                  <CandidateRow
                    key={c.key}
                    c={c}
                    phone={phones[c.key] ?? ''}
                    name={names[c.key] ?? c.name}
                    result={results[c.key]}
                    onPhone={(v) => setPhones((p) => ({ ...p, [c.key]: v }))}
                    onName={(v) => setNames((n) => ({ ...n, [c.key]: v }))}
                  />
                ))}
              </ul>
            )}
          </Card>

          <div className="sticky bottom-4 z-20 mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg">
            <label className="flex items-center gap-2 text-[13px]">
              <span className="text-fg-2">Status</span>
              <Select className="h-8 w-auto" value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'pending')}>
                <option value="active">Aktiv</option>
                <option value="pending">Wartet auf Freigabe</option>
              </Select>
            </label>
            <label className="flex items-center gap-2 text-[13px]" title="Der Bot schreibt jedem neuen Nutzer eine kurze Vorstellung. Viele Nachrichten an Unbekannte auf einmal kann WhatsApp als Spam werten.">
              <Toggle checked={welcome} onChange={setWelcome} disabled={status !== 'active'} label="Begrüßung schicken" />
              <span className={cx(status !== 'active' && 'text-fg-3')}>Begrüßung per WhatsApp</span>
            </label>
            <span className="flex-1 text-xs text-fg-3">
              {invalid > 0 ? <span className="text-danger">{invalid} Nummer{invalid === 1 ? '' : 'n'} ungültig</span> : welcome && ready.length > 5 ? 'Tipp: Bei vielen Nutzern die Begrüßung lieber aus lassen, sonst wertet WhatsApp das schnell als Spam.' : null}
            </span>
            <Button variant="primary" icon={<Import className="size-4" />} disabled={!ready.length || invalid > 0} loading={run.isPending} onClick={() => run.mutate(ready)}>
              {ready.length ? `${ready.length} Nutzer importieren` : 'Importieren'}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function CandidateRow({
  c,
  phone,
  name,
  result,
  onPhone,
  onName,
}: {
  c: Candidate;
  phone: string;
  name: string;
  result?: ImportResult;
  onPhone: (v: string) => void;
  onName: (v: string) => void;
}) {
  const problem = phoneProblem(phone);
  const done = result?.ok;
  return (
    <li className={cx('flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center', c.existing && !result && 'bg-surface-2/40')}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={name || c.name} />
        <div className="min-w-0 flex-1">
          {c.existing || done ? (
            <span className="block truncate text-[13px] font-semibold">{c.existing?.name ?? name}</span>
          ) : (
            <Input className="h-8 max-w-56 font-semibold" value={name} onChange={(e) => onName(e.target.value)} aria-label="Anzeigename" />
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
            {c.jellyfin && (
              <Badge tone={c.jellyfin.disabled ? 'neutral' : 'info'} title={c.jellyfin.disabled ? 'In Jellyfin deaktiviert' : undefined}>
                Jellyfin · {c.jellyfin.name}
                {c.jellyfin.disabled && ' (deaktiviert)'}
              </Badge>
            )}
            {c.plex && (
              <Badge tone="warn">
                Plex · {c.plex.username}
                {c.plex.owner && ' (Besitzer)'}
              </Badge>
            )}
            {c.seerr && <Badge tone="violet">Jellyseerr · #{c.seerr.id}</Badge>}
            {c.jellyfin?.admin && (
              <span className="inline-flex items-center gap-0.5" title="Administrator in Jellyfin">
                <Shield className="size-3" /> Admin
              </span>
            )}
            {c.email && <span className="truncate">{c.email}</span>}
          </div>
        </div>
      </div>

      <div className="md:w-72 md:shrink-0">
        {done ? (
          <p className="flex items-center gap-1.5 text-[13px] text-ok">
            <CircleCheck className="size-4" />
            {result.action === 'created' ? 'Angelegt' : 'Mit bestehendem Nutzer verbunden'}
            <Link to={`/users/${result.userId}`} className="ml-1 text-accent hover:underline">
              öffnen
            </Link>
          </p>
        ) : c.existing ? (
          <p className="text-[13px] text-fg-3">
            Verknüpft mit{' '}
            <Link to={`/users/${c.existing.id}`} className="text-accent hover:underline">
              {c.existing.name}
            </Link>{' '}
            <span className="tabular-nums">· +{c.existing.wa_id}</span>
          </p>
        ) : (
          <>
            <Input
              inputMode="tel"
              autoComplete="off"
              placeholder="WhatsApp-Nummer, z. B. +49 151 …"
              value={phone}
              onChange={(e) => onPhone(e.target.value)}
              className={cx((problem || result?.error) && 'border-danger focus:border-danger focus:ring-danger/20')}
              aria-label={`WhatsApp-Nummer für ${name}`}
            />
            {(problem || result?.error) && <p className="mt-1 text-xs text-danger">{problem ?? result?.error}</p>}
          </>
        )}
      </div>
    </li>
  );
}
