/**
 * Editorial rules for player-facing text. Shared by the Worker (authoritative,
 * on review/import) and the ingestion job (early feedback). Pure functions.
 */
import { findGiveaways } from './content.ts';
import { normalizeTitle, titleSimilarity } from './dedupe.ts';

export const PLAY_TITLE_MIN = 12;
export const PLAY_TITLE_MAX = 200;
export const EXPLANATION_MIN = 20;
export const EXPLANATION_MAX = 600;
/** Approved play titles this similar to another approved title are treated as the same question. */
export const PLAY_TITLE_CLASH = 0.82;

// Control, zero-width and bidi-override characters: all source and model text is untrusted.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'g');

/** Strip control characters, collapse whitespace, cap length. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const URLISH = /\b(https?:\/\/|www\.)|\b[a-z0-9-]+\.(com|net|org|io|co|news|tv)\b/i;

export type PlayTitleContext = {
  originalTitle: string;
  /** Source policy allows showing/using the exact headline. */
  exactTitleAllowed: boolean;
  /** Other approved/retired play titles of the same answer side. */
  existingTitles?: readonly { id: string; title: string }[];
};

/** Problems with a play title; empty = acceptable. */
export function playTitleProblems(title: string, ctx: PlayTitleContext): string[] {
  const out: string[] = [];
  if (title.length < PLAY_TITLE_MIN || title.length > PLAY_TITLE_MAX) out.push(`PLAY_TITLE_LENGTH: must be ${PLAY_TITLE_MIN}-${PLAY_TITLE_MAX} characters`);
  if (/[<>]/.test(title)) out.push('PLAY_TITLE_MARKUP: must be plain text');
  if (URLISH.test(title)) out.push('PLAY_TITLE_URL: must not contain links or domains');
  const giveaways = findGiveaways(title);
  if (giveaways.length) out.push(`PLAY_TITLE_GIVEAWAY: gives the answer away (${giveaways.join(', ')})`);
  if (!ctx.exactTitleAllowed && ctx.originalTitle && normalizeTitle(title) === normalizeTitle(ctx.originalTitle)) {
    out.push('PLAY_TITLE_VERBATIM: is the verbatim source headline; write an original summary');
  }
  const clash = ctx.existingTitles?.find((t) => titleSimilarity(t.title, title) >= PLAY_TITLE_CLASH);
  if (clash) out.push(`PLAY_TITLE_DUPLICATE: near-duplicate of approved question ${clash.id}`);
  return out;
}

export function explanationProblems(text: string): string[] {
  const out: string[] = [];
  if (text.length < EXPLANATION_MIN || text.length > EXPLANATION_MAX) out.push(`EXPLANATION_LENGTH: must be ${EXPLANATION_MIN}-${EXPLANATION_MAX} characters`);
  if (/[<>]/.test(text)) out.push('EXPLANATION_MARKUP: must be plain text');
  if (/\bhttps?:\/\//i.test(text)) out.push('EXPLANATION_URL: links belong in the source reference, not the explanation');
  return out;
}

/** Problem code prefix ("PLAY_TITLE_GIVEAWAY: ..." → "PLAY_TITLE_GIVEAWAY"). */
export const problemCode = (problem: string) => problem.split(':')[0]!;

// ---------------------------------------------------------------------------
// Near-copy safeguards for Independent Factual Summaries. They catch obvious copying of a source
// headline; passing them is NOT proof of originality (the reviewer attests to that).
// ---------------------------------------------------------------------------

export const NEAR_COPY_SIMILARITY = 0.6;
export const NEAR_COPY_SHARED_WORDS = 5;

/** Longest run of consecutive identical words (after normalization) shared by two texts. */
export function longestSharedWordRun(a: string, b: string): number {
  const x = normalizeTitle(a).split(' ').filter(Boolean);
  const y = normalizeTitle(b).split(' ').filter(Boolean);
  let best = 0;
  const prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let diag = 0;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j]!;
      prev[j] = x[i - 1] === y[j - 1] ? diag + 1 : 0;
      if (prev[j]! > best) best = prev[j]!;
      diag = tmp;
    }
  }
  return best;
}

/** Problems when `text` copies the source headline too closely. Empty = no obvious copying detected. */
export function nearCopyProblems(text: string, sourceHeadline: string, field: 'PLAY_TITLE' | 'EXPLANATION'): string[] {
  if (!text || !sourceHeadline) return [];
  const out: string[] = [];
  if (field === 'PLAY_TITLE') {
    const sim = titleSimilarity(text, sourceHeadline);
    if (sim >= NEAR_COPY_SIMILARITY) out.push(`PLAY_TITLE_NEAR_COPY: too close to the source headline (similarity ${sim.toFixed(2)}); describe the facts in your own words`);
  }
  const run = longestSharedWordRun(text, sourceHeadline);
  if (run >= NEAR_COPY_SHARED_WORDS) out.push(`${field}_SHARED_PHRASE: repeats ${run} consecutive words of the source headline`);
  return out;
}

// ---------------------------------------------------------------------------
// Placeholder / generic-text guard for human approvals. Template text such as
// "YOUR OWN REVIEWED TITLE" satisfies the length rules, so it is refused explicitly.
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\byour own\b/i,
  /\b(placeholder|lorem ipsum|dummy text|sample text|fixme|todo|tbd)\b/i,
  /\bx{3,}\b/i,
  /\b(goes|go) here\b/i,
  /\b(insert|enter|write|type|add|put)\b[^.]{0,40}\bhere\b/i,
  /\b(reviewed|verified|neutral|example|sample|dummy|test) (play )?(title|explanation|summary|text)\b/i,
  /\{\{|\}\}|\[[A-Z_ ]{3,}\]|\{[A-Za-z_ ]{3,}\}/,
];

/** Whole texts that say nothing about the incident. */
const GENERIC_TEXTS = new Set([
  'title', 'play title', 'explanation', 'question', 'test', 'testing', 'n a', 'none', 'null', 'undefined', 'unknown',
  'same as above', 'see source', 'see link', 'see the source', 'see the link', 'no explanation', 'fill in', 'fill me in',
]);

/** Minimum distinct words (2+ letters) for text to describe an incident at all. */
const MIN_DISTINCT_WORDS = { PLAY_TITLE: 3, EXPLANATION: 5 } as const;

/**
 * Problems when reviewer text is a placeholder, template slot, all-capitals or too generic to be a real
 * summary. Empty = no placeholder detected (it does not judge accuracy; the reviewer attests to that).
 */
export function placeholderProblems(text: string, field: 'PLAY_TITLE' | 'EXPLANATION'): string[] {
  const out: string[] = [];
  const clean = text.trim();
  const normalized = normalizeTitle(clean);
  if (!clean || PLACEHOLDER_PATTERNS.some((re) => re.test(clean)) || GENERIC_TEXTS.has(normalized)) {
    out.push(`${field}_PLACEHOLDER: looks like placeholder or template text; write the real ${field === 'PLAY_TITLE' ? 'title' : 'explanation'}`);
  }
  const letters = clean.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 8 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    out.push(`${field}_ALL_CAPS: is written in capitals (typical of placeholders); use normal sentence case`);
  }
  const distinct = new Set(normalized.split(' ').filter((w) => /\p{L}{2,}/u.test(w)));
  if (distinct.size < MIN_DISTINCT_WORDS[field]) out.push(`${field}_GENERIC: too generic (${distinct.size} distinct words); describe the specific incident`);
  return out;
}
