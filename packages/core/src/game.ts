import type { Answer, PlayerChoice, PublicQuestion, Question, RevealedQuestion } from './types.ts';

/**
 * Public, per-challenge question id ("h1", "h2", ...). Internal ids never leave
 * the server, because an id like "fl-0042" could itself spoil the answer.
 */
export function publicQuestionId(index: number): string {
  return `h${index + 1}`;
}

/** Inverse of publicQuestionId; -1 when malformed or out of range. */
export function publicQuestionIndex(id: unknown, size: number): number {
  if (typeof id !== 'string') return -1;
  const m = /^h([1-9][0-9]?)$/.exec(id);
  if (!m) return -1;
  const index = Number(m[1]) - 1;
  return index < size ? index : -1;
}

/** Strip everything that would spoil the answer. */
export function toPublicQuestion(q: Question, index: number): PublicQuestion {
  return { id: publicQuestionId(index), headline: q.headline };
}

export function toRevealedQuestion(q: Question, index: number): RevealedQuestion {
  const out: RevealedQuestion = {
    id: publicQuestionId(index),
    headline: q.headline,
    answer: q.answer,
    explanation: q.explanation,
    placeholder: q.placeholder === true,
  };
  if (q.answer === 'gta') out.gtaSubtype = q.gtaSubtype ?? 'fiction';
  // Sources are only ever shown for real (non-placeholder) items.
  if (!q.placeholder) {
    if (q.sourceUrl) out.sourceUrl = q.sourceUrl;
    if (q.sourceName) out.sourceName = q.sourceName;
    if (q.publishedAt) out.publishedAt = q.publishedAt;
  }
  return out;
}

export function isAnswer(value: unknown): value is Answer {
  return value === 'florida' || value === 'gta';
}

/** One cell per question: true = correct, false = wrong, null = unanswered (counts as a miss). */
export type ResultCell = boolean | null;

export function scoreCells(cells: readonly ResultCell[]): number {
  return cells.filter((c) => c === true).length;
}

export function gradeChoices(answers: readonly Answer[], choices: readonly PlayerChoice[]): ResultCell[] {
  return answers.map((answer, i) => {
    const choice = choices[i];
    return choice === null || choice === undefined ? null : choice === answer;
  });
}

export type ShareInput = {
  date: string;
  number?: number;
  cells: readonly ResultCell[];
  seconds?: number;
  url: string;
};

/**
 * Spoiler-free share text. Squares show whether the *player* was right,
 * never which answer was correct.
 *
 *   GTA or Florida? 🐊 #2026-11-19
 *   🟩🟩🟥🟩🟩
 *   4/5 — Can you beat me?
 *   https://example.com
 */
export function buildShareText({ date, cells, seconds, url }: ShareInput): string {
  const grid = cells.map((c) => (c === true ? '🟩' : c === false ? '🟥' : '⬜')).join('');
  const score = scoreCells(cells);
  const time = typeof seconds === 'number' ? ` in ${Math.max(0, Math.round(seconds))}s` : '';
  return [`GTA or Florida? 🐊 #${date}`, grid, `${score}/${cells.length}${time} — Can you beat me?`, url].join('\n');
}

export type ScoreTitle = { title: string; minRatio: number };

const TITLES: ScoreTitle[] = [
  { minRatio: 1, title: 'Certified gator brain' },
  { minRatio: 0.75, title: 'Swamp savant' },
  { minRatio: 0.5, title: 'Tourist with potential' },
  { minRatio: 0.25, title: 'Lost on I-4' },
  { minRatio: 0, title: 'Fresh off the plane' },
];

export function scoreTitle(score: number, total: number): string {
  const ratio = total > 0 ? score / total : 0;
  return (TITLES.find((t) => ratio >= t.minRatio) ?? TITLES[TITLES.length - 1]!).title;
}
