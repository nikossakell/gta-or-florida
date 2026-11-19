import { daysBetween, isIsoDate } from './dates.ts';
import { canonicalizeUrl, findSimilarPairs } from './dedupe.ts';
import {
  ANSWERS,
  CATEGORIES,
  DIFFICULTIES,
  GTA_SUBTYPES,
  STATUSES,
  type Answer,
  type Question,
  type ScheduleFile,
} from './types.ts';

export type Issue = {
  level: 'error' | 'warning';
  code: string;
  message: string;
  questionId?: string;
  date?: string;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const HEADLINE_MIN = 12;
const HEADLINE_MAX = 200;
const EXPLANATION_MIN = 10;
const EXPLANATION_MAX = 600;

export const NEAR_DUPLICATE_ERROR = 0.82;
export const NEAR_DUPLICATE_WARNING = 0.65;

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isIsoDateOrDateTime(value: unknown): boolean {
  return typeof value === 'string' && (isIsoDate(value) || (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))));
}

/** Structural + editorial checks for one question. Accepts unknown input (parsed JSON). */
export function validateQuestion(raw: unknown): Issue[] {
  const issues: Issue[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [{ level: 'error', code: 'not_object', message: 'Question must be an object' }];
  }
  const q = raw as Partial<Question> & Record<string, unknown>;
  const id = typeof q.id === 'string' ? q.id : undefined;
  const err = (code: string, message: string) => issues.push({ level: 'error', code, message, questionId: id });
  const warn = (code: string, message: string) => issues.push({ level: 'warning', code, message, questionId: id });

  if (!id || !ID_PATTERN.test(id)) err('invalid_id', `Invalid id ${JSON.stringify(q.id)} (lowercase a-z, 0-9, _ or -, 3-64 chars)`);

  if (typeof q.headline !== 'string' || q.headline.trim().length < HEADLINE_MIN || q.headline.length > HEADLINE_MAX) {
    err('invalid_headline', `Headline must be ${HEADLINE_MIN}-${HEADLINE_MAX} characters`);
  } else if (/[<>]/.test(q.headline)) {
    err('markup_in_headline', 'Headline must be plain text (no < or >)');
  }

  if (typeof q.explanation !== 'string' || q.explanation.trim().length < EXPLANATION_MIN || q.explanation.length > EXPLANATION_MAX) {
    err('invalid_explanation', `Explanation must be ${EXPLANATION_MIN}-${EXPLANATION_MAX} characters`);
  }

  if (!ANSWERS.includes(q.answer as Answer)) err('invalid_answer', `Answer must be one of ${ANSWERS.join(', ')}`);
  if (!STATUSES.includes(q.status as never)) err('invalid_status', `Status must be one of ${STATUSES.join(', ')}`);
  if (!CATEGORIES.includes(q.category as never)) err('invalid_category', `Category must be one of ${CATEGORIES.join(', ')}`);
  if (!DIFFICULTIES.includes(q.difficulty as never)) err('invalid_difficulty', 'Difficulty must be 1, 2 or 3');
  if (typeof q.canonicalEventId !== 'string' || q.canonicalEventId.trim() === '') {
    err('missing_canonical_event', 'canonicalEventId is required');
  }
  if (q.placeholder !== undefined && typeof q.placeholder !== 'boolean') err('invalid_placeholder', 'placeholder must be boolean');
  if (q.sourceUrl !== undefined && !isHttpsUrl(q.sourceUrl)) err('invalid_source_url', 'sourceUrl must be an https URL');
  if (q.publishedAt !== undefined && !isIsoDateOrDateTime(q.publishedAt)) err('invalid_published_at', 'publishedAt must be an ISO date');
  if (q.reviewedAt !== undefined && !isIsoDateOrDateTime(q.reviewedAt)) err('invalid_reviewed_at', 'reviewedAt must be an ISO date');
  if (q.approvedAt !== undefined && !isIsoDateOrDateTime(q.approvedAt)) err('invalid_approved_at', 'approvedAt must be an ISO date');

  const verified = q.status === 'verified';
  if (verified && !q.reviewedAt) err('missing_review', 'Verified questions need reviewedAt (human approval)');

  if (q.answer === 'florida') {
    if (q.gtaSubtype !== undefined) err('subtype_on_florida', 'gtaSubtype only applies to gta answers');
    if (q.placeholder) {
      // A placeholder is invented text: attaching a real-looking source would be false sourcing.
      if (q.sourceUrl || q.sourceName || q.publishedAt) {
        err('placeholder_with_source', 'Placeholder Florida items must not carry sourceUrl/sourceName/publishedAt');
      }
    } else if (verified) {
      if (!q.sourceUrl) err('missing_source', 'Verified Florida answers require a reviewed sourceUrl');
      if (!q.sourceName) err('missing_source_name', 'Verified Florida answers require sourceName');
      if (!q.publishedAt) err('missing_published_at', 'Verified Florida answers require publishedAt');
    }
  }

  if (q.answer === 'gta') {
    const subtype = q.gtaSubtype ?? 'fiction';
    if (!GTA_SUBTYPES.includes(subtype)) err('invalid_gta_subtype', `gtaSubtype must be one of ${GTA_SUBTYPES.join(', ')}`);
    if (subtype === 'fiction' && q.sourceUrl) {
      err('fiction_with_source', 'Fictional scenarios must not cite a source (they are original writing)');
    }
    if (subtype === 'gta_lore' && verified && !q.sourceUrl) {
      err('missing_lore_source', 'gta_lore questions require a sourceUrl for the canon claim');
    }
    if (typeof q.explanation === 'string' && /\b(gta ?(vi|6)|grand theft auto (vi|6))\b.*\bcanon\b/i.test(q.explanation)) {
      warn('canon_claim', 'Explanation appears to claim GTA VI canon; fiction must be labeled as fiction');
    }
  }

  return issues;
}

