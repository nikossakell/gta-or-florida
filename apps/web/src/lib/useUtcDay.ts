import { msUntilNextUtcDay, utcDate } from '@gof/core';
import { useEffect, useState } from 'react';

/** Current UTC date (YYYY-MM-DD), updated shortly after each UTC midnight while the tab stays open. */
export function useUtcDay(): string {
  const [day, setDay] = useState(() => utcDate());
  useEffect(() => {
    const id = window.setTimeout(() => setDay(utcDate()), msUntilNextUtcDay() + 1000);
    return () => window.clearTimeout(id);
  }, [day]);
  return day;
}
