import { useMutation, useQuery } from '@tanstack/react-query';
import { LogOut, RefreshCw, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { api, queryClient, type WhatsAppInfo } from '../api';
import { WA_STATE } from '../components/Layout';
import { Button, Card, ConfirmDialog, Dot, ErrorBox, KeyValue, Loading, PageHeader, RelTime, Spinner, toast, toastError } from '../components/ui';

export function WhatsAppPage() {
  const q = useQuery({
    queryKey: ['whatsapp'],
    queryFn: () => api<WhatsAppInfo>('/whatsapp'),
    // the QR code rotates every ~20 s
    refetchInterval: (query) => (query.state.data?.state === 'qr' ? 5_000 : 30_000),
  });
  const [confirmLogout, setConfirmLogout] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['whatsapp'] });

  const logout = useMutation({
    mutationFn: () => api('/whatsapp/logout', { body: {} }),
    onSuccess: () => {
      toast('Abgemeldet – gleich erscheint ein neuer QR-Code');
      setConfirmLogout(false);
      refresh();
    },
    onError: toastError,
  });
  const restart = useMutation({ mutationFn: () => api('/whatsapp/restart', { body: {} }), onSuccess: () => { toast('Verbindung wird neu aufgebaut'); refresh(); }, onError: toastError });

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const w = q.data;
  const s = WA_STATE[w.state] ?? WA_STATE.starting;

  return (
    <>
      <PageHeader
        title="WhatsApp"
        subtitle="Verbindung des Bot-Kontos (verknüpftes Gerät)"
        actions={
          w.state !== 'disabled' && (
            <>
              <Button icon={<RefreshCw className="size-4" />} loading={restart.isPending} onClick={() => restart.mutate()}>
                Neu verbinden
              </Button>
              {w.state === 'open' && (
                <Button variant="danger-ghost" icon={<LogOut className="size-4" />} onClick={() => setConfirmLogout(true)}>
                  Abmelden
                </Button>
              )}
            </>
          )
        }
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Status">
          <div className="mb-4 flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-surface-2">
              <Smartphone className="size-5 text-fg-2" />
            </span>
            <div>
              <p className="flex items-center gap-2 font-semibold">
                <Dot tone={s.tone} pulse={w.state === 'starting'} /> {s.label}
              </p>
              {w.me && <p className="text-[13px] text-fg-3">{w.me.name ?? 'Bot'} · +{w.me.id.split(/[:@]/)[0]}</p>}
            </div>
          </div>
          <KeyValue
            items={[
              ['Verbunden seit', w.connectedSince ? <RelTime value={w.connectedSince} /> : null],
              ['Konto', w.me ? `+${w.me.id.split(/[:@]/)[0]}` : null],
            ]}
          />
          <p className="mt-4 text-xs leading-relaxed text-fg-3">
            Tipp: Nutze für den Bot eine eigene Nummer (z. B. WhatsApp Business auf einer Zweit-SIM). Die Sitzung bleibt im Daten-Volume gespeichert – nach Neustarts musst du nicht neu scannen.
          </p>
        </Card>

        {w.state === 'qr' || w.qr ? (
          <Card title="Mit WhatsApp verknüpfen">
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              {w.qr ? <img src={w.qr} alt="WhatsApp-QR-Code" className="size-56 rounded-lg border border-line bg-white p-2" /> : <Spinner className="size-8" />}
              <ol className="list-decimal space-y-1.5 pl-4 text-[13px] text-fg-2">
                <li>WhatsApp auf dem Bot-Handy öffnen</li>
                <li>
                  <strong>Einstellungen → Verknüpfte Geräte</strong>
                </li>
                <li>„Gerät hinzufügen“ antippen</li>
                <li>Diesen Code scannen – er erneuert sich automatisch</li>
              </ol>
            </div>
          </Card>
        ) : w.state === 'open' ? (
          <Card title="Alles bereit">
            <p className="text-[13px] text-fg-2">Der Bot empfängt Nachrichten. Nutzer schreiben einfach an die Nummer oben.</p>
          </Card>
        ) : (
          <Card title="Verbindung wird aufgebaut">
            <div className="flex items-center gap-2 text-[13px] text-fg-3">
              <Spinner /> Einen Moment – falls das länger dauert, „Neu verbinden“ klicken.
            </div>
          </Card>
        )}
      </div>
      <ConfirmDialog open={confirmLogout} title="WhatsApp abmelden?" confirmLabel="Abmelden" danger loading={logout.isPending} onConfirm={() => logout.mutate()} onClose={() => setConfirmLogout(false)}>
        Der Bot wird als verknüpftes Gerät entfernt und kann keine Nachrichten mehr empfangen, bis du einen neuen QR-Code scannst – z. B. um eine andere Nummer zu verwenden.
      </ConfirmDialog>
    </>
  );
}
