import { hashString } from './rng.ts';

/**
 * Deduplication helpers for the candidate → approved pipeline.
 *
 *  1. Canonical URL       — same article reached via tracking links, AMP, www, etc.
 *  2. Title fingerprint   — same words in any order / casing / punctuation.
 *  3. Title similarity    — near-duplicate wording (syndicated rewrites, paraphrases).
 *
 * Similarity is a heuristic. Scores between the review and duplicate thresholds
 * are flagged for a human, never silently merged.
 */

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  'ref',
  'ref_src',
  'ref_url',
  'referrer',
  'cmpid',
  'cmp',
  'ocid',
  'taid',
  'smid',
  'sr_share',
  'via',
  'outputtype',
  'amp',
  '_ga',
  '_gl',
  'icid',
  'ito',
  'at_medium',
  'at_campaign',
]);

const TRACKING_PREFIXES = ['utm_', 'pk_', 'hsa_', 'ga_', 'at_'];

/**
 * Normalize an article URL so that the same story from the same publisher
 * compares equal. Returns null for anything that is not an absolute http(s) URL.
 */
export function canonicalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.protocol = 'https:';
  url.username = '';
  url.password = '';
  url.hash = '';
  url.port = '';
  url.hostname = url.hostname.toLowerCase().replace(/^(www\d?|m|amp|mobile)\./, '').replace(/\.$/, '');

  const kept: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    const k = key.toLowerCase();
    if (TRACKING_PARAMS.has(k) || TRACKING_PREFIXES.some((p) => k.startsWith(p))) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);

  let path = url.pathname
    .replace(/\/{2,}/g, '/')
    .replace(/\/(amp|amp\.html)\/?$/i, '/')
    .replace(/\/index\.(html?|php)$/i, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  url.pathname = path;

  return url.toString();
}

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by for from had has have he her his i in into is it its ' +
    'of on or our says said she so than that the their them they this to up was we were ' +
    'what when where which who will with you your after over about out off just more new ' +
    'police report reports reportedly'
  ).split(' '),
);

/**
 * Strip a trailing " - Publisher" / " | Publisher" suffix that news headlines
 * commonly carry, but only when the suffix is short.
 */
export function stripPublisherSuffix(title: string): string {
  const m = /^(.*\S)\s+[|–—-]\s+([^|–—-]{1,40})$/.exec(title.trim());
  if (!m) return title.trim();
  const suffixWords = (m[2] ?? '').trim().split(/\s+/).length;
  return suffixWords <= 5 ? (m[1] ?? title).trim() : title.trim();
}

/** Lowercase, strip accents, quotes and punctuation, collapse whitespace. */
export function normalizeTitle(title: string): string {
  return stripPublisherSuffix(title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’ʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Very light stemming so "arrested"/"arrests"/"arrest" collapse together. */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('es') && !token.endsWith('ses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function contentTokens(title: string): string[] {
  return normalizeTitle(title)
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/** Order-insensitive fingerprint of a headline's content words. */
export function titleFingerprint(title: string): string {
  const tokens = [...new Set(contentTokens(title))].sort();
  return `fp_${hashString(tokens.join(' ')).toString(16).padStart(8, '0')}`;
}

function trigrams(text: string): Set<string> {
  const s = ` ${text} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function dice<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

export type PreparedTitle = { tokens: Set<string>; grams: Set<string> };
type Prepared = PreparedTitle;

/** Precompute a title's token + trigram sets (reuse across many comparisons). */
export function prepareTitle(title: string): PreparedTitle {
  return prepare(title);
}

/** Similarity of two prepared titles; identical to titleSimilarity on the raw strings. */
export function preparedSimilarity(a: PreparedTitle, b: PreparedTitle): number {
  return similarityPrepared(a, b);
}

function prepare(title: string): Prepared {
  return { tokens: new Set(contentTokens(title)), grams: trigrams(normalizeTitle(title)) };
}

function similarityPrepared(a: Prepared, b: Prepared): number {
  return 0.5 * jaccard(a.tokens, b.tokens) + 0.5 * dice(a.grams, b.grams);
}

/** 0..1 similarity between two headlines (word overlap + character trigrams). */
export function titleSimilarity(a: string, b: string): number {
  return similarityPrepared(prepare(a), prepare(b));
}

export const DEFAULT_DUPLICATE_THRESHOLD = 0.82;
export const DEFAULT_REVIEW_THRESHOLD = 0.5;

export type DedupeRecord = { id: string; title: string; url?: string };

export type DedupeVerdict =
  | { kind: 'new' }
  | { kind: 'duplicate'; reason: 'url' | 'fingerprint' | 'similar'; of: string; similarity: number }
  | { kind: 'review'; of: string; similarity: number };

export type DeduperOptions = { duplicateThreshold?: number; reviewThreshold?: number };

/**
 * Incremental deduplicator. Seed it with everything already known (candidates
 * and approved questions), then `check` + `add` each incoming item so that
 * duplicates inside the same batch are caught too.
 */
export function createDeduper(existing: Iterable<DedupeRecord>, options: DeduperOptions = {}) {
  const duplicateThreshold = options.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD;
  const reviewThreshold = options.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;
  const byUrl = new Map<string, string>();
  const byFingerprint = new Map<string, string>();
  const pool: { id: string; prepared: Prepared }[] = [];

  function add(record: DedupeRecord): void {
    const canonical = record.url ? canonicalizeUrl(record.url) : null;
    if (canonical && !byUrl.has(canonical)) byUrl.set(canonical, record.id);
    const fp = titleFingerprint(record.title);
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, record.id);
    pool.push({ id: record.id, prepared: prepare(record.title) });
  }

  function check(item: { title: string; url?: string }): DedupeVerdict {
    const canonical = item.url ? canonicalizeUrl(item.url) : null;
    const urlHit = canonical ? byUrl.get(canonical) : undefined;
    if (urlHit) return { kind: 'duplicate', reason: 'url', of: urlHit, similarity: 1 };

    const fpHit = byFingerprint.get(titleFingerprint(item.title));
    if (fpHit) return { kind: 'duplicate', reason: 'fingerprint', of: fpHit, similarity: 1 };

    const prepared = prepare(item.title);
    let best: { id: string; score: number } | null = null;
    for (const entry of pool) {
      const score = similarityPrepared(prepared, entry.prepared);
      if (!best || score > best.score) best = { id: entry.id, score };
    }
    if (best && best.score >= duplicateThreshold) {
      return { kind: 'duplicate', reason: 'similar', of: best.id, similarity: round(best.score) };
    }
    if (best && best.score >= reviewThreshold) {
      return { kind: 'review', of: best.id, similarity: round(best.score) };
    }
    return { kind: 'new' };
  }

  for (const record of existing) add(record);
  return { check, add };
}

/** All pairs of headlines at or above `threshold` similarity. O(n²); fine for a few thousand items. */
export function findSimilarPairs(
  records: readonly DedupeRecord[],
  threshold: number,
): { a: string; b: string; similarity: number }[] {
  const prepared = records.map((r) => ({ id: r.id, p: prepare(r.title) }));
  const out: { a: string; b: string; similarity: number }[] = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const x = prepared[i]!;
      const y = prepared[j]!;
      const s = similarityPrepared(x.p, y.p);
      if (s >= threshold) out.push({ a: x.id, b: y.id, similarity: round(s) });
    }
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
