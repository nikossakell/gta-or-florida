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
