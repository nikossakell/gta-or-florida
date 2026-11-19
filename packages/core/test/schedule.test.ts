import { describe, expect, it } from 'vitest';
import { addDays, buildSchedule, validateSchedule, type Question } from '../src/index.ts';
import { makeBank, makeQuestion } from './fixtures.ts';

const START = '2026-11-19';

describe('buildSchedule', () => {
  it('is deterministic for the same inputs', () => {
    const bank = makeBank(30, 30);
    const a = buildSchedule({ questions: bank, startDate: START, days: 10 });
    const b = buildSchedule({ questions: bank.slice().reverse(), startDate: START, days: 10 });
    expect(a.schedule.days).toEqual(b.schedule.days);
  });

  it('changes selection when the seed changes', () => {
    const bank = makeBank(30, 30);
    const a = buildSchedule({ questions: bank, startDate: START, days: 3, seed: 'one' });
    const b = buildSchedule({ questions: bank, startDate: START, days: 3, seed: 'two' });
    expect(a.schedule.days.map((d) => d.questionIds)).not.toEqual(b.schedule.days.map((d) => d.questionIds));
  });

  it('produces balanced 2/3 or 3/2 days with no repeated questions and passes validation', () => {
    const bank = makeBank(40, 40);
    const { schedule, shortageDate } = buildSchedule({ questions: bank, startDate: START, days: 16 });
    expect(shortageDate).toBeNull();
    expect(schedule.days).toHaveLength(16);
    const byId = new Map(bank.map((q) => [q.id, q]));
    const all = schedule.days.flatMap((d) => d.questionIds);
    expect(new Set(all).size).toBe(all.length);
    for (const day of schedule.days) {
      const florida = day.questionIds.filter((id) => byId.get(id)!.answer === 'florida').length;
      expect([2, 3]).toContain(florida);
    }
    expect(validateSchedule(schedule, bank)).toEqual([]);
  });

  it('numbers days from the epoch and records usage metadata', () => {
    const bank = makeBank(10, 10);
    const { schedule } = buildSchedule({ questions: bank, startDate: START, days: 2 });
    expect(schedule.epoch).toBe(START);
    expect(schedule.days.map((d) => d.number)).toEqual([1, 2]);
    const firstId = schedule.days[0]!.questionIds[0]!;
    expect(schedule.usage?.[firstId]).toMatchObject({ lastPublishedAt: START, timesPublished: 1 });
  });

  it('prefers category diversity within a day', () => {
    const bank = makeBank(30, 30);
    const { schedule } = buildSchedule({ questions: bank, startDate: START, days: 5 });
    const byId = new Map(bank.map((q) => [q.id, q]));
    for (const day of schedule.days) {
      const cats = new Set(day.questionIds.map((id) => byId.get(id)!.category));
      expect(cats.size).toBeGreaterThanOrEqual(4);
    }
  });

  it('never alters existing days when extending', () => {
    const bank = makeBank(30, 30);
    const first = buildSchedule({ questions: bank, startDate: START, days: 3 });
    // Adding new questions must not reshuffle days that players may already have seen.
    const bigger = [...bank, ...makeBank(10, 10).map((q) => ({ ...q, id: `${q.id}-new`, canonicalEventId: `${q.canonicalEventId}-new`, headline: `${q.headline} extra` }))];
    const second = buildSchedule({ questions: bigger, existing: first.schedule, startDate: START, days: 6 });
    expect(second.kept).toEqual(first.added);
    expect(second.schedule.days.slice(0, 3)).toEqual(first.schedule.days);
    expect(second.added).toHaveLength(3);
  });

  it('excludes unverified and placeholder questions by default', () => {
    const bank: Question[] = [
      ...makeBank(5, 5),
      makeQuestion(500, 'florida', { status: 'candidate' }),
      makeQuestion(501, 'gta', { placeholder: true }),
    ];
    const { schedule } = buildSchedule({ questions: bank, startDate: START, days: 2 });
    const used = new Set(schedule.days.flatMap((d) => d.questionIds));
    expect(used.has('florida-500')).toBe(false);
    expect(used.has('gta-1501')).toBe(false);
  });

  it('never schedules two questions about the same canonical event close together', () => {
    const bank = makeBank(12, 12).map((q, i) => (i < 2 ? { ...q, canonicalEventId: 'same-event' } : q));
    const { schedule } = buildSchedule({ questions: bank, startDate: START, days: 4 });
    const days = schedule.days.filter((d) => d.questionIds.some((id) => id === 'florida-000' || id === 'florida-001'));
    const hits = days.flatMap((d) => d.questionIds.filter((id) => id === 'florida-000' || id === 'florida-001'));
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});

describe('schedule exhaustion', () => {
  it('stops at the first unfillable day instead of recycling', () => {
    // 12 questions at 5/day = 2 full days; day 3 must be reported as a shortage.
    const bank = makeBank(6, 6);
    const result = buildSchedule({ questions: bank, startDate: START, days: 5 });
    expect(result.added).toEqual([START, addDays(START, 1)]);
    expect(result.shortageDate).toBe(addDays(START, 2));
    expect(result.warnings.find((w) => w.code === 'shortage')?.date).toBe(addDays(START, 2));
    const all = result.schedule.days.flatMap((d) => d.questionIds);
    expect(new Set(all).size).toBe(all.length);
  });

  it('reports a shortage when one answer side runs out even if the other has stock', () => {
    const bank = makeBank(1, 20); // cannot reach 2 Florida per day
    const result = buildSchedule({ questions: bank, startDate: START, days: 3 });
    expect(result.added).toEqual([]);
    expect(result.shortageDate).toBe(START);
  });

  it('reuses questions only after the cooldown and warns when it does', () => {
    const bank = makeBank(5, 5); // exactly 2 days of fresh content
    const result = buildSchedule({ questions: bank, startDate: START, days: 6, cooldownDays: 2 });
    expect(result.shortageDate).toBeNull();
    expect(result.warnings.some((w) => w.code === 'reused_after_cooldown')).toBe(true);
    expect(validateSchedule(result.schedule, bank)).toEqual([]);
  });

  it('a 180-day cooldown with a small bank surfaces the shortage rather than violating policy', () => {
    const bank = makeBank(10, 10);
    const result = buildSchedule({ questions: bank, startDate: START, days: 30, cooldownDays: 180 });
    expect(result.added).toHaveLength(4);
    expect(result.shortageDate).toBe(addDays(START, 4));
  });

  it('warns about low inventory', () => {
    const bank = makeBank(15, 15);
    const result = buildSchedule({ questions: bank, startDate: START, days: 2 });
    expect(result.warnings.some((w) => w.code === 'low_inventory')).toBe(true);
  });

  it('refuses to start before the existing epoch', () => {
    const bank = makeBank(20, 20);
    const first = buildSchedule({ questions: bank, startDate: START, days: 1 });
    expect(() => buildSchedule({ questions: bank, existing: first.schedule, startDate: addDays(START, -1), days: 1 })).toThrow(/epoch/);
  });
});
