/**
 * Facts-first editorial model for official incident reports.
 *
 *   Stage 1  structured incident facts: roles (never names), objects, normalized actions, legal stage,
 *            location/date with their basis, and claims that point at the evidence passage (passage id,
 *            sentence number, digest) instead of copying it.
 *   Stage 2  a trivia title + explanation drafted FROM those facts (never from the headline), then
 *            validated against the evidence by `draftProblems` below.
 *
 * Every function is pure. Nothing here approves anything: a draft that passes is still a suggestion for
 * the human reviewer, and the source's per-operation access rules decide whether it may ever be used.
 */
import { explanationProblems, longestSharedWordRun, nearCopyProblems, placeholderProblems, playTitleProblems } from './editorial.ts';
import { normalizeTitle, titleSimilarity } from './dedupe.ts';
import { s, type Infer } from './schema.ts';

// ---------------------------------------------------------------------------
// Legal stage: an arrest, a charge or a citation is an allegation, not guilt.
// ---------------------------------------------------------------------------

export const LEGAL_STAGES = ['none', 'warning', 'cited', 'arrested', 'charged', 'pleaded_guilty', 'convicted', 'sentenced', 'civil', 'unknown'] as const;
export type LegalStage = (typeof LEGAL_STAGES)[number];
/** Stages that do not establish guilt: wording must attribute them ("according to …", "was charged with …"). */
export const ALLEGATION_STAGES: ReadonlySet<LegalStage> = new Set(['warning', 'cited', 'arrested', 'charged', 'unknown']);

