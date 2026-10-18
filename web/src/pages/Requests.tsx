import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot, Globe, Inbox, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, queryClient, type BotRequest } from '../api';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Loading, PageHeader, RelTime, Segmented, toast, toastError } from '../components/ui';
import { Link } from '../router';

type Filter = 'all' | 'waiting' | 'done';

export function RequestsPage() {
  const q = useQuery({ queryKey: ['requests'], queryFn: () => api<BotRequest[]>('/requests') });
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const items = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter((r) => (filter === 'all' ? true : filter === 'waiting' ? !r.notified_at : !!r.notified_at))
      .filter((r) => !s || `${r.title} ${r.user_name ?? ''}`.toLowerCase().includes(s));
  }, [q.data, filter, search]);
  const waiting = (q.data ?? []).filter((r) => !r.notified_at).length;
  const sync = useMutation({
    mutationFn: () => api<{ imported: number; unmatched: number; errors: string[] }>('/requests/sync', { body: {} }),
    onSuccess: (r) => {
      toast(
        `${r.imported ? `${r.imported} Anfrage${r.imported === 1 ? '' : 'n'} übernommen` : 'Nichts Neues'}${r.unmatched ? ` · ${r.unmatched} ohne verknüpften Nutzer` : ''}`,
        r.errors.length ? 'info' : 'ok',
      );
      for (const e of r.errors) toastError(new Error(e));
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
    },
    onError: toastError,
  });

  return (
    <>
      <PageHeader
        title="Anfragen"
        subtitle="Über den Bot oder auf der Jellyseerr-/Ombi-Webseite angefragt. Webseiten-Anfragen werden über die verknüpften Konten automatisch zugeordnet."
        actions={
          <Button variant="secondary" icon={<RefreshCw className="size-3.5" />} loading={sync.isPending} onClick={() => sync.mutate()}>
            Jetzt abgleichen
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `Alle ${q.data?.length ?? ''}` },
            { value: 'waiting', label: `Wartet ${waiting}` },
            { value: 'done', label: 'Verfügbar' },
          ]}
        />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <Input placeholder="Titel oder Nutzer …" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      {q.isError && <ErrorBox error={q.error} />}
      <Card padded={false}>
        {q.isPending ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState icon={<Inbox className="size-6" />} title="Keine Anfragen" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-[13px]">
              <thead className="border-b border-line text-left text-xs text-fg-3">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Titel</th>
                  <th className="px-2 py-2.5 font-medium">Typ</th>
                  <th className="px-2 py-2.5 font-medium">Nutzer</th>
                  <th className="px-2 py-2.5 font-medium">Über</th>
                  <th className="px-2 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Angefragt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((r) => (
                  <tr key={r.id}>
                    <td className="max-w-xs truncate px-4 py-2.5 font-medium">
                      {r.tmdb_id ? (
                        <a href={`https://www.themoviedb.org/${r.media_type}/${r.tmdb_id}`} target="_blank" rel="noreferrer" className="hover:underline">
                          {r.title}
                        </a>
                      ) : (
                        r.title
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      <Badge tone={r.media_type === 'movie' ? 'info' : 'violet'}>{r.media_type === 'movie' ? 'Film' : 'Serie'}</Badge>
                    </td>
                    <td className="px-2 py-2.5">
                      <Link to={`/users/${r.user_id}`} className="text-accent-text hover:underline">
                        {r.user_name ?? `#${r.user_id}`}
                      </Link>
                    </td>
                    <td className="px-2 py-2.5 text-fg-3">
                      <span className="inline-flex items-center gap-1.5" title={r.via === 'web' ? 'Auf der Webseite angefragt' : 'Über den Bot angefragt'}>
                        {r.via === 'web' ? <Globe className="size-3.5" /> : <Bot className="size-3.5" />}
                        {r.source === 'seerr' ? 'Jellyseerr' : 'Ombi'}
                        {r.via === 'web' ? ' (Webseite)' : ' (Bot)'}
                      </span>
                    </td>
                    <td className="px-2 py-2.5">
                      {r.notified_at ? (
                        <Badge tone="ok" title={`Benachrichtigt ${r.notified_at}`}>
                          Verfügbar
                        </Badge>
                      ) : (
                        <Badge tone="warn">Wartet</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-fg-3">
                      <RelTime value={r.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
