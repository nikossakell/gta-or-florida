import {
  addDays,
  daysBetween,
  gradeChoices,
  isAnswer,
  isIsoDate,
  publicQuestionIndex,
  scoreCells,
  toPublicQuestion,
  toRevealedQuestion,
  utcDate,
  type AnswerResponse,
  type ArchiveResponse,
  type ChallengeResponse,
  type FinishResponse,
  type HealthResponse,
  type PlayerChoice,
  type Question,
  type ScheduleDay,
} from '@gof/core';
import { HttpError } from '../http-error.ts';
import type { ContentStore } from './questions.ts';

export type ChallengeServiceOptions = {
  store: ContentStore;
  allowPlaceholders: boolean;
  archiveDays: number;
  timeLimitSeconds: number;
  now?: () => Date;
};

const MAX_ID_LENGTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createChallengeService(opts: ChallengeServiceOptions) {
  const now = opts.now ?? (() => new Date());

  function snapshot() {
    const snap = opts.store.get();
    if (!snap.schedule) {
      throw new HttpError(503, 'CONTENT_UNAVAILABLE', 'Challenge data is not available right now.');
    }
    return snap;
  }

  /** Resolve a scheduled day the player is allowed to see (today or within the archive window). */
  function resolveDay(challengeId: string): { day: ScheduleDay; questions: Question[]; today: string } {
    if (!isIsoDate(challengeId)) throw new HttpError(400, 'BAD_REQUEST', 'Challenge id must be a date (YYYY-MM-DD).');
    const today = utcDate(now());
    const age = daysBetween(challengeId, today);
    if (age < 0) throw new HttpError(404, 'FUTURE_CHALLENGE', 'That challenge is not available yet.');
    if (age > opts.archiveDays) throw new HttpError(404, 'NOT_FOUND', 'That challenge is outside the archive window.');

    const snap = snapshot();
    const day = snap.days.get(challengeId);
    if (!day) {
      if (challengeId === today) throw new HttpError(404, 'NO_CHALLENGE', 'No challenge is scheduled for today yet.');
      throw new HttpError(404, 'NOT_FOUND', 'No challenge was scheduled for that date.');
    }
    const questions = day.questionIds.map((id) => snap.questions.get(id));
    if (questions.some((q) => !q) || (!opts.allowPlaceholders && questions.some((q) => q?.placeholder))) {
      throw new HttpError(503, 'CONTENT_UNAVAILABLE', 'This challenge cannot be served right now.');
    }
    return { day, questions: questions as Question[], today };
  }

  function getChallenge(challengeId: string | 'today'): ChallengeResponse {
    const id = challengeId === 'today' ? utcDate(now()) : challengeId;
    const { day, questions, today } = resolveDay(id);
    return {
      challengeId: day.challengeId,
      date: day.date,
      number: day.number,
      today,
      timeLimitSeconds: opts.timeLimitSeconds,
      sample: questions.some((q) => q.placeholder === true),
      questions: questions.map((q, i) => toPublicQuestion(q, i)),
    };
  }

  function answer(challengeId: string, body: unknown): AnswerResponse {
    const { questions } = resolveDay(challengeId);
    if (!isPlainObject(body)) throw new HttpError(400, 'BAD_REQUEST', 'Expected a JSON object.');
    const { questionId, choice } = body;
    if (typeof questionId !== 'string' || questionId.length > MAX_ID_LENGTH) throw new HttpError(400, 'BAD_REQUEST', 'questionId is required.');
    if (!isAnswer(choice)) throw new HttpError(400, 'BAD_REQUEST', 'choice must be "florida" or "gta".');
    const index = publicQuestionIndex(questionId, questions.length);
    const q = questions[index];
    if (!q) throw new HttpError(400, 'BAD_REQUEST', 'That question is not part of this challenge.');
    return { questionId, choice, correct: q.answer === choice, question: toRevealedQuestion(q, index) };
  }

  function finish(challengeId: string, body: unknown): FinishResponse {
    const { day, questions } = resolveDay(challengeId);
    if (!isPlainObject(body) || !Array.isArray(body.answers)) throw new HttpError(400, 'BAD_REQUEST', 'Expected { answers: [...] }.');
    if (body.answers.length !== questions.length) {
      throw new HttpError(400, 'BAD_REQUEST', `Expected exactly ${questions.length} answers.`);
    }
    const choices = new Map<number, PlayerChoice>();
    for (const entry of body.answers) {
      if (!isPlainObject(entry) || typeof entry.questionId !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'Each answer needs a questionId.');
      if (!(entry.choice === null || isAnswer(entry.choice))) throw new HttpError(400, 'BAD_REQUEST', 'choice must be "florida", "gta" or null.');
      const index = publicQuestionIndex(entry.questionId, questions.length);
      if (index < 0) throw new HttpError(400, 'BAD_REQUEST', 'Answers do not match this challenge.');
      if (choices.has(index)) throw new HttpError(400, 'BAD_REQUEST', 'Duplicate questionId in answers.');
      choices.set(index, entry.choice);
    }

    const cells = gradeChoices(
      questions.map((q) => q.answer),
      questions.map((_, i) => choices.get(i) ?? null),
    );
    return {
      challengeId: day.challengeId,
      date: day.date,
      number: day.number,
      score: scoreCells(cells),
      total: questions.length,
      cells,
      questions: questions.map((q, i) => toRevealedQuestion(q, i)),
    };
  }

  function archive(): ArchiveResponse {
    const today = utcDate(now());
    const snap = snapshot();
    const days = [];
    for (let i = 0; i <= opts.archiveDays; i++) {
      const date = addDays(today, -i);
      const day = snap.days.get(date);
      if (!day) continue;
      if (!opts.allowPlaceholders && day.questionIds.some((id) => snap.questions.get(id)?.placeholder)) continue;
      days.push({ date, number: day.number, challengeId: day.challengeId, isToday: i === 0 });
    }
    return { today, days };
  }

  function health(): HealthResponse {
    const snap = opts.store.get();
    const today = utcDate(now());
    const out: HealthResponse = {
      status: snap.schedule && !snap.error ? 'ok' : 'degraded',
      time: now().toISOString(),
      questions: snap.questions.size,
      scheduledDays: snap.schedule?.days.length ?? 0,
      todayScheduled: snap.days.has(today),
    };
    if (snap.error) out.dataError = 'Latest content failed validation; serving last good data if available.';
    return out;
  }

  return { getChallenge, answer, finish, archive, health };
}

export type ChallengeService = ReturnType<typeof createChallengeService>;
