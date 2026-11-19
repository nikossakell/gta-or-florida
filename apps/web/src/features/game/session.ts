import type { ChallengeResponse } from '@gof/core';
import type { AnswerRecord, PlayMode, StoredProgress } from '../../lib/storage.ts';

export type Phase = 'question' | 'answering' | 'reveal' | 'timeup' | 'finishing';

export type SessionState = {
  index: number;
  phase: Phase;
  answers: AnswerRecord[];
  /** Time spent with a question on screen (the clock pauses during reveals). */
  elapsedMs: number;
  answerError: string | null;
  finishError: string | null;
  /** Where to return if submitting the round fails. */
  finishFrom: 'reveal' | 'timeup' | null;
};

export type SessionAction =
  | { type: 'choose' }
  | { type: 'answered'; record: AnswerRecord }
  | { type: 'answerFailed'; message: string }
  | { type: 'next' }
  | { type: 'tick'; deltaMs: number; limitMs: number }
  | { type: 'finish' }
  | { type: 'finishFailed'; message: string };

export function initialSession(challenge: ChallengeResponse, progress: StoredProgress | null): SessionState {
  const ids = challenge.questions.map((q) => q.id);
  const valid =
    progress &&
    progress.date === challenge.date &&
    progress.questionIds.length === ids.length &&
    progress.questionIds.every((id, i) => id === ids[i]) &&
    progress.answers.every((a, i) => a.questionId === ids[i]) &&
    progress.index >= 0 &&
    progress.index < ids.length &&
    (progress.answers.length === progress.index || progress.answers.length === progress.index + 1);

  if (!valid || !progress) {
    return { index: 0, phase: 'question', answers: [], elapsedMs: 0, answerError: null, finishError: null, finishFrom: null };
  }
  const limitMs = challenge.timeLimitSeconds * 1000;
  const timedOut = limitMs > 0 && progress.elapsedMs >= limitMs;
  return {
    index: progress.index,
    phase: timedOut || progress.phase === 'timeup' ? 'timeup' : progress.answers.length === progress.index + 1 ? 'reveal' : 'question',
    answers: progress.answers,
    elapsedMs: progress.elapsedMs,
    answerError: null,
    finishError: null,
    finishFrom: null,
  };
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'choose':
      return state.phase === 'question' ? { ...state, phase: 'answering', answerError: null } : state;
    case 'answered':
      if (state.phase !== 'answering') return state;
      return { ...state, phase: 'reveal', answers: [...state.answers, action.record] };
    case 'answerFailed':
      return state.phase === 'answering' ? { ...state, phase: 'question', answerError: action.message } : state;
    case 'next':
      return state.phase === 'reveal' ? { ...state, phase: 'question', index: state.index + 1, answerError: null } : state;
    case 'tick': {
      if (state.phase !== 'question') return state;
      const elapsedMs = state.elapsedMs + Math.max(0, action.deltaMs);
      if (action.limitMs > 0 && elapsedMs >= action.limitMs) return { ...state, elapsedMs: action.limitMs, phase: 'timeup' };
      return { ...state, elapsedMs };
    }
    case 'finish':
      if (state.phase !== 'reveal' && state.phase !== 'timeup') return state;
      return { ...state, phase: 'finishing', finishFrom: state.phase, finishError: null };
    case 'finishFailed':
      return state.phase === 'finishing' ? { ...state, phase: state.finishFrom ?? 'timeup', finishError: action.message } : state;
  }
}

export function toProgress(state: SessionState, challenge: ChallengeResponse, mode: PlayMode): StoredProgress {
  return {
    date: challenge.date,
    questionIds: challenge.questions.map((q) => q.id),
    mode,
    index: state.index,
    phase: state.phase === 'reveal' ? 'reveal' : state.phase === 'timeup' ? 'timeup' : 'question',
    elapsedMs: Math.round(state.elapsedMs),
    answers: state.answers,
    updatedAt: new Date().toISOString(),
  };
}
