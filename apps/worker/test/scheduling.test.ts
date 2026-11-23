import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, createRng } from '@gof/core';
import { ensureSchedule, scheduleRounds } from '../src/services/scheduling.ts';
import { APPROVED_PUBLISHER, createHarness, seedApproved, seedMany, seedSource, type Harness } from './harness.ts';

let h: Harness;
const START = '2026-11-22';

beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.dispose());
beforeEach(() => h.reset());

async function rounds() {
  const { results } = await h.db
    .prepare(
      `SELECT r.day, r.florida_count, r.number, i.position, i.question_id, q.answer_kind
         FROM daily_rounds r JOIN daily_round_items i ON i.day = r.day JOIN questions q ON q.id = i.question_id ORDER BY r.day, i.position`,
    )
    .all<{ day: string; florida_count: number; number: number; position: number; question_id: string; answer_kind: string }>();
  const byDay = new Map<string, typeof results>();
  for (const r of results) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  return byDay;
}

describe('scheduleRounds', () => {
  it('alternates 3/2 and 2/3, five unique questions per day, never reused', async () => {
    await seedMany(h.db, 30, 30);
    const r = await scheduleRounds(h.db, { startDate: START, days: 10, rng: createRng('alt') });
    expect(r.added).toHaveLength(10);
    expect(r.shortageDate).toBeNull();
    const days = await rounds();
    const counts = [...days.values()].map((d) => d.filter((x) => x.answer_kind === 'FLORIDA').length);
    counts.forEach((c, i) => {
      expect([2, 3]).toContain(c);
      if (i > 0) expect(c).not.toBe(counts[i - 1]);
    });
    const ids = [...days.values()].flat().map((x) => x.question_id);
    expect(new Set(ids).size).toBe(50);
    expect([...days.values()].map((d) => d[0]!.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('is idempotent: re-running keeps existing days and their order', async () => {
    await seedMany(h.db, 20, 20);
    await scheduleRounds(h.db, { startDate: START, days: 3, rng: createRng('a') });
    const before = await rounds();
    const again = await scheduleRounds(h.db, { startDate: START, days: 3, rng: createRng('b') });
    expect(again.added).toEqual([]);
    expect(again.kept).toEqual([START, addDays(START, 1), addDays(START, 2)]);
    expect(await rounds()).toEqual(before);
  });

  it('stops at a shortage without writing a partial day or inventing anything', async () => {
    await seedMany(h.db, 6, 4);
    const r = await scheduleRounds(h.db, { startDate: START, days: 5, rng: createRng('short') });
    expect(r.added).toHaveLength(2);
    expect(r.shortageDate).toBe(addDays(START, 2));
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['shortage', 'low_inventory']));
    const days = await rounds();
    expect(days.size).toBe(2);
    for (const d of days.values()) expect(d).toHaveLength(5);
  });

  it('first day can run with 3 + 3 approved', async () => {
    await seedMany(h.db, 3, 3);
    const r = await scheduleRounds(h.db, { startDate: START, days: 1 });
    expect(r.added).toHaveLength(1);
  });

  it('two concurrent runs never duplicate or reorder a date', async () => {
    await seedMany(h.db, 20, 20);
    const results = await Promise.allSettled([
      scheduleRounds(h.db, { startDate: START, days: 4, rng: createRng('x') }),
      scheduleRounds(h.db, { startDate: START, days: 4, rng: createRng('y') }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const days = await rounds();
    expect(days.size).toBe(4);
    const ids = [...days.values()].flat().map((x) => x.question_id);
    expect(new Set(ids).size).toBe(20);
  });

  it('excludes unreviewed sources, broken links, fixtures and unapproved questions', async () => {
    await seedSource(h.db, APPROVED_PUBLISHER);
    await seedSource(h.db, { ...APPROVED_PUBLISHER, id: 'publisher:unreviewed.example.org', licenseStatus: 'unreviewed', canUseEditorialSummary: false, canDisplayOriginalTitle: false, autoPublishAllowed: false });
    await seedSource(h.db, { ...APPROVED_PUBLISHER, id: 'grandtheftwiki', type: 'gta_wiki' });
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'FLORIDA', { sourceId: 'publisher:unreviewed.example.org' });
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'FLORIDA', { link: 'broken' });
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'FLORIDA', { fixture: true });
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'GTA');
    const r = await scheduleRounds(h.db, { startDate: START, days: 1 });
    expect(r.added).toEqual([]);
    expect(r.shortageDate).toBe(START);
  });

  it('ensureSchedule publishes due days and keeps a forward window', async () => {
    await seedMany(h.db, 40, 40);
    const r = await ensureSchedule(h.db, { now: new Date(`${START}T00:05:00Z`), aheadDays: 30 });
    expect(r.added.length).toBe(16); // 80 approved / 5 per day
    expect(r.shortageDate).toBe(addDays(START, 16));
    const st = await h.db.prepare(`SELECT status, COUNT(*) AS n FROM daily_rounds GROUP BY status`).all<{ status: string; n: number }>();
    expect(Object.fromEntries(st.results.map((x) => [x.status, x.n]))).toEqual({ published: 1, scheduled: 15 });
  });
});
