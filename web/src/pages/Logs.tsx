import { useQuery } from '@tanstack/react-query';
import { Pause, Play, ScrollText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type LogEntry } from '../api';
import { Button, Card, EmptyState, ErrorBox, Input, Loading, PageHeader, Segmented, cx, parseDate } from '../components/ui';

const LEVELS: Record<number, { label: string; className: string }> = {
  10: { label: 'TRACE', className: 'text-fg-3' },
  20: { label: 'DEBUG', className: 'text-fg-3' },
  30: { label: 'INFO', className: 'text-info' },
  40: { label: 'WARN', className: 'text-warn' },
  50: { label: 'ERROR', className: 'text-danger' },
  60: { label: 'FATAL', className: 'text-danger font-bold' },
};

export function LogsPage() {
  const [level, setLevel] = useState('30');
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['logs', level], queryFn: () => api<LogEntry[]>(`/logs?level=${level}&limit=1000`), refetchInterval: follow ? 5_000 : false });
  const ref = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (q.data ?? []).filter((l) => !f || `${l.msg} ${JSON.stringify(l.data ?? {})}`.toLowerCase().includes(f));
  }, [q.data, filter]);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [items, follow]);

  return (
    <>
      <PageHeader
        title="Logs"
        subtitle="Die letzten 1000 Log-Einträge seit dem Start (live)"
        actions={
          <Button icon={follow ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => setFollow(!follow)}>
            {follow ? 'Anhalten' : 'Live folgen'}
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          value={level}
          onChange={setLevel}
          options={[
            { value: '20', label: 'Debug' },
            { value: '30', label: 'Info' },
            { value: '40', label: 'Warnungen' },
            { value: '50', label: 'Fehler' },
          ]}
        />
        <Input placeholder="Filtern …" className="ml-auto w-full sm:w-64" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {q.isError && <ErrorBox error={q.error} />}
      <Card padded={false}>
        {q.isPending ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState icon={<ScrollText className="size-6" />} title="Keine Einträge">
            {level === '20' ? 'Debug-Logs erscheinen nur, wenn das Log-Level unter Einstellungen → System auf „debug“ steht.' : undefined}
          </EmptyState>
        ) : (
          <div ref={ref} className="h-[calc(100vh-16rem)] min-h-80 overflow-y-auto font-mono text-xs" onWheel={(e) => e.deltaY < 0 && follow && setFollow(false)}>
            {items.map((l) => {
              const lv = LEVELS[l.level] ?? { label: String(l.level), className: '' };
              const hasData = l.data && Object.keys(l.data).length > 0;
              return (
                <div key={l.id} className={cx('border-b border-line/60 px-4 py-1', l.level >= 50 && 'bg-danger-soft/40', hasData && 'cursor-pointer hover:bg-surface-2')} onClick={() => hasData && setExpanded(expanded === l.id ? null : l.id)}>
                  <div className="flex gap-3">
                    <span className="shrink-0 text-fg-3 tabular-nums">{parseDate(l.time).toLocaleTimeString('de-DE')}</span>
                    <span className={cx('w-11 shrink-0', lv.className)}>{lv.label}</span>
                    <span className="min-w-0 flex-1 break-words">
                      {l.msg}
                      {hasData && expanded !== l.id && <span className="ml-2 text-fg-3">{JSON.stringify(l.data).slice(0, 140)}</span>}
                    </span>
                  </div>
                  {expanded === l.id && <pre className="mt-1 mb-1 ml-[7.5rem] overflow-x-auto rounded bg-surface-2 p-2 text-[11px] whitespace-pre-wrap">{JSON.stringify(l.data, null, 2)}</pre>}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
