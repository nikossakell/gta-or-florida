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
