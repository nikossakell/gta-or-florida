/**
 * Public game: read-only, one indexed query per request (Workers Free: 10 ms CPU).
 * Answers, kinds, sources and games never leave the Worker before a guess.
 */
import {
  addDays,
  daysBetween,
  gradeChoices,
  isIsoDate,
  publicQuestionIndex,
  scoreCells,
  SOURCE_CTA,
  toPublicQuestion,
  toRevealedQuestion,
  utcDate,
  type Answer,
  type AnswerResponse,
  type ArchiveResponse,
  type ChallengeResponse,
  type ContentKind,
  type FinishResponse,
  type GtaGame,
  type PlayerChoice,
  type Question,
} from '@gof/core';
import { ARCHIVE_DAYS, TIME_LIMIT_SECONDS } from '@gof/config';
import { DEFAULT_WITHDRAWN_MESSAGE } from '@gof/core';
import { isLocal, type Env } from '../env.ts';
import { HttpError } from '../http.ts';

type RoundRow = {
  day: string;
  number: number;
  status: 'scheduled' | 'published' | 'withdrawn';
  public_message: string | null;
  content_version: number;
  position: number | null;
  question_id: string | null;
  quality_state: string | null;
  answer_kind: 'FLORIDA' | 'GTA' | null;
  play_title: string | null;
  explanation: string | null;
  is_fixture: number | null;
  kind: ContentKind | null;
  game: string | null;
  category: string | null;
  incident_status: string | null;
  original_url: string | null;
  final_url: string | null;
  original_title: string | null;
  publisher: string | null;
  published_at: string | null;
  link_status: string | null;
  source_name: string | null;
  license_status: string | null;
  can_use_editorial_summary: number | null;
  can_display_original_title: number | null;
};

const ROUND_SQL = `
  SELECT r.day, r.number, r.status, r.public_message, r.content_version,
         i.position, q.id AS question_id, q.quality_state, q.answer_kind, q.play_title, q.explanation, q.is_fixture,
         inc.kind, inc.game, inc.category, inc.status AS incident_status,
         sr.original_url, sr.final_url, sr.original_title, sr.publisher, sr.published_at, sr.link_status,
         s.name AS source_name, s.license_status, s.can_use_editorial_summary, s.can_display_original_title
    FROM daily_rounds r
    LEFT JOIN daily_round_items i ON i.day = r.day
    LEFT JOIN questions q ON q.id = i.question_id
    LEFT JOIN incidents inc ON inc.id = q.incident_id
    LEFT JOIN source_references sr ON sr.id = q.primary_reference_id
    LEFT JOIN sources s ON s.id = sr.source_id
   WHERE r.day = ?
   ORDER BY i.position`;

function toQuestion(r: RoundRow): Question {
  const answer: Answer = r.answer_kind === 'FLORIDA' ? 'florida' : 'gta';
  const fixture = r.is_fixture === 1;
  const q: Question = {
    id: r.question_id!,
    headline: r.play_title!,
    answer,
    explanation: r.explanation!,
    status: 'verified',
    category: (r.category ?? 'other') as Question['category'],
    difficulty: 2,
    canonicalEventId: r.question_id!,
    placeholder: fixture,
  };
  if (r.kind) q.kind = r.kind;
  if (answer === 'gta') q.gtaSubtype = fixture ? 'fiction' : 'gta_lore';
  if (!fixture) {
    q.sourceUrl = r.original_url ?? undefined;
    q.sourceName = r.publisher ?? r.source_name ?? undefined;
    if (r.kind) q.sourceCta = SOURCE_CTA[r.kind];
    if (r.published_at) q.publishedAt = r.published_at;
    if (r.game) q.game = r.game as GtaGame;
    // Exact headline only when the owner-reviewed source policy allows it.
    if (r.can_display_original_title === 1 && r.original_title) q.originalTitle = r.original_title;
  }
  return q;
}

export type ResolvedRound = { day: string; number: number; contentVersion: number; questions: Question[]; today: string };

