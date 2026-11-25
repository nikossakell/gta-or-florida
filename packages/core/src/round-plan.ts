/**
 * Pure planner for the daily schedule: `size` (5) questions per day from the verified question bank.
 * Randomness is injected; the Worker uses crypto.getRandomValues and persists each day once, so every
 * visitor sees the same questions in the same order.
 *
 * Category draw: each slot independently picks Florida or GTA with probability 1/2, so every split from
 * 0 Florida / 5 GTA to 5 Florida / 0 GTA can occur and the order is random. When the inventory on a date
 * cannot satisfy a draw, the draw is resampled. This is done exactly and in O(1): the split is sampled
 * from the same binomial distribution restricted to the feasible splits, and the slots get random
 * positions. That equals "redraw until feasible", but with no unbounded loop.
 *
 * Hard constraints (never broken; the plan fails instead):
 *  - exactly `size` questions per day, only from the questions passed in (the caller passes eligible ones);
 *  - no duplicate question id or event id within a day;
 *  - an event is not used within `cooldownDays` of another use of the same event, before OR after,
 *    including days that are already persisted (`history`).
 * Preferences, in order: questions used less often first, then no two near-identical headlines in a day,
 * then diversity (category, publisher, game, difficulty), then random.
 *
 * If some date cannot be filled at all, the whole period is re-planned with fresh randomness (bounded),
 * because earlier random choices can block later dates. If that also fails, the result carries the
 * furthest valid prefix and a diagnostic naming the date, the inventory and the cooldown that block it.
 */
import { addDays } from './dates.ts';
import { contentTokens } from './dedupe.ts';
import { seededShuffle } from './rng.ts';

export type Side = 'FLORIDA' | 'GTA';
export type Rng = () => number;

/** Uniform [0,1) from the Web Crypto API (available in Workers and Node ≥ 19). */
export const cryptoRng: Rng = () => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
};

export type BankQuestion = {
  id: string;
  /** Questions describing the same underlying event share it (defaults to the incident). */
  eventId: string;
  answer: Side;
  category: string;
  difficulty: number;
  publisher: string | null;
  game: string | null;
  /** Play title, for the near-duplicate check between questions of the same day. */
  title?: string;
};

/** One question already placed on a persisted day (any status). */
export type ScheduledUse = { date: string; questionId: string; eventId: string };

export type PlannedDay = { date: string; questions: BankQuestion[]; floridaCount: number; resampled: boolean };

export type PlanFailure = {
  /** First date that could not be filled (in the attempt that got furthest). */
  date: string;
  /** Requested dates that were filled before it in that attempt. */
  plannedDays: number;
  requestedDays: number;
  /** Distinct events usable on that date (outside the cooldown and unused that day). */
  floridaAvailable: number;
  gtaAvailable: number;
  /** Distinct events in the eligible bank. */
  floridaEvents: number;
  gtaEvents: number;
  size: number;
  cooldownDays: number;
  /** Whether the date fails even without this run's earlier choices (only more inventory or a shorter cooldown helps). */
  blockedByExistingSchedule: boolean;
  message: string;
};

export type PlanResult =
  | { ok: true; days: PlannedDay[]; restarts: number }
  | { ok: false; failure: PlanFailure; partial: PlannedDay[]; restarts: number };

export type PlanInput = {
  questions: readonly BankQuestion[];
  /** Persisted rounds: cooldown (both directions) and usage counts. */
  history: readonly ScheduledUse[];
  /** All-time number of rounds each question appeared in. Defaults to counting `history`. */
  usageCounts?: ReadonlyMap<string, number>;
  /** New dates to fill, ascending. Must not already be in `history`. */
  dates: readonly string[];
  size?: number;
  cooldownDays: number;
  rng: Rng;
  /** Whole-period re-plans after a date cannot be filled (default 6). */
  maxRestarts?: number;
};

