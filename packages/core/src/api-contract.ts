/** Contract for this app's own HTTP API (not a third-party API). */
import type { ResultCell } from './game.ts';
import type { Answer, PlayerChoice, PublicQuestion, RevealedQuestion } from './types.ts';

export type ChallengeResponse = {
  challengeId: string;
  date: string;
  number: number;
  /** Server's current UTC date, so clients don't trust their own clock for "today". */
  today: string;
  timeLimitSeconds: number;
  /** True when any question is development placeholder content. */
  sample: boolean;
  questions: PublicQuestion[];
};

export type AnswerRequest = { questionId: string; choice: Answer };

export type AnswerResponse = {
  questionId: string;
  choice: Answer;
  correct: boolean;
  question: RevealedQuestion;
};

export type FinishRequest = {
  answers: { questionId: string; choice: PlayerChoice }[];
};

export type FinishResponse = {
  challengeId: string;
  date: string;
  number: number;
  score: number;
  total: number;
  cells: ResultCell[];
  questions: RevealedQuestion[];
};

export type ArchiveEntry = { date: string; number: number; challengeId: string; isToday: boolean };

export type ArchiveResponse = { today: string; days: ArchiveEntry[] };

/** GET /api/health: liveness only. No secrets, paths, bindings or inventory internals. */
export type HealthResponse = {
  status: 'ok' | 'degraded';
  time: string;
  version: string;
  runtime: 'cloudflare-workers';
  db: 'ok' | 'error';
  todayReady: boolean;
};

export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'DAILY_NOT_READY',
  'ROUND_WITHDRAWN',
  'QUESTION_NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'FUTURE_CHALLENGE',
  'CONTENT_UNAVAILABLE',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ApiErrorBody = { error: { code: ApiErrorCode; message: string } };
