/**
 * Pure planner for one 5-question daily round (ported from the legacy SQLite
 * scheduler). Randomness is injected; the Worker uses crypto.getRandomValues and
 * persists the result once, so every visitor sees the same order.
 *
 *  - Alternates 3 Florida + 2 GTA / 2 Florida + 3 GTA with the previous day.
 *  - With no previous day, spends the better-stocked side first (tie: random).
 *  - Greedy diversity (category, publisher, game, difficulty), then a shuffle
 *    that avoids repeating yesterday's answer pattern.
 *  - On shortage returns ok:false. Nothing is invented or reused.
 */
import { seededShuffle } from './rng.ts';

export type Side = 'FLORIDA' | 'GTA';

export type PoolQuestion = {
  id: string;
  answer: Side;
  category: string;
  difficulty: number;
  publisher: string | null;
  game: string | null;
};

export type Rng = () => number;

/** Uniform [0,1) from the Web Crypto API (available in Workers and Node ≥ 19). */
export const cryptoRng: Rng = () => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
};

function penalty(q: PoolQuestion, chosen: readonly PoolQuestion[]): number {
  let p = 0;
  for (const c of chosen) {
    if (c.category === q.category) p += 2;
    if (q.publisher && c.publisher === q.publisher) p += 3;
    if (q.game && c.game === q.game) p += 2;
    if (c.difficulty === q.difficulty) p += 1;
  }
  return p;
}

function pickDiverse(pool: readonly PoolQuestion[], count: number, chosen: readonly PoolQuestion[]): PoolQuestion[] | null {
  const remaining = pool.slice();
  const out: PoolQuestion[] = [];
  while (out.length < count) {
    if (remaining.length === 0) return null;
    let bestIdx = 0;
    let best = Infinity;
    remaining.forEach((q, i) => {
      const p = penalty(q, [...chosen, ...out]);
      if (p < best) {
        best = p;
        bestIdx = i;
      }
    });
    out.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return out;
}

export const answerPattern = (qs: readonly { answer: Side }[]) => qs.map((q) => (q.answer === 'FLORIDA' ? 'F' : 'G')).join('');

export type DayPlan =
  | { ok: true; questions: PoolQuestion[]; floridaCount: number; alternationKept: boolean }
  | { ok: false; floridaAvailable: number; gtaAvailable: number };

export function planDay(input: {
  pool: readonly PoolQuestion[];
  size: number;
  previousFlorida: number | null;
  previousPattern: string | null;
  rng: Rng;
}): DayPlan {
  const { pool, size, rng } = input;
  const low = Math.floor(size / 2);
  const high = Math.ceil(size / 2);
  const florida = seededShuffle(pool.filter((q) => q.answer === 'FLORIDA'), rng);
  const gta = seededShuffle(pool.filter((q) => q.answer === 'GTA'), rng);

  const preferred =
    input.previousFlorida !== null
      ? input.previousFlorida >= high
        ? low
        : high
      : florida.length === gta.length
        ? rng() < 0.5
          ? low
          : high
        : florida.length > gta.length
          ? high
          : low;
  const splits = preferred === low ? [low, high] : [high, low];

  for (const [i, floridaCount] of splits.entries()) {
    const chosen: PoolQuestion[] = [];
    const f = pickDiverse(florida, floridaCount, chosen);
    if (!f) continue;
    chosen.push(...f);
    const g = pickDiverse(gta, size - floridaCount, chosen);
    if (!g) continue;
    chosen.push(...g);

    let ordered = seededShuffle(chosen, rng);
    for (let tries = 0; tries < 10 && input.previousPattern && answerPattern(ordered) === input.previousPattern; tries++) {
      ordered = seededShuffle(chosen, rng);
    }
    return { ok: true, questions: ordered, floridaCount, alternationKept: i === 0 };
  }
  return { ok: false, floridaAvailable: florida.length, gtaAvailable: gta.length };
}

/** Days fillable from unused stock: alternating days consume size/2 of each side on average. */
export function runwayDays(unusedFlorida: number, unusedGta: number, size = 5): number {
  return Math.floor(Math.min(unusedFlorida, unusedGta) / (size / 2));
}
