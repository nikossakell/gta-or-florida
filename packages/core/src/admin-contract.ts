/**
 * Contract for the Worker's *protected* routes (/api/v1/admin/*). Callers are
 * the ingestion job (service token) and the owner's admin CLI (admin token).
 * Schemas double as runtime validation in the Worker.
 */
import { CATEGORIES } from './types.ts';
import { CONTENT_KINDS, GTA_GAMES, LINK_STATUSES, type GtaGame } from './content.ts';
import { s, type Infer } from './schema.ts';
import { incidentFactsSchema } from './facts.ts';
import type { PlanFailure } from './round-plan.ts';

/** Event id shared by questions about the same underlying event (e.g. "fl-2026-polk-airboat"). */
export const eventIdSchema = s.string({ min: 3, max: 80, pattern: /^[a-z0-9][a-z0-9:._-]*$/ });

export const MAX_IMPORT_ITEMS = 20;

/**
 * Admin/service bearer tokens: 32–512 visible ASCII characters (0x21–0x7E), nothing else.
 * This is exactly what the API Worker's `Authorization: Bearer …` parser accepts, so a client
 * can reject a token it could never authenticate with, before sending it anywhere.
 */
export const BEARER_TOKEN_MIN = 32;
export const BEARER_TOKEN_MAX = 512;

/** Why a configured token can't be sent as a bearer token (categories only — never the value). Empty = valid. */
export function bearerTokenProblems(token: unknown): string[] {
  if (token === undefined || token === null || token === '') return ['missing'];
  if (typeof token !== 'string') return ['not a string'];
  const out: string[] = [];
  if (token.length < BEARER_TOKEN_MIN) out.push(`shorter than ${BEARER_TOKEN_MIN} characters`);
  if (token.length > BEARER_TOKEN_MAX) out.push(`longer than ${BEARER_TOKEN_MAX} characters`);
  if (/[ \t\r\n]/.test(token)) out.push('contains spaces, tabs or line breaks');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(token)) out.push('contains control characters (e.g. pasted terminal escape codes)');
  if (/[^\x00-\x7f]/.test(token)) out.push('contains non-ASCII characters');
  if (/^bearer[ \t]/i.test(token)) out.push('includes the "Bearer " prefix');
  return out;
}
export const MAX_IMPORT_BYTES = 256 * 1024;
export const MAX_ADMIN_BODY_BYTES = 64 * 1024;

