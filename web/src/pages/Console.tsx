import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot, Megaphone, Send } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { api, queryClient, type Message, type Runtime } from '../api';
import { ChatTranscript } from '../components/Chat';
import { Button, ConfirmDialog, EmptyState, ErrorBox, Loading, Modal, PageHeader, Textarea, toast, toastError } from '../components/ui';
import { Link } from '../router';

interface ConsoleData {
  admin: { id: number; label: string };
  runtime: Runtime;
  messages: Message[];
}

const EXAMPLES = ['Welche Tickets sind gerade offen?', 'Wer hat diese Woche am meisten angefragt?', 'Läuft auf dem Jellyfin gerade etwas mit Transcoding?', 'Gibt es Warnungen in Sonarr oder Radarr?'];

function BroadcastModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState(false);
  const send = useMutation({
    mutationFn: () => api<{ recipients: number }>('/broadcast', { body: { text } }),
    onSuccess: (r) => {
      toast(`Wird an ${r.recipients} Nutzer verschickt`);
      setText('');
      setConfirm(false);
      onClose();
    },
    onError: toastError,
  });
  return (
    <>
      <Modal
        open={open && !confirm}
        onClose={onClose}
        title="Rundnachricht an alle Nutzer"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button variant="primary" disabled={!text.trim()} onClick={() => setConfirm(true)} icon={<Megaphone className="size-4" />}>
              Weiter
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[13px] text-fg-2">Geht wortwörtlich an alle aktiven Nutzer (außer Admins), z. B. für Wartungsankündigungen.</p>
        <Textarea rows={6} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Hi! Der Server ist heute ab 22 Uhr kurz wegen Wartung offline …" />
        <p className="mt-1 text-xs text-fg-3">WhatsApp-Formatierung: *fett*, _kursiv_</p>
      </Modal>
      <ConfirmDialog open={confirm} title="Wirklich an alle senden?" confirmLabel="Jetzt senden" loading={send.isPending} onConfirm={() => send.mutate()} onClose={() => setConfirm(false)}>
        <p className="mb-2">Die Nachricht wird an alle aktiven Nutzer geschickt:</p>
        <blockquote className="rounded-lg bg-surface-2 p-3 whitespace-pre-wrap">{text}</blockquote>
      </ConfirmDialog>
    </>
  );
}

export function ConsolePage() {
  const q = useQuery({ queryKey: ['console'], queryFn: () => api<ConsoleData>('/console') });
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [broadcast, setBroadcast] = useState(false);

  const ask = useMutation({
    mutationFn: (t: string) => api<{ reply: string }>('/console', { body: { text: t } }),
    onMutate: (t) => {
      setPending(t);
      setText('');
    },
    onSettled: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ['console'] });
    },
    onError: (err, t) => {
      setText(t);
      toastError(err);
    },
  });

  const submit = (t = text) => {
    if (t.trim() && !ask.isPending) ask.mutate(t.trim());
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const messages: Message[] = [
    ...(q.data?.messages ?? []),
    ...(pending ? [{ id: Number.MAX_SAFE_INTEGER, user_id: 0, role: 'user' as const, content: pending, summarized: 0, via: null, created_at: new Date().toISOString() }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Admin-Agent"
        subtitle={q.data ? `Derselbe Agent wie per WhatsApp an deine Admin-Nummer – mit vollem Zugriff auf Server, Tickets und Nutzer. Läuft als ${q.data.admin.label}.` : 'Frag den Bot mit Admin-Rechten'}
        actions={
          <Button icon={<Megaphone className="size-4" />} onClick={() => setBroadcast(true)}>
            Rundnachricht
          </Button>
        }
      />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <div className="space-y-3">
          <ErrorBox error={q.error} />
          <Link to="/settings?group=general" className="text-[13px] text-accent-text underline">
            Zu den Einstellungen
          </Link>
        </div>
      ) : (
        <div className="flex h-[calc(100vh-13rem)] min-h-[420px] flex-col overflow-hidden rounded-xl border border-line shadow-card">
          <ChatTranscript
            className="flex-1"
            messages={messages}
            incomingLabel="Du"
            typing={ask.isPending ? 'Agent arbeitet …' : undefined}
            empty={
              <EmptyState icon={<Bot className="size-7" />} title="Was möchtest du wissen?">
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {EXAMPLES.map((e) => (
                    <button key={e} type="button" onClick={() => submit(e)} className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-fg-2 hover:border-accent hover:text-fg">
                      {e}
                    </button>
                  ))}
                </div>
              </EmptyState>
            }
          />
          <div className="flex items-end gap-2 border-t border-line bg-surface p-3">
            <Textarea rows={2} className="max-h-40 min-h-11 resize-y" placeholder="Frag den Admin-Agenten … (Enter sendet)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
            <Button variant="primary" className="h-11" loading={ask.isPending} disabled={!text.trim()} onClick={() => submit()} icon={<Send className="size-4" />}>
              <span className="hidden sm:inline">Senden</span>
            </Button>
          </div>
        </div>
      )}
      <BroadcastModal open={broadcast} onClose={() => setBroadcast(false)} />
    </>
  );
}
