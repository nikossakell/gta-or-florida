import { describe, expect, it } from 'vitest';
import {
  answerBalanceRange,
  hasErrors,
  validateQuestion,
  validateQuestionBank,
  validateSchedule,
  type ScheduleFile,
} from '../src/index.ts';
import { makeBank, makeQuestion } from './fixtures.ts';

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('validateQuestion', () => {
  it('accepts a well-formed verified Florida item and fiction item', () => {
    expect(validateQuestion(makeQuestion(1, 'florida'))).toEqual([]);
    expect(validateQuestion(makeQuestion(2, 'gta'))).toEqual([]);
  });

  it('requires a source for verified Florida answers', () => {
    const q = makeQuestion(1, 'florida', { sourceUrl: undefined, sourceName: undefined });
    expect(codes(validateQuestion(q))).toEqual(expect.arrayContaining(['missing_source', 'missing_source_name']));
  });

  it('rejects non-https sources', () => {
    expect(codes(validateQuestion(makeQuestion(1, 'florida', { sourceUrl: 'http://insecure.example/x' })))).toContain('invalid_source_url');
  });

  it('forbids sources on placeholders and on fiction', () => {
    const placeholder = makeQuestion(1, 'florida', { placeholder: true });
    expect(codes(validateQuestion(placeholder))).toContain('placeholder_with_source');
    const fiction = makeQuestion(2, 'gta', { sourceUrl: 'https://example.com' });
    expect(codes(validateQuestion(fiction))).toContain('fiction_with_source');
  });

  it('allows placeholder Florida items without a source', () => {
    const q = makeQuestion(1, 'florida', { placeholder: true, sourceUrl: undefined, sourceName: undefined, publishedAt: undefined });
    expect(validateQuestion(q)).toEqual([]);
  });

  it('rejects invalid statuses, categories and difficulties', () => {
    const q = { ...makeQuestion(1, 'gta'), status: 'approved', category: 'aliens', difficulty: 7 };
    expect(codes(validateQuestion(q))).toEqual(expect.arrayContaining(['invalid_status', 'invalid_category', 'invalid_difficulty']));
  });

  it('requires reviewedAt for verified items', () => {
    expect(codes(validateQuestion(makeQuestion(1, 'gta', { reviewedAt: undefined })))).toContain('missing_review');
  });

  it('rejects markup in headlines', () => {
    expect(codes(validateQuestion(makeQuestion(1, 'gta', { headline: 'Hello <script>alert(1)</script> world' })))).toContain('markup_in_headline');
  });

  it('requires a source for gta_lore', () => {
    expect(codes(validateQuestion(makeQuestion(1, 'gta', { gtaSubtype: 'gta_lore' })))).toContain('missing_lore_source');
  });

  it('handles non-object input', () => {
    expect(codes(validateQuestion(null))).toEqual(['not_object']);
  });
});

describe('validateQuestionBank', () => {
  it('passes a clean bank', () => {
    expect(hasErrors(validateQuestionBank(makeBank(10, 10)))).toBe(false);
  });

  it('fails on duplicate ids', () => {
    const bank = makeBank(3, 3);
    bank.push({ ...bank[0]!, headline: 'Completely different words entirely here', canonicalEventId: 'other', sourceUrl: 'https://z.example/q' });
    expect(codes(validateQuestionBank(bank))).toContain('duplicate_id');
  });

  it('fails on repeated canonical events and repeated source articles', () => {
    const bank = makeBank(3, 3);
    bank[1] = { ...bank[1]!, canonicalEventId: bank[0]!.canonicalEventId, sourceUrl: `${bank[0]!.sourceUrl}?utm_source=x` };
    const c = codes(validateQuestionBank(bank));
    expect(c).toContain('duplicate_canonical_event');
    expect(c).toContain('duplicate_source');
  });

  it('fails on near-duplicate fictional plots with superficial wording changes', () => {
    const bank = [
      makeQuestion(1, 'gta', { headline: 'Mob boss hires you to steal a blimp during the boat parade' }),
      makeQuestion(2, 'gta', { headline: 'Mob boss hires you to steal the blimp during a boat parade' }),
    ];
    expect(codes(validateQuestionBank(bank))).toContain('near_duplicate_headline');
    expect(hasErrors(validateQuestionBank(bank))).toBe(true);
  });
});

describe('validateSchedule', () => {
  const bank = makeBank(6, 6);
  const base: ScheduleFile = {
    version: 1,
    epoch: '2026-11-19',
    size: 5,
    cooldownDays: 180,
    seed: 't',
    days: [
      { date: '2026-11-19', number: 1, challengeId: '2026-11-19', questionIds: ['florida-000', 'florida-001', 'gta-1000', 'gta-1001', 'gta-1002'] },
    ],
  };

  it('accepts a valid schedule', () => {
    expect(validateSchedule(base, bank)).toEqual([]);
  });

  it('fails on unknown references, wrong size and duplicates', () => {
    const s: ScheduleFile = {
      ...base,
      days: [
        ...base.days,
        { date: '2026-11-20', number: 2, challengeId: '2026-11-20', questionIds: ['nope', 'florida-002', 'florida-002', 'gta-1003'] },
      ],
    };
    const c = codes(validateSchedule(s, bank));
    expect(c).toContain('wrong_size');
    const s2: ScheduleFile = {
      ...base,
      days: [...base.days, { date: '2026-11-20', number: 2, challengeId: '2026-11-20', questionIds: ['nope', 'florida-002', 'florida-002', 'gta-1003', 'gta-1004'] }],
    };
    const c2 = codes(validateSchedule(s2, bank));
    expect(c2).toEqual(expect.arrayContaining(['unknown_question', 'repeat_in_day']));
  });

  it('fails on repeats within the cooldown window', () => {
    const s: ScheduleFile = {
      ...base,
      days: [...base.days, { date: '2026-11-20', number: 2, challengeId: '2026-11-20', questionIds: ['florida-000', 'florida-002', 'gta-1003', 'gta-1004', 'gta-1005'] }],
    };
    expect(codes(validateSchedule(s, bank))).toContain('cooldown_violation');
  });

  it('fails on one-sided days', () => {
    const s: ScheduleFile = {
      ...base,
      days: [{ ...base.days[0]!, questionIds: ['gta-1000', 'gta-1001', 'gta-1002', 'gta-1003', 'gta-1004'] }],
    };
    expect(codes(validateSchedule(s, bank))).toContain('answer_imbalance');
  });

  it('fails on duplicate dates and wrong numbering', () => {
    const s: ScheduleFile = { ...base, days: [base.days[0]!, { ...base.days[0]!, number: 9 }] };
    expect(codes(validateSchedule(s, bank))).toEqual(expect.arrayContaining(['duplicate_date', 'invalid_number']));
  });

  it('can forbid placeholder content', () => {
    const withPlaceholder = bank.map((q) => (q.id === 'gta-1000' ? { ...q, placeholder: true } : q));
    expect(codes(validateSchedule(base, withPlaceholder, { forbidPlaceholders: true }))).toContain('placeholder_scheduled');
  });
});

describe('answerBalanceRange', () => {
  it('keeps days close to 50/50', () => {
    expect(answerBalanceRange(5)).toEqual([2, 3]);
    expect(answerBalanceRange(8)).toEqual([3, 5]);
    expect(answerBalanceRange(2)).toEqual([1, 1]);
  });
});
