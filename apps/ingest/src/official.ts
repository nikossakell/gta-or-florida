/**
 * Official incident reports → facts-first trivia candidates (pure, deterministic, offline-testable).
 *
 *   document → passages (adapter) → per passage:
 *     Stage 1  structured facts: roles (names removed), objects, legal stage, location/date + basis,
 *              claims that reference passage/sentence/digest (no stored source text)
 *     safety   hard rejections (minors, sexual content, death/serious injury, graphic violence, cruelty)
 *              and holds (serious threats → safety review)
 *     quality  unusualness, specificity, entertainment, GTA plausibility, factual/geo confidence,
 *              source quality → candidate | safety_review | reject
 *     Stage 2  title + explanation drafted from the facts by an incident "frame" (never from the
 *              headline), validated by @gof/core draftProblems; no frame → no draft (a human writes it)
 *
 * Code can reject or hold. It cannot approve, verify for a human, or grant any source right. No model
 * is called: AI processing is a separate source operation that is not cleared for any official source.
 */
import { createHash } from 'node:crypto';
import {
  ALLEGATION_STAGES,
  cleanText,
  draftProblems,
  OFFICIAL_AUTOMATION_OPERATIONS,
  OFFICIAL_PROVIDER,
  OFFICIAL_PUBLISH_OPERATIONS,
  accessOperationProblems,
  operationStatus,
  parse,
  incidentFactsSchema,
  formatIssues,
  type Claim,
  type ClaimStatus,
  type IncidentFacts,
  type LegalStage,
  type SourcePolicy,
} from '@gof/core';
import { unusualness } from './filters.ts';
import { floridaCounty, type OfficialAdapter, type OfficialDocument, type OfficialPassage } from './adapters/official-document.ts';
import { fwcAdapter } from './adapters/fwc.ts';
import { flaglerAdapter } from './adapters/flagler.ts';
import type { Discovered, ExistingTitle } from './pipeline.ts';

export const OFFICIAL_ADAPTERS: readonly OfficialAdapter[] = [fwcAdapter, flaglerAdapter];
export const EXTRACTOR_VERSION = 'rules@1';
/** Candidates below this total score are rejected as not interesting enough (uncalibrated; see report). */
export const MIN_TOTAL_SCORE = 45;

