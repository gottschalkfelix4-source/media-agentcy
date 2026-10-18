import { Loader2, X } from 'lucide-react';
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { Runtime } from '../api';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- layout primitives

export function Card({ children, className, title, actions, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface shadow-card', className)}>
      {(title || actions) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-fg-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-fg-3">{icon}</div>}
      <p className="font-medium text-fg-2">{title}</p>
      {children && <div className="max-w-sm text-[13px] text-fg-3">{children}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('animate-spin', className ?? 'size-4')} />;
}

export function Loading({ label = 'Lädt …' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-fg-3">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">{error instanceof Error ? error.message : String(error)}</div>;
}

// ---------------------------------------------------------------- badges & status

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'violet';

const toneClass: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-fg-2',
  accent: 'bg-accent-soft text-accent-text',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  violet: 'bg-violet-soft text-violet',
};

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium', toneClass[tone], className)}>
      {children}
    </span>
  );
}

const dotTone: Record<Tone, string> = {
  neutral: 'bg-fg-3',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  violet: 'bg-violet',
};

export function Dot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', dotTone[tone], pulse && 'animate-pulse-dot')} />;
}

export const USER_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Aktiv', tone: 'ok' },
  pending: { label: 'Wartet auf Freigabe', tone: 'warn' },
  blocked: { label: 'Gesperrt', tone: 'danger' },
};

export const TICKET_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Offen', tone: 'info' },
  auto_fixing: { label: 'Auto-Fix läuft', tone: 'violet' },
  escalated: { label: 'Eskaliert', tone: 'danger' },
  resolved: { label: 'Gelöst', tone: 'ok' },
  closed: { label: 'Geschlossen', tone: 'neutral' },
};

export const TICKET_CATEGORY: Record<string, string> = {
  playback: 'Wiedergabe',
  missing_media: 'Fehlender Inhalt',
  quality: 'Qualität',
  audio_subtitles: 'Ton/Untertitel',
  metadata: 'Metadaten',
  download: 'Download',
  account: 'Konto',
  server: 'Server',
  other: 'Sonstiges',
};
export const categoryLabel = (c: string) => TICKET_CATEGORY[c] ?? c;

export const SEVERITY: Record<string, { label: string; tone: Tone }> = {
  low: { label: 'Niedrig', tone: 'neutral' },
  normal: { label: 'Normal', tone: 'info' },
  high: { label: 'Hoch', tone: 'warn' },
  critical: { label: 'Kritisch', tone: 'danger' },
};