/** Validate a full question bank: per-item checks plus cross-item duplicate detection. */
export function validateQuestionBank(questions: readonly unknown[]): Issue[] {
  const issues: Issue[] = [];
  questions.forEach((q) => issues.push(...validateQuestion(q)));

  const typed = questions.filter((q): q is Question => typeof q === 'object' && q !== null) as Question[];

  const seenIds = new Map<string, number>();
  for (const q of typed) seenIds.set(q.id, (seenIds.get(q.id) ?? 0) + 1);
  for (const [id, count] of seenIds) {
    if (count > 1) issues.push({ level: 'error', code: 'duplicate_id', message: `Duplicate id "${id}" (${count}×)`, questionId: id });
  }

  const live = typed.filter((q) => q.status === 'verified');

  const byEvent = new Map<string, string[]>();
  for (const q of live) byEvent.set(q.canonicalEventId, [...(byEvent.get(q.canonicalEventId) ?? []), q.id]);
  for (const [eventId, ids] of byEvent) {
    if (ids.length > 1) {
      issues.push({
        level: 'error',
        code: 'duplicate_canonical_event',
        message: `canonicalEventId "${eventId}" is used by ${ids.join(', ')}; one playable question per real-world event`,
        questionId: ids[1],
      });
    }
  }

  const byUrl = new Map<string, string>();
  for (const q of live) {
    if (!q.sourceUrl) continue;
    const canonical = canonicalizeUrl(q.sourceUrl);
    if (!canonical) continue;
    const prior = byUrl.get(canonical);
    if (prior) {
      issues.push({ level: 'error', code: 'duplicate_source', message: `${q.id} and ${prior} cite the same article`, questionId: q.id });
    } else byUrl.set(canonical, q.id);
  }

  for (const pair of findSimilarPairs(
    live.map((q) => ({ id: q.id, title: q.headline })),
    NEAR_DUPLICATE_WARNING,
  )) {
    const level = pair.similarity >= NEAR_DUPLICATE_ERROR ? 'error' : 'warning';
    issues.push({
      level,
      code: 'near_duplicate_headline',
      message: `${pair.a} and ${pair.b} have near-duplicate headlines (similarity ${pair.similarity})`,
      questionId: pair.b,
    });
  }

  return issues;
}

/** Allowed number of Florida answers in a day of `size` questions (~50/50, never all one side). */
export function answerBalanceRange(size: number): [min: number, max: number] {
  if (size <= 1) return [0, size];
  return [Math.max(1, Math.floor(size * 0.4)), Math.min(size - 1, Math.ceil(size * 0.6))];
}

export type ScheduleValidationOptions = {
  /** Fail if a day references placeholder (sample) content. */
  forbidPlaceholders?: boolean;
};

