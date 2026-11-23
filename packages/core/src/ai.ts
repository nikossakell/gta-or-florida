/**
 * Model-output contracts for the batch classifier (Workers AI, called from the
 * ingestion job only — never per visitor).
 *
 * Model output is untrusted: it may be malformed, hallucinated, or steered by
 * prompt-injection text inside an article. We parse strictly, then *ground*
 * every claim against the text we sent and deterministic facts. Anything that
 * doesn't ground becomes a reason code that forces human review.
 */
import { CATEGORIES } from './types.ts';
import { GTA_GAMES, type GtaGame } from './content.ts';
import { cleanText, explanationProblems, playTitleProblems } from './editorial.ts';
import { parse, s, type Infer } from './schema.ts';

export const AI_REASON_CODES = [
  'NOT_AN_INCIDENT',
  'TANGENTIAL_FLORIDA',
  'POLITICS_SPORTS_BUSINESS',
  'TRAGEDY_OR_GRAPHIC',
  'MINOR_OR_PRIVATE_PERSON',
  'UNVERIFIED_ALLEGATION',
  'SATIRE',
  'NEEDS_LOCATION_VERIFICATION',
  'NEEDS_GAME_VERIFICATION',
  'NEEDS_DATE',
  'AMBIGUOUS',
  'OTHER',
] as const;
export type AiReasonCode = (typeof AI_REASON_CODES)[number];

const reasonCodes = s.array(s.enum(AI_REASON_CODES), { max: 8 });
const GAME_KEYS = Object.keys(GTA_GAMES) as GtaGame[];

/** Cheap first pass (Granite). */
export const triageSchema = s.object({
  relevant: s.boolean(),
  sensitive: s.boolean(),
  reasonCodes,
});
export type Triage = Infer<typeof triageSchema>;

/** Full extraction (Gemma), only for items that passed triage. */
export const assessmentSchema = s.object({
  relevant: s.boolean(),
  incidentCategory: s.enum(CATEGORIES),
  playTitle: s.string({ max: 240 }),
  explanationDraft: s.string({ max: 800 }),
  floridaEvidenceText: s.nullable(s.string({ max: 300 })),
  gtaGame: s.nullable(s.enum(GAME_KEYS)),
  sensitive: s.boolean(),
  needsReview: s.boolean(),
  reasonCodes,
});
export type Assessment = Infer<typeof assessmentSchema>;

/**
 * Extract the first balanced top-level JSON object from model text (models
 * sometimes wrap JSON in prose or code fences). Returns undefined if none parses.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function parseTriage(raw: unknown): { ok: true; value: Triage } | { ok: false; error: string } {
  const value = typeof raw === 'string' ? extractJsonObject(raw) : raw;
  const r = parse(triageSchema, value);
  return r.ok ? r : { ok: false, error: 'AI_SCHEMA_INVALID' };
}

export type GroundingContext = {
  kind: 'FLORIDA_NEWS' | 'GTA_CANON';
  /** Exactly the source text given to the model (title + excerpt). */
  sourceText: string;
  originalTitle: string;
  exactTitleAllowed: boolean;
  deterministicGame: GtaGame | null;
};

export type GroundedAssessment = {
  schemaValid: boolean;
  value: Assessment | null;
  /** Codes from the model plus grounding failures (prefixed GROUND_). */
  reasonCodes: string[];
  /** Drafts usable as review suggestions (still never auto-trusted). */
  playTitle: string | null;
  explanation: string | null;
};

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Strict parse + grounding of a full assessment. */
export function groundAssessment(raw: unknown, ctx: GroundingContext): GroundedAssessment {
  const value = typeof raw === 'string' ? extractJsonObject(raw) : raw;
  const r = parse(assessmentSchema, value);
  if (!r.ok) return { schemaValid: false, value: null, reasonCodes: ['AI_SCHEMA_INVALID'], playTitle: null, explanation: null };
  const a = r.value;
  const codes: string[] = [...a.reasonCodes];
  const playTitle = cleanText(a.playTitle, 240);
  const explanation = cleanText(a.explanationDraft, 800);

  if (playTitleProblems(playTitle, { originalTitle: ctx.originalTitle, exactTitleAllowed: ctx.exactTitleAllowed }).length) codes.push('GROUND_PLAY_TITLE');
  if (explanationProblems(explanation).length) codes.push('GROUND_EXPLANATION');
  if (ctx.kind === 'FLORIDA_NEWS') {
    // Evidence must be a verbatim quote from what we sent, not a model invention.
    if (!a.floridaEvidenceText || !norm(ctx.sourceText).includes(norm(a.floridaEvidenceText))) codes.push('GROUND_FLORIDA_EVIDENCE');
    if (a.gtaGame !== null) codes.push('GROUND_KIND_MISMATCH');
  } else {
    if (!a.gtaGame || a.gtaGame !== ctx.deterministicGame) codes.push('GROUND_GAME');
    if (a.floridaEvidenceText !== null) codes.push('GROUND_KIND_MISMATCH');
  }
  return { schemaValid: true, value: a, reasonCodes: [...new Set(codes)], playTitle: playTitle || null, explanation: explanation || null };
}