export function StatusBadge({ map, value }: { map: Record<string, { label: string; tone: Tone }>; value: string }) {
  const s = map[value] ?? { label: value, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** What the user's bot conversation is doing right now. */
export function RuntimeChip({ runtime, paused, compact }: { runtime: Runtime; paused?: boolean; compact?: boolean }) {
  if (paused)
    return (
      <Badge tone="warn" title="Bot antwortet nicht – du hast übernommen">
        <Dot tone="warn" /> {compact ? 'Pausiert' : 'Bot pausiert'}
      </Badge>
    );
  if (runtime.state === 'working')
    return (
      <Badge tone="accent" title={runtime.since ? `seit ${fmtTime(runtime.since)}` : undefined}>
        <Dot tone="accent" pulse /> Antwortet{runtime.queued ? ` (+${runtime.queued})` : ''}
      </Badge>
    );
  if (runtime.state === 'collecting')
    return (
      <Badge tone="info" title="Wartet, ob noch weitere Nachrichten kommen">
        <Dot tone="info" pulse /> Sammelt
      </Badge>
    );
  if (runtime.lastError && (!runtime.lastReplyAt || runtime.lastError.at > runtime.lastReplyAt))
    return (
      <Badge tone="danger" title={runtime.lastError.message}>
        <Dot tone="danger" /> Fehler
      </Badge>
    );
  return (
    <Badge tone="neutral">
      <Dot tone="neutral" /> Bereit
    </Badge>
  );
}

// ---------------------------------------------------------------- form controls

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';

const buttonVariant: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-fg border-line-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-fg-2 border-transparent hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white border-transparent hover:opacity-90',
  'danger-ghost': 'bg-transparent text-danger border-transparent hover:bg-danger-soft',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-[13px]',
        buttonVariant[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-3.5" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" title={label} aria-label={label} className={cx('inline-flex size-8 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40', className)} {...rest}>
      {children}
    </button>
  );
}

const fieldBase = 'w-full rounded-lg border border-line-strong bg-surface px-3 text-[13px] text-fg placeholder:text-fg-3 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(fieldBase, 'h-9', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(fieldBase, 'py-2 leading-relaxed', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(fieldBase, 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', checked ? 'bg-accent' : 'bg-surface-3 ring-1 ring-line-strong ring-inset')}
    >
      <span className={cx('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  );
}

export function Field({ label, help, children, aside }: { label: ReactNode; help?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-fg">{label}</span>
        {aside}
      </div>
      {children}
      {help && <p className="mt-1 text-xs text-fg-3">{help}</p>}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto [scrollbar-width:none] border-b border-line px-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
            value === t.id ? 'border-accent text-fg' : 'border-transparent text-fg-3 hover:text-fg-2',
          )}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="rounded bg-surface-3 px-1.5 text-[11px] text-fg-2">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx('rounded-md px-2.5 py-1 text-xs font-medium transition-colors', value === o.value ? 'bg-surface text-fg shadow-card' : 'text-fg-3 hover:text-fg-2')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- overlays

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={cx('animate-slide-in flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-xl sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="font-semibold">{title}</h2>
          <IconButton label="Schließen" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Promise-free confirm dialog driven by state. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Bestätigen',
  danger,
  loading,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-fg-2">{children}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- toasts

type ToastItem = { id: number; tone: 'ok' | 'danger' | 'info'; text: string };
let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
let toastSeq = 0;

export function toast(text: string, tone: ToastItem['tone'] = 'ok') {
  const id = ++toastSeq;
  toasts = [...toasts, { id, tone, text }];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    toastListeners.forEach((l) => l());
  }, tone === 'danger' ? 7000 : 3500);
}
export const toastError = (err: unknown) => toast(err instanceof Error ? err.message : String(err), 'danger');

export function Toaster() {
  const items = useSyncExternalStore(
    (fn) => {
      toastListeners.add(fn);
      return () => toastListeners.delete(fn);
    },
    () => toasts,
  );
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 left-4 z-[60] flex flex-col items-end gap-2 sm:left-auto">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cx(
            'animate-slide-in pointer-events-auto max-w-sm rounded-lg border px-3.5 py-2.5 text-[13px] shadow-lg',
            t.tone === 'danger' ? 'border-danger/30 bg-danger-soft text-danger' : t.tone === 'info' ? 'border-line bg-surface text-fg' : 'border-ok/30 bg-ok-soft text-ok',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- data display

export function Stat({ label, value, hint, icon, tone }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-fg-3">
        {label}
        {icon && <span className={cx('rounded-md p-1', tone ? toneClass[tone] : 'bg-surface-2 text-fg-3')}>{icon}</span>}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight text-fg tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-fg-3">{hint}</div>}
    </div>
  );
}

/** Stacked bar chart for daily series. */
export function BarChart({
  data,
  series,
  height = 140,
  days,
}: {
  data: readonly object[];
  series: { key: string; label: string; color: string }[];
  height?: number;
  days: number;
}) {
  // Fill gaps so every day of the window has a bar.
  const byDay = new Map((data as Record<string, number | string>[]).map((d) => [String(d.day), d]));
  const filled: Record<string, number | string>[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    filled.push(byDay.get(key) ?? { day: key });
  }
  const totals = filled.map((d) => series.reduce((a, s) => a + (Number(d[s.key]) || 0), 0));
  const max = Math.max(1, ...totals);
  const [hover, setHover] = useState<number | null>(null);
  const h = hover !== null ? filled[hover] : null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-3">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
            {h && <strong className="font-semibold text-fg tabular-nums">{fmtNum(Number(h[s.key]) || 0)}</strong>}
          </span>
        ))}
        <span className="ml-auto tabular-nums">{h ? fmtDay(String(h.day)) : `Letzte ${days} Tage`}</span>
      </div>
      <div className="flex items-end gap-[3px]" style={{ height }} onMouseLeave={() => setHover(null)}>
        {filled.map((d, i) => (
          <div key={String(d.day)} className="group relative flex h-full flex-1 cursor-default flex-col justify-end" onMouseEnter={() => setHover(i)}>
            <div className={cx('flex flex-col-reverse overflow-hidden rounded-t-[3px] transition-opacity', hover !== null && hover !== i && 'opacity-50')} style={{ height: `${(totals[i] / max) * 100}%`, minHeight: totals[i] ? 2 : 0 }}>
              {series.map((s) => (
                <div key={s.key} style={{ background: s.color, flexGrow: Number(d[s.key]) || 0 }} />
              ))}
            </div>
            {!totals[i] && <div className="h-px bg-line" />}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-fg-3 tabular-nums">
        <span>{fmtDay(String(filled[0].day))}</span>
        <span>Heute</span>
      </div>
    </div>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-fg-3">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v ?? <span className="text-fg-3">–</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || '?';
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', className ?? 'size-9 text-[13px]')} style={{ background: `hsl(${hue} 55% 50% / 0.18)`, color: `hsl(${hue} 50% 42%)` }}>
      {initials}
    </span>
  );
}

// ---------------------------------------------------------------- formatting

/** SQLite gives "YYYY-MM-DD HH:MM:SS" in UTC; JS ISO strings work as-is. */
export function parseDate(s: string) {
  return new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
}

const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
export function fmtRelative(s: string | null | undefined, now = Date.now()) {
  if (!s) return '–';
  const diff = (parseDate(s).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'gerade eben';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(s);
}

export function fmtDate(s: string | null | undefined) {
  if (!s) return '–';
  return parseDate(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDateTime(s: string | null | undefined) {
  if (!s) return '–';
  return parseDate(s).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtTime(s: string) {
  return parseDate(s).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(day: string) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

export const fmtNum = (n: number) => n.toLocaleString('de-DE');

export function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio.`;
  if (n >= 10_000) return `${Math.round(n / 1000).toLocaleString('de-DE')} k`;
  return fmtNum(n);
}

export function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} Tage`;
}

/** Re-renders the caller every `ms` so relative times stay fresh. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function RelTime({ value, className }: { value: string | null | undefined; className?: string }) {
  const now = useNow();
  return (
    <time className={className} title={fmtDateTime(value)} dateTime={value ?? undefined}>
      {fmtRelative(value, now)}
    </time>
  );
}

/** Renders WhatsApp-style *bold* / _italic_ and keeps line breaks. */
export function WaText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <span className="wa-text break-words whitespace-pre-wrap">
      {parts.map((p, i) =>
        /^\*[^*]+\*$/.test(p) ? <strong key={i}>{p.slice(1, -1)}</strong> : /^_[^_]+_$/.test(p) ? <em key={i}>{p.slice(1, -1)}</em> : <span key={i}>{p}</span>,
      )}
    </span>
  );
}
