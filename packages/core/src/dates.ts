const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The UTC calendar date for an instant. */
export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function toEpochDay(date: string): number {
  if (!isIsoDate(date)) throw new Error(`Invalid ISO date: ${date}`);
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

export function addDays(date: string, days: number): string {
  return new Date((toEpochDay(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return toEpochDay(b) - toEpochDay(a);
}

/** Milliseconds until the next UTC midnight. */
export function msUntilNextUtcDay(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}
