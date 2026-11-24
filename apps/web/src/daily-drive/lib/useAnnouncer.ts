import { useCallback, useEffect, useRef, useState } from 'react';

/** Polite live-region text; clearing first makes a repeated message announce again. */
export function useAnnouncer(): { message: string; announce: (text: string) => void } {
  const [message, setMessage] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const announce = useCallback((text: string) => {
    setMessage('');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(text), 30);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { message, announce };
}
