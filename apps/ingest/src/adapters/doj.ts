/**
 * U.S. Department of Justice press releases — Florida's three U.S. Attorney's Offices.
 *
 *   API:     GET https://www.justice.gov/api/v1/press_releases.json  (documented at
 *            https://www.justice.gov/developer/api-documentation/api_v1; pagesize ≤ 50;
 *            "more than 4 requests per second … may be blocked")
 *   Rights:  https://www.justice.gov/legalpolicies — DOJ website information is public domain
 *            "unless otherwise indicated"; third-party photos/graphics and DOJ seals/logos are NOT.
 *            We keep only title, teaser, URL, date and office (never images or seals).
 *
 * The API ignores component filters (verified 2026-11-23), and the per-district RSS/HTML pages sit
 * behind a bot challenge, so we page the department-wide list newest-first and keep releases
 * whose URL belongs to /usao-sdfl, /usao-mdfl or /usao-ndfl.
 */
import { cleanText } from '@gof/core';
import { decode } from './rss.ts';
import { unusualness, type Unusualness } from '../filters.ts';

export const DOJ_API = 'https://www.justice.gov/api/v1/press_releases.json';
export const DOJ_PAGE_SIZE = 50;
export const FLORIDA_DISTRICTS = {
  'usao-sdfl': 'Southern District of Florida',
  'usao-mdfl': 'Middle District of Florida',
  'usao-ndfl': 'Northern District of Florida',
} as const;
export type FloridaDistrict = keyof typeof FLORIDA_DISTRICTS;

export type DojRelease = {
  uuid: string;
  title: string;
  /** Plain-text teaser (dateline + first sentence); public domain. */
  teaser: string;
  url: string;
  /** YYYY-MM-DD (the API's date is day precision). */
  date: string;
  district: FloridaDistrict;
};

const DISTRICT_URL = /^https:\/\/www\.justice\.gov\/(usao-[smn]dfl)\/pr\/[a-z0-9-]+\/?$/;

export function dojPageUrl(page: number): URL {
  const u = new URL(DOJ_API);
  u.searchParams.set('pagesize', String(DOJ_PAGE_SIZE));
  u.searchParams.set('page', String(page));
  u.searchParams.set('sort', 'date');
  u.searchParams.set('direction', 'DESC');
  u.searchParams.set('fields', 'uuid,title,teaser,url,date,component');
  return u;
}

/** One API page → (all release dates on the page, Florida-district releases only). Defensive: untrusted JSON. */
export function parseDojPage(body: unknown): { dates: string[]; releases: DojRelease[] } {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) throw new Error('DOJ API: "results" missing');
  const dates: string[] = [];
  const releases: DojRelease[] = [];
  for (const raw of results) {
    const r = raw as Record<string, unknown>;
    const ts = Number(r.date);
    const date = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
    if (date) dates.push(date);
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    const m = DISTRICT_URL.exec(url);
    if (!m || !date) continue;
    const title = cleanText(decode(String(r.title ?? '')), 400);
    if (!title) continue;
    releases.push({
      uuid: String(r.uuid ?? '').slice(0, 80),
      title,
      teaser: cleanText(decode(String(r.teaser ?? '')), 800),
      url,
      date,
      district: m[1] as FloridaDistrict,
    });
  }
  return { dates, releases };
}

// ---------------------------------------------------------------------------
// Content rules for press releases (code can reject, never approve)
// ---------------------------------------------------------------------------

export type LegalStatus = 'convicted' | 'sentenced' | 'pleaded_guilty' | 'charged' | 'arrested' | 'civil' | 'other';

/** Case stage from the title/teaser. Charges and arrests are allegations: the person is presumed innocent. */
export function legalStatus(text: string): LegalStatus {
  const t = text.toLowerCase();
  if (/\bsentenced\b/.test(t)) return 'sentenced';
  if (/\b(pleads?|pleaded|pled) guilty\b/.test(t)) return 'pleaded_guilty';
  if (/\b(convict(s|ed)|found guilty|jury verdict)\b/.test(t)) return 'convicted';
  if (/\b(settle(s|d|ment)?|agree(s|d)? to pay|civil (complaint|lawsuit|penalt))/.test(t)) return 'civil';
  if (/\b(charged|indicted|indictment|accused|complaint|faces? charges)\b/.test(t)) return 'charged';
  if (/\b(arrested|arrest)\b/.test(t)) return 'arrested';
  return 'other';
}

