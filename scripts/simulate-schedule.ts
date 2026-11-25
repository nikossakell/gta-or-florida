#!/usr/bin/env -S npx tsx
/**
 * `npm run schedule:simulate -- [--events 150,300] [--days 90] [--cooldown 30] [--seeds 20] [--florida-share 0.5] [--json]`
 *
 * Offline simulation of the daily scheduler (packages/core/src/round-plan.ts, the planner the Worker uses)
 * on synthetic banks of approved events (one question per event, fictional titles). Two modes per bank:
 *  - bulk:  one plan for the whole period (`npm run admin -- schedule --days 90`)
 *  - cron:  what production does: plan 30 days, then each day add the day 29 days ahead, with all
 *           earlier days as persisted history (ensureSchedule with SCHEDULE_AHEAD_DAYS=30)
 * Reports scheduling failures, event repeat intervals, the Florida/GTA split distribution against the
 * Binomial(5, ½) target, periodicity, and execution time. Reads and writes nothing.
 */
import { parseArgs } from 'node:util';
import { addDays, createRng, dateRange, planSchedule, type BankQuestion, type PlannedDay, type ScheduledUse } from '@gof/core';

const { values } = parseArgs({
  options: {
    events: { type: 'string', default: '150,300' },
    days: { type: 'string', default: '90' },
    cooldown: { type: 'string', default: '30' },
    seeds: { type: 'string', default: '20' },
    'florida-share': { type: 'string', default: '0.5' },
    start: { type: 'string', default: '2027-01-01' },
    json: { type: 'boolean', default: false },
  },
});
const DAYS = Number(values.days);
const COOLDOWN = Number(values.cooldown);
const SEEDS = Number(values.seeds);
const SHARE = Number(values['florida-share']);
const START = values.start!;
const AHEAD = 30;
const CATS = ['wildlife', 'crime', 'vehicles', 'weird', 'other'];
const WORDS = ['iguana', 'airboat', 'mailbox', 'flamingo', 'scooter', 'parrot', 'blimp', 'kayak', 'tractor', 'lighthouse', 'manatee', 'jetski', 'trolley', 'pelican', 'hovercraft', 'raccoon', 'canoe', 'sandcastle', 'bulldozer', 'tortoise', 'zeppelin', 'armadillo', 'forklift', 'heron'];

