import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api.js';
import { Button } from './ui.jsx';

/**
 * A deployed instance runs real browsers with its owner's API key, so it asks for the access code the
 * owner shared. Once entered, a cookie keeps you in for 12 hours.
 * @param {{ onUnlocked: () => void }} props
 */
export function AccessGate({ onUnlocked }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!code.trim()) return setError('Enter the access code you were given.');
    setBusy(true);
    setError('');
    try {
      await api.unlock(code.trim());
      onUnlocked();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center bg-bg px-4 py-10">
      <form
        onSubmit={submit}
        className="mx-auto w-full max-w-[420px] rounded-2xl border border-line bg-panel p-6 shadow-pop sm:p-8"
      >
        <span className="grid size-10 place-items-center rounded-xl bg-user/10 text-user">
          <KeyRound size={18} aria-hidden />
        </span>
        <h1 className="mt-4 text-[22px] font-semibold tracking-tight">AI E2E Agent</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
          This instance starts real browsers and AI runs on its owner’s account. Enter the access
          code you were given to use it.
        </p>
        <label htmlFor="code" className="mt-6 block text-[13px] font-medium">
          Access code
        </label>
        <input
          id="code"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? 'code-error' : undefined}
          className="mt-1.5 h-11 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[15px] outline-none hover:border-line-strong focus:border-user"
        />
        {error && (
          <p id="code-error" role="alert" className="mt-2 text-[13px] text-bad">
            {error}
          </p>
        )}
        <Button type="submit" variant="accent" busy={busy} className="mt-5 h-11 w-full">
          Unlock
        </Button>
        <p className="mt-4 text-[12px] text-faint">
          No code? The project is at{' '}
          <a
            className="text-user hover:underline"
            href="https://github.com/Roh4n-1729/AI-E2E-Testing-Agent"
            target="_blank"
            rel="noreferrer"
          >
            github.com/Roh4n-1729/AI-E2E-Testing-Agent
          </a>
          .
        </p>
      </form>
    </main>
  );
}
