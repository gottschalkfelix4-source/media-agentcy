import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, queryClient, setUnauthorizedHandler } from './api';
import { Layout } from './components/Layout';
import { Loading, Toaster } from './components/ui';
import { useLiveUpdates } from './live';
import { ActivityPage } from './pages/Activity';
import { ConsolePage } from './pages/Console';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { LogsPage } from './pages/Logs';
import { RequestsPage } from './pages/Requests';
import { SettingsPage } from './pages/Settings';
import { TicketsPage } from './pages/Tickets';
import { UserDetailPage } from './pages/UserDetail';
import { UserImportPage } from './pages/UserImport';
import { UsersPage } from './pages/Users';
import { WhatsAppPage } from './pages/WhatsApp';
import { match, useLocation } from './router';

interface Me {
  authenticated: boolean;
  passwordFromEnv: boolean;
  botName: string;
}

function Routes() {
  const { path } = useLocation();
  let m: Record<string, string> | null;
  if (path === '/' || path === '') return <Dashboard />;
  if (path === '/users') return <UsersPage />;
  if (path === '/users/import') return <UserImportPage />;
  if ((m = match('/users/:id', path))) return <UserDetailPage id={Number(m.id)} />;
  if (path === '/tickets') return <TicketsPage />;
  if (path === '/requests') return <RequestsPage />;
  if (path === '/console') return <ConsolePage />;
  if (path === '/whatsapp') return <WhatsAppPage />;
  if (path === '/activity') return <ActivityPage />;
  if (path === '/logs') return <LogsPage />;
  if (path === '/settings') return <SettingsPage />;
  return (
    <div className="py-20 text-center text-fg-3">
      <p className="text-lg font-medium text-fg-2">Seite nicht gefunden</p>
      <p className="mt-1">{path}</p>
    </div>
  );
}

export function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), staleTime: Infinity });
  const authed = !!me.data?.authenticated;
  const [, force] = useState(0);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.setQueryData<Me>(['me'], (old) => (old ? { ...old, authenticated: false } : old));
      force((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    if (me.data?.botName) document.title = `${me.data.botName} · Admin`;
  }, [me.data?.botName]);

  const live = useLiveUpdates(authed);

  if (me.isPending) return <Loading />;
  return (
    <>
      {authed ? (
        <Layout botName={me.data!.botName} live={live}>
          <Routes />
        </Layout>
      ) : (
        <Login botName={me.data?.botName ?? 'Media Agentcy'} onLoggedIn={() => void me.refetch()} />
      )}
      <Toaster />
    </>
  );
}
