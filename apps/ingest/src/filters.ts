/**
 * Deterministic content filters (run before any model call). Code rules are
 * the first and cheapest gate: they can reject, never approve.
 */
import { domainMatches } from './normalize.ts';

/** Tragedy / violence / vulnerable-person terms: not entertainment material. */
const SENSITIVE = /\b(killed|kills|dies|died|dead|death|deadly|fatal(ly)?|murder(ed|s)?|homicide|shot|shooting|stabb(ed|ing)|suicide|overdose|rape|sexual|abuse[ds]?|child(ren)?|kid|toddler|infant|baby|teen(ager)?s?|missing|drown(ed|ing)?|hostage|terror(ism|ist)?|massacre|funeral|victims?|injured|critically|hospitali[sz]ed)\b/i;
/** Routine news that is not a quirky incident. (Team names that are also animals — dolphins, panthers — are deliberately absent.) */
const ROUTINE = /\b(election|senate|governor|desantis|congress|legislat\w*|lawmakers?|stock market|earnings|inflation|mortgage rates?|nfl|nba|mlb|nhl|playoffs?|touchdown|quarterback|buccaneers)\b/i;

export type FilterResult = { decision: 'candidate' | 'reject'; reasonCodes: string[] };

export function prefilterFlorida(input: { title: string; domain: string; floridaSignal: 'title' | 'domain' | 'none'; blockedDomains: readonly string[] }): FilterResult {
  const reasons: string[] = [];
  if (input.title.length < 20) reasons.push('TITLE_TOO_SHORT');
  if (domainMatches(input.domain, input.blockedDomains)) reasons.push('SATIRE_OR_BLOCKED_DOMAIN');
  if (input.floridaSignal === 'none') reasons.push('NO_FLORIDA_SIGNAL');
  if (SENSITIVE.test(input.title)) reasons.push('SENSITIVE_TERMS');
  if (ROUTINE.test(input.title)) reasons.push('ROUTINE_NEWS');
  return { decision: reasons.length ? 'reject' : 'candidate', reasonCodes: reasons };
}

export function prefilterGta(input: { title: string; needsReviewReason?: string }): FilterResult {
  const reasons: string[] = [];
  if (input.title.length < 4) reasons.push('TITLE_TOO_SHORT');
  // Wiki extraction uncertainty (column headings, unlinked sections) is a review reason, not a rejection.
  return { decision: reasons.length ? 'reject' : 'candidate', reasonCodes: reasons };
}

/** Verbatim Florida place-name evidence from the source text (null if none). Used as grounding, never as proof. */
export function floridaEvidence(title: string, placeNames: readonly string[]): string | null {
  for (const name of placeNames) {
    const m = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(title);
    if (m) return m[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unusualness ("is this a fun, unlikely-but-true story?"): a deterministic ranking signal.
// It can reject (official sources below a threshold) or annotate for the reviewer — never approve.
// ---------------------------------------------------------------------------

const UNUSUAL_CUES: [label: string, re: RegExp][] = [
  ['animal', /\b(alligators?|gators?|crocodiles?|pythons?|boas?|snakes?|iguanas?|manatees?|monkeys?|primates?|lemurs?|sloths?|emus?|ostrich(es)?|kangaroos?|raccoons?|possums?|opossums?|squirrels?|bears?|panthers?|bobcats?|sharks?|dolphins?|turtles?|tortoises?|parrots?|macaws?|cockatoos?|songbirds?|birds?|owls?|eagles?|roosters?|chickens?|goats?|pigs?|hogs?|horses?|ponies|donkeys?|llamas?|alpacas?|frogs?|toads?|lizards?|geckos?|tarantulas?|scorpions?|bees?|eels?|lobsters?|crabs?|conchs?|seahorses?|coral reefs?|orchids?|cactus|cacti)\b/i],
  ['vehicle', /\b(lawn ?mowers?|golf carts?|airboats?|jet ?skis?|kayaks?|paddle ?boards?|scooters?|tractors?|forklifts?|hovercraft|blimps?|hot air balloons?|submarines?|semi-submersibles?|zambonis?)\b/i],
  ['object', /\b(hot tubs?|toilets?|coolers?|inflatables?|costumes?|mascots?|wigs?|clowns?|pirates?|unicorns?|mermaids?|santa claus|pizzas?|tacos?|burritos?|nuggets?|drive-?thru|waffle house|bingo|slot machines?|fireworks|meteorites?|moon rocks?|cigars?|rum|cheese|eggs|mangoes|lottery tickets?|scratch-offs?|sneakers|beanie babies|pok[eé]mon|trading cards?|comic books?|dinosaur|fossils?|shipwrecks?|treasure|doubloons|gold coins?|statues?|drones?|park signs?|road signs?|yachts?|teak|artworks?|paintings?|warhol|picasso|banksy|doping|race ?horses?|golf balls?|jerseys?|memorabilia)\b/i],
  ['deception', /\b(fake|faked|counterfeit\w*|impersonat\w*|pos(ed|ing) as|disguis\w*|dressed (up )?as|pretend\w*|bogus|phony|sham|fictitious|imaginary|self-proclaimed|claimed to be)\b/i],
  ['odd_act', /\b(hid(den|ing)? (in|inside|under)|stuffed (in|into|inside)|strapped to|concealed (in|inside|under)|tried to (pay|sell|ship|mail|smuggle)|attempt(ed)? to (pay|sell|ship|mail|smuggle)|in (his|her|their) (pants|underwear|bra|luggage|carry-on|prosthetic))\b/i],
  ['wildlife_crime', /\b(poach\w*|lacey act|endangered species|wildlife trafficking|smuggl\w* (protected|exotic|endangered|wildlife|reptiles?|birds?|eggs|turtles?|corals?))\b/i],
  ['strange', /\b(psychic|witch\w*|exorcis\w*|ghosts?|haunted|space aliens?|extraterrestrials?|ufos?|zombies?|vampires?|time travel\w*|wizard|voodoo|bizarre|unusual|strange|weird|odd)\b/i],
];

const ROUTINE_CUES: [label: string, re: RegExp][] = [
  ['routine_fraud', /\b((bank|wire|mail|health ?care|medicare|medicaid|tax|securities|insurance|mortgage|loan|ppp|pandemic|identity|credit card|investment|unemployment|benefits?|program) fraud|identity theft|money laundering|bank secrecy act|bribery|kickbacks?|embezzl\w*|tax evasion|false tax|tax returns?|ponzi|structuring)\b/i],
  ['administrative', /\b(awards?|honou?r(s|ed)?|recogni[sz]ed|appoint\w*|sworn|retire\w*|statement|settle(s|d|ment)?|agrees? to pay|consent decree|civil (penalty|complaint|lawsuit)|annual report|grants?|outreach)\b/i],
];

export type Unusualness = { score: number; cues: string[] };

/** +2 per distinct unusual cue group, −1 per routine cue group. 0 = ordinary; ≥ 2 = at least one unusual element. */
export function unusualness(text: string): Unusualness {
  const cues: string[] = [];
  let score = 0;
  for (const [label, re] of UNUSUAL_CUES) {
    const m = re.exec(text);
    if (m) {
      score += 2;
      cues.push(`${label}:${m[0].toLowerCase()}`);
    }
  }
  for (const [label, re] of ROUTINE_CUES) {
    if (re.test(text)) {
      score -= 1;
      cues.push(label);
    }
  }
  return { score, cues };
}

export const describeUnusualness = (u: Unusualness) => `Unusualness: ${u.score}${u.cues.length ? ` (${u.cues.join(', ')})` : ''}`;
