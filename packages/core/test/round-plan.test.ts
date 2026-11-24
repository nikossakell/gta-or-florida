import { describe, expect, it } from 'vitest';
import { addDays, answerPattern, createRng, dateRange, daysBetween, drawSlots, planSchedule, type BankQuestion, type ScheduledUse } from '../src/index.ts';

const START = '2027-01-01';
const CATS = ['wildlife', 'crime', 'vehicles', 'weird', 'other'];
const NOUNS = ['iguana', 'airboat', 'mailbox', 'flamingo', 'scooter', 'parrot', 'blimp', 'kayak', 'tractor', 'lighthouse', 'manatee', 'jetski', 'trolley', 'pelican', 'hovercraft', 'raccoon', 'canoe', 'sandcastle', 'bulldozer', 'tortoise', 'zeppelin', 'armadillo', 'forklift', 'heron', 'unicycle', 'possum', 'catamaran', 'gazebo', 'skateboard', 'opossum', 'monorail'];
const VERBS = ['steals', 'paints', 'buries', 'races', 'rescues', 'sells', 'hides', 'repairs', 'launches', 'guards', 'chases', 'delivers', 'borrows'];
/** Distinct, fictional headline per index (so near-duplicate detection only fires where a test wants it). */
const title = (i: number, side: string) => `${side} ${NOUNS[i % NOUNS.length]} ${VERBS[Math.floor(i / NOUNS.length) % VERBS.length]} ${NOUNS[(i * 7 + 3) % NOUNS.length]} number ${i}`;

/** Clearly fictional test bank: one question per event unless `variants` adds extra questions to events. */
function bank(florida: number, gta: number, variants = 0): BankQuestion[] {
  const out: BankQuestion[] = [];
  for (let i = 0; i < florida; i++)
    out.push({ id: `f${i}`, eventId: `ev-f${i}`, answer: 'FLORIDA', category: CATS[i % 5]!, difficulty: (i % 3) + 1, publisher: `pub${i % 4}`, game: null, title: title(i, 'Resident') });
  for (let i = 0; i < gta; i++)
    out.push({ id: `g${i}`, eventId: `ev-g${i}`, answer: 'GTA', category: CATS[(i + 2) % 5]!, difficulty: (i % 3) + 1, publisher: null, game: `G${i % 5}`, title: title(i, 'Crew') });
  for (let v = 0; v < variants; v++) {
    const base = out[v % out.length]!;
    out.push({ ...base, id: `${base.id}-v${v}`, title: `${base.title} (variant ${v})` });
  }
  return out;
}

function checkHardConstraints(days: { date: string; questions: BankQuestion[] }[], cooldown: number, history: ScheduledUse[] = []) {
  const uses: { date: string; eventId: string }[] = [...history];
  for (const d of days) {
    expect(d.questions).toHaveLength(5);
    expect(new Set(d.questions.map((q) => q.id)).size).toBe(5);
    expect(new Set(d.questions.map((q) => q.eventId)).size).toBe(5);
    for (const q of d.questions) {
      for (const u of uses) if (u.eventId === q.eventId) expect(Math.abs(daysBetween(u.date, d.date))).toBeGreaterThanOrEqual(cooldown);
    }
    uses.push(...d.questions.map((q) => ({ date: d.date, eventId: q.eventId })));
  }
}

describe('drawSlots', () => {
  it('draws each slot independently (50/50) when the inventory allows it', () => {
    const seq = [0.1, 0.9, 0.2, 0.8, 0.3]; // F G F G F
    let i = 0;
    const r = drawSlots(5, () => seq[i++]!, () => true)!;
    expect(r).toEqual({ slots: ['FLORIDA', 'GTA', 'FLORIDA', 'GTA', 'FLORIDA'], resampled: false });
  });

  it('can produce every split from 0/5 to 5/0', () => {
    for (let f = 0; f <= 5; f++) {
      const slots = Array.from({ length: 5 }, (_, k) => (k < f ? 0.1 : 0.9));
      let i = 0;
      const r = drawSlots(5, () => slots[i++]!, () => true)!;
      expect(r.slots.filter((s) => s === 'FLORIDA')).toHaveLength(f);
    }
  });

  it('resamples among feasible splits only, and returns null when none is feasible', () => {
    const rng = createRng('resample');
    for (let n = 0; n < 200; n++) {
      const r = drawSlots(5, rng, (f) => f <= 1)!;
      expect(r.slots.filter((s) => s === 'FLORIDA').length).toBeLessThanOrEqual(1);
    }
    expect(drawSlots(5, rng, () => false)).toBeNull();
  });

  it('keeps the binomial shape when conditioned (1 Florida is 5× as likely as 0)', () => {
    const rng = createRng('shape');
    const tally = [0, 0];
    for (let n = 0; n < 6000; n++) tally[drawSlots(5, rng, (f) => f <= 1)!.slots.filter((s) => s === 'FLORIDA').length]!++;
    expect(tally[1]! / tally[0]!).toBeGreaterThan(4);
    expect(tally[1]! / tally[0]!).toBeLessThan(6.2);
  });
});

