/**
 * Curated question-bank batch format and its conversion to Worker import items.
 * Pure (depends only on @gof/core) so the Worker's tests can use the same conversion.
 * Offline validation (source policy, wording checks) is in bank.ts.
 */
import { canonicalizeUrl, CATEGORIES, eventIdSchema, formatIssues, GTA_GAMES, hashString, MANUAL_PROVIDER, parse, s, titleFingerprint, type ImportItem, type Infer } from '@gof/core';

const GAME_KEYS = Object.keys(GTA_GAMES) as (keyof typeof GTA_GAMES)[];

export const bankEntrySchema = s.object({
  /** Shared by every question about the same underlying event (cooldown + one per day). */
  eventId: eventIdSchema,
  origin: s.enum(['FLORIDA', 'GTA'] as const),
  /** The play headline: original wording, no answer giveaways. */
  headline: s.string({ min: 1, max: 240 }),
  /** Shown after answering: verified facts in original wording. */
  explanation: s.string({ min: 1, max: 800 }),
  /** Where the facts were verified (https). Linked after answering. */
  sourceUrl: s.string({ min: 8, max: 2048 }),
  /** The source's own headline/page title: internal only, used to check the headline is not copied. */
  sourceTitle: s.string({ min: 1, max: 400 }),
  publisher: s.optional(s.string({ min: 1, max: 120 })),
  /** YYYY-MM-DD the report was published (Florida: required at approval). */
  publishedAt: s.optional(s.string({ max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ })),
  /** Florida: where it happened, as verified ("Lakeland, Polk County, Florida"). */
  location: s.optional(s.string({ min: 3, max: 200 })),
  category: s.optional(s.enum(CATEGORIES)),
  difficulty: s.optional(s.int({ min: 1, max: 3 })),
  /** GTA: the game the event is documented in. */
  game: s.optional(s.enum(GAME_KEYS)),
  spoiler: s.optional(s.boolean()),
  /** Verification notes for the reviewer (internal). */
  notes: s.optional(s.string({ max: 1000 })),
});
export type BankEntry = Infer<typeof bankEntrySchema>;

export const bankFileSchema = s.object({
  /** Label for this collection round, e.g. "2027-Q1". */
  batch: s.string({ min: 1, max: 80 }),
  /** Development fixtures (placeholder text, example URLs): importable into the local Worker only. */
  fixture: s.optional(s.boolean()),
  questions: s.array(bankEntrySchema, { min: 1, max: 1000 }),
});
export type BankFile = Infer<typeof bankFileSchema>;

/** Hex digest from two independent 32-bit hashes (stable across platforms; not a security boundary). */
const hex = (v: string) => hashString(v).toString(16).padStart(8, '0') + hashString(`#${v}`).toString(16).padStart(8, '0');

/** Stable per-question key: the same draft imported twice is recognised as a duplicate. */
export function entryKey(e: Pick<BankEntry, 'eventId' | 'headline'>): string {
  return `${e.eventId}:${hex(`${e.eventId}\n${titleFingerprint(e.headline)}`).slice(0, 12)}`;
}

/** A validated entry as a Worker import item (a `manual` candidate; the Worker decides nothing but "review"). */
export function toImportItem(e: BankEntry, file: Pick<BankFile, 'batch' | 'fixture'>, now: Date): ImportItem {
  const key = entryKey(e);
  const canonical = canonicalizeUrl(e.sourceUrl) ?? e.sourceUrl;
  // One reference row per question: questions about the same article must not collide on canonical_url.
  const canonicalUrl = `${canonical.replace(/#.*$/, '')}#bank-${key.slice(-12)}`;
  const notes = [`Curated bank batch "${file.batch}" (bank:import).`, e.location ? `Location (as researched): ${e.location}` : null, e.notes ? `Verification notes: ${e.notes}` : null]
    .filter(Boolean)
    .join('\n');
  return {
    kind: e.origin === 'FLORIDA' ? 'FLORIDA_NEWS' : 'GTA_CANON',
    incidentKey: `bank:${key}`,
    reference: {
      provider: MANUAL_PROVIDER,
      providerKey: `bank:${key}`,
      originalUrl: e.sourceUrl,
      canonicalUrl,
      originalTitle: e.sourceTitle.trim().slice(0, 400),
      publisher: e.publisher?.trim() ?? null,
      publishedAt: e.publishedAt ?? null,
      providerSeenAt: now.toISOString(),
      wikiPageId: null,
      wikiSection: null,
      contentDigest: hex(`${e.sourceUrl}\n${e.headline}`),
      linkCheck: null,
    },
    incident: {
      category: e.category ?? 'other',
      gameDetected: e.game ?? null,
      floridaSignal: 'none',
      floridaEvidence: e.location?.trim() ?? null,
      possibleDuplicateOfKey: null,
      similarity: null,
      notes: notes.slice(0, 1000),
    },
    question: {
      playTitleDraft: e.headline.trim(),
      explanationDraft: e.explanation.trim(),
      difficulty: e.difficulty ?? 2,
      eventId: e.eventId,
      ...(e.spoiler ? { spoiler: true } : {}),
    },
    ai: null,
    prefilter: { decision: 'candidate', reasonCodes: [] },
    ...(file.fixture ? { fixture: true } : {}),
  };
}

export function parseBankFile(raw: unknown): { ok: true; file: BankFile } | { ok: false; error: string } {
  const r = parse(bankFileSchema, raw);
  return r.ok ? { ok: true, file: r.value } : { ok: false, error: formatIssues(r.issues) };
}