function bank(events: number): BankQuestion[] {
  const florida = Math.round(events * SHARE);
  return Array.from({ length: events }, (_, i) => ({
    id: `q${i}`,
    eventId: `e${i}`,
    answer: i < florida ? 'FLORIDA' : 'GTA',
    category: CATS[i % CATS.length]!,
    difficulty: (i % 3) + 1,
    publisher: i < florida ? `pub${i % 9}` : null,
    game: i < florida ? null : `G${i % 7}`,
    title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7 + 3) % WORDS.length]} ${WORDS[(i * 11 + 5) % WORDS.length]} case ${i}`,
  }));
}

type Run = { ok: boolean; failedDate: string | null; days: PlannedDay[]; ms: number[] };

function bulk(questions: BankQuestion[], seed: string): Run {
  const t = performance.now();
  const r = planSchedule({ questions, history: [], dates: dateRange(START, DAYS), cooldownDays: COOLDOWN, rng: createRng(seed) });
  const ms = performance.now() - t;
  return r.ok ? { ok: true, failedDate: null, days: r.days, ms: [ms] } : { ok: false, failedDate: r.failure.date, days: r.partial, ms: [ms] };
}

function cron(questions: BankQuestion[], seed: string): Run {
  const rng = createRng(seed);
  const days: PlannedDay[] = [];
  const ms: number[] = [];
  const history = (): ScheduledUse[] => days.flatMap((d) => d.questions.map((q) => ({ date: d.date, questionId: q.id, eventId: q.eventId })));
  // Day 0: fill the whole window; then each daily run has exactly one new date (today + 29).
  for (let t = 0; t + AHEAD <= DAYS || t === 0; t++) {
    const have = new Set(days.map((d) => d.date));
    const dates = dateRange(addDays(START, t), AHEAD).filter((d) => !have.has(d) && d < addDays(START, DAYS));
    if (!dates.length) continue;
    const t0 = performance.now();
    const r = planSchedule({ questions, history: history(), dates, cooldownDays: COOLDOWN, rng });
    ms.push(performance.now() - t0);
    days.push(...(r.ok ? r.days : r.partial)); // the cron writes the plannable prefix
    if (!r.ok) return { ok: false, failedDate: r.failure.date, days, ms };
  }
  return { ok: true, failedDate: null, days, ms };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : NaN;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const BINOM = [1, 5, 10, 10, 5, 1].map((c) => c / 32);

function analyse(runs: Run[], events: number) {
  const intervals: number[] = [];
  const splits = [0, 0, 0, 0, 0, 0];
  let florida = 0;
  let slots = 0;
  let resampled = 0;
  let periodic = 0;
  let comparable = 0;
  let violations = 0;
  const usesPerEvent: number[] = [];
  for (const r of runs) {
    const last = new Map<string, string>();
    const uses = new Map<string, number>();
    const setOf = new Map<string, string>();
    for (const d of r.days) {
      splits[d.floridaCount]!++;
      florida += d.floridaCount;
      slots += d.questions.length;
      if (d.resampled) resampled++;
      if (new Set(d.questions.map((q) => q.eventId)).size !== d.questions.length) violations++;
      const key = d.questions.map((q) => q.eventId).sort().join(',');
      setOf.set(d.date, key);
      const earlier = setOf.get(addDays(d.date, -COOLDOWN));
      if (earlier !== undefined) {
        comparable++;
        if (earlier === key) periodic++;
      }
      for (const q of d.questions) {
        const prev = last.get(q.eventId);
        if (prev) {
          const gap = Math.round((Date.parse(d.date) - Date.parse(prev)) / 86_400_000);
          intervals.push(gap);
          if (gap < COOLDOWN) violations++;
        }
        last.set(q.eventId, d.date);
        uses.set(q.eventId, (uses.get(q.eventId) ?? 0) + 1);
      }
    }
    for (let e = 0; e < events; e++) usesPerEvent.push(uses.get(`e${e}`) ?? 0);
  }
  const daysTotal = splits.reduce((a, b) => a + b, 0);
  return {
    failures: runs.filter((r) => !r.ok).length,
    failedDates: [...new Set(runs.filter((r) => !r.ok).map((r) => r.failedDate))].slice(0, 5),
    daysPlanned: { min: Math.min(...runs.map((r) => r.days.length)), mean: mean(runs.map((r) => r.days.length)) },
    constraintViolations: violations,
    repeatInterval: intervals.length ? { min: Math.min(...intervals), p50: pct(intervals, 50), mean: +mean(intervals).toFixed(1), p95: pct(intervals, 95), max: Math.max(...intervals), repeats: intervals.length } : null,
    usesPerEvent: { min: Math.min(...usesPerEvent), mean: +mean(usesPerEvent).toFixed(2), max: Math.max(...usesPerEvent), neverUsed: usesPerEvent.filter((u) => u === 0).length },
    splitHistogram: splits.map((n, k) => ({ florida: k, days: n, share: +(n / daysTotal).toFixed(3), binomial: +BINOM[k]!.toFixed(3) })),
    floridaShare: +(florida / slots).toFixed(3),
    resampledDays: +(resampled / daysTotal).toFixed(3),
    sameEventsAsCooldownAgo: comparable ? +(periodic / comparable).toFixed(3) : null,
    ms: { mean: +mean(runs.flatMap((r) => r.ms)).toFixed(2), p95: +pct(runs.flatMap((r) => r.ms), 95).toFixed(2), max: +Math.max(...runs.flatMap((r) => r.ms)).toFixed(2), perRunTotal: +mean(runs.map((r) => r.ms.reduce((a, b) => a + b, 0))).toFixed(1) },
  };
}

const report: Record<string, unknown> = {};
for (const events of values.events!.split(',').map(Number)) {
  const questions = bank(events);
  for (const [mode, fn] of [['bulk', bulk], ['cron', cron]] as const) {
    // Warm-up run (JIT) is excluded from timing; then SEEDS measured runs.
    fn(questions, 'warmup');
    const runs = Array.from({ length: SEEDS }, (_, s) => fn(questions, `${mode}-${events}-${s}`));
    report[`${events} events (${Math.round(events * SHARE)} FL / ${events - Math.round(events * SHARE)} GTA) · ${mode}`] = analyse(runs, events);
  }
}

if (values.json) console.log(JSON.stringify({ settings: { days: DAYS, cooldown: COOLDOWN, seeds: SEEDS, floridaShare: SHARE }, report }, null, 2));
else {
  console.log(`Simulation: ${DAYS} days, ${COOLDOWN}-day cooldown, ${SEEDS} seeds per configuration, 5 questions/day\n`);
  for (const [name, r] of Object.entries(report) as [string, ReturnType<typeof analyse>][]) {
    console.log(`■ ${name}`);
    console.log(`  failures: ${r.failures}/${SEEDS}${r.failures ? ` (first unfillable: ${r.failedDates.join(', ')})` : ''} · days planned min ${r.daysPlanned.min}, mean ${r.daysPlanned.mean.toFixed(1)} · constraint violations: ${r.constraintViolations}`);
    if (r.repeatInterval) console.log(`  repeat interval (days): min ${r.repeatInterval.min} · median ${r.repeatInterval.p50} · mean ${r.repeatInterval.mean} · p95 ${r.repeatInterval.p95} · max ${r.repeatInterval.max} (${r.repeatInterval.repeats} repeats)`);
    console.log(`  uses per event: min ${r.usesPerEvent.min} · mean ${r.usesPerEvent.mean} · max ${r.usesPerEvent.max} · never used ${r.usesPerEvent.neverUsed}`);
    console.log(`  Florida per day: ${r.splitHistogram.map((s) => `${s.florida}:${(s.share * 100).toFixed(1)}% (target ${(s.binomial * 100).toFixed(1)}%)`).join('  ')}`);
    console.log(`  Florida share ${(r.floridaShare * 100).toFixed(1)}% · resampled draws ${(r.resampledDays * 100).toFixed(1)}% of days · same 5 events as ${COOLDOWN} days earlier: ${r.sameEventsAsCooldownAgo === null ? 'n/a' : `${(r.sameEventsAsCooldownAgo * 100).toFixed(1)}% of days`}`);
    console.log(`  planner time: mean ${r.ms.mean} ms · p95 ${r.ms.p95} ms · max ${r.ms.max} ms per call · ${r.ms.perRunTotal} ms per simulated run\n`);
  }
}
