import { useEffect, useState } from 'react';

const SHOW_MS = 1700;

/**
 * Centre-screen pixel banner ("TURBO STREAK ×3!", "TIME'S UP!"). Shown once per `token` change,
 * removed after 1.7 s. Purely decorative: the message is also announced through the live region.
 */
export function Banner({ text, token, tone }: { text: string; token: number | null; tone?: 'timeup' }) {
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (token === null) return;
    setShown(token);
    const id = window.setTimeout(() => setShown(null), SHOW_MS);
    return () => window.clearTimeout(id);
  }, [token]);
  if (shown === null) return null;
  return (
    <div className={`banner${tone ? ` ${tone}` : ''}`} aria-hidden="true">
      {text}
    </div>
  );
}
