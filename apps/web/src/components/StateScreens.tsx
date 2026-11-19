import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { OfflineGator, SleepingGator } from './Gator.tsx';
import { RetryIcon } from './Icons.tsx';
import { Button, ButtonLink } from './ui.tsx';

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'UNKNOWN';
}

/** "Stuck in traffic" — feed failed to load. */
export function ErrorState({
  error,
  onRetry,
  title = 'Stuck in traffic',
  message,
  showArchive = true,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  message?: ReactNode;
  showArchive?: boolean;
}) {
  const online = useOnline();
  const text =
    message ??
    (online
      ? 'We couldn’t load today’s headlines. Check your connection, then try again.'
      : 'You appear to be offline. Reconnect, then try again.');
  return (
    <section className="flex flex-col items-center pt-6 text-center" role="alert" aria-labelledby="error-title">
      <OfflineGator className="w-64 max-w-full" />
      <h1 id="error-title" className="font-display text-sun mt-4 text-5xl leading-tight sm:text-6xl">
        {title}
      </h1>
      <p className="text-cream/90 mt-4 max-w-md text-lg">{text}</p>
      <p className="text-dim mt-3 font-mono text-sm">Error {errorCode(error)}</p>
      <div className="mt-8 flex w-full flex-col gap-4">
        {onRetry && (
          <Button onClick={onRetry}>
            <RetryIcon /> Try again
          </Button>
        )}
        {showArchive && (
          <ButtonLink to="/archive" variant="secondary">
            Browse past rounds
          </ButtonLink>
        )}
      </div>
    </section>
  );
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col items-center pt-4 text-center" aria-labelledby="empty-title">
      <SleepingGator className="w-64 max-w-full" />
      <h2 id="empty-title" className="font-display mt-4 text-4xl leading-tight sm:text-5xl">
        {title}
      </h2>
      <div className="text-muted mt-4 max-w-md text-lg">{children}</div>
      {action && <div className="mt-8 w-full">{action}</div>}
    </section>
  );
}

export function LoadingBlock({ label = 'Loading…', lines = 3 }: { label?: string; lines?: number }) {
  return (
    <div role="status" aria-live="polite" className="card animate-pulse p-7">
      <span className="sr-only">{label}</span>
      <div className="bg-line/70 h-4 w-1/3 rounded-full" />
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="bg-line/60 mt-5 h-7 rounded-full" style={{ width: `${90 - i * 18}%` }} />
      ))}
    </div>
  );
}
