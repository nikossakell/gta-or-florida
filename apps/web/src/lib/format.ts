const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const LONG = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const PUB = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function at(date: string): Date {
  return new Date(date.length === 10 ? `${date}T00:00:00Z` : date);
}

/** "Thu 19 Nov" */
export function shortDay(date: string): string {
  return DAY.format(at(date)).replace(',', '');
}

/** "Thursday 19 November 2026" */
export function longDay(date: string): string {
  return LONG.format(at(date)).replace(',', '');
}

/** "19 Nov 2026" */
export function publishedDay(date: string): string {
  const d = at(date);
  return Number.isNaN(d.getTime()) ? date : PUB.format(d);
}

/** "22h 30m" / "4m" */
export function countdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

export function numberWord(n: number): string {
  return WORDS[n] ?? String(n);
}
