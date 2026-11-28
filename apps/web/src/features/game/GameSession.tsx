import type { Answer, ChallengeResponse, FinishResponse } from '@gof/core';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { api, ApiError } from '../../api/index.ts';
import { clearProgress, getProgress, saveProgress, saveResult, type PlayMode, type StoredResult } from '../../lib/storage.ts';
import { initialSession, sessionReducer, toProgress } from './session.ts';
import { DriveSession } from '../../daily-drive/screens/DriveSession.tsx';

function friendly(error: unknown, fallback: string): string {
  if (error instanceof ApiError && (error.code === 'NETWORK' || error.code === 'FEED_TIMEOUT')) {
    return 'Connection hiccup — tap again to retry.';
  }
  return fallback;
}

export function GameSession({
  challenge,
  practice,
  onComplete,
}: {
  challenge: ChallengeResponse;
  /** Replays are never saved and never touch streaks. */
  practice: boolean;
  onComplete: (result: StoredResult, saved: boolean) => void;
}) {
  const mode: PlayMode = challenge.date === challenge.today ? 'daily' : 'archive';
  const [state, dispatch] = useReducer(sessionReducer, null, () => initialSession(challenge, practice ? null : getProgress(challenge.date)));
  const total = challenge.questions.length;
  const limitMs = challenge.timeLimitSeconds * 1000;
  const question = challenge.questions[state.index];

  // Clock: runs only while a question is on screen.
  useEffect(() => {
    if (state.phase !== 'question') return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      dispatch({ type: 'tick', deltaMs: now - last, limitMs });
      last = now;
    }, 200);
    return () => window.clearInterval(id);
  }, [state.phase, limitMs]);

  // Persist progress (throttled to whole seconds) so a reload can't reset the round.
  const elapsedSecond = Math.floor(state.elapsedMs / 1000);
  useEffect(() => {
    if (practice || state.phase === 'finishing') return;
    saveProgress(toProgress(state, challenge, mode));
  }, [practice, challenge, mode, state.index, state.phase, state.answers, elapsedSecond]);

  const answerMutation = useMutation({
    mutationFn: (choice: Answer) => api.answer(challenge.challengeId, { questionId: question!.id, choice }),
    onSuccess: (res) =>
      dispatch({ type: 'answered', record: { questionId: res.questionId, choice: res.choice, correct: res.correct, question: res.question } }),
    onError: (error) => dispatch({ type: 'answerFailed', message: friendly(error, 'Couldn’t check that answer. Try again.') }),
  });

  const completed = useRef(false);
  const finishMutation = useMutation({
    mutationFn: () =>
      api.finish(challenge.challengeId, {
        answers: challenge.questions.map((q, i) => ({ questionId: q.id, choice: state.answers[i]?.choice ?? null })),
      }),
    onSuccess: (res: FinishResponse) => {
      if (completed.current) return;
      completed.current = true;
      const result: StoredResult = {
        date: res.date,
        number: res.number,
        mode,
        score: res.score,
        total: res.total,
        cells: res.cells,
        choices: challenge.questions.map((_, i) => state.answers[i]?.choice ?? null),
        seconds: Math.round(state.elapsedMs / 1000),
        timedOut: state.answers.length < total,
        completedAt: new Date().toISOString(),
        sample: challenge.sample,
        questions: res.questions,
      };
      if (practice) {
        onComplete(result, false);
        return;
      }
      const stored = saveResult(result);
      clearProgress(challenge.date);
      onComplete(stored, true);
    },
    onError: (error) => dispatch({ type: 'finishFailed', message: friendly(error, 'Couldn’t submit your round. Try again.') }),
  });

  const choose = useCallback(
    (choice: Answer) => {
      if (state.phase !== 'question') return;
      dispatch({ type: 'choose' });
      answerMutation.mutate(choice);
    },
    [state.phase, answerMutation],
  );

  const finish = useCallback(() => {
    dispatch({ type: 'finish' });
    finishMutation.mutate();
  }, [finishMutation]);

  const next = useCallback(() => {
    if (state.index + 1 >= total) finish();
    else dispatch({ type: 'next' });
  }, [state.index, total, finish]);

  const remainingMs = limitMs > 0 ? Math.max(0, limitMs - state.elapsedMs) : 0;
  // Presentation: the Daily Drive session; all state and callbacks live here.
  return (
    <DriveSession
      label={practice ? 'REPLAY' : mode === 'daily' ? 'DAILY DRIVE' : 'ARCHIVE'}
      number={challenge.number}
      questions={challenge.questions}
      state={state}
      remainingMs={remainingMs}
      limitMs={limitMs}
      onChoose={choose}
      onNext={next}
      onFinish={finish}
    />
  );
}