export function createChallengeService(env: Env, now: () => Date = () => new Date()) {
  const allowFixtures = isLocal(env);

  async function resolveDay(day: string): Promise<ResolvedRound> {
    if (!isIsoDate(day)) throw new HttpError(400, 'BAD_REQUEST', 'Challenge id must be a date (YYYY-MM-DD).');
    const today = utcDate(now());
    const age = daysBetween(day, today);
    if (age < 0) throw new HttpError(404, 'FUTURE_CHALLENGE', 'That challenge is not available yet.');
    if (age > ARCHIVE_DAYS) throw new HttpError(404, 'NOT_FOUND', 'That challenge is outside the archive window.');

    const { results } = await env.DB.prepare(ROUND_SQL).bind(day).all<RoundRow>();
    const notReady = () =>
      day === today
        ? new HttpError(503, 'DAILY_NOT_READY', 'Today’s round is not ready yet. Please check back soon.', { 'Retry-After': '300' })
        : new HttpError(404, 'NOT_FOUND', 'No challenge was scheduled for that date.');
    if (results.length === 0) throw notReady();
    const head = results[0]!;
    if (head.status === 'withdrawn') throw new HttpError(410, 'ROUND_WITHDRAWN', head.public_message ?? DEFAULT_WITHDRAWN_MESSAGE);

    // Defence in depth: a round is served only if every item is still publishable *now*.
    const servable =
      results.length === 5 &&
      results.every(
        (r) =>
          r.question_id &&
          r.quality_state === 'approved' &&
          r.incident_status === 'active' &&
          (r.is_fixture === 1
            ? allowFixtures
            : r.license_status === 'approved' && r.can_use_editorial_summary === 1 && (r.link_status === 'ok' || r.link_status === 'manual_ok')),
      );
    if (!servable) throw notReady();
    return { day, number: head.number, contentVersion: head.content_version, questions: results.map(toQuestion), today };
  }

  async function getChallenge(id: 'today' | string): Promise<{ body: ChallengeResponse; etag: string }> {
    const day = id === 'today' ? utcDate(now()) : id;
    const r = await resolveDay(day);
    const body: ChallengeResponse = {
      challengeId: r.day,
      date: r.day,
      number: r.number,
      today: r.today,
      timeLimitSeconds: TIME_LIMIT_SECONDS,
      sample: r.questions.some((q) => q.placeholder === true),
      questions: r.questions.map((q, i) => toPublicQuestion(q, i)),
    };
    return { body, etag: `"${r.day}-v${r.contentVersion}"` };
  }

  function parseChoice(value: unknown): Answer | null {
    if (value === 'florida' || value === 'FLORIDA') return 'florida';
    if (value === 'gta' || value === 'GTA') return 'gta';
    return null;
  }

  function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  async function answer(day: string, body: unknown): Promise<AnswerResponse> {
    if (!isObject(body)) throw new HttpError(400, 'BAD_REQUEST', 'Expected a JSON object.');
    const { questionId } = body;
    if (typeof questionId !== 'string' || questionId.length > 8) throw new HttpError(400, 'BAD_REQUEST', 'questionId is required.');
    const choice = parseChoice(body.choice);
    if (!choice) throw new HttpError(400, 'BAD_REQUEST', 'choice must be "FLORIDA" or "GTA".');
    const r = await resolveDay(day);
    const index = publicQuestionIndex(questionId, r.questions.length);
    const q = r.questions[index];
    if (!q) throw new HttpError(404, 'QUESTION_NOT_FOUND', 'That question is not part of this challenge.');
    // Reveals only this one question.
    return { questionId, choice, correct: q.answer === choice, question: toRevealedQuestion(q, index) };
  }

  async function finish(day: string, body: unknown): Promise<FinishResponse> {
    if (!isObject(body) || !Array.isArray(body.answers)) throw new HttpError(400, 'BAD_REQUEST', 'Expected { answers: [...] }.');
    const r = await resolveDay(day);
    if (body.answers.length !== r.questions.length) throw new HttpError(400, 'BAD_REQUEST', `Expected exactly ${r.questions.length} answers.`);
    const choices = new Map<number, PlayerChoice>();
    for (const entry of body.answers) {
      if (!isObject(entry) || typeof entry.questionId !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'Each answer needs a questionId.');
      const choice = entry.choice === null ? null : parseChoice(entry.choice);
      if (entry.choice !== null && !choice) throw new HttpError(400, 'BAD_REQUEST', 'choice must be "FLORIDA", "GTA" or null.');
      const index = publicQuestionIndex(entry.questionId, r.questions.length);
      if (index < 0) throw new HttpError(400, 'BAD_REQUEST', 'Answers do not match this challenge.');
      if (choices.has(index)) throw new HttpError(400, 'BAD_REQUEST', 'Duplicate questionId in answers.');
      choices.set(index, choice);
    }
    const cells = gradeChoices(
      r.questions.map((q) => q.answer),
      r.questions.map((_, i) => choices.get(i) ?? null),
    );
    return {
      challengeId: r.day,
      date: r.day,
      number: r.number,
      score: scoreCells(cells),
      total: r.questions.length,
      cells,
      questions: r.questions.map((q, i) => toRevealedQuestion(q, i)),
    };
  }

  async function archive(): Promise<ArchiveResponse> {
    const today = utcDate(now());
    const from = addDays(today, -ARCHIVE_DAYS);
    const { results } = await env.DB.prepare(
      `SELECT r.day, r.number, MAX(q.is_fixture) AS has_fixture, COUNT(i.position) AS items
         FROM daily_rounds r
         JOIN daily_round_items i ON i.day = r.day
         JOIN questions q ON q.id = i.question_id
        WHERE r.day BETWEEN ? AND ? AND r.status <> 'withdrawn'
        GROUP BY r.day ORDER BY r.day DESC`,
    )
      .bind(from, today)
      .all<{ day: string; number: number; has_fixture: number; items: number }>();
    const days = results
      .filter((r) => r.items === 5 && (allowFixtures || r.has_fixture === 0))
      .map((r) => ({ date: r.day, number: r.number, challengeId: r.day, isToday: r.day === today }));
    return { today, days };
  }

  async function todayReady(): Promise<boolean> {
    try {
      await resolveDay(utcDate(now()));
      return true;
    } catch {
      return false;
    }
  }

  return { getChallenge, answer, finish, archive, todayReady, resolveDay };
}
