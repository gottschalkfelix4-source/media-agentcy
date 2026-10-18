import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/** Minimal history-based router – the app has a handful of routes and needs nothing more. */

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  notify();
  window.scrollTo({ top: 0 });
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useLocation() {
  const path = useSyncExternalStore(subscribe, () => location.pathname);
  const search = useSyncExternalStore(subscribe, () => location.search);
  return { path, query: new URLSearchParams(search) };
}

/** Matches "/users/:id" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function setQuery(params: Record<string, string | null>) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === '') q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  history.replaceState(null, '', location.pathname + (s ? `?${s}` : ''));
  notify();
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}