/** Validate a schedule against the bank: references, sizes, balance and repeat windows. */
export function validateSchedule(
  schedule: ScheduleFile,
  questions: readonly Question[],
  options: ScheduleValidationOptions = {},
): Issue[] {
  const issues: Issue[] = [];
  const err = (code: string, message: string, date?: string, questionId?: string) =>
    issues.push({ level: 'error', code, message, date, questionId });

  if (schedule.version !== 1) err('schedule_version', 'Unsupported schedule version');
  if (!isIsoDate(schedule.epoch)) err('schedule_epoch', 'Schedule epoch must be YYYY-MM-DD');
  if (!Number.isInteger(schedule.size) || schedule.size < 1 || schedule.size > 20) err('schedule_size', 'Schedule size must be an integer 1-20');
  if (!Number.isInteger(schedule.cooldownDays) || schedule.cooldownDays < 0) err('schedule_cooldown', 'cooldownDays must be a non-negative integer');
  if (!Array.isArray(schedule.days)) {
    err('schedule_days', 'Schedule days must be an array');
    return issues;
  }
  if (issues.length) return issues;

  const byId = new Map(questions.map((q) => [q.id, q]));
  const seenDates = new Set<string>();
  const seenChallengeIds = new Set<string>();
  const lastUseOfQuestion = new Map<string, string>();
  const lastUseOfEvent = new Map<string, string>();
  const [minFlorida, maxFlorida] = answerBalanceRange(schedule.size);
  let previousDate: string | null = null;

  for (const day of schedule.days) {
    const date = day.date;
    if (!isIsoDate(date)) {
      err('invalid_date', `Invalid date ${JSON.stringify(date)}`);
      continue;
    }
    if (seenDates.has(date)) err('duplicate_date', `Date ${date} is scheduled more than once`, date);
    seenDates.add(date);
    if (previousDate && daysBetween(previousDate, date) <= 0) err('unsorted_days', `Days must be in ascending order (${previousDate} → ${date})`, date);
    previousDate = date;

    if (isIsoDate(schedule.epoch) && day.number !== daysBetween(schedule.epoch, date) + 1) {
      err('invalid_number', `Day ${date} should be #${daysBetween(schedule.epoch, date) + 1}, found #${day.number}`, date);
    }
    if (!day.challengeId || seenChallengeIds.has(day.challengeId)) err('invalid_challenge_id', `Missing or duplicate challengeId on ${date}`, date);
    seenChallengeIds.add(day.challengeId);

    if (!Array.isArray(day.questionIds) || day.questionIds.length !== schedule.size) {
      err('wrong_size', `${date} has ${day.questionIds?.length ?? 0} questions, expected ${schedule.size}`, date);
      continue;
    }
    if (new Set(day.questionIds).size !== day.questionIds.length) err('repeat_in_day', `${date} repeats a question`, date);

    let florida = 0;
    const eventsToday = new Set<string>();
    for (const qid of day.questionIds) {
      const q = byId.get(qid);
      if (!q) {
        err('unknown_question', `${date} references unknown question "${qid}"`, date, qid);
        continue;
      }
      if (q.status !== 'verified') err('unverified_question', `${date} references ${q.status} question "${qid}"`, date, qid);
      if (options.forbidPlaceholders && q.placeholder) err('placeholder_scheduled', `${date} schedules placeholder "${qid}"`, date, qid);
      if (q.answer === 'florida') florida++;

      if (eventsToday.has(q.canonicalEventId)) err('repeat_event_in_day', `${date} contains canonical event "${q.canonicalEventId}" twice`, date, qid);
      eventsToday.add(q.canonicalEventId);

      const lastQ = lastUseOfQuestion.get(qid);
      if (lastQ && daysBetween(lastQ, date) < schedule.cooldownDays) {
        err('cooldown_violation', `"${qid}" repeats on ${date}, only ${daysBetween(lastQ, date)} days after ${lastQ} (cooldown ${schedule.cooldownDays})`, date, qid);
      }
      const lastE = lastUseOfEvent.get(q.canonicalEventId);
      if (lastE && lastE !== date && daysBetween(lastE, date) < schedule.cooldownDays && lastE !== lastQ) {
        err('event_cooldown_violation', `Event "${q.canonicalEventId}" repeats on ${date} within the cooldown window`, date, qid);
      }
      lastUseOfQuestion.set(qid, date);
      lastUseOfEvent.set(q.canonicalEventId, date);
    }
    if (florida < minFlorida || florida > maxFlorida) {
      err('answer_imbalance', `${date} has ${florida} Florida / ${schedule.size - florida} GTA; allowed Florida count ${minFlorida}-${maxFlorida}`, date);
    }
  }
  return issues;
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