export function adapterForUrl(url: URL): OfficialAdapter | null {
  return OFFICIAL_ADAPTERS.find((a) => a.matches(url)) ?? null;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------
// Access: what the owner has (not) cleared. Explicit owner-supplied URLs are a supervised pilot.
// ---------------------------------------------------------------------------

export type AccessVerdict = { allowed: boolean; mode: 'pilot' | 'automated'; problems: string[]; warnings: string[] };

/**
 * May this document be fetched now?
 *  - automated (cron / Workflow): discover + fetch + extractFacts must be explicitly allowed.
 *  - pilot (owner runs the CLI with explicit URLs): refused for blocked sources and denied fetch;
 *    unknown fetch is allowed as a supervised, single-document evaluation, and every resulting
 *    candidate stays in review because publication still needs the publish operations cleared.
 */
export function fetchVerdict(src: SourcePolicy, mode: 'pilot' | 'automated'): AccessVerdict {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (src.licenseStatus === 'blocked') problems.push(`SOURCE_BLOCKED: ${src.id} may not be used in any mode`);
  if (!src.access) problems.push(`SOURCE_ACCESS_UNREVIEWED: ${src.id} is not a registered official source`);
  else {
    if (operationStatus(src, 'fetch') === 'denied') problems.push(`SOURCE_OPERATION_DENIED: fetch is denied for ${src.id}`);
    if (mode === 'automated') {
      problems.push(...accessOperationProblems(src, OFFICIAL_AUTOMATION_OPERATIONS));
      if (src.access.acquisition === 'explicit_urls' || src.access.acquisition === 'none') problems.push(`ACQUISITION_NOT_AUTOMATED: ${src.id} is limited to ${src.access.acquisition}`);
    } else {
      for (const p of accessOperationProblems(src, OFFICIAL_PUBLISH_OPERATIONS)) warnings.push(`${p} — candidates stay in review`);
    }
  }
  return { allowed: problems.length === 0, mode, problems: [...new Set(problems)], warnings };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const ABBREVIATIONS = /\b(Lt|Sgt|Cpl|Det|Dep|Ofc|Capt|Mr|Mrs|Ms|Dr|St|Jr|Sr|No|Inc|Co|Ave|Rd|Blvd|Hwy|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Fla|U\.S|a\.m|p\.m|[A-Z])\./g;

export function splitSentences(text: string): string[] {
  const guarded = text.replace(ABBREVIATIONS, (m) => m.replace(/\./g, '․'));
  return guarded
    .split(/(?<=[.!?][”"’)]?)\s+(?=[A-Z“"(0-9])/)
    .map((s) => s.replace(/․/g, '.').trim())
    .filter((s) => s.length > 2);
}

function titleCase(text: string): string {
  const small = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'as', 'by', 'from', 'with', 'if']);
  return text
    .split(' ')
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

// ---------------------------------------------------------------------------
// Personal data (never stored, never in drafts)
// ---------------------------------------------------------------------------

const TITLES =
  /\b(?:K-9 Officer|Officer Specialist|Senior Officer|Captive Wildlife Investigator|Wildlife Investigator|Officers?|Lieutenant|Lt\.|Sergeant|Sgt\.|Corporal|Cpl\.|Deputies|Deputy|Detectives?|Det\.|Investigators?|Captain|Capt\.|Sheriff|Chief|Trooper|Agent|K-9)\s+((?:[A-Z]\.\s*)*[A-Z][A-Za-z'’-]+(?:(?:,\s*|\s+and\s+|\s+)(?:(?:Officer|Officer Specialist|Lieutenant|Investigator)\s+)?(?:[A-Z]\.\s*)*[A-Z][A-Za-z'’-]+)*)/g;
const NAME_AGE = /\b([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,3}),\s*(\d{1,3}),\s*of\s+([A-Z][A-Za-z .'-]{2,40}?)(?=[,.;]|\s+(?:was|is|had|has)\b)/g;
const NOT_NAMES = new Set(['County', 'Florida', 'State', 'Road', 'Wildlife', 'Management', 'Area', 'Jail', 'Office', 'Sheriff', 'Officer', 'Officers', 'The', 'A', 'An', 'And', 'K-9']);

export type PersonalData = { names: string[]; ages: number[]; residences: string[] };

export function findPersonalData(text: string): PersonalData {
  const names = new Set<string>();
  const ages: number[] = [];
  const residences = new Set<string>();
  for (const m of text.matchAll(TITLES)) {
    for (const part of m[1]!.split(/,\s*|\s+and\s+|\s+/)) {
      const t = part.replace(/[.,]$/, '');
      if (/^[A-Z][a-z'’-]{2,}$/.test(t) && !NOT_NAMES.has(t)) names.add(t);
    }
  }
  for (const m of text.matchAll(NAME_AGE)) {
    for (const t of m[1]!.split(/\s+/)) if (!NOT_NAMES.has(t)) names.add(t);
    ages.push(Number(m[2]));
    residences.add(m[3]!.trim());
  }
  for (const m of text.matchAll(/\b(\d{1,3})-year-old\b/g)) ages.push(Number(m[1]));
  // Surnames repeat later on their own ("Castano told detectives…"): they are already in `names`.
  return { names: [...names], ages, residences: [...residences] };
}

function deidentify(text: string, pd: PersonalData): string {
  let out = text.replace(NAME_AGE, 'a person');
  if (pd.names.length) {
    const alt = pd.names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    out = out.replace(new RegExp(`\\b(?:[A-Z]\\.\\s*)*(?:${alt})(?:\\s+(?:[A-Z]\\.\\s*)*(?:${alt}))*(['’]s)?\\b`, 'g'), (_m, poss: string | undefined) => (poss ? "the person's" : 'the person'));
  }
  out = out.replace(/\b\d{1,3}-year-old\s*/g, '');
  return out
    .replace(/\b(?:K-9 Officer|Officer Specialist|Senior Officer|Captive Wildlife Investigator|Wildlife Investigator|Officers?|Lieutenant|Lt\.|Sergeant|Sgt\.|Deputy|Deputies|Detectives?|Investigators?|Sheriff)\s+the person(?:(?:,\s*|\s+and\s+)(?:(?:Officer|Officer Specialist|Lieutenant|Investigator)\s+)?the person)*/g, 'officers')
    .replace(/\s{2,}/g, ' ');
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const HARD: [code: string, re: RegExp][] = [
  ['MINOR_INVOLVED', /\b(child|children|kids?|toddlers?|infants?|minors?|teens?|teenagers?|boys?|girls?|students?|juvenile (?:male|female|suspect|offender|driver|passenger|boy|girl)s?)\b/i],
  ['SEXUAL_CONTENT', /\b(sexual\w*|rape\w*|molest\w*|lewd|lascivious|indecent exposure|exposed (?:him|her)self|prostitut\w*|pornograph\w*|voyeur\w*)\b/i],
  ['DEATH_OR_SERIOUS_INJURY', /\b(died|dies|dead body|deceased|fatal\w*|killed|homicide|murder\w*|manslaughter|drown(?:ed|ing)|critically injured|serious(?:ly)? injur\w*|life-threatening|airlifted|trauma (?:center|alert)|overdos\w*|suicid\w*)\b/i],
  ['GRAPHIC_VIOLENCE', /\b(stabb\w*|shot (?:and|him|her|at)|shooting|gunshot|bleeding|blood|beat(?:en|ing) (?:him|her|them)|strangl\w*|machete|dismember\w*)\b/i],
  ['ANIMAL_CRUELTY', /\b(animal cruelty|cruelty to animals|mutilat\w*|tortur\w*|dog ?fight\w*|cock ?fight\w*)\b/i],
  ['VULNERABLE_VICTIM', /\b(domestic (?:violence|battery|disturbance)|elderly|65 or older|disabled (?:adult|person)|nursing home)\b/i],
];
const HOLD: [code: string, re: RegExp][] = [
  ['SERIOUS_THREAT', /\b(robb(?:ed|ery|ing|er)|armed|hold-?up|threaten\w*|hostage|carjack\w*|brandish\w*|as if (?:a|he had a|she had a) weapon|pretend\w* to have a (?:weapon|gun)|point(?:ed|ing) (?:a|the|his|her) (?:gun|firearm|weapon|knife|bag|object) at)\b/i],
  ['DRUGS', /\b(fentanyl|heroin|cocaine|methamphetamine|meth)\b/i],
  ['NEEDS_LOCATION_REVIEW', /\b(?:in|from|to) (?:Georgia|Alabama|Mississippi|Louisiana|Texas|South Carolina|North Carolina|Tennessee|New York|Cuba|the Bahamas|Puerto Rico)\b/],
];
const NOTE: [code: string, re: RegExp][] = [['WEAPON_MENTIONED', /\b(firearms?|guns?|rifles?|shotguns?|pistols?|handguns?|knife|knives)\b/i]];

// ---------------------------------------------------------------------------
// Legal stage
// ---------------------------------------------------------------------------

const STAGE_TESTS: [LegalStage, RegExp][] = [
  ['sentenced', /\bsentenced\b/i],
  ['pleaded_guilty', /\b(?:pleaded|pled|pleads) guilty\b/i],
  ['convicted', /\b(?:convicted|found guilty)\b/i],
  ['charged', /\b(?:charged with|faces? charges?|was charged|indicted)\b/i],
  ['arrested', /\b(?:arrested|placed under arrest|booked into)\b/i],
  ['cited', /\b(?:cited|citations?|notice to appear|ticketed)\b/i],
  ['warning', /\b(?:warnings?|warned)\b/i],
];

export function legalStageOf(text: string): LegalStage {
  for (const [stage, re] of STAGE_TESTS) if (re.test(text)) return stage;
  return 'none';
}

/** The offense named for the enforcement action ("illegal take of an American alligator"), de-identified. */
export function chargePhrase(text: string): string | null {
  const patterns = [
    /\b(?:arrested|charged|cited)\b(?:\s+[A-Za-z]+){0,3}?\s+(?:for|with)\s+((?:[A-Za-z][\w'’-]*\s?){1,9}?)(?=[.,;]|\s+and\s+(?:transported|booked|taken|issued|released|warnings?)|$)/,
    /\bcitation\b(?:\s+(?:was\s+)?issued)?(?:\s+to\s+the\s+[a-z]+(?:\s+of\s+the\s+[a-z]+)?)?\s+for\s+((?:[A-Za-z][\w'’-]*\s?){1,9}?)(?=[.,;]|\s+and\s|$)/,
    /\bnotice to appear for\s+((?:[A-Za-z][\w'’-]*\s?){1,9}?)(?=[.,;]|\s+and\s|$)/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const phrase = m[1]!.trim();
      if (!/^(?:him|her|them|the|a|an)$/i.test(phrase)) return phrase;
    }
  }
  return null;
}

/** Who the enforcement action was against, as a role. */
function actedOnRole(text: string, fallback: string): string {
  const m = /\b(?:citation was issued to|cited|arrested|charged)\s+the\s+(owner|operator|driver|individual|subject|suspect|boater|hunter|angler|man|woman)\b/i.exec(text)
    ?? /\bthe\s+(owner|operator|driver|individual|subject|suspect|boater|hunter|angler)\s+(?:was|received)\b/i.exec(text);
  const role = m?.[1]?.toLowerCase() ?? fallback;
  return role === 'subject' ? 'person' : role === 'individual' ? 'person' : role;
}

// ---------------------------------------------------------------------------
// Claims (Stage 1)
// ---------------------------------------------------------------------------

const PREDICATES = /\b(found|discovered|located|observed|responded|escaped|used|extracted|rescued|arrested|cited|issued|stopped|removed|denied|admitted|hiding|blocking|flushing|maneuvered|pointed|robbed|grabbed|drove|tracked|searched|checked|caught|told|alerted|walked|waited|seized|released|transported)\b/i;
const ROLE_WORDS: [role: string, re: RegExp][] = [
  ['officers', /\b(officers?|lieutenant|lt\.|investigators?|wildlife officers?|k-9 officer|officer specialist)\b/i],
  ['deputies', /\b(deput(?:y|ies)|detectives?|sheriff)\b/i],
  ['k-9', /\bk-9\b/i],
  ['clerk', /\bclerk\b/i],
  ['owner', /\bowner\b/i],
  ['operator', /\boperator\b/i],
  ['individual', /\b(individuals?|subjects?|man|woman|people|persons?|suspect|driver|group)\b/i],
];

function roleOf(fragment: string): string {
  for (const [role, re] of ROLE_WORDS) if (re.test(fragment)) return role;
  return 'report';
}

function claimStatus(sentence: string): ClaimStatus {
  if (/\b(denied|disputed|claims? (?:he|she|they) did not)\b/i.test(sentence)) return 'disputed';
  if (/\b(suspected|believed|possibly|appeared to|may have|allegedly|leading the officers? (?:ton? )?believe|as if)\b/i.test(sentence)) return 'uncertain';
  return 'supported';
}

export function extractClaims(passage: OfficialPassage, pd: PersonalData): Claim[] {
  const claims: Claim[] = [];
  splitSentences(passage.text).forEach((sentence, i) => {
    if (claims.length >= 24) return;
    const m = PREDICATES.exec(sentence);
    if (!m) return;
    const before = deidentify(sentence.slice(0, m.index), pd);
    const after = deidentify(sentence.slice(m.index + m[0].length), pd)
      .replace(/^[\s,]+/, '')
      .split(/[.;]/)[0]!
      .split(/\s+/)
      .slice(0, 14)
      .join(' ');
    claims.push({
      id: `c${claims.length + 1}`,
      predicate: m[1]!.toLowerCase(),
      subject: roleOf(before),
      object: cleanText(after, 160),
      status: claimStatus(sentence),
      evidence: { passageId: passage.id, sentence: i + 1, digest: sha(sentence).slice(0, 32) },
    });
  });
  return claims;
}

// ---------------------------------------------------------------------------
// Objects and participants
// ---------------------------------------------------------------------------

const ANIMALS =
  'alligators?|gators?|crocodiles?|pythons?|boas?|snakes?|iguanas?|manatees?|monkeys?|lemurs?|sloths?|emus?|ostrich(?:es)?|kangaroos?|raccoons?|opossums?|bears?|panthers?|bobcats?|sharks?|dolphins?|turtles?|tortoises?|parrots?|macaws?|owls?|eagles?|roosters?|goats?|pigs?|hogs?|horses?|cows?|deer|ducks?|geese|goose|birds?|frogs?|toads?|lizards?|tarantulas?|scorpions?|bees?|lobsters?|crabs?|coyotes?|foxes|fox';
const ANIMAL_RE = new RegExp(`\\b(${ANIMALS})\\b`, 'gi');
const NOTABLE =
  /\b(buckets?|rags|coolers?|backpacks?|bags?|masks?|clowns?|costumes?|cash registers?|register drawer|drawers?|suvs?|swamp buggy|airboats?|vessels?|boats?|jet skis?|kayaks?|golf carts?|lawn ?mowers?|lights|holes?|shovels?|probes?|artifacts?|enclosures?|doorways?|gas station|decoys|sandbar|traps?|nets?|spotlights?|flashlights?|drones?|treestands?|fireworks|wigs?|toilets?|pools?|garages?|kitchens?|mailbox(?:es)?)\b/gi;

export function objectsOf(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(ANIMAL_RE)) found.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(NOTABLE)) found.add(m[1]!.toLowerCase());
  return [...found].slice(0, 16);
}

function participantsOf(text: string, doc: OfficialDocument): string[] {
  const out = new Set<string>();
  if (/\b(officers?|lieutenant|investigators?)\b/i.test(text)) out.add(doc.agency.actors);
  if (/\bdeput(?:y|ies)|detectives?\b/i.test(text)) out.add('deputies');
  if (/\bk-9\b/i.test(text)) out.add('k-9');
  for (const [role, re] of ROLE_WORDS.slice(3)) if (re.test(text)) out.add(role);
  if (/\btrapper\b/i.test(text)) out.add('trapper');
  if (/\bhunt(?:ers?|ing)\b/i.test(text)) out.add('hunters');
  return [...out].slice(0, 8);
}

// ---------------------------------------------------------------------------
// Frames (Stage 2): facts → original title + explanation. Templates only use slot words taken
// from the evidence plus neutral framing words; draftProblems re-checks every word anyway.
// ---------------------------------------------------------------------------

type FrameCtx = { text: string; doc: OfficialDocument; legal: LegalStage; charge: string | null; county: string | null };
type FrameResult = { incidentType: string; entertainment: number; title: string; summary: string; actedOn: string };
type Frame = { id: string; build(ctx: FrameCtx): FrameResult | null };

const MODS = /^(?:live|juvenile|baby|young|small|large|wild|adult|black|white|brown|gray|grey|ruffed|exotic|captive|\d+-foot)$/i;
const singular = (w: string) => (/(?:ies)$/.test(w) ? `${w.slice(0, -3)}y` : /(?:ss|us)$/.test(w) ? w : w.replace(/s$/, ''));
const actorsTitle = (doc: OfficialDocument) => titleCase(doc.agency.actors);
const plural = (phrase: string) => /[^s]s$/.test(phrase.split(' ').pop() ?? '');

const FRAMES: Frame[] = [
  {
    id: 'concealed_animal',
    build({ text, doc }) {
      const re = new RegExp(
        `\\b(?:found|discovered|located)\\s+(?:a|an|one|two|three|several)\\s+((?:(?:live|juvenile|baby|young|small|large|wild|\\d+-foot)\\s+){0,3})(${ANIMALS})\\s+(?:(?:hidden|concealed|stuffed|tucked)\\s+)?(underneath|under|beneath|inside|in)\\s+(?:the|a|an|his|her|their|its|several|some|two|three|a few)\\s+([a-z]+(?:\\s+[a-z]+){0,2}?)(?=[.,;]|\\s+(?:in|inside|on|at|and|with|that|which|near|parked|behind|under)\\b)`,
        'i',
      );
      const m = re.exec(text);
      if (!m) return null;
      const mods = m[1]!.trim().toLowerCase();
      const animal = singular(m[2]!.toLowerCase());
      const prep = m[3]!.toLowerCase();
      const cover = m[4]!.toLowerCase();
      const container = /\b(bucket|cooler|bag|backpack|box|tote|tank|trunk|suitcase|luggage|purse)\b/i.exec(cover)?.[1] ?? /\b(bucket|cooler|bag|backpack|box|tote|tank|trunk|suitcase|luggage|purse)\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
      const what = `${mods ? `${mods} ` : ''}${animal}`;
      // A different (synonymous) preposition keeps the sentence from replaying the source's wording.
      const altPrep = prep === 'under' ? 'beneath' : prep === 'underneath' || prep === 'beneath' ? 'under' : prep;
      const checked = /\bchecked (?:the|a|an)\s+(?:\w+\s+)?(bucket|cooler|bag|backpack|box|tote|tank|trunk)\b/i.test(text);
      const title =
        container && !cover.includes(container) && checked
          ? `${actorsTitle(doc)} Check ${article(container)} ${titleCase(container)} of ${titleCase(cover)} and Find ${article(what)} ${titleCase(what)}`
          : `${actorsTitle(doc)} Find ${article(what)} ${titleCase(what)} ${titleCase(prep)} ${plural(cover) ? '' : `${article(cover)} `}${titleCase(cover)}${container && !cover.includes(container) ? ` in ${article(container)} ${titleCase(container)}` : ''}`;
      const summary =
        container && !cover.includes(container)
          ? `${cap(doc.agency.actors)} checking ${article(container)} ${container} found ${article(what)} ${what} ${altPrep} the ${cover} inside it.`
          : `${cap(doc.agency.actors)} found ${article(what)} ${what} ${altPrep} ${plural(cover) ? 'some' : article(cover)} ${cover}.`;
      return { incidentType: 'concealed_wildlife', entertainment: 0.9, title, summary, actedOn: 'person' };
    },
  },
  {
    id: 'animal_in_place',
    build({ text, doc }) {
      const re = new RegExp(`\\b(?:an?|the)\\s+((?:(?:large|small|juvenile|young|baby|\\d+-foot)\\s+){0,2})(${ANIMALS})\\s+(blocking|inside|lounging in|sitting in|stuck in|wandering into)\\s+(?:a|the|an)\\s+([a-z]+(?:\\s+of\\s+(?:a|an|the)\\s+[a-z]+)?)`, 'i');
      const m = re.exec(text);
      if (!m) return null;
      const place = m[4]!.toLowerCase();
      if (!/\b(doorway|entrance|door|business|store|home|house|garage|pool|kitchen|bathroom|office|restaurant|porch|lanai|mailbox|toilet|driveway|station|school|bank|hospital|car|truck)\b/.test(place)) return null;
      const animal = singular(m[2]!.toLowerCase());
      const mods = m[1]!.trim().toLowerCase();
      const what = `${mods ? `${mods} ` : ''}${animal}`;
      const verb = m[3]!.toLowerCase();
      const removed = /\b(?:was|were)\s+(?:successfully\s+)?(removed|relocated|captured)\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
      const verbTitle = verb === 'blocking' ? 'Blocks' : verb === 'inside' ? 'Turns Up Inside' : titleCase(verb.replace(/ing\b/, 's'));
      if (verbTitle === 'Turns Up Inside') return null; // "turns up" is not backed by evidence: leave it to a human
      const title = `${cap(article(what))} ${titleCase(what)} ${verbTitle} the ${titleCase(place)}${removed ? ` Until ${actorsTitle(doc)} ${removed === 'removed' ? 'Remove' : removed === 'relocated' ? 'Relocate' : 'Capture'} It` : ''}`;
      const responded = /\bresponded\b/i.test(text);
      const summary = `${cap(doc.agency.actors)} ${responded ? 'responded' : 'were called'} after ${article(what)} ${what} was reported ${verb} the ${place}${removed ? `; the animal was ${removed}` : ''}.`;
      return { incidentType: 'wildlife_in_human_space', entertainment: 0.85, title, summary, actedOn: 'person' };
    },
  },
  {
    id: 'escaped_animal',
    build({ text, doc }) {
      const re = new RegExp(`\\b(?:a|an|the)\\s+((?:[a-z-]+\\s+){0,4}?)(${ANIMALS})\\s+(?:that\\s+)?(?:had\\s+)?escaped(?:\\s+from\\s+(?:its|an?|the|their)\\s+([a-z]+))?`, 'i');
      const m = re.exec(text);
      if (!m) return null;
      const animal = singular(m[2]!.toLowerCase());
      const mods = m[1]!.trim().toLowerCase().split(/\s+/).filter((w) => w && w !== 'and');
      const titleMod = mods.filter((w) => MODS.test(w) && !/^(?:black|white|brown|gray|grey)$/.test(w)).slice(-1)[0];
      const fullMods = mods.every((w) => MODS.test(w)) ? m[1]!.trim().toLowerCase() : titleMod ?? '';
      const enclosure = m[3]?.toLowerCase() ?? null;
      const notFound = /\b(?:unable to be located|could not be located|was not located|remains? (?:at large|missing))\b/i.test(text);
      const tWhat = `${titleMod ? `${titleMod} ` : ''}${animal}`;
      const title = `${cap(article(tWhat))} ${titleCase(tWhat)} Escapes${enclosure ? ` Its ${titleCase(enclosure)}` : ''}${notFound ? ` and ${actorsTitle(doc)} Are Unable to Locate It` : ''}`;
      void fullMods;
      const searched = /\bsearch(?:es|ed)?\b/i.test(text);
      const follow = searched || notFound ? `, and ${doc.agency.actors}${searched ? ' searched for it' : ''}${searched && notFound ? ' but' : ''}${notFound ? ' were unable to locate it' : ''}` : '';
      const summary = `${cap(article(tWhat))} ${tWhat} escaped${enclosure ? ` its ${enclosure}` : ''}${follow}.`;
      return { incidentType: 'escaped_captive_wildlife', entertainment: 0.8, title, summary, actedOn: 'owner' };
    },
  },
  {
    id: 'unusual_vehicle_rescue',
    build({ text, doc }) {
      const m = /\bused\s+(?:a|an)\s+(swamp buggy|marsh buggy|airboat|helicopter|tractor|kayak|canoe|jet ski)\s+to\s+(extract|rescue|reach|retrieve|transport|tow)\s+(?:the\s+)?(?:(two|three|four|five|six|\d+)\s+)?(people|individuals|persons|hunters|fishermen|boaters|hikers|campers|occupants|kayakers)\b/i.exec(text);
      if (!m) return null;
      const vehicle = m[1]!.toLowerCase();
      const verb = m[2]!.toLowerCase();
      const count = m[3]?.toLowerCase() ?? null;
      const who = m[4]!.toLowerCase() === 'individuals' || m[4]!.toLowerCase() === 'persons' ? 'people' : m[4]!.toLowerCase();
      const offTrail = /\bdriven off-trail\b/i.test(text);
      const night = /\bnight\b/i.test(text);
      const group = `${count ? `${count} ` : ''}${who}`;
      const title = `An Officer Uses ${article(vehicle)} ${titleCase(vehicle)} to ${titleCase(verb)} ${titleCase(group)}${offTrail ? ` Who Drove Off-Trail${night ? ' at Night' : ''}` : ''}`;
      const summary = `${cap(doc.agency.actors)} used ${article(vehicle)} ${vehicle} to ${verb} ${group} from the area${offTrail ? ` after they had driven off-trail${night ? ' at night' : ''}` : ''}.`;
      return { incidentType: 'unusual_rescue', entertainment: 0.65, title, summary, actedOn: 'person' };
    },
  },
  {
    id: 'person_hiding',
    build({ text, doc }) {
      const m = /\b(?:an?|the|one)\s+(individual|subject|man|woman|person|suspect)\s+hiding\s+(in|inside|under|behind|beneath|underneath)\s+(?:a|an|the)\s+((?:[a-z]+\s+){0,2}?[a-z]+)(?=[.,;\s])/i.exec(text);
      if (!m) return null;
      const prep = m[2]!.toLowerCase();
      const place = m[3]!.toLowerCase();
      const k9 = /\bK-9\b/.test(text);
      const artifact = /\bartifacts?\b/i.test(text) && /\b(?:dug|digging)\b/i.test(text);
      const title = `${actorsTitle(doc)}${k9 ? ' and a K-9' : ''} Find a Person Hiding ${titleCase(prep)} ${article(place)} ${titleCase(place)}${artifact ? ' at an Artifact Dig Site' : ''}`;
      const summary = `${cap(doc.agency.actors)}${k9 ? ' and a K-9 tracked down' : ' found'} a person hiding ${prep} ${article(place)} ${place}${artifact ? ' near a freshly dug artifact site' : ''}.`;
      return { incidentType: 'person_hiding', entertainment: 0.75, title, summary, actedOn: 'person' };
    },
  },
  {
    id: 'herding_wildlife',
    build({ text, doc }) {
      const m = /\b(?:maneuvered|steered|drove)\s+(?:his|her|their|the|a)\s+(vessel|boat|airboat|truck|vehicle)\s+around\s+(?:a|the)\s+((?:raft|flock|group|herd)\s+of\s+(?:ducks|birds|geese|deer|waterfowl))\s*,?\s+(flushing|herding|pushing)\s+them\s+toward\b/i.exec(text);
      if (!m) return null;
      const vessel = m[1]!.toLowerCase();
      const flock = m[2]!.toLowerCase();
      const hunters = /\bhunt(?:ers?|ing)\b/i.test(text);
      const sandbar = /\bsandbar\b/i.test(text);
      const title = `A ${titleCase(vessel)} Operator Flushes a ${titleCase(flock)} Toward ${hunters ? 'Hunters' : 'a Group'}${sandbar ? ' on a Sandbar' : ''}`;
      const observed = /\bobserved\b/i.test(text) ? 'observed' : 'saw';
      const summary = `${cap(doc.agency.actors)} ${observed} a ${vessel} operator maneuver around a ${flock} and flush them toward ${hunters ? 'people hunting' : 'a group'}${sandbar ? ' from a sandbar' : ''}.`;
      return { incidentType: 'wildlife_herding', entertainment: 0.7, title, summary, actedOn: 'operator' };
    },
  },
  {
    id: 'unauthorized_lights',
    build({ text, doc }) {
      const m = /\b(vessel|boat|vehicle|car|truck|golf cart)\s+with\s+flashing\s+((?:(?:blue|red|white|amber)\s+(?:and\s+)?){1,3})lights\b/i.exec(text);
      if (!m) return null;
      const vehicle = m[1]!.toLowerCase();
      const colors = m[2]!.trim().toLowerCase();
      const noReason = /\bno justifiable reason\b/i.test(text);
      const stopped = /\bstopped\b/i.test(text);
      const title = `${actorsTitle(doc)} ${stopped ? 'Stop' : 'Investigate'} ${article(vehicle)} ${titleCase(vehicle)} Flashing ${titleCase(colors)} Lights${noReason ? ' for No Justifiable Reason' : ''}`;
      const summary = `${cap(doc.agency.actors)} ${stopped ? 'stopped' : 'checked'} ${article(vehicle)} ${vehicle} that was flashing ${colors} lights${noReason ? ' with no justifiable reason' : ''}.`;
      return { incidentType: 'unauthorized_emergency_lights', entertainment: 0.6, title, summary, actedOn: 'operator' };
    },
  },
  {
    id: 'costumed_robbery',
    build({ text, doc }) {
      const mask = /\bwearing\s+(?:a|an)\s+([a-z]+)\s+mask\b/i.exec(text);
      const point = /\bpointed\s+(?:the|a)\s+(bag|towel|hand|finger|object|bottle)\s+at\s+(?:the|a|her|him)\s*(clerk|cashier|employee|teller)?/i.exec(text);
      if (!mask || !/\brobb(?:ed|ery|ing)\b/i.test(text)) return null;
      const costume = mask[1]!.toLowerCase();
      const thing = point?.[1]?.toLowerCase() ?? null;
      const target = point?.[2]?.toLowerCase() ?? (/\bclerk\b/i.test(text) ? 'clerk' : 'cashier');
      const hidden = /\bhidden\b/i.test(text);
      const title = thing
        ? `${titleCase(doc.agency.actors)} Say a Man in ${article(costume)} ${titleCase(costume)} Mask Pointed ${article(thing)} ${titleCase(thing)} at ${article(target)} ${titleCase(target)} as if It ${hidden ? 'Hid a Weapon' : 'Were a Weapon'}`
        : `${titleCase(doc.agency.actors)} Say a Man in ${article(costume)} ${titleCase(costume)} Mask Robbed a Store`;
      const place = /\bgas station\b/i.test(text) ? 'gas station' : /\bconvenience store\b/i.test(text) ? 'convenience store' : 'store';
      const stolen = /\bstolen\b/i.test(text) ? (/\bSUV\b/.test(text) ? 'stolen SUV' : /\b(?:car|vehicle)\b/i.test(text) ? 'stolen vehicle' : null) : null;
      const how = !thing ? '' : /\bpretend/i.test(text) && hidden ? ` while pretending ${article(thing)} ${thing} hid a weapon` : ` while pointing ${article(thing)} ${thing} as if it were a weapon`;
      const summary = `According to ${doc.agency.reference}, a man wearing ${article(costume)} ${costume} mask robbed a ${place}${how}${stolen ? `, and ${doc.agency.actors} later stopped him in a ${stolen}` : ''}.`;
      return { incidentType: 'costumed_robbery', entertainment: 0.85, title, summary, actedOn: 'man' };
    },
  },
];

function legalSentence(stage: LegalStage, charge: string | null, role: string, doc: OfficialDocument): string {
  const who = role === 'man' ? 'He' : `The ${role}`;
  switch (stage) {
    case 'none':
      return '';
    case 'warning':
      return `${who} received a warning.`;
    case 'cited':
      return `${who} was cited${charge ? ` over ${charge}` : ''}.`;
    case 'arrested':
      return `${who} was arrested${charge ? ` on a charge of ${charge}` : ''}; an arrest is an accusation, not proof of guilt.`;
    case 'charged':
      return `${who} was arrested and charged${charge ? ` with ${charge}` : ''}; a charge is an accusation, not proof of guilt.`;
    default:
      return '';
  }
}

function attributionSentence(doc: OfficialDocument, county: string | null): string {
  if (doc.agency.documentLabel === 'news release') return '';
  return `${cap(doc.agency.reference)} documented the case in its ${doc.agency.documentLabel}${county ? ` for ${county} County, Florida` : ''}.`;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const ROUTINE_ENFORCEMENT = /\b(bag limit|undersized|size limit|over (?:the|their) (?:daily )?limit|fishing licen[cs]es?|hunting licen[cs]es?|valid licen[cs]e|closed season|resource inspection|boating safety|navigation lights|registration|life jackets?|fire extinguisher|baited)\b/i;
const GTA_CUES = /\b(vehicles?|suvs?|cars?|trucks?|boats?|vessels?|airboats?|swamp buggy|stolen|masks?|clowns?|costumes?|robb\w*|chase|fled|lights|alligators?|gators?|hiding|hole|weapon|cash|drawer|register|decoys|flushing|herding|escaped)\b/gi;

export type EvaluatedIncident = {
  passage: OfficialPassage;
  facts: IncidentFacts;
  draft: { playTitle: string; explanation: string } | null;
  /** In-memory only: identifiers and places a draft must never contain. */
  forbiddenTerms: string[];
  placeTerms: string[];
  providerKey: string;
  decision: 'candidate' | 'safety_review' | 'reject';
  reasons: string[];
};

export type EvaluationContext = {
  source: SourcePolicy;
  existingTitles?: readonly { id: string; title: string }[];
};

function placeTermsOf(text: string, doc: OfficialDocument, county: string | null): string[] {
  const out = new Set<string>();
  if (county) out.add(county);
  if (doc.agency.county) out.add(doc.agency.county);
  for (const m of text.matchAll(/\b((?:[A-Z][a-z]+|[A-Z]\.[A-Z]\.)(?:\s+(?:[A-Z][a-z]+|of|St\.))*\s+(?:County|Road|Inlet|Bay|Lake|River|Creek|Beach|Key|Keys|Area|Ramp|Park|Island|Springs?|Sound|Bridge|Jail|Point|Sanctuary|Preserve|Pier|Harbor|Refuge|Pond|Canal|Spillway|Plant))\b/g)) out.add(m[1]!);
  for (const m of text.matchAll(/\b(Palm Coast|Bunnell|Flagler Beach|St\. Augustine|Highland Beach|Miami|Tampa|Orlando|Jacksonville|Hollywood|Key West|Plantation Key|Horseshoe Beach)\b/g)) out.add(m[1]!);
  return [...out];
}

export function evaluatePassage(doc: OfficialDocument, passage: OfficialPassage, ctx: EvaluationContext): EvaluatedIncident {
  const text = passage.text;
  const pd = findPersonalData(text);
  const county = floridaCounty(passage.heading) ?? doc.agency.county;
  const legal = legalStageOf(text);
  const charge = (() => {
    const c = chargePhrase(text);
    if (!c) return null;
    let out = c;
    for (const n of pd.names) out = out.replace(new RegExp(`\\b${n}\\b`, 'g'), '').trim();
    return out.length >= 3 ? out : null;
  })();
  const claims = extractClaims(passage, pd);
  const objects = objectsOf(text);
  const safetyHard = HARD.filter(([, re]) => re.test(text)).map(([c]) => c);
  if (pd.ages.some((a) => a < 18)) safetyHard.push('MINOR_INVOLVED');
  const safetyHold = HOLD.filter(([, re]) => re.test(text)).map(([c]) => c);
  const notes = NOTE.filter(([, re]) => re.test(text)).map(([c]) => c);
  const placeTerms = placeTermsOf(text, doc, county);
  // Place names ("Manatee River", "Bear Point") are not unusual animals.
  const unusual = unusualness(placeTerms.reduce((t, p) => t.split(p).join(' '), text));
  const evidenceText = `${passage.heading ?? ''} ${text}`;

  // Stage 2: first frame that matches builds the draft from the facts.
  let frame: Frame | null = null;
  let built: FrameResult | null = null;
  for (const f of FRAMES) {
    const r = f.build({ text, doc, legal, charge, county });
    if (r) {
      frame = f;
      built = r;
      break;
    }
  }
  const forbiddenTerms = [...pd.names, ...pd.residences, ...pd.ages.map(String), ...pd.ages.map((a) => `${a}-year-old`)];
  let draft: { playTitle: string; explanation: string } | null = null;
  let draftIssues: string[] = [];
  if (built) {
    const role = actedOnRole(text, built.actedOn);
    const parts = [built.summary, legalSentence(legal, charge, role, doc), attributionSentence(doc, county)].filter(Boolean);
    let explanation = parts.join(' ');
    if (explanation.length > 600) explanation = parts.slice(0, 2).join(' ');
    draft = { playTitle: titleCase(built.title.replace(/\s+/g, ' ').trim()), explanation: explanation.replace(/\s+/g, ' ').trim() };
    draftIssues = draftProblems(draft, {
      headline: doc.title,
      evidenceText,
      legalStage: legal,
      forbiddenTerms,
      placeTerms,
      extraNeutral: [...`${doc.agency.name} ${doc.agency.reference} ${doc.agency.documentLabel} ${doc.agency.actors} documented case`.split(/\s+/), ...(county ? [county] : [])],
      existingTitles: ctx.existingTitles,
    });
  }

  // Quality (deterministic; uncalibrated weights — a ranking aid, never an approval).
  const gtaHits = new Set([...text.matchAll(GTA_CUES)].map((m) => m[1]!.toLowerCase())).size;
  const supported = claims.filter((c) => c.status === 'supported').length;
  const disputed = claims.some((c) => c.status === 'disputed');
  const verifiedCounty = !!floridaCounty(passage.heading) || !!doc.agency.county;
  const outOfState = safetyHold.includes('NEEDS_LOCATION_REVIEW');
  const scores = {
    unusualness: built ? Math.min(1, 0.8 + (unusual.score >= 4 ? 0.2 : 0)) : Math.min(1, Math.max(0, unusual.score) / 4) * 0.6,
    specificity: Math.min(1, Math.min(1, objects.length / 5) * 0.6 + (county ? 0.2 : 0) + (doc.eventDate || doc.period.from ? 0.2 : 0)),
    entertainment: built ? built.entertainment : Math.min(0.5, Math.max(0, unusual.score) * 0.1),
    gtaPlausibility: Math.min(1, gtaHits * 0.2),
    factualConfidence: Math.max(0, Math.min(1, 0.6 + (claims.length ? (0.4 * supported) / claims.length : 0) - (disputed ? 0.15 : 0))),
    geoConfidence: outOfState ? 0.3 : verifiedCounty ? 0.95 : 0.7,
    safety: safetyHard.length ? 0 : Math.max(0, 1 - (safetyHold.length ? 0.5 : 0) - (notes.length ? 0.1 : 0)),
    sourceQuality: ctx.source.access?.officialGovernment ? 0.9 : 0.5,
  };
  const round2 = (n: number) => Math.round(n * 100) / 100;
  for (const k of Object.keys(scores) as (keyof typeof scores)[]) scores[k] = round2(scores[k]);
  const total = Math.round(
    100 * (0.25 * scores.unusualness + 0.1 * scores.specificity + 0.25 * scores.entertainment + 0.1 * scores.gtaPlausibility + 0.1 * scores.factualConfidence + 0.1 * scores.geoConfidence + 0.1 * scores.sourceQuality),
  );

  const reasons: string[] = [];
  let decision: EvaluatedIncident['decision'] = 'candidate';
  if (safetyHard.length) {
    decision = 'reject';
    reasons.push(...safetyHard);
  } else if (!built && (unusual.score < 4 || ROUTINE_ENFORCEMENT.test(text) || /\b(dead|carcass\w*)\b/i.test(text))) {
    // Without a recognized oddity frame, only clearly unusual, non-routine incidents reach a human.
    decision = 'reject';
    reasons.push(ROUTINE_ENFORCEMENT.test(text) ? 'ROUTINE_ENFORCEMENT' : 'NOT_UNUSUAL');
  } else if (total < MIN_TOTAL_SCORE) {
    decision = 'reject';
    reasons.push('LOW_QUALITY_SCORE');
  } else if (safetyHold.length) {
    decision = 'safety_review';
    reasons.push(...safetyHold);
  }
  if (decision !== 'reject') {
    if (!draft) reasons.push('DRAFT_REQUIRED');
    else if (draftIssues.length) reasons.push('DRAFT_INVALID');
    if (!verifiedCounty) reasons.push('COUNTY_UNVERIFIED');
    if (ALLEGATION_STAGES.has(legal) && legal !== 'unknown') reasons.push('ALLEGATION_ONLY');
    if (disputed) reasons.push('DISPUTED_CLAIM');
  }
  reasons.push(...notes);

  const month = (doc.eventDate ?? doc.period.to ?? doc.publishedAt ?? '').slice(0, 7) || '-';
  const keyObjects = objects.filter((o) => new RegExp(`^(?:${ANIMALS})$`).test(o) || /^(?:masks?|clowns?|swamp buggy|airboats?|lights|holes?|artifacts?|decoys|enclosures?)$/.test(o));
  const signature = cleanText(`${built?.incidentType ?? 'unclassified'}|${county ?? '-'}|${month}|${[...new Set(keyObjects.map(singular))].sort().join(',')}`, 200);
  const passageDigest = sha(text).slice(0, 16);
  const providerKey = `${doc.documentId}#${passageDigest}`;

  const blockers = [
    ...(ctx.source.licenseStatus !== 'approved' ? ['SOURCE_RIGHTS_UNREVIEWED'] : []),
    ...accessOperationProblems(ctx.source, [...new Set([...OFFICIAL_PUBLISH_OPERATIONS, ...OFFICIAL_AUTOMATION_OPERATIONS])]).map((p) => p.split(':')[0]!),
    'NO_AUTOMATED_APPROVAL_MODE',
    'NO_MEASURED_ACCURACY',
    ...(decision !== 'candidate' ? ['NOT_A_CLEAN_CANDIDATE'] : []),
    ...(!draft || draftIssues.length ? ['NO_VALID_DRAFT'] : []),
    ...(ALLEGATION_STAGES.has(legal) && legal !== 'warning' && legal !== 'cited' ? ['CRIMINAL_ALLEGATION'] : []),
    ...(notes.length || safetyHold.length ? ['SAFETY_NOTES'] : []),
  ];

  const facts: IncidentFacts = {
    version: 1,
    extractor: `${doc.adapterId}:${EXTRACTOR_VERSION}`,
    incidentType: built?.incidentType ?? 'unclassified',
    documentId: doc.documentId,
    passageId: passage.id,
    evidenceUrl: doc.url,
    location: {
      state: 'Florida',
      county,
      place: null,
      verified: verifiedCounty && !outOfState,
      basis: floridaCounty(passage.heading) ? 'report_heading' : 'agency_jurisdiction',
    },
    eventDate: doc.eventDate
      ? { from: doc.eventDate, to: doc.eventDate, precision: 'day', basis: 'stated_in_text' }
      : doc.period.from || doc.period.to
        ? { from: doc.period.from, to: doc.period.to, precision: 'range', basis: 'report_period' }
        : doc.publishedAt
          ? { from: null, to: doc.publishedAt.slice(0, 10), precision: 'range', basis: 'publication_date' }
          : { from: null, to: null, precision: 'unknown', basis: 'none' },
    participants: participantsOf(text, doc),
    objects,
    actions: claims.slice(0, 10).map((c) => cleanText(`${c.subject} ${c.predicate} ${c.object}`, 160)),
    legalStage: legal,
    claims,
    redactions: { personNames: pd.names.length, ages: pd.ages.length, excludedParagraphs: doc.excludedParagraphs },
    safetyFlags: [...new Set([...safetyHard, ...safetyHold, ...notes])],
    quality: { scores, total, decision, reasons: [...new Set(reasons)].slice(0, 20) },
    draft: built && frame ? { origin: 'rules', generator: EXTRACTOR_VERSION, frame: frame.id, problems: draftIssues.slice(0, 20).map((p) => p.slice(0, 240)) } : null,
    signature,
    verification: 'pending',
    phaseB: { eligible: false, blockers: [...new Set(blockers)].slice(0, 20) },
  };
  const checked = parse(incidentFactsSchema, facts);
  if (!checked.ok) throw new Error(`facts record failed its own schema: ${formatIssues(checked.issues, 4)}`);
  return { passage, facts, draft, forbiddenTerms, placeTerms, providerKey, decision, reasons: facts.quality.reasons };
}

export type EvaluatedDocument = { doc: OfficialDocument; incidents: EvaluatedIncident[] };

export function evaluateDocument(doc: OfficialDocument, ctx: EvaluationContext): EvaluatedDocument {
  return { doc, incidents: doc.passages.map((p) => evaluatePassage(doc, p, ctx)) };
}

// ---------------------------------------------------------------------------
// Deduplication by incident (not headline): signature + key-object overlap
// ---------------------------------------------------------------------------

const KEY_STOP = new Set(['officer', 'officers', 'wildlife', 'deputies', 'find', 'found', 'discover', 'police', 'person', 'man', 'woman', 'hidden', 'inside', 'under', 'live', 'baby', 'juvenile', 'young']);
const keyNouns = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[a-z]+/g) ?? [])
      .map((w) => (w === 'gator' || w === 'gators' ? 'alligator' : singular(w)))
      .filter((w) => w.length > 2 && !KEY_STOP.has(w) && (new RegExp(`^(?:${ANIMALS})$`).test(w) || /^(?:bucket|cooler|mask|clown|costume|swamp|buggy|airboat|hole|artifact|decoy|lemur|enclosure|doorway|light|suv|register|drawer|rag|vehicle|boat|vessel)$/.test(w))),
  );

/** Possible duplicate of an incident seen earlier in this run or already in D1 (title index). Flags for review; never drops. */
export function possibleDuplicate(
  inc: EvaluatedIncident,
  earlier: readonly EvaluatedIncident[],
  existing: readonly ExistingTitle[],
  seenAt: string | null,
): { key: string; similarity: number } | null {
  const sig = inc.facts.signature;
  for (const e of earlier) {
    if (e.providerKey === inc.providerKey) continue;
    if (e.facts.signature === sig && !sig.startsWith('unclassified|')) return { key: `official:${e.providerKey}`, similarity: 1 };
  }
  const mine = keyNouns(`${inc.draft?.playTitle ?? ''} ${inc.facts.objects.join(' ')}`);
  if (mine.size === 0) return null;
  for (const t of existing) {
    const theirs = keyNouns(t.title);
    const shared = [...mine].filter((w) => theirs.has(w));
    const animalShared = shared.some((w) => new RegExp(`^(?:${ANIMALS})$`).test(w));
    const within = !seenAt || !t.seenAt || Math.abs(Date.parse(seenAt) - Date.parse(t.seenAt)) <= 45 * 86_400_000;
    if (shared.length >= 2 && animalShared && within) return { key: t.incidentKey, similarity: Math.round((shared.length / Math.max(mine.size, theirs.size)) * 100) / 100 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Into the shared pipeline (Discovered → ImportItem). Rejected passages are counted, not imported.
// ---------------------------------------------------------------------------

export function incidentUrl(doc: OfficialDocument, inc: EvaluatedIncident): string {
  // canonical_url is UNIQUE per reference: a per-incident fragment keeps several incidents of ONE document apart.
  return `${doc.url}#incident-${inc.providerKey.split('#')[1]}`;
}

export function toDiscovered(doc: OfficialDocument, inc: EvaluatedIncident, seenAt: string): Discovered {
  const notes = [
    `Official report (${doc.adapterId}), passage ${inc.passage.id}${inc.passage.heading ? ` under "${inc.passage.heading}"` : ''}.`,
    `Quality ${inc.facts.quality.total}/100 → ${inc.decision}${inc.reasons.length ? ` (${inc.reasons.join(', ')})` : ''}.`,
    inc.facts.draft ? `Facts-first draft (${inc.facts.draft.frame})${inc.facts.draft.problems.length ? ` with problems: ${inc.facts.draft.problems.map((p) => p.split(':')[0]).join(', ')}` : ' passed validation'}.` : 'No draft: a reviewer must write the title and explanation from the facts.',
    'Facts are source-reported; verify them against the linked document before approving.',
  ].join('\n');
  return {
    kind: 'FLORIDA_NEWS',
    provider: OFFICIAL_PROVIDER,
    providerKey: inc.providerKey,
    title: doc.title,
    dedupeTitle: inc.draft?.playTitle ?? `${inc.facts.incidentType} ${inc.facts.objects.join(' ')}`,
    originalUrl: doc.url,
    canonicalUrl: incidentUrl(doc, inc),
    publisher: doc.agency.name,
    publishedAt: doc.publishedAt,
    seenAt,
    excerpt: '',
    gameHint: null,
    wikiPageId: null,
    wikiSection: null,
    floridaSignal: 'domain',
    floridaEvidence: inc.passage.heading ?? doc.agency.name,
    notes,
    prefilter: { decision: inc.decision === 'reject' ? 'reject' : 'candidate', reasonCodes: inc.reasons.filter((r) => /^[A-Z0-9_]+$/.test(r)).slice(0, 40) },
    aiAllowed: false,
    facts: inc.facts,
    draft: inc.draft && inc.facts.draft?.problems.length === 0 ? inc.draft : null,
  };
}