/** Two headlines sharing at least this share of content words (Jaccard) are not put in the same day when avoidable. */
export const SIMILAR_TITLE_THRESHOLD = 0.5;
/** Candidates considered per slot (least used first, random within a usage tier). */
const WINDOW = 24;

const BINOMIAL_5 = [1, 5, 10, 10, 5, 1];
function binomial(n: number, k: number): number {
  if (n === 5) return BINOMIAL_5[k]!;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Slot categories for one day: independent 50/50 per slot; if that split is not feasible, an exact
 * sample of the same distribution conditioned on feasibility. `feasible(f)` says whether f Florida slots
 * can be filled. Returns null when no split is feasible.
 */
export function drawSlots(size: number, rng: Rng, feasible: (florida: number) => boolean): { slots: Side[]; resampled: boolean } | null {
  const slots: Side[] = Array.from({ length: size }, () => (rng() < 0.5 ? 'FLORIDA' : 'GTA'));
  const f = slots.filter((s) => s === 'FLORIDA').length;
  if (feasible(f)) return { slots, resampled: false };
  const options: number[] = [];
  for (let k = 0; k <= size; k++) if (feasible(k)) options.push(k);
  if (!options.length) return null;
  const total = options.reduce((t, k) => t + binomial(size, k), 0);
  let x = rng() * total;
  let florida = options[options.length - 1]!;
  for (const k of options) {
    x -= binomial(size, k);
    if (x < 0) {
      florida = k;
      break;
    }
  }
  const positions = seededShuffle(
    Array.from({ length: size }, (_, i) => i),
    rng,
  ).slice(0, florida);
  const out: Side[] = Array.from({ length: size }, () => 'GTA');
  for (const p of positions) out[p] = 'FLORIDA';
  return { slots: out, resampled: true };
}

export function planSchedule(input: PlanInput): PlanResult {
  const size = input.size ?? 5;
  const cooldown = Math.max(0, Math.floor(input.cooldownDays));
  const { rng } = input;
  const maxRestarts = input.maxRestarts ?? 6;

  // ---- static data, indexed once (the hot loops below use arrays, not maps) ----
  const qs = input.questions;
  const qIndex = new Map(qs.map((q, i) => [q.id, i]));
  const eventIndex = new Map<string, number>();
  const eventQs: number[][] = [];
  const eventSide: Side[] = [];
  qs.forEach((q, i) => {
    let e = eventIndex.get(q.eventId);
    if (e === undefined) {
      eventIndex.set(q.eventId, (e = eventQs.length));
      eventQs.push([]);
      eventSide.push(q.answer);
    }
    eventQs[e]!.push(i);
  });
  const E = eventQs.length;
  const floridaEvents = eventSide.filter((x) => x === 'FLORIDA').length;
  const gtaEvents = E - floridaEvents;
  // Near-duplicate headlines: overlap of stemmed content words (core/dedupe.ts contentTokens), computed lazily once.
  const tokens: (Set<string> | null | undefined)[] = new Array(qs.length);
  const tokensOf = (i: number) => (tokens[i] === undefined ? (tokens[i] = qs[i]!.title ? new Set(contentTokens(qs[i]!.title!)) : null) : tokens[i]!);
  const similar = (a: number, b: number) => {
    const ta = tokensOf(a);
    const tb = tokensOf(b);
    if (!ta || !tb || !ta.size || !tb.size) return false;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    return inter / (ta.size + tb.size - inter) >= SIMILAR_TITLE_THRESHOLD;
  };

  // Dates as integer day numbers (parsed once).
  const dayNum = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  /** Persisted uses per event (any status, before or after the period). */
  const baseUses: number[][] = Array.from({ length: E }, () => []);
  for (const u of input.history) {
    const e = eventIndex.get(u.eventId);
    if (e !== undefined) baseUses[e]!.push(dayNum(u.date));
  }
  const baseCounts = new Int32Array(qs.length);
  if (input.usageCounts) for (const [id, n] of input.usageCounts) {
    const i = qIndex.get(id);
    if (i !== undefined) baseCounts[i] = n;
  }
  else for (const u of input.history) {
    const i = qIndex.get(u.questionId);
    if (i !== undefined) baseCounts[i]!++;
  }
  const NEVER = -1e9;

  type State = { last: Float64Array; counts: Int32Array };
  const freshState = (): State => ({ last: new Float64Array(E).fill(NEVER), counts: baseCounts.slice() });

  /** Event e may be used on `day`: no persisted use and no planned use within the cooldown (planned uses only move forward). */
  const usable = (st: State, e: number, day: number) => {
    if (cooldown <= 0) return true;
    if (day - st.last[e]! < cooldown) return false;
    for (const d of baseUses[e]!) if (Math.abs(d - day) < cooldown) return false;
    return true;
  };

  /** Usable events per side on a day, each represented by its least-used question (ties random). */
  function available(st: State, day: number): Record<Side, number[]> {
    const out: Record<Side, number[]> = { FLORIDA: [], GTA: [] };
    for (let e = 0; e < E; e++) {
      if (!usable(st, e, day)) continue;
      const list = eventQs[e]!;
      let best = list[0]!;
      if (list.length > 1) {
        let ties = 1;
        for (let k = 1; k < list.length; k++) {
          const i = list[k]!;
          if (st.counts[i]! < st.counts[best]!) {
            best = i;
            ties = 1;
          } else if (st.counts[i] === st.counts[best] && rng() * ++ties < 1) best = i; // reservoir tie-break
        }
      }
      out[eventSide[e]!].push(best);
    }
    return out;
  }

  const penalty = (i: number, day: readonly number[]) => {
    const q = qs[i]!;
    let p = 0;
    for (const j of day) {
      const c = qs[j]!;
      if (c.category === q.category) p += 2;
      if (q.publisher && c.publisher === q.publisher) p += 3;
      if (q.game && c.game === q.game) p += 2;
      if (c.difficulty === q.difficulty) p += 1;
    }
    return p;
  };

  /**
   * Least-used first: the lowest usage tier(s), randomly sampled down to WINDOW candidates (bounds CPU),
   * then greedy diversity. A near-duplicate headline is swapped for an equally used alternative.
   */
  function pick(candidates: number[], count: number, day: number[], counts: Int32Array): void {
    let minUse = Infinity;
    for (const i of candidates) if (counts[i]! < minUse) minUse = counts[i]!;
    const win: number[] = [];
    for (let tier = minUse; win.length < WINDOW && win.length < candidates.length; tier++) {
      const t = candidates.filter((i) => counts[i] === tier);
      const take = Math.min(t.length, WINDOW - win.length);
      for (let k = 0; k < take; k++) {
        const j = k + Math.floor(rng() * (t.length - k));
        [t[k], t[j]] = [t[j]!, t[k]!];
        win.push(t[k]!);
      }
      if (tier > minUse + 1000) break;
    }
    for (let n = 0; n < count && win.length; n++) {
      let bestIdx = 0;
      let bestUse = Infinity;
      let bestPen = Infinity;
      for (let k = 0; k < win.length; k++) {
        const i = win[k]!;
        const use = counts[i]!;
        if (use > bestUse) continue;
        const pen = penalty(i, day);
        if (use < bestUse || pen < bestPen) {
          bestUse = use;
          bestPen = pen;
          bestIdx = k;
        }
      }
      let chosen = win.splice(bestIdx, 1)[0]!;
      if (day.some((d) => similar(chosen, d))) {
        const alt = win.findIndex((i) => counts[i] === bestUse && !day.some((d) => similar(i, d)));
        if (alt >= 0) chosen = win.splice(alt, 1, chosen)[0]!;
      }
      day.push(chosen);
    }
  }

  type Attempt = { days: PlannedDay[]; fail: { date: string; f: number; g: number } | null };
  function attempt(): Attempt {
    const st = freshState();
    const days: PlannedDay[] = [];
    for (const date of input.dates) {
      const dn = dayNum(date);
      const avail = available(st, dn);
      const draw = drawSlots(size, rng, (f) => f <= avail.FLORIDA.length && size - f <= avail.GTA.length);
      if (!draw) return { days, fail: { date, f: avail.FLORIDA.length, g: avail.GTA.length } };
      const floridaCount = draw.slots.filter((x) => x === 'FLORIDA').length;
      const picked: number[] = [];
      pick(avail.FLORIDA, floridaCount, picked, st.counts);
      const florida = picked.slice();
      pick(avail.GTA, size - floridaCount, picked, st.counts);
      const queues: Record<Side, number[]> = { FLORIDA: seededShuffle(florida, rng), GTA: seededShuffle(picked.slice(florida.length), rng) };
      // Slots keep their drawn categories; the picks fill them in random order.
      const order = draw.slots.map((x) => queues[x].shift()!);
      for (const i of order) {
        st.last[eventIndex.get(qs[i]!.eventId)!] = dn;
        st.counts[i]!++;
      }
      days.push({ date, questions: order.map((i) => qs[i]!), floridaCount, resampled: draw.resampled });
    }
    return { days, fail: null };
  }

  const baseOnly = (date: string) => {
    const a = available(freshState(), dayNum(date));
    return a.FLORIDA.length + a.GTA.length;
  };

  let best: Attempt | null = null;
  let restarts = 0;
  for (; restarts <= maxRestarts; restarts++) {
    const a = attempt();
    if (!a.fail) return { ok: true, days: a.days, restarts };
    if (!best || a.days.length > best.days.length) best = a;
    // Re-planning only helps if this run's own earlier choices caused the gap.
    if (baseOnly(a.fail.date) < size) {
      best = a;
      break;
    }
  }
  const fail = best!.fail!;
  const failure: PlanFailure = {
    date: fail.date,
    plannedDays: best!.days.length,
    requestedDays: input.dates.length,
    floridaAvailable: fail.f,
    gtaAvailable: fail.g,
    floridaEvents,
    gtaEvents,
    size,
    cooldownDays: cooldown,
    blockedByExistingSchedule: baseOnly(fail.date) < size,
    message: describeFailure({ date: fail.date, f: fail.f, g: fail.g, floridaEvents, gtaEvents, size, cooldown, planned: best!.days.length, requested: input.dates.length }),
  };
  return { ok: false, failure, partial: best!.days, restarts: Math.min(restarts, maxRestarts) };
}

function describeFailure(x: { date: string; f: number; g: number; floridaEvents: number; gtaEvents: number; size: number; cooldown: number; planned: number; requested: number }): string {
  const rotation = x.size * Math.max(1, x.cooldown);
  return [
    `Cannot fill ${x.date}: only ${x.f + x.g} event(s) are usable that day (${x.f} Florida, ${x.g} GTA; ${x.size} needed) under the ${x.cooldown}-day event cooldown.`,
    `The eligible bank has ${x.floridaEvents} Florida and ${x.gtaEvents} GTA event(s); a ${x.cooldown}-day cooldown needs about ${rotation} distinct events (${x.size} per day) to run indefinitely.`,
    `${x.planned} of ${x.requested} requested day(s) could be planned.`,
    'Fix: approve more questions about different events, schedule fewer days, or use a shorter cooldown.',
  ].join(' ');
}

/** Consecutive dates from `start`: helper for callers building `dates`. */
export function dateRange(start: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}

/** "FGGFG": the answer pattern of a day (diagnostics and tests). */
export const answerPattern = (qs: readonly { answer: Side }[]) => qs.map((q) => (q.answer === 'FLORIDA' ? 'F' : 'G')).join('');