export const isAllegation = (s: LegalStatus) => s === 'charged' || s === 'arrested' || s === 'other';

/**
 * Serious crimes and vulnerable victims: never game material. Broader than the news filter because
 * federal releases are dominated by violence, sexual exploitation, weapons and hard-drug cases.
 */
const DOJ_SERIOUS =
  /\b(child(ren)?|minors?|juveniles?|csam|exploit\w*|sexual\w*|sex(ually)?|porn\w*|enticement|groom\w*|traffick\w*|smuggl\w* (of )?(people|persons|migrants|aliens)|murder\w*|homicide|manslaughter|kill\w*|death|died|dead|fatal\w*|kidnap\w*|assassinat\w*|coup|carjack\w*|robber(y|ies)|armed|firearms?|guns?|machine ?guns?|shoot\w*|assault\w*|terror\w*|hate crime|bomb\w*|explosive\w*|threat\w*|stalk\w*|overdose\w*|fentanyl|heroin|cocaine|methamphetamine|cartel|gang|racketeering|abuse\w*|rape|torture\w*|elder|disab\w*|suicide|victims?|cyberstalk\w*|ransomware|extort\w*|shot|deceased|corpses?|bod(y|ies)|remains|dog ?fight\w*|cock ?fight\w*|animal cruelty|arson|set\w* .{0,20}on fire|patients?|onlyfans|escort\w*|prostitut\w*|nude|naked)\b/i;
/** Process notices and program news, not incidents. */
const DOJ_ROUTINE = /\b(announces? (new|the)|joins|welcomes|sworn in|appointed|names new|statement (of|from|by)|community outreach|town hall|grant(s)? to|awards? \$|training|conference|press conference|public service announcement|reminds|warns (the )?public|scam alert|seeks (information|public)|most wanted|fugitive)\b/i;

/**
 * `minUnusual` (default 0 = off): official releases are mostly routine prosecutions; below this
 * unusualness score they are recorded as NOT_UNUSUAL instead of filling the review queue.
 */
/** Immigration and election prosecutions: vulnerable people / partisan subjects — never game material. */
const DOJ_EXCLUDED_SUBJECT = /\b(illegal(ly)? re-?entr\w*|re-?entering the (country|united states)|deport\w*|removed from the united states|illegal aliens?|criminal aliens?|immigration (crimes?|offenses?|fraud|prosecutions?)|alien smuggling|visa fraud|asylum|(illegally )?vot(e|ed|ing) in|voter fraud|election (fraud|crimes?))\b/i;

export function prefilterDoj(input: { title: string; teaser: string; includeAllegations: boolean; minUnusual?: number }): {
  decision: 'candidate' | 'reject';
  reasonCodes: string[];
  status: LegalStatus;
  unusual: Unusualness;
} {
  const text = `${input.title} ${input.teaser}`;
  const unusual = unusualness(text);
  // The headline states this release's stage; the teaser often mentions *earlier* convictions.
  const fromTitle = legalStatus(input.title);
  const status = fromTitle !== 'other' ? fromTitle : legalStatus(input.teaser.slice(0, 300));
  const reasons: string[] = [];
  if (DOJ_SERIOUS.test(text)) reasons.push('SERIOUS_CRIME_OR_VULNERABLE_VICTIM');
  if (DOJ_ROUTINE.test(input.title)) reasons.push('ROUTINE_NOTICE');
  if (DOJ_EXCLUDED_SUBJECT.test(text)) reasons.push('IMMIGRATION_OR_ELECTION_CASE');
  if (!input.includeAllegations && isAllegation(status)) reasons.push('ALLEGATION_ONLY');
  if (input.title.length < 20) reasons.push('TITLE_TOO_SHORT');
  if ((input.minUnusual ?? 0) > 0 && unusual.score < input.minUnusual!) reasons.push('NOT_UNUSUAL');
  return { decision: reasons.length ? 'reject' : 'candidate', reasonCodes: reasons, status, unusual };
}

/** Verbatim dateline place (e.g. "Tampa, Florida") from the teaser: grounding for the location, not proof. */
export function dojDateline(teaser: string): string | null {
  const m = /^\s*([A-Z][A-Za-z .'-]{1,40}),\s*(Florida|Fla\.?)\b/.exec(teaser);
  return m ? `${m[1]}, ${m[2]}` : null;
}
