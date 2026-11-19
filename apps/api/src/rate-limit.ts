/** Fixed-window, in-memory, per-key rate limiter. Good enough for a single small instance. */
export function createRateLimiter({ windowMs, max }: { windowMs: number; max: number }, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const t = now();
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return {
    /** Returns null if allowed, or the number of seconds to wait. */
    check(key: string): number | null {
      const t = now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      return entry.count > max ? Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) : null;
    },
    stop() {
      clearInterval(sweep);
    },
  };
}
