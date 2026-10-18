import { useEffect, useState } from 'react';
import { queryClient } from './api';

type ServerEvent =
  | { type: 'message'; userId: number }
  | { type: 'user'; userId: number }
  | { type: 'ticket'; ticketId: number; userId?: number }
  | { type: 'request'; userId: number }
  | { type: 'activity'; userId?: number | null }
  | { type: 'runtime'; userId: number }
  | { type: 'whatsapp'; state: string }
  | { type: 'settings' }
  | { type: 'log' };

/** Which cached queries an event makes stale. */
function keysFor(e: ServerEvent): unknown[][] {
  switch (e.type) {
    case 'message':
      return [['messages', e.userId], ['users'], ['user', e.userId], ['overview'], ['console']];
    case 'user':
      return [['users'], ['user', e.userId], ['overview']];
    case 'ticket':
      return [['tickets'], ['ticket', e.ticketId], ['overview'], ...(e.userId ? [['user', e.userId]] : [['user']])];
    case 'request':
      return [['requests'], ['user', e.userId], ['overview']];
    case 'activity':
      return [['activity'], ['overview']];
    case 'runtime':
      return [['users'], ['user', e.userId], ['overview'], ['console']];
    case 'whatsapp':
      return [['whatsapp'], ['overview']];
    case 'settings':
      return [['settings'], ['overview'], ['services']];
    case 'log':
      return [['logs']];
  }
}

/** Connects to the server's event stream and refreshes affected data. Returns the connection state. */
export function useLiveUpdates(enabled: boolean) {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let pending = new Map<string, unknown[]>();
    let timer: number | undefined;
    const flush = () => {
      const batch = pending;
      pending = new Map();
      timer = undefined;
      for (const key of batch.values()) void queryClient.invalidateQueries({ queryKey: key });
    };

    const es = new EventSource('/api/events');
    es.addEventListener('hello', () => setConnected(true));
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as ServerEvent;
        for (const key of keysFor(e)) pending.set(JSON.stringify(key), key);
        timer ??= window.setTimeout(flush, 250);
      } catch {
        // ignore malformed events
      }
    };
    es.onerror = () => setConnected(false);
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
      setConnected(false);
    };
  }, [enabled]);

  return connected;
}
