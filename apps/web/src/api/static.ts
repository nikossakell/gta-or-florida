/**
 * Data source for static hosting (GitHub Pages): reads the JSON files produced
 * by `scripts/build-pages.ts` instead of calling the Node API. Same interface
 * and error codes as the HTTP client, so the UI doesn't know the difference.
 *
 * Note: without a server the answer files are publicly reachable. Reveals are
 * fetched one question at a time, only after answering — the same guarantee
 * the API gives. Cheating resistance is out of scope for this game.
 */
import {
  addDays,
  gradeChoices,
  isIsoDate,
  publicQuestionIndex,
  scoreCells,
  utcDate,
  type AnswerRequest,
  type AnswerResponse,
  type ArchiveResponse,
  type ChallengeResponse,
  type FinishRequest,
  type FinishResponse,
  type RevealedQuestion,
} from '@gof/core';
import { ApiError, withTimeout } from './client.ts';

type StaticArchive = ArchiveResponse & { archiveDays?: number };

export function createStaticApi(baseUrl: string, now: () => Date = () => new Date()) {
  const root = `${baseUrl.replace(/\/?$/, '/')}data`;

  async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${root}/${path}`, { headers: { accept: 'application/json' }, signal: withTimeout(signal) });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError') throw new ApiError('FEED_TIMEOUT', 'The server took too long to respond.');
      if (name === 'AbortError') throw error;
      throw new ApiError('NETWORK', 'Could not reach the server.');
    }
    if (res.status === 404) throw new ApiError('NOT_FOUND', 'Not found.', 404);
    if (!res.ok) throw new ApiError('BAD_RESPONSE', `HTTP ${res.status}`, res.status);
    try {
      return (await res.json()) as T;
    } catch {
      // Pages serves 404.html (HTML) for some missing paths with a 200 in previews.
      throw new ApiError('NOT_FOUND', 'Not found.', 404);
    }
  }

  async function challenge(id: 'today' | string, signal?: AbortSignal): Promise<ChallengeResponse> {
    const today = utcDate(now());
    const date = id === 'today' ? today : id;
    if (!isIsoDate(date)) throw new ApiError('BAD_REQUEST', 'Challenge id must be a date (YYYY-MM-DD).', 400);
    if (date > today) throw new ApiError('FUTURE_CHALLENGE', 'That challenge is not available yet.', 404);
    try {
      const c = await getJson<ChallengeResponse>(`challenge/${date}.json`, signal);
      return { ...c, today };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND' && date === today) {
        throw new ApiError('DAILY_NOT_READY', 'No challenge is published for today yet.', 503);
      }
      throw error;
    }
  }

  async function archive(signal?: AbortSignal): Promise<ArchiveResponse> {
    const today = utcDate(now());
    const data = await getJson<StaticArchive>('archive.json', signal);
    const oldest = addDays(today, -(data.archiveDays ?? 7));
    return {
      today,
      days: data.days
        .filter((d) => d.date <= today && d.date >= oldest)
        .map((d) => ({ ...d, isToday: d.date === today }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    };
  }

  function reveal(date: string, publicId: string): Promise<RevealedQuestion> {
    return getJson<RevealedQuestion>(`reveal/${date}/${publicId}.json`);
  }

  async function answer(challengeId: string, body: AnswerRequest): Promise<AnswerResponse> {
    const c = await challenge(challengeId);
    if (publicQuestionIndex(body.questionId, c.questions.length) < 0) {
      throw new ApiError('BAD_REQUEST', 'That question is not part of this challenge.', 400);
    }
    const q = await reveal(c.date, body.questionId);
    return { questionId: body.questionId, choice: body.choice, correct: q.answer === body.choice, question: q };
  }

  async function finish(challengeId: string, body: FinishRequest): Promise<FinishResponse> {
    const c = await challenge(challengeId);
    const choices = new Map(body.answers.map((a) => [a.questionId, a.choice]));
    const questions = await Promise.all(c.questions.map((q) => reveal(c.date, q.id)));
    const cells = gradeChoices(
      questions.map((q) => q.answer),
      c.questions.map((q) => choices.get(q.id) ?? null),
    );
    return { challengeId: c.challengeId, date: c.date, number: c.number, score: scoreCells(cells), total: cells.length, cells, questions };
  }

  return { challenge, archive, answer, finish };
}
