import {
  canonicalizeUrl,
  createDeduper,
  hashString,
  titleFingerprint,
  type Candidate,
  type CandidateFile,
  type DedupeRecord,
  type Question,
} from '@gof/core';
import type { GdeltArticle } from './gdelt.ts';

export type SourcesConfig = {
  version: 1;
  gdelt: {
    endpoint: string;
    minDelaySeconds: number;
    maxRecords: number;
    timespan: string;
    sort: 'DateDesc' | 'DateAsc' | 'HybridRel';
    queryOperators?: string;
    queriesPerRun: number;
    batches: { id: string; query: string }[];
  };
  domains: {
    blocked: { list: string[] };
    floridaHints: { list: string[] };
  };
  floridaPlaceNames: string[];
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function domainMatches(domain: string, list: readonly string[]): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '');
  return list.some((entry) => d === entry || d.endsWith(`.${entry}`));
}

export function createFloridaSignal(config: SourcesConfig) {
  const place = new RegExp(`\\b(${config.floridaPlaceNames.map(escapeRegex).join('|')})\\b`, 'i');
  return (article: Pick<GdeltArticle, 'title' | 'domain'>): Candidate['floridaSignal'] => {
    if (place.test(article.title)) return 'title';
    if (domainMatches(article.domain, config.domains.floridaHints.list)) return 'domain';
    return 'none';
  };
}

export type MergeStats = {
  fetched: number;
  added: number;
  flaggedForReview: number;
  duplicates: number;
  blocked: number;
  invalid: number;
};

export type MergeInput = {
  file: CandidateFile;
  approved: readonly Question[];
  articles: readonly { article: GdeltArticle; query: string }[];
  config: SourcesConfig;
  now: Date;
};

/**
 * Merge freshly discovered articles into the candidate queue.
 * Pure function: no I/O, deterministic for the same input.
 *
 * - Exact duplicates (same canonical URL, same title fingerprint, or very
 *   similar headline) of anything already known are dropped.
 * - Looser matches are kept but flagged with `possibleDuplicateOf` for a human.
 * - Satire / blocked domains are dropped.
 * - Nothing is ever written to the approved bank.
 */
export function mergeCandidates({ file, approved, articles, config, now }: MergeInput): { file: CandidateFile; stats: MergeStats } {
  const known: DedupeRecord[] = [
    ...file.candidates.map((c) => ({ id: c.id, title: c.title, url: c.canonicalUrl })),
    ...approved.map((q) => ({ id: q.id, title: q.headline, url: q.sourceUrl })),
  ];
  const deduper = createDeduper(known);
  const signal = createFloridaSignal(config);
  const stats: MergeStats = { fetched: articles.length, added: 0, flaggedForReview: 0, duplicates: 0, blocked: 0, invalid: 0 };
  const added: Candidate[] = [];
  const discoveredAt = now.toISOString();

  for (const { article, query } of articles) {
    const canonicalUrl = canonicalizeUrl(article.url);
    if (!canonicalUrl) {
      stats.invalid++;
      continue;
    }
    if (domainMatches(article.domain, config.domains.blocked.list)) {
      stats.blocked++;
      continue;
    }
    const verdict = deduper.check({ title: article.title, url: canonicalUrl });
    if (verdict.kind === 'duplicate') {
      stats.duplicates++;
      continue;
    }
    const candidate: Candidate = {
      id: `cand-${hashString(canonicalUrl).toString(16).padStart(8, '0')}`,
      title: article.title,
      url: article.url,
      canonicalUrl,
      domain: article.domain,
      discoveredAt,
      provider: 'gdelt',
      query,
      fingerprint: titleFingerprint(article.title),
      status: 'candidate',
      floridaSignal: signal(article),
    };
    if (article.seenAt) candidate.seenAt = article.seenAt;
    if (article.language) candidate.language = article.language;
    if (article.sourceCountry) candidate.sourceCountry = article.sourceCountry;
    if (verdict.kind === 'review') {
      candidate.possibleDuplicateOf = verdict.of;
      candidate.similarity = verdict.similarity;
      stats.flaggedForReview++;
    }
    deduper.add({ id: candidate.id, title: candidate.title, url: canonicalUrl });
    added.push(candidate);
    stats.added++;
  }

  return {
    file: { ...file, version: 1, updatedAt: discoveredAt, candidates: [...file.candidates, ...added] },
    stats,
  };
}

/** Pick the next `count` batches, rotating through the list across runs. */
export function selectBatches<T>(batches: readonly T[], start: number, count: number): { selected: T[]; next: number } {
  if (batches.length === 0) return { selected: [], next: 0 };
  const n = Math.min(Math.max(count, 0), batches.length);
  const offset = ((start % batches.length) + batches.length) % batches.length;
  const selected = Array.from({ length: n }, (_, i) => batches[(offset + i) % batches.length]!);
  return { selected, next: (offset + n) % batches.length };
}