const GAME_KEYS = Object.keys(GTA_GAMES) as GtaGame[];
const isoDateTime = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;
const id = (max = 160) => s.string({ min: 1, max, pattern: /^[A-Za-z0-9:_.#%\-/]+$/ });
/** Incident keys embed wiki section anchors (apostrophes, commas, quotes…). Only ever bound as SQL parameters. */
const key = s.string({ min: 1, max: 320, pattern: /^[^\s<>\u0000-\u001f\u007f]+$/u });
/** WHATWG-serialized https URL: no whitespace, quotes or angle brackets (they arrive percent-encoded). */
const httpsUrl = s.string({ min: 12, max: 2048, pattern: /^https:\/\/[^\s<>"]+$/ });
const text = (max: number) => s.string({ max });
const reason = s.array(s.string({ min: 1, max: 80, pattern: /^[A-Z0-9_]+$/ }), { max: 40 });

export const linkCheckSchema = s.object({
  status: s.enum(LINK_STATUSES),
  httpStatus: s.nullable(s.int({ min: 0, max: 999 })),
  finalUrl: s.nullable(httpsUrl),
  checkedAt: s.string({ max: 40, pattern: isoDateTime }),
  note: s.optional(text(200)),
});
export type LinkCheck = Infer<typeof linkCheckSchema>;

export const aiTraceSchema = s.object({
  models: s.array(s.string({ min: 1, max: 80 }), { max: 4 }),
  promptVersion: s.string({ min: 1, max: 40 }),
  schemaValid: s.boolean(),
  relevant: s.boolean(),
  sensitive: s.boolean(),
  needsReview: s.boolean(),
  gtaGame: s.nullable(s.enum(GAME_KEYS)),
  category: s.nullable(s.enum(CATEGORIES)),
  reasonCodes: reason,
  tokensIn: s.int({ min: 0, max: 10_000_000 }),
  tokensOut: s.int({ min: 0, max: 10_000_000 }),
});
export type AiTrace = Infer<typeof aiTraceSchema>;

export const importItemSchema = s.object({
  kind: s.enum(CONTENT_KINDS),
  /** Stable incident identity: "gta:grandtheftwiki:<pageid>#<anchor>" or "fl:<fingerprint>". */
  incidentKey: key,
  /** Another outlet's report of an incident we already have (multi-source incident). */
  attachToIncidentKey: s.optional(key),
  reference: s.object({
    provider: s.string({ min: 1, max: 40, pattern: /^[a-z0-9_]+$/ }),
    providerKey: s.nullable(s.string({ min: 1, max: 300 })),
    originalUrl: httpsUrl,
    canonicalUrl: httpsUrl,
    originalTitle: s.string({ min: 1, max: 400 }),
    publisher: s.nullable(text(120)),
    publishedAt: s.nullable(s.string({ max: 40, pattern: isoDateTime })),
    providerSeenAt: s.nullable(s.string({ max: 40, pattern: isoDateTime })),
    wikiPageId: s.nullable(s.int({ min: 0, max: 1e12 })),
    wikiSection: s.nullable(text(200)),
    contentDigest: s.string({ min: 8, max: 80, pattern: /^[a-f0-9]+$/ }),
    linkCheck: s.nullable(linkCheckSchema),
  }),
  incident: s.object({
    category: s.enum(CATEGORIES),
    gameDetected: s.nullable(s.enum(GAME_KEYS)),
    floridaSignal: s.enum(['title', 'domain', 'none'] as const),
    floridaEvidence: s.nullable(text(300)),
    possibleDuplicateOfKey: s.nullable(key),
    similarity: s.nullable(s.number({ min: 0, max: 1 })),
    notes: s.nullable(text(1000)),
  }),
  question: s.object({
    playTitleDraft: s.string({ min: 1, max: 240 }),
    explanationDraft: text(800),
    difficulty: s.int({ min: 1, max: 3 }),
    /** Questions about the same underlying event share it (default: the incident). */
    eventId: s.optional(eventIdSchema),
    /** Left out of scheduling unless explicitly included. */
    spoiler: s.optional(s.boolean()),
  }),
  ai: s.nullable(aiTraceSchema),
  /** Deterministic pre-filter result from the job (the Worker re-checks policy itself). */
  prefilter: s.object({ decision: s.enum(['candidate', 'reject'] as const), reasonCodes: reason }),
  fixture: s.optional(s.boolean()),
  /** Structured facts (official-report adapters): roles, normalized actions, claims → evidence refs. No source text. */
  facts: s.optional(incidentFactsSchema),
});
export type ImportItem = Infer<typeof importItemSchema>;

export const runReportSchema = s.object({
  id: id(80),
  provider: s.string({ min: 1, max: 40 }),
  startedAt: s.string({ max: 40, pattern: isoDateTime }),
  finishedAt: s.nullable(s.string({ max: 40, pattern: isoDateTime })),
  status: s.enum(['running', 'ok', 'partial', 'failed'] as const),
  fetched: s.int({ min: 0, max: 1e7 }),
  newCount: s.int({ min: 0, max: 1e7 }),
  duplicates: s.int({ min: 0, max: 1e7 }),
  rejected: s.int({ min: 0, max: 1e7 }),
  errors: s.array(text(300), { max: 50 }),
  aiRequests: s.int({ min: 0, max: 1e6 }),
  tokensIn: s.int({ min: 0, max: 1e9 }),
  tokensOut: s.int({ min: 0, max: 1e9 }),
  neuronsEstimate: s.number({ min: 0, max: 1e9 }),
  models: s.array(s.string({ min: 1, max: 80 }), { max: 4 }),
});
export type RunReport = Infer<typeof runReportSchema>;

export const importBatchSchema = s.object({
  items: s.array(importItemSchema, { max: MAX_IMPORT_ITEMS }),
  run: s.optional(runReportSchema),
  checkpoints: s.optional(s.array(s.object({ provider: s.string({ min: 1, max: 40 }), key: s.string({ min: 1, max: 200 }), value: s.string({ max: 2000 }) }), { max: 20 })),
});
export type ImportBatch = Infer<typeof importBatchSchema>;

export type ImportItemResult = {
  incidentKey: string;
  outcome: 'inserted' | 'attached' | 'duplicate' | 'invalid';
  questionState?: 'candidate' | 'approved' | 'rejected';
  gate?: { decision: string; effective: string; reasons: string[] };
  errors?: string[];
};
export type ImportResponse = { results: ImportItemResult[]; replayed: boolean };

/** Prefilter lookup: which of these keys/URLs already exist (any state, incl. rejected). */
export const knownRequestSchema = s.object({
  canonicalUrls: s.array(httpsUrl, { max: 90 }),
  providerKeys: s.array(s.string({ min: 1, max: 300 }), { max: 90 }),
});
export type KnownResponse = { canonicalUrls: string[]; providerKeys: string[] };

/** Titles for client-side similarity (paged; the Worker does no fuzzy matching itself). */
export type TitleIndexResponse = { items: { incidentKey: string; title: string; kind: string; seenAt: string | null }[]; nextCursor: string | null };

export const APPROVAL_MODES = ['licensed', 'factual_summary'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** What the human reviewer verified for an Independent Factual Summary (all required, all explicit). */
export const TEXT_ORIGINS = ['human_written', 'machine_draft_reviewed'] as const;
export type TextOrigin = (typeof TEXT_ORIGINS)[number];

export const factualAttestationSchema = s.object({
  /** The play title and explanation were written by the reviewer, not copied or adapted from the source. */
  humanWritten: s.boolean(),
  /**
   * Who wrote the text. Default "human_written" (humanWritten must be true). "machine_draft_reviewed": the
   * reviewer checked a facts-first machine draft line by line against the evidence (humanWritten must then be
   * false — the attestation states what actually happened; no fabricated authorship).
   */
  textOrigin: s.optional(s.enum(TEXT_ORIGINS)),
  /** The incident itself happened as described (checked against the evidence, not just the headline). */
  incidentVerified: s.boolean(),
  /** Every factual claim in the explanation is supported by the evidence. */
  claimsVerified: s.boolean(),
  /** No private individual is named; charges are worded as allegations; no minors or victims identifiable. */
  privacyChecked: s.boolean(),
  verifiedDate: s.string({ max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ }),
  /** Florida news: the Florida place (e.g. "Pace, Florida"). GTA: the in-game place or game. */
  verifiedLocation: s.string({ min: 2, max: 120 }),
  /** Where the facts were checked (https). At least one must be the candidate's own source. */
  evidenceUrls: s.array(httpsUrl, { min: 1, max: 5 }),
  notes: s.optional(text(500)),
});
export type FactualAttestation = Infer<typeof factualAttestationSchema>;

export const reviewSchema = s.object({
  questionId: id(80),
  /** revoke: return an approved, never-scheduled question to review (admin only; needs a reason; a fresh approval follows). */
  action: s.enum(['approve', 'reject', 'edit', 'revoke'] as const),
  playTitle: s.optional(s.string({ max: 240 })),
  explanation: s.optional(s.string({ max: 800 })),
  category: s.optional(s.enum(CATEGORIES)),
  difficulty: s.optional(s.int({ min: 1, max: 3 })),
  game: s.optional(s.enum(GAME_KEYS)),
  locationVerified: s.optional(s.boolean()),
  publishedAt: s.optional(s.string({ max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ })),
  publisher: s.optional(s.string({ min: 1, max: 120 })),
  notDuplicate: s.optional(s.boolean()),
  /** Fresh check performed by the admin CLI (Node, SSRF-safe) right before approving. */
  linkCheck: s.optional(linkCheckSchema),
  linkVerifiedManually: s.optional(s.boolean()),
  reason: s.optional(s.string({ max: 500 })),
  /**
   * "licensed" (default): the source's reuse rights allow an editorial summary (unchanged path).
   * "factual_summary": Independent Factual Summary — the reviewer publishes independently verified
   * facts in their OWN words with a link, without reusing the publisher's wording. Requires `factual`.
   */
  mode: s.optional(s.enum(APPROVAL_MODES)),
  factual: s.optional(factualAttestationSchema),
  /** Group with other questions about the same event (approve/edit; editable on approved questions too). */
  eventId: s.optional(eventIdSchema),
  /** Mark as a spoiler (excluded from scheduling by default). Editable on approved questions too. */
  spoiler: s.optional(s.boolean()),
});
export type ReviewRequest = Infer<typeof reviewSchema>;

export const scheduleSchema = s.object({
  /** Period to plan (30 or 90 are the documented horizons; the Worker caps it at MAX_SCHEDULE_DAYS). */
  days: s.int({ min: 1, max: 366 }),
  startDate: s.optional(s.string({ max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ })),
  dryRun: s.optional(s.boolean()),
  /** Event cooldown in days (default EVENT_COOLDOWN_DAYS). */
  cooldownDays: s.optional(s.int({ min: 0, max: 365 })),
  /** Include questions marked as spoilers (excluded by default). */
  includeSpoilers: s.optional(s.boolean()),
  /** Write the days that can be planned even if the whole period cannot (the cron does this). */
  allowPartial: s.optional(s.boolean()),
});
export type ScheduleRequest = Infer<typeof scheduleSchema>;

export const withdrawSchema = s.object({
  target: s.enum(['question', 'day'] as const),
  id: id(80),
  reason: s.string({ min: 5, max: 300 }),
  /** Shown to players on a withdrawn round. Defaults to a generic maintenance message. */
  publicMessage: s.optional(s.string({ min: 5, max: 200 })),
});
export type WithdrawRequest = Infer<typeof withdrawSchema>;

export const benchmarkSchema = s.object({
  policyVersion: s.string({ min: 1, max: 40 }),
  sampleSize: s.int({ min: 1, max: 1e6 }),
  falseApprovalRate: s.number({ min: 0, max: 1 }),
  measuredAt: s.string({ max: 40, pattern: isoDateTime }),
  notes: s.optional(s.string({ max: 1000 })),
});

export type ScheduleResponse = {
  /** false = the requested period could not be planned in full (see error); nothing was written unless allowPartial. */
  ok: boolean;
  added: { date: string; floridaCount: number }[];
  kept: string[];
  /** First date that could not be filled, if any. */
  shortageDate: string | null;
  error: { code: 'SCHEDULE_INFEASIBLE'; date: string; message: string; details: PlanFailure } | null;
  warnings: { code: string; date?: string; message: string }[];
  inventory: {
    /** Eligible questions that were never scheduled. */
    unusedFlorida: number;
    unusedGta: number;
    /** Eligible (and, unless included, non-spoiler) questions / distinct events in the bank. */
    eligibleFlorida: number;
    eligibleGta: number;
    floridaEvents: number;
    gtaEvents: number;
    excludedSpoilers: number;
    /** Consecutive days from the start date that are scheduled (or, in a dry run, would be). */
    runwayDays: number;
    scheduledAhead: number;
  };
  settings: { startDate: string; days: number; cooldownDays: number; includeSpoilers: boolean; dryRun: boolean; allowPartial: boolean };
};

export const DEFAULT_WITHDRAWN_MESSAGE = 'This round was withdrawn for a content review. Please check back later.';
