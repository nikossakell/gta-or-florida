import { canonicalizeUrl, cleanText } from '@gof/core';
import type { FeedConfig } from './adapters/rss.ts';

export { cleanText };

/** data/sources.json: discovery configuration (never published content). */
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
  grandTheftWiki?: {
    categories: { name: string; mode: 'sections' | 'pages'; note?: string }[];
  };
  domains: {
    blocked: { list: string[] };
    floridaHints: { list: string[] };
  };
  floridaPlaceNames: string[];
  /** Publisher feeds; fetched only when the source policy is approved. */
  rss?: FeedConfig[];
};

/** Validate the parsed data/sources.json (runtime-neutral: the Worker bundles it as a JSON import). */
export function parseSourcesConfig(raw: unknown, label = 'sources.json'): SourcesConfig {
  const config = raw as SourcesConfig;
  if (config?.version !== 1 || !Array.isArray(config.gdelt?.batches)) throw new Error(`${label} has an unexpected shape`);
  return config;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function domainMatches(domain: string, list: readonly string[]): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '');
  return list.some((entry) => d === entry || d.endsWith(`.${entry}`));
}

/** Heuristic only: whether title/domain suggests Florida. A reviewer must still verify the location. */
export function createFloridaSignal(config: Pick<SourcesConfig, 'floridaPlaceNames' | 'domains'>) {
  const place = new RegExp(`\\b(${config.floridaPlaceNames.map(escapeRegex).join('|')})\\b`, 'i');
  return (article: { title: string; domain: string }): 'title' | 'domain' | 'none' => {
    if (place.test(article.title)) return 'title';
    if (domainMatches(article.domain, config.domains.floridaHints.list)) return 'domain';
    return 'none';
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

const AMP_HOSTS = /^(amp|amp-cdn)\./;
const AGGREGATOR_HOSTS = ['news.google.com', 'cdn.ampproject.org', 'flipboard.com', 'msn.com', 'news.yahoo.com'];

/**
 * Canonical form of a publisher URL: tracking params removed, AMP variants and
 * host case normalized, meaningful query params preserved (see core canonicalizeUrl).
 * Returns null for non-http(s) or aggregator/AMP-cache URLs (we want publisher links).
 */
export function normalizePublisherUrl(raw: string): string | null {
  const canonical = canonicalizeUrl(raw);
  if (!canonical) return null;
  const host = new URL(canonical).hostname;
  if (AMP_HOSTS.test(host) || domainMatches(host, AGGREGATOR_HOSTS)) return null;
  return canonical;
}
