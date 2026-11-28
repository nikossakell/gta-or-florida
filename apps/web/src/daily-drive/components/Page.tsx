import { Link } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client.ts';
import { ArcadeButton } from './ArcadeButton.tsx';
import { Gus } from './Gus.tsx';
import { CalendarIcon, HomeIcon } from './Shape.tsx';

/** Frame for the screens around the game (archive, about, loading / error / empty): HUD header + column. */
export function Page({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="wrap">
      <header className="hud">
        <Link to="/" className="iconbtn" aria-label="Home" title="Home">
          <HomeIcon />
        </Link>
        <div className="hud-mid">
          <div className="t1">{label}</div>
          <div className="t2">GTA or Florida?</div>
        </div>
        <Link to="/archive" className="iconbtn" aria-label="Past rounds" title="Past rounds">
          <CalendarIcon />
        </Link>
      </header>
      {children}
    </div>
  );
}

/** Link to the archive, styled as a secondary button. */
export function PastRoundsLink() {
  return (
    <Link to="/archive" className="btn2">
      Browse past rounds
    </Link>
  );
}

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

/** "Stuck in traffic": a request failed. */
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
    <section className="panel state err" role="alert" aria-labelledby="error-title">
      <Gus state="wrong" size="lg" decorative />
      <h1 id="error-title">{title}</h1>
      <p>{text}</p>
      <p className="code">Error {errorCode(error)}</p>
      <div className="acts">
        {onRetry && <ArcadeButton variant="primary" onClick={onRetry} big="TRY AGAIN" />}
        {showArchive && <PastRoundsLink />}
      </div>
    </section>
  );
}

/** Nothing to show (round not ready, withdrawn, no result yet…). */
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="panel state" aria-labelledby="empty-title">
      <Gus state="low" size="lg" decorative />
      <h2 id="empty-title">{title}</h2>
      <p>{children}</p>
      {action && <div className="acts">{action}</div>}
    </section>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="panel loading">
      <span className="sr">{label}</span>
    </div>
  );
}
