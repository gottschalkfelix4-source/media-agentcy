import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  Inbox,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  Moon,
  ScrollText,
  Settings,
  Smartphone,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, queryClient, type Overview } from '../api';
import { Link, useLocation } from '../router';
import { Dot, IconButton, cx, type Tone } from './ui';

const NAV = [
  { to: '/', label: 'Übersicht', icon: LayoutDashboard },
  { to: '/users', label: 'Nutzer', icon: Users },
  { to: '/tickets', label: 'Tickets', icon: LifeBuoy },
  { to: '/requests', label: 'Anfragen', icon: Inbox },
  { to: '/console', label: 'Admin-Agent', icon: Bot },
  { to: '/whatsapp', label: 'WhatsApp', icon: Smartphone },
  { to: '/activity', label: 'Aktivität', icon: Activity },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/settings', label: 'Einstellungen', icon: Settings },
] as const;

export const WA_STATE: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Verbunden', tone: 'ok' },
  qr: { label: 'QR-Code scannen', tone: 'warn' },
  starting: { label: 'Verbindet …', tone: 'info' },
  closed: { label: 'Getrennt', tone: 'danger' },
  logged_out: { label: 'Abgemeldet', tone: 'danger' },
  disabled: { label: 'Deaktiviert', tone: 'neutral' },
};

type Theme = 'light' | 'dark';
function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {
      // storage unavailable – theme just won't persist
    }
    setTheme(next);
  };
  return (
    <IconButton label={theme === 'dark' ? 'Helles Design' : 'Dunkles Design'} onClick={toggle}>
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </IconButton>
  );
}

export function Layout({ botName, live, children }: { botName: string; live: boolean; children: ReactNode }) {
  const { path } = useLocation();
  const [open, setOpen] = useState(false);
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/overview'), refetchInterval: 60_000 });
  const o = overview.data;

  useEffect(() => setOpen(false), [path]);

  const isActive = (to: string) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));
  const badge = (to: string) => {
    if (!o) return undefined;
    if (to === '/users' && o.users.pending) return { n: o.users.pending, tone: 'warn' as const };
    if (to === '/tickets' && o.tickets.escalated) return { n: o.tickets.escalated, tone: 'danger' as const };
    if (to === '/tickets' && o.tickets.active) return { n: o.tickets.active, tone: 'neutral' as const };
    return undefined;
  };
  const wa = WA_STATE[o?.bot.whatsapp.state ?? 'starting'] ?? WA_STATE.starting;

  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    queryClient.clear();
    location.href = '/';
  };

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3">
      {NAV.map(({ to, label, icon: Icon }) => {
        const b = badge(to);
        return (
          <Link
            key={to}
            to={to}
            className={cx(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors',
              isActive(to) ? 'bg-accent-soft text-accent-text' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="flex-1">{label}</span>
            {b && (
              <span className={cx('rounded-full px-1.5 text-[11px] font-semibold tabular-nums', b.tone === 'danger' ? 'bg-danger text-white' : b.tone === 'warn' ? 'bg-warn text-white' : 'bg-surface-3 text-fg-2')}>
                {b.n}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <Link to="/" className="flex items-center gap-2.5 px-5 py-4">
      <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-on-accent">
        <Bot className="size-4.5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-semibold text-fg">{botName}</span>
        <span className="block text-[11px] text-fg-3">Admin-Oberfläche{o ? ` · v${o.bot.version}` : ''}</span>
      </span>
    </Link>
  );

  return (
    <div className="flex min-h-full">
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        {brand}
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <div className="border-t border-line p-3">
          <button type="button" onClick={logout} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-fg-3 hover:bg-surface-2 hover:text-fg">
            <LogOut className="size-4" /> Abmelden
          </button>
        </div>
      </aside>

      {/* mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="animate-slide-in absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface">
            <div className="flex items-center justify-between pr-3">
              {brand}
              <IconButton label="Menü schließen" onClick={() => setOpen(false)}>
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
            <div className="border-t border-line p-3">
              <button type="button" onClick={logout} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-fg-3 hover:bg-surface-2">
                <LogOut className="size-4" /> Abmelden
              </button>
            </div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/85 px-4 backdrop-blur lg:px-6">
          <IconButton label="Menü" className="lg:hidden" onClick={() => setOpen(true)}>
            <Menu className="size-5" />
          </IconButton>
          <div className="flex-1" />
          <Link to="/whatsapp" className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-fg-2 hover:bg-surface-2" title="WhatsApp-Verbindung">
            <Dot tone={wa.tone} pulse={o?.bot.whatsapp.state === 'starting'} />
            <span className="hidden sm:inline">WhatsApp: </span>
            {wa.label}
          </Link>
          {o && o.busy.length > 0 && (
            <Link to="/users" className="hidden items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-fg-2 hover:bg-surface-2 sm:flex">
              <Dot tone="accent" pulse /> {o.busy.length} aktiv
            </Link>
          )}
          <span className="flex items-center gap-1.5 px-2 text-xs text-fg-3" title={live ? 'Live-Updates verbunden' : 'Live-Updates getrennt – Daten werden regelmäßig neu geladen'}>
            <Dot tone={live ? 'ok' : 'neutral'} />
            <span className="hidden md:inline">{live ? 'Live' : 'Offline'}</span>
          </span>
          <ThemeToggle />
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
