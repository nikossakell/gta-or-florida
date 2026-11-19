import { addDays, daysBetween, isIsoDate } from './dates.ts';
import { createRng, seededShuffle } from './rng.ts';
import type { Answer, Question, QuestionUsage, ScheduleDay, ScheduleFile } from './types.ts';
import { answerBalanceRange } from './validate.ts';

export type BuildScheduleOptions = {
  questions: readonly Question[];
  /** Existing schedule. Its days are never modified or reshuffled. */
  existing?: ScheduleFile | null;
  /** First date to fill (UTC, YYYY-MM-DD). */
  startDate: string;
  /** Number of consecutive days to fill from startDate. */
  days: number;
  size?: number;
  cooldownDays?: number;
  seed?: string;
  /** Include placeholder (sample) content. Off by default. */
  allowPlaceholders?: boolean;
};

export type ScheduleWarning = {
  code: 'shortage' | 'reused_after_cooldown' | 'low_inventory';
  date?: string;
  message: string;
};

export type BuildScheduleResult = {
  schedule: ScheduleFile;
  /** Dates newly added by this run. */
  added: string[];
  /** Dates in the requested range that already existed and were kept untouched. */
  kept: string[];
  /** First date that could not be filled, if any. Scheduling stops there. */
  shortageDate: string | null;
  warnings: ScheduleWarning[];
};

export const DEFAULT_SIZE = 5;
export const DEFAULT_COOLDOWN_DAYS = 180;
export const DEFAULT_SEED = 'gta-or-florida';

type UsageIndex = Map<string, string[]>;

function indexUsage(days: readonly ScheduleDay[], byId: Map<string, Question>) {
  const byQuestion: UsageIndex = new Map();
  const byEvent: UsageIndex = new Map();
  for (const day of days) {
    for (const qid of day.questionIds) {
      byQuestion.set(qid, [...(byQuestion.get(qid) ?? []), day.date]);
      const q = byId.get(qid);
      if (q) byEvent.set(q.canonicalEventId, [...(byEvent.get(q.canonicalEventId) ?? []), day.date]);
    }
  }
  return { byQuestion, byEvent };
}

/** True when no recorded use lies within `cooldown` days of `date` (either side). */
function clearOfCooldown(uses: readonly string[] | undefined, date: string, cooldown: number): boolean {
  if (!uses) return true;
  return uses.every((d) => Math.abs(daysBetween(d, date)) >= Math.max(cooldown, 1));
}

/**
 * Pick `count` questions from `pool` (already shuffled), preferring new
 * categories, then new difficulties, and never two of the same canonical event.
 */
