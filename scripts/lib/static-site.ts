import {
  addDays,
  daysBetween,
  publicQuestionId,
  toPublicQuestion,
  toRevealedQuestion,
  type ArchiveResponse,
  type ChallengeResponse,
  type Question,
  type RevealedQuestion,
  type ScheduleFile,
} from '@gof/core';

/**
 * Static data layout for hosts without a server (GitHub Pages):
 *
 *   data/archive.json                    published days (≤ today + leadDays, within the archive window)
 *   data/challenge/<date>.json           public questions only — no answers, explanations or sources
 *   data/reveal/<date>/<h1..hN>.json     one file per question, fetched only after it is answered
 *
 * Without a server, a determined player CAN fetch reveal files early. That is
 * no weaker than the API's per-question reveal endpoint, and cheating resistance
 * is explicitly out of scope for this anonymous game. What we do guarantee:
 * future days are never published (rebuild daily), and answers are not part of
 * the initial challenge payload.
 */
export type StaticSiteOptions = {
  questions: readonly Question[];
  schedule: ScheduleFile;
  /** Build date (UTC). */
  today: string;
  archiveDays: number;
  /** Publish this many days ahead of `today`. 0 = never publish future rounds. */
  leadDays: number;
  timeLimitSeconds: number;
  allowPlaceholders: boolean;
};

export type StaticArchive = ArchiveResponse & { archiveDays: number };

export type StaticSite = {
  files: Map<string, unknown>;
  published: string[];
  skippedPlaceholderDays: string[];
};

export function buildStaticSite(opts: StaticSiteOptions): StaticSite {
  const byId = new Map(opts.questions.filter((q) => q.status === 'verified').map((q) => [q.id, q]));
  const first = addDays(opts.today, -opts.archiveDays);
  const last = addDays(opts.today, opts.leadDays);

  const files = new Map<string, unknown>();
  const published: string[] = [];
  const skippedPlaceholderDays: string[] = [];

  for (const day of opts.schedule.days) {
    if (daysBetween(first, day.date) < 0 || daysBetween(day.date, last) < 0) continue;
    const questions = day.questionIds.map((id) => byId.get(id));
    if (questions.some((q) => !q)) throw new Error(`${day.date} references a missing or unverified question`);
    const qs = questions as Question[];
    if (!opts.allowPlaceholders && qs.some((q) => q.placeholder)) {
      skippedPlaceholderDays.push(day.date);
      continue;
    }

    const challenge: ChallengeResponse = {
      challengeId: day.challengeId,
      date: day.date,
      number: day.number,
      today: opts.today, // the client replaces this with its own UTC date
      timeLimitSeconds: opts.timeLimitSeconds,
      sample: qs.some((q) => q.placeholder === true),
      questions: qs.map((q, i) => toPublicQuestion(q, i)),
    };
    files.set(`data/challenge/${day.date}.json`, challenge);
    qs.forEach((q, i) => {
      const reveal: RevealedQuestion = toRevealedQuestion(q, i);
      files.set(`data/reveal/${day.date}/${publicQuestionId(i)}.json`, reveal);
    });
    published.push(day.date);
  }

  const archive: StaticArchive = {
    today: opts.today,
    archiveDays: opts.archiveDays,
    days: published
      .slice()
      .sort((a, b) => b.localeCompare(a))
      .map((date) => {
        const day = opts.schedule.days.find((d) => d.date === date)!;
        return { date, number: day.number, challengeId: day.challengeId, isToday: date === opts.today };
      }),
  };
  files.set('data/archive.json', archive);

  return { files, published, skippedPlaceholderDays };
}
