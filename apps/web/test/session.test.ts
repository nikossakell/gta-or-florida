import type { ChallengeResponse, RevealedQuestion } from '@gof/core';
import { describe, expect, it } from 'vitest';
import { initialSession, sessionReducer, toProgress, type SessionState } from '../src/features/game/session.ts';

const challenge: ChallengeResponse = {
  challengeId: '2026-11-19',
  date: '2026-11-19',
  number: 8,
  today: '2026-11-19',
  timeLimitSeconds: 60,
  sample: false,
  questions: [
    { id: 'q1', headline: 'One' },
    { id: 'q2', headline: 'Two' },
  ],
};
const revealed = (id: string): RevealedQuestion => ({ id, headline: id, answer: 'gta', explanation: 'x', placeholder: false });
const record = (id: string) => ({ questionId: id, choice: 'gta' as const, correct: true, question: revealed(id) });

describe('sessionReducer', () => {
  const start = initialSession(challenge, null);

  it('runs the clock only while a question is shown', () => {
    let s = sessionReducer(start, { type: 'tick', deltaMs: 1000, limitMs: 60_000 });
    expect(s.elapsedMs).toBe(1000);
    s = sessionReducer(s, { type: 'choose' });
    s = sessionReducer(s, { type: 'tick', deltaMs: 5000, limitMs: 60_000 });
    expect(s.elapsedMs).toBe(1000);
    s = sessionReducer(s, { type: 'answered', record: record('q1') });
    expect(s.phase).toBe('reveal');
    s = sessionReducer(s, { type: 'tick', deltaMs: 5000, limitMs: 60_000 });
    expect(s.elapsedMs).toBe(1000);
  });

  it('times out at the limit', () => {
    const s = sessionReducer(start, { type: 'tick', deltaMs: 61_000, limitMs: 60_000 });
    expect(s).toMatchObject({ phase: 'timeup', elapsedMs: 60_000 });
  });

  it('ignores answers that arrive in the wrong phase (e.g. double taps)', () => {
    const s = sessionReducer(start, { type: 'answered', record: record('q1') });
    expect(s).toBe(start);
    const choosing = sessionReducer(start, { type: 'choose' });
    expect(sessionReducer(choosing, { type: 'choose' })).toBe(choosing);
  });

  it('returns to the question with an error if checking fails', () => {
    const s = sessionReducer(sessionReducer(start, { type: 'choose' }), { type: 'answerFailed', message: 'nope' });
    expect(s).toMatchObject({ phase: 'question', answerError: 'nope', answers: [] });
  });

  it('returns to where it was if submitting the round fails', () => {
    let s: SessionState = { ...start, phase: 'reveal', index: 1, answers: [record('q1'), record('q2')] };
    s = sessionReducer(s, { type: 'finish' });
    expect(s.phase).toBe('finishing');
    s = sessionReducer(s, { type: 'finishFailed', message: 'offline' });
    expect(s).toMatchObject({ phase: 'reveal', finishError: 'offline' });
  });
});

describe('initialSession (resume)', () => {
  it('restores a saved reveal', () => {
    const saved = toProgress({ ...initialSession(challenge, null), phase: 'reveal', answers: [record('q1')], elapsedMs: 4000 }, challenge, 'daily');
    expect(initialSession(challenge, saved)).toMatchObject({ index: 0, phase: 'reveal', elapsedMs: 4000 });
  });

  it('restores a timed-out round as time up', () => {
    const saved = toProgress({ ...initialSession(challenge, null), elapsedMs: 60_000 }, challenge, 'daily');
    expect(initialSession(challenge, saved).phase).toBe('timeup');
  });

  it('discards progress that does not match the challenge', () => {
    const saved = toProgress({ ...initialSession(challenge, null), index: 1, answers: [record('zzz')] }, challenge, 'daily');
    expect(initialSession(challenge, saved)).toMatchObject({ index: 0, answers: [] });
  });
});
