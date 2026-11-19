import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildShareText,
  daysBetween,
  gradeChoices,
  isIsoDate,
  msUntilNextUtcDay,
  publicQuestionId,
  publicQuestionIndex,
  scoreTitle,
  toPublicQuestion,
  toRevealedQuestion,
  utcDate,
} from '../src/index.ts';
import { makeQuestion } from './fixtures.ts';

describe('share text', () => {
  it('matches the documented spoiler-free format', () => {
    const text = buildShareText({ date: '2026-11-19', cells: [true, true, false, true, true], url: 'https://example.com' });
    expect(text).toBe('GTA or Florida? 🐊 #2026-11-19\n🟩🟩🟥🟩🟩\n4/5 — Can you beat me?\nhttps://example.com');
  });

  it('marks unanswered questions and optional time', () => {
    const text = buildShareText({ date: '2026-11-19', cells: [true, null], seconds: 41.4, url: 'u' });
    expect(text.split('\n')[1]).toBe('🟩⬜');
    expect(text).toContain('1/2 in 41s');
  });

  it('never contains the words florida/gta as answers', () => {
    const text = buildShareText({ date: '2026-11-19', cells: [true, false], url: 'https://x' });
    expect(text.split('\n').slice(1).join('\n')).not.toMatch(/florida|gta/i);
  });
});

describe('public/revealed projections', () => {
  it('public questions carry no answer, explanation, source or internal id', () => {
    const q = makeQuestion(1, 'florida');
    const pub = toPublicQuestion(q, 2);
    expect(pub).toEqual({ id: 'h3', headline: q.headline });
    expect(JSON.stringify(pub)).not.toContain(q.id);
  });

  it('maps public ids back to positions', () => {
    expect(publicQuestionIndex(publicQuestionId(4), 5)).toBe(4);
    expect(publicQuestionIndex('h6', 5)).toBe(-1);
    expect(publicQuestionIndex('h0', 5)).toBe(-1);
    expect(publicQuestionIndex('florida-001', 5)).toBe(-1);
    expect(publicQuestionIndex(3, 5)).toBe(-1);
  });

  it('reveals source only for non-placeholder items', () => {
    expect(toRevealedQuestion(makeQuestion(1, 'florida'), 0).sourceUrl).toMatch(/^https:/);
    const placeholder = makeQuestion(2, 'florida', { placeholder: true, sourceUrl: 'https://should-not-leak.example' });
    expect(toRevealedQuestion(placeholder, 0).sourceUrl).toBeUndefined();
    expect(toRevealedQuestion(makeQuestion(3, 'gta'), 0).gtaSubtype).toBe('fiction');
  });
});

describe('grading', () => {
  it('treats null as a miss', () => {
    expect(gradeChoices(['florida', 'gta', 'gta'], ['florida', 'florida', null])).toEqual([true, false, null]);
  });

  it('gives a title for each score band', () => {
    expect(scoreTitle(5, 5)).toBe('Certified gator brain');
    expect(scoreTitle(0, 5)).toBe('Fresh off the plane');
  });
});

describe('dates', () => {
  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-1-1')).toBe(false);
  });

  it('does UTC arithmetic', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-11-01', '2026-11-19')).toBe(18);
    expect(utcDate(new Date('2026-11-19T23:59:59-05:00'))).toBe('2026-11-20');
    expect(msUntilNextUtcDay(new Date('2026-11-19T23:00:00Z'))).toBe(3_600_000);
  });
});