function pickDiverse(pool: readonly Question[], count: number, taken: Question[]): Question[] {
  const picked: Question[] = [];
  const remaining = pool.slice();
  while (picked.length < count && remaining.length > 0) {
    const chosen = [...taken, ...picked];
    const events = new Set(chosen.map((q) => q.canonicalEventId));
    const cats = new Set(chosen.map((q) => q.category));
    const diffs = new Set(chosen.map((q) => q.difficulty));
    const allowed = remaining.filter((q) => !events.has(q.canonicalEventId));
    if (allowed.length === 0) break;
    const next =
      allowed.find((q) => !cats.has(q.category) && !diffs.has(q.difficulty)) ??
      allowed.find((q) => !cats.has(q.category)) ??
      allowed.find((q) => !diffs.has(q.difficulty)) ??
      allowed[0]!;
    picked.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return picked;
}

/** Rebuild per-question scheduler metadata from the full day list. */
export function computeUsage(days: readonly ScheduleDay[], questions: readonly Question[]): Record<string, QuestionUsage> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const usage: Record<string, QuestionUsage> = {};
  for (const day of days) {
    for (const qid of day.questionIds) {
      const q = byId.get(qid);
      const prev = usage[qid];
      usage[qid] = {
        questionId: qid,
        canonicalEventId: q?.canonicalEventId ?? prev?.canonicalEventId ?? 'unknown',
        lastPublishedAt: prev && prev.lastPublishedAt > day.date ? prev.lastPublishedAt : day.date,
        timesPublished: (prev?.timesPublished ?? 0) + 1,
        ...(q?.approvedAt ?? q?.reviewedAt ? { approvedAt: q?.approvedAt ?? q?.reviewedAt } : {}),
      };
    }
  }
  return Object.fromEntries(Object.entries(usage).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Deterministically extend a schedule.
 *
 * - Selection for a date is seeded by `${seed}:${date}`, so the same bank and
 *   history always yield the same days.
 * - Never-used questions are preferred. Previously used ones are only eligible
 *   after `cooldownDays`, and that reuse is reported as a warning.
 * - If a date cannot be filled while respecting balance and cooldown,
 *   scheduling stops there and `shortageDate` is set. Nothing is recycled or
 *   invented silently.
 */
export function buildSchedule(options: BuildScheduleOptions): BuildScheduleResult {
  const size = options.size ?? options.existing?.size ?? DEFAULT_SIZE;
  const cooldownDays = options.cooldownDays ?? options.existing?.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
  const seed = options.seed ?? options.existing?.seed ?? DEFAULT_SEED;

  if (!isIsoDate(options.startDate)) throw new Error(`Invalid startDate: ${options.startDate}`);
  if (!Number.isInteger(options.days) || options.days < 0) throw new Error('days must be a non-negative integer');
  if (!Number.isInteger(size) || size < 1) throw new Error('size must be a positive integer');
  if (options.existing && options.existing.size !== size) {
    throw new Error(`Existing schedule uses size ${options.existing.size}; refusing to mix with size ${size}`);
  }

  const eligibleBank = options.questions.filter(
    (q) => q.status === 'verified' && (options.allowPlaceholders || !q.placeholder),
  );
  const byId = new Map(options.questions.map((q) => [q.id, q]));

  const existingDays = options.existing?.days.slice() ?? [];
  const existingDates = new Set(existingDays.map((d) => d.date));
  const epoch =
    options.existing?.epoch ??
    [options.startDate, ...existingDays.map((d) => d.date)].sort()[0] ??
    options.startDate;

  if (options.existing && daysBetween(epoch, options.startDate) < 0) {
    throw new Error(`startDate ${options.startDate} is before the schedule epoch ${epoch}`);
  }

  const newDays: ScheduleDay[] = [];
  const added: string[] = [];
  const kept: string[] = [];
  const warnings: ScheduleWarning[] = [];
  let shortageDate: string | null = null;
  const [minFlorida, maxFlorida] = answerBalanceRange(size);

  for (let offset = 0; offset < options.days; offset++) {
    const date = addDays(options.startDate, offset);
    if (existingDates.has(date)) {
      kept.push(date);
      continue;
    }

    const allDays = [...existingDays, ...newDays];
    const { byQuestion, byEvent } = indexUsage(allDays, byId);

    const fresh: Question[] = [];
    const reusable: Question[] = [];
    for (const q of eligibleBank) {
      if (!clearOfCooldown(byEvent.get(q.canonicalEventId), date, cooldownDays)) continue;
      const uses = byQuestion.get(q.id);
      if (!uses) fresh.push(q);
      else if (clearOfCooldown(uses, date, cooldownDays)) reusable.push(q);
    }

    const rng = createRng(`${seed}:${date}`);
    const order = (qs: Question[]) => seededShuffle(qs.slice().sort((a, b) => a.id.localeCompare(b.id)), rng);
    const freshBy = (a: Answer) => order(fresh.filter((q) => q.answer === a));
    const reuseBy = (a: Answer) => order(reusable.filter((q) => q.answer === a));
    const pools = {
      florida: { fresh: freshBy('florida'), reuse: reuseBy('florida') },
      gta: { fresh: freshBy('gta'), reuse: reuseBy('gta') },
    };

    // Lean toward whichever side has more fresh stock so the bank drains evenly;
    // break ties with the date-seeded RNG so the split isn't a fixed pattern.
    const candidatesFlorida: number[] = [];
    for (let n = minFlorida; n <= maxFlorida; n++) candidatesFlorida.push(n);
    const freshDiff = pools.florida.fresh.length - pools.gta.fresh.length;
    const preferred = seededShuffle(candidatesFlorida, rng).sort((a, b) => {
      const ideal = size / 2 + Math.sign(freshDiff) * 0.5;
      return Math.abs(a - ideal) - Math.abs(b - ideal);
    });

    let picked: Question[] | null = null;
    let usedReuse = false;
    for (const floridaCount of preferred) {
      const need: Record<Answer, number> = { florida: floridaCount, gta: size - floridaCount };
      const chosen: Question[] = [];
      let reused = false;
      for (const side of ['florida', 'gta'] as const) {
        const fromFresh = pickDiverse(pools[side].fresh, need[side], chosen);
        chosen.push(...fromFresh);
        if (fromFresh.length < need[side]) {
          const fromReuse = pickDiverse(pools[side].reuse, need[side] - fromFresh.length, chosen);
          if (fromReuse.length) reused = true;
          chosen.push(...fromReuse);
        }
      }
      if (chosen.length === size) {
        picked = chosen;
        usedReuse = reused;
        break;
      }
    }

    if (!picked) {
      shortageDate = date;
      warnings.push({
        code: 'shortage',
        date,
        message:
          `Not enough eligible questions for ${date}: fresh florida=${pools.florida.fresh.length}, gta=${pools.gta.fresh.length}; ` +
          `reusable (cooldown ${cooldownDays}d) florida=${pools.florida.reuse.length}, gta=${pools.gta.reuse.length}. ` +
          'Approve more questions; scheduling stopped here.',
      });
      break;
    }
    if (usedReuse) {
      warnings.push({
        code: 'reused_after_cooldown',
        date,
        message: `${date} reuses questions published more than ${cooldownDays} days ago (fresh inventory exhausted)`,
      });
    }

    const ordered = seededShuffle(picked, rng);
    newDays.push({
      date,
      number: daysBetween(epoch, date) + 1,
      challengeId: date,
      questionIds: ordered.map((q) => q.id),
    });
    added.push(date);
  }

  const days = [...existingDays, ...newDays].sort((a, b) => a.date.localeCompare(b.date));
  const usedIds = new Set(days.flatMap((d) => d.questionIds));
  const unused = eligibleBank.filter((q) => !usedIds.has(q.id));
  const runwayDays = Math.floor(unused.length / size);
  if (!shortageDate && runwayDays < 14) {
    warnings.push({
      code: 'low_inventory',
      message: `Only ${unused.length} never-scheduled questions left (~${runwayDays} more days at ${size}/day)`,
    });
  }

  return {
    schedule: {
      version: 1,
      epoch,
      size,
      cooldownDays,
      seed,
      days,
      usage: computeUsage(days, options.questions),
    },
    added,
    kept,
    shortageDate,
    warnings,
  };
}
