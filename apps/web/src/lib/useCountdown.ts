import { msUntilNextUtcDay } from '@gof/core';
import { useEffect, useState } from 'react';
import { countdown } from './format.ts';

/** Time until the next UTC round, refreshed every 30 s ("22h 30m"). */
export function useCountdown(): string {
  const [ms, setMs] = useState(() => msUntilNextUtcDay());
  useEffect(() => {
    const id = window.setInterval(() => setMs(msUntilNextUtcDay()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return countdown(ms);
}