export const CLAIM_STATUSES = ['supported', 'uncertain', 'disputed'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const QUALITY_DIMENSIONS = ['unusualness', 'specificity', 'entertainment', 'gtaPlausibility', 'factualConfidence', 'geoConfidence', 'safety', 'sourceQuality'] as const;
export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

const code = s.string({ min: 1, max: 80, pattern: /^[A-Z0-9_]+$/ });
const shortText = (max: number) => s.string({ max });
const isoDate = s.string({ max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
const score = s.number({ min: 0, max: 1 });

export const claimSchema = s.object({
  id: s.string({ min: 1, max: 12, pattern: /^c\d{1,3}$/ }),
  /** Normalized predicate (e.g. "found", "escaped", "cited"). */
  predicate: s.string({ min: 1, max: 40 }),
  /** Role, never a name ("officer", "individual", "suspect"). */
  subject: shortText(60),
  /** Short normalized object phrase (our wording of the fact, not a quote). */
  object: shortText(160),
  status: s.enum(CLAIM_STATUSES),
  evidence: s.object({
    passageId: s.string({ min: 1, max: 80 }),
    sentence: s.int({ min: 1, max: 500 }),
    /** sha-256 prefix of the source sentence, to re-verify later without storing the text. */
    digest: s.string({ min: 16, max: 64, pattern: /^[a-f0-9]+$/ }),
  }),
});
export type Claim = Infer<typeof claimSchema>;

export const incidentFactsSchema = s.object({
  version: s.literal(1),
  /** Which deterministic/AI extractor produced the record (e.g. "rules:fwc-weekly@1"). */
  extractor: s.string({ min: 1, max: 60 }),
  incidentType: s.string({ min: 1, max: 60, pattern: /^[a-z_]+$/ }),
  documentId: s.string({ min: 1, max: 160 }),
  passageId: s.string({ min: 1, max: 80 }),
  evidenceUrl: s.string({ min: 12, max: 2048, pattern: /^https:\/\/[^\s<>"]+$/ }),
  location: s.object({
    state: s.nullable(s.literal('Florida')),
    county: s.nullable(shortText(60)),
    place: s.nullable(shortText(80)),
    verified: s.boolean(),
    basis: s.enum(['report_heading', 'stated_in_text', 'agency_jurisdiction', 'none'] as const),
  }),
  eventDate: s.object({
    from: s.nullable(isoDate),
    to: s.nullable(isoDate),
    precision: s.enum(['day', 'range', 'unknown'] as const),
    basis: s.enum(['stated_in_text', 'report_period', 'publication_date', 'none'] as const),
  }),
  participants: s.array(shortText(40), { max: 8 }),
  objects: s.array(shortText(60), { max: 16 }),
  actions: s.array(shortText(160), { max: 10 }),
  legalStage: s.enum(LEGAL_STAGES),
  claims: s.array(claimSchema, { max: 24 }),
  /** Counts only: what was removed from anything we keep (names, ages, addresses). */
  redactions: s.object({ personNames: s.int({ min: 0, max: 200 }), ages: s.int({ min: 0, max: 200 }), excludedParagraphs: s.int({ min: 0, max: 200 }) }),
  safetyFlags: s.array(code, { max: 20 }),
  quality: s.object({
    scores: s.object({
      unusualness: score,
      specificity: score,
      entertainment: score,
      gtaPlausibility: score,
      factualConfidence: score,
      geoConfidence: score,
      safety: score,
      sourceQuality: score,
    }),
    total: s.int({ min: 0, max: 100 }),
    decision: s.enum(['candidate', 'safety_review', 'reject'] as const),
    reasons: s.array(code, { max: 20 }),
  }),
  draft: s.nullable(
    s.object({
      origin: s.enum(['rules', 'ai'] as const),
      generator: s.string({ min: 1, max: 60 }),
      frame: s.string({ min: 1, max: 60 }),
      /** Validator result for the stored draft (empty = passed every check). */
      problems: s.array(s.string({ max: 240 }), { max: 20 }),
    }),
  ),
  /** Normalized incident signature for cross-source dedupe (objects + county + month). */
  signature: shortText(200),
  /** Human verification status of the record (machines never set "human_verified"). */
  verification: s.enum(['pending', 'human_verified'] as const),
  /** Shadow evaluation for future controlled auto-publication (Phase B). Never acted on. */
  phaseB: s.object({ eligible: s.literal(false), blockers: s.array(code, { max: 20 }) }),
});
export type IncidentFacts = Infer<typeof incidentFactsSchema>;

// ---------------------------------------------------------------------------
// Draft validation (rules drafts today, AI drafts later — same checks)
// ---------------------------------------------------------------------------

/** A shared run of this many consecutive words with the source text counts as copying. */
export const SOURCE_PHRASE_MAX_RUN = 7;
/** Synonym-normalized similarity to the source headline above this = cosmetic paraphrase. */
export const HEADLINE_PARAPHRASE_SIMILARITY = 0.5;

/** Synonym groups: a draft may use any member when the evidence uses another one. Conservative on purpose. */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['find', 'found', 'discover', 'discovered', 'locate', 'located', 'uncover', 'uncovered', 'spot', 'spotted'],
  ['hide', 'hid', 'hidden', 'hiding', 'conceal', 'concealed', 'concealing', 'stash', 'stashed'],
  ['alligator', 'gator'],
  ['juvenile', 'young', 'baby'],
  ['under', 'underneath', 'beneath', 'below'],
  ['bucket', 'pail'],
  ['officer', 'deputy', 'lieutenant', 'investigator', 'detective', 'sergeant', 'captain', 'trooper'],
  ['vessel', 'boat'],
  ['individual', 'person', 'people', 'subject', 'man', 'woman', 'someone'],
  ['operator', 'driver', 'boater'],
  ['drive', 'drove', 'driven', 'driving'],
  ['dig', 'dug', 'digging', 'digger', 'excavate', 'excavating', 'excavation'],
  ['cite', 'cited', 'citation', 'ticket', 'ticketed'],
  ['arrest', 'arrested', 'custody'],
  ['escape', 'escaped', 'escapes', 'loose'],
  ['remove', 'removed', 'relocate', 'relocated', 'capture', 'captured'],
  ['rescue', 'rescued', 'extract', 'extracted', 'retrieve'],
  ['steal', 'stole', 'stolen'],
  ['rob', 'robbed', 'robbery'],
  ['store', 'shop', 'business'],
  ['suv', 'traverse'],
  ['mask', 'masked'],
  ['use', 'uses', 'used', 'using'],
];
const SYNONYM_OF = new Map<string, string>();
for (const g of SYNONYM_GROUPS) for (const w of g) SYNONYM_OF.set(w, g[0]!);

/** Framing words a draft may always use (attribution, hedges, generic roles, function words). */
const NEUTRAL = new Set(
  (
    'a an the and or but of to in on at by for from with into onto over after before during while when where who whom whose which that this these those ' +
    'it its it\'s itself they them their he him his she her hers was were is are be been being has have had do does did not no nor as if than then so ' +
    'there here up down out off about around near inside outside through toward towards until later earlier again also only just still even very ' +
    'one some any another other both each all more most several' +
    ' says say said saying according report reports reported reporting documented records record recorded listed describes described account ' +
    'official officials authorities agency state wildlife law enforcement weekly release news incident case call calls called ' +
    'allegedly alleged allegation accused accusation charge charges charged suspect suspected suspicion accusations proof guilt guilty presumed innocent ' +
    'unproven court convicted conviction ' +
    'officers officer deputies police wildlife team animal creature vehicle what why how could would can will may might ' +
    'florida county sheriff sheriffs office fish conservation commission fwc department'
  ).split(/\s+/),
);

/** Words that assert guilt; forbidden while the legal stage is an allegation. */
const GUILT_WORDS = /\b(guilty|convicted|criminals?|robbers?|thie(f|ves)|burglars?|crooks?|poachers?|felons?|culprits?|perpetrators?|lawbreakers?)\b/i;
/** Attribution/hedging that must accompany an allegation in the explanation. */
const HEDGE = /\b(according to|said|says|reported|alleg\w*|accus\w*|charged|charges?|arrested on|cited|citation|warn\w*|suspect\w*|police say|deputies say|officers say)\b/i;
const AGENCY_WORDS = /\b(fwc|fish and wildlife|conservation commission|sheriff'?s?|county|police department|highway patrol)\b/i;

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', dozen: '12', twenty: '20', hundred: '100', hundreds: '100', thousand: '1000',
};

function stemWord(w: string): string {
  let t = w.toLowerCase().replace(/['’]s$/, '');
  if (SYNONYM_OF.has(t)) return SYNONYM_OF.get(t)!;
  let suffix = true;
  if (t.length > 5 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  else if (t.length > 5 && t.endsWith('ers')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('es') && !t.endsWith('ses')) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  else suffix = false;
  // stopped → stopp → stop, digging → digg → dig (but keep -ll/-ss/-zz).
  if (suffix && /([b-df-hj-np-tv-z])\1$/.test(t) && !/(ll|ss|zz)$/.test(t)) t = t.slice(0, -1);
  return SYNONYM_OF.get(t) ?? t;
}

/** Content words of a text (lowercase, hyphen parts split). */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) ?? []).flatMap((w) => w.split(/[-]/));
}

/** Canonical stems used for evidence matching (synonym-aware). */
export function evidenceStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(text)) {
    out.add(stemWord(w));
    if (NUMBER_WORDS[w]) out.add(NUMBER_WORDS[w]!);
  }
  return out;
}

/** Draft words (stems) that are neither framing words nor found in the evidence. */
export function unsupportedTerms(text: string, evidence: Set<string>, extraNeutral: readonly string[] = []): string[] {
  const neutral = new Set([...NEUTRAL, ...extraNeutral.map((w) => w.toLowerCase())]);
  const out = new Set<string>();
  for (const w of words(text)) {
    if (neutral.has(w)) continue;
    if (w.length <= 1 && !/^\d$/.test(w)) continue;
    const st = stemWord(w);
    if (neutral.has(st)) continue;
    if (evidence.has(st)) continue;
    if (NUMBER_WORDS[w] && evidence.has(NUMBER_WORDS[w]!)) continue;
    out.add(w);
  }
  return [...out];
}

/** Synonym-normalized similarity: catches "Man Taken Into Custody After Concealing Young Alligator" vs "…Arrested After Hiding Baby Alligator". */
export function canonicalSimilarity(a: string, b: string): number {
  const canon = (t: string) => words(t).filter((w) => !NEUTRAL.has(w) || ['man', 'woman', 'person'].includes(w)).map(stemWord).join(' ');
  return titleSimilarity(canon(a), canon(b));
}

export type DraftContext = {
  /** Source headline / document title (never displayed; used for copy and paraphrase checks). */
  headline: string;
  /** Exactly the evidence passages the facts were extracted from (kept in memory only). */
  evidenceText: string;
  legalStage: LegalStage;
  /** Names, ages and other identifiers found in the source: must never appear in the draft. */
  forbiddenTerms: readonly string[];
  /** Place names of this incident (county, city, landmarks): never in the title (answer leakage). */
  placeTerms: readonly string[];
  /** Words the generator may use that are not in the evidence (e.g. the agency's display name). */
  extraNeutral?: readonly string[];
  existingTitles?: readonly { id: string; title: string }[];
};

/**
 * Every problem with a drafted title + explanation (empty = the draft may be shown to a reviewer as a
 * suggestion). Covers originality (headline copy and cosmetic paraphrase, source-phrase copying),
 * grounding (no unsupported words, numbers, quotes), privacy, answer leakage, legal wording and the
 * existing editorial rules (length, giveaways, placeholders, near-duplicates).
 */
export function draftProblems(draft: { playTitle: string; explanation: string }, ctx: DraftContext): string[] {
  const out: string[] = [];
  const { playTitle: title, explanation } = draft;
  out.push(...playTitleProblems(title, { originalTitle: ctx.headline, exactTitleAllowed: false, existingTitles: ctx.existingTitles }));
  out.push(...explanationProblems(explanation));
  out.push(...placeholderProblems(title, 'PLAY_TITLE'), ...placeholderProblems(explanation, 'EXPLANATION'));
  out.push(...nearCopyProblems(title, ctx.headline, 'PLAY_TITLE'), ...nearCopyProblems(explanation, ctx.headline, 'EXPLANATION'));

  const para = canonicalSimilarity(title, ctx.headline);
  if (ctx.headline && para >= HEADLINE_PARAPHRASE_SIMILARITY) out.push(`PLAY_TITLE_HEADLINE_PARAPHRASE: a synonym-swapped version of the source headline (${para.toFixed(2)}); build the title from the facts`);
  for (const [field, text] of [['PLAY_TITLE', title], ['EXPLANATION', explanation]] as const) {
    const run = longestSharedWordRun(text, ctx.evidenceText);
    if (run >= SOURCE_PHRASE_MAX_RUN) out.push(`${field}_SOURCE_PHRASE: copies ${run} consecutive words of the source text`);
    if (/["“”«»]/.test(text)) out.push(`${field}_QUOTE: quotations from the source are not allowed`);
    const lower = ` ${normalizeTitle(text)} `;
    const leaked = ctx.forbiddenTerms.filter((t) => t.trim().length > 1 && lower.includes(` ${normalizeTitle(t)} `));
    if (leaked.length) out.push(`${field}_PERSONAL_DATA: contains identifying details (${leaked.length} term(s)) from the source`);
    if (ALLEGATION_STAGES.has(ctx.legalStage) && GUILT_WORDS.test(text)) out.push(`${field}_GUILT_ASSERTED: the source reports an allegation (${ctx.legalStage}); do not state guilt`);
  }
  const evidence = evidenceStems(`${ctx.evidenceText} ${ctx.headline}`);
  for (const [field, text] of [['PLAY_TITLE', title], ['EXPLANATION', explanation]] as const) {
    const unsupported = unsupportedTerms(text, evidence, ctx.extraNeutral);
    if (unsupported.length) out.push(`${field}_UNSUPPORTED: words not backed by the evidence (${unsupported.slice(0, 6).join(', ')})`);
  }
  if (ALLEGATION_STAGES.has(ctx.legalStage) && ctx.legalStage !== 'unknown' && !HEDGE.test(explanation)) {
    out.push('EXPLANATION_ALLEGATION_UNHEDGED: attribute the enforcement action ("according to …", "was cited", "was charged") — it is not proof of guilt');
  }
  // Answer leakage before the reveal: no place names, agencies or giveaways in the title.
  const titleNorm = ` ${normalizeTitle(title)} `;
  const places = ctx.placeTerms.filter((p) => p.trim().length > 2 && titleNorm.includes(` ${normalizeTitle(p)} `));
  if (places.length) out.push(`PLAY_TITLE_LOCATION: names a place (${places.join(', ')}) that gives the answer away`);
  if (AGENCY_WORDS.test(title)) out.push('PLAY_TITLE_AGENCY: names the reporting agency (gives the answer away)');
  return [...new Set(out)];
}
