import { describe, expect, it, vi } from 'vitest';
import {
  clearAllLocalData,
  computeStats,
  getProgress,
  getResult,
  getResults,
  saveProgress,
  saveResult,
  type StoredResult,
} from '../src/lib/storage.ts';

function result(date: string, score: number, mode: 'daily' | 'archive' = 'daily', total = 5): StoredResult {
  return {
    date,
    number: 1,
    mode,
    score,
    total,
    cells: Array.from({ length: total }, (_, i) => i < score),
    choices: [],
    seconds: 30,
    timedOut: false,
    completedAt: `${date}T10:00:00Z`,
    sample: false,
    questions: [],
  };
}

describe('result storage', () => {
  it('keeps only the first scored attempt for a date', () => {
    saveResult(result('2026-11-19', 2));
    const second = saveResult(result('2026-11-19', 5));
    expect(second.score).toBe(2);
    expect(getResult('2026-11-19')?.score).toBe(2);
  });

  it('round-trips in-progress state', () => {
    const progress = {
      date: '2026-11-19',
      questionIds: ['a', 'b'],
      mode: 'daily' as const,
      index: 1,
      phase: 'question' as const,
      elapsedMs: 1234,
      answers: [],
      updatedAt: 'x',
    };
    saveProgress(progress);
    expect(getProgress('2026-11-19')).toEqual(progress);
  });

  it('tolerates corrupt or unavailable storage', () => {
    localStorage.setItem('gof:v1:results', '{not json');
    expect(getResults()).toEqual({});
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => saveResult(result('2026-11-19', 3))).not.toThrow();
    spy.mockRestore();
  });

  it('clears only this app’s keys', () => {
    localStorage.setItem('other-app', 'keep');
    saveResult(result('2026-11-19', 3));
    clearAllLocalData();
    expect(getResults()).toEqual({});
    expect(localStorage.getItem('other-app')).toBe('keep');
  });
});

describe('computeStats', () => {
  it('counts consecutive daily completions ending today', () => {
    const r = Object.fromEntries(
      [result('2026-11-17', 3), result('2026-11-18', 4), result('2026-11-19', 5)].map((x) => [x.date, x]),
    );
    expect(computeStats(r, '2026-11-19')).toEqual({ played: 3, streak: 3, best: { score: 5, total: 5 } });
  });

  it('keeps the streak alive until the end of today', () => {
    const r = { '2026-11-18': result('2026-11-18', 3) };
    expect(computeStats(r, '2026-11-19').streak).toBe(1);
    expect(computeStats(r, '2026-11-20').streak).toBe(0);
  });

  it('never counts archive plays toward the streak', () => {
    const r = { '2026-11-18': result('2026-11-18', 3, 'archive'), '2026-11-19': result('2026-11-19', 3) };
    expect(computeStats(r, '2026-11-19')).toMatchObject({ played: 2, streak: 1 });
  });

  it('handles no data', () => {
    expect(computeStats({}, '2026-11-19')).toEqual({ played: 0, streak: 0, best: null });
  });
});
