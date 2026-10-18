import { Bot, LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Input } from '../components/ui';

export function Login({ botName, onLoggedIn }: { botName: string; onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    try {
      await api('/auth/login', { body: { password } });
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7 shadow-card">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-accent text-on-accent">
            <Bot className="size-6" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">{botName}</h1>
            <p className="text-[13px] text-fg-3">Admin-Oberfläche</p>
          </div>
        </div>
        <label className="mb-1.5 block text-[13px] font-medium" htmlFor="pw">
          Passwort
        </label>
        <Input id="pw" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && (
          <div className="mt-3">
            <ErrorBox error={error} />
          </div>
        )}
        <Button type="submit" variant="primary" className="mt-4 w-full" loading={loading} disabled={!password} icon={<LogIn className="size-4" />}>
          Anmelden
        </Button>
        <p className="mt-5 text-center text-xs leading-relaxed text-fg-3">
          Beim ersten Start steht ein zufälliges Passwort im Container-Log. Alternativ per <code className="rounded bg-surface-2 px-1">WEB_PASSWORD</code> festlegen.
        </p>
      </form>
    </div>
  );
}