describe('planSchedule', () => {
  it('fills every requested day with exactly five questions and no duplicate question or event', () => {
    const r = planSchedule({ questions: bank(150, 150), history: [], dates: dateRange(START, 90), cooldownDays: 30, rng: createRng('full') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.days).toHaveLength(90);
    checkHardConstraints(r.days, 30);
  });

  it('produces all six Florida/GTA distributions over a long run, roughly binomially', () => {
    const r = planSchedule({ questions: bank(150, 150), history: [], dates: dateRange(START, 400), cooldownDays: 30, rng: createRng('dist') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const counts = [0, 0, 0, 0, 0, 0];
    for (const d of r.days) counts[d.floridaCount]!++;
    expect(counts.every((c) => c > 0)).toBe(true);
    // Binomial(5, ½): 2 and 3 Florida are ~31% each; 0 and 5 are ~3% each.
    expect(counts[2]! + counts[3]!).toBeGreaterThan(400 * 0.5);
    expect(counts[0]! + counts[5]!).toBeLessThan(400 * 0.12);
    expect(new Set(r.days.map((d) => answerPattern(d.questions))).size).toBeGreaterThan(20); // order varies too
  });

  it('enforces the event cooldown, also against persisted days before and after the period', () => {
    const questions = bank(30, 30, 20); // 20 events have a second wording
    const history: ScheduledUse[] = [
      { date: addDays(START, -3), questionId: 'f0', eventId: 'ev-f0' },
      { date: addDays(START, 12), questionId: 'g0', eventId: 'ev-g0' },
    ];
    const r = planSchedule({ questions, history, dates: dateRange(START, 10), cooldownDays: 10, rng: createRng('cool') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    checkHardConstraints(r.days, 10, history);
    const used = r.days.flatMap((d) => d.questions.map((q) => ({ date: d.date, ev: q.eventId })));
    expect(used.filter((u) => u.ev === 'ev-f0').every((u) => daysBetween(addDays(START, -3), u.date) >= 10)).toBe(true);
    expect(used.filter((u) => u.ev === 'ev-g0').every((u) => daysBetween(u.date, addDays(START, 12)) >= 10)).toBe(true);
  });

  it('reuses a question only after its cooldown, and prefers the least-used questions', () => {
    const r = planSchedule({ questions: bank(10, 10), history: [], dates: dateRange(START, 12), cooldownDays: 4, rng: createRng('reuse') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    checkHardConstraints(r.days, 4);
    const counts = new Map<string, number>();
    for (const q of r.days.flatMap((d) => d.questions)) counts.set(q.id, (counts.get(q.id) ?? 0) + 1);
    // 60 slots over 20 questions: least-used-first keeps every question within a narrow band.
    expect(counts.size).toBe(20);
    expect(Math.max(...counts.values()) - Math.min(...counts.values())).toBeLessThanOrEqual(2);
  });

  it('adapts the split to a thin category instead of breaking a constraint', () => {
    const r = planSchedule({ questions: bank(2, 60), history: [], dates: dateRange(START, 6), cooldownDays: 30, rng: createRng('thin') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    checkHardConstraints(r.days, 30);
    expect(r.days.reduce((n, d) => n + d.floridaCount, 0)).toBeLessThanOrEqual(2); // each Florida event once in 30 days
  });

  it('fails with an actionable diagnostic and the valid prefix when the inventory cannot cover the period', () => {
    const r = planSchedule({ questions: bank(6, 6), history: [], dates: dateRange(START, 5), cooldownDays: 30, rng: createRng('short') });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toMatchObject({ date: addDays(START, 2), plannedDays: 2, requestedDays: 5, floridaEvents: 6, gtaEvents: 6, cooldownDays: 30 });
    expect(r.failure.floridaAvailable + r.failure.gtaAvailable).toBeLessThan(5);
    expect(r.failure.message).toMatch(/Cannot fill 2027-01-03.*30-day event cooldown.*6 Florida and 6 GTA/);
    expect(r.partial).toHaveLength(2);
    checkHardConstraints(r.partial, 30);
  });

  it('never puts two questions about the same event in one day', () => {
    const questions = bank(5, 5, 40); // many wordings per event
    const r = planSchedule({ questions, history: [], dates: dateRange(START, 1), cooldownDays: 30, rng: createRng('same-event') });
    expect(r.ok).toBe(true);
    if (r.ok) checkHardConstraints(r.days, 30);
  });

  it('avoids near-identical headlines in one day when an alternative exists', () => {
    const qs = bank(10, 10);
    qs[0]!.title = 'Alligator found swimming in a backyard pool in Tampa';
    qs[1]!.title = 'Alligator found swimming in a backyard pool in Ocala';
    for (let seed = 0; seed < 30; seed++) {
      const r = planSchedule({ questions: qs, history: [], dates: dateRange(START, 1), cooldownDays: 30, rng: createRng(`sim-${seed}`) });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.days[0]!.questions.filter((q) => q.id === 'f0' || q.id === 'f1').length).toBeLessThanOrEqual(1);
    }
  });

  it('plans 90 days from a 300-question bank quickly (the Worker has a 10 ms CPU budget)', () => {
    const questions = bank(150, 150);
    const t0 = performance.now();
    const r = planSchedule({ questions, history: [], dates: dateRange(START, 90), cooldownDays: 30, rng: createRng('perf') });
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(250); // generous for CI; see the measured figure in the report
  });
});

describe('cooldown boundary (off-by-one)', () => {
  // Exactly five events: a day is fillable only if all five are outside the cooldown.
  const five = bank(3, 2);
  const usedOn = (date: string): ScheduledUse[] => five.map((q) => ({ date, questionId: q.id, eventId: q.eventId }));
  const plan = (history: ScheduledUse[], date: string, cooldownDays = 30) => planSchedule({ questions: five, history, dates: [date], cooldownDays, rng: createRng('edge') });

  it('an event shown on day D is blocked on D+29 and free again on D+30 (cooldown 30 = at least 30 days apart)', () => {
    expect(plan(usedOn(START), addDays(START, 29)).ok).toBe(false);
    expect(plan(usedOn(START), addDays(START, 30)).ok).toBe(true);
  });

  it('applies the same boundary to persisted days AFTER the planned date', () => {
    expect(plan(usedOn(addDays(START, 29)), START).ok).toBe(false);
    expect(plan(usedOn(addDays(START, 30)), START).ok).toBe(true);
  });

  it('within one run, a 150-event bank under a 30-day cooldown repeats each event exactly 30 days later, never 29', () => {
    const r = planSchedule({ questions: bank(75, 75), history: [], dates: dateRange(START, 61), cooldownDays: 30, rng: createRng('rotation') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seen = new Map<string, string>();
    const gaps: number[] = [];
    for (const d of r.days)
      for (const q of d.questions) {
        const prev = seen.get(q.eventId);
        if (prev) gaps.push(daysBetween(prev, d.date));
        seen.set(q.eventId, d.date);
      }
    expect(gaps.length).toBeGreaterThan(0);
    expect(Math.min(...gaps)).toBe(30);
  });

  it('cooldown 1 allows the next day; cooldown 0 still forbids a repeat within the same day', () => {
    expect(plan(usedOn(START), addDays(START, 1), 1).ok).toBe(true);
    expect(plan(usedOn(START), addDays(START, 1), 2).ok).toBe(false);
    const r = planSchedule({ questions: five, history: [], dates: dateRange(START, 3), cooldownDays: 0, rng: createRng('zero') });
    expect(r.ok).toBe(true);
    if (r.ok) for (const d of r.days) expect(new Set(d.questions.map((q) => q.eventId)).size).toBe(5);
  });
});
