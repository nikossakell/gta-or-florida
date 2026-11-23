/**
 * Per-run caps, set from Worker vars (strings). Defaults are sized for Workers FREE:
 * 10 ms CPU per step, 50 subrequests per invocation, 1,024 steps per instance,
 * 3,000 Workflow steps per day (Cloudflare docs, read 2026-11-23). See README_DEPLOYMENT.md §8b.
 * On Workers Paid, raise SCAN_PAGE_SIZE / SCAN_CANDIDATES / PROCESS_BATCH substantially.
 */
import { AI_DEFAULT_BUDGET, LOW_INVENTORY_DAYS } from '@gof/config';

export type IngestLimits = {
  /** Incidents per title-index page in one fuzzy-dedupe step (×2 titles worst case). */
  scanPageSize: number;
  /** Candidates compared per fuzzy-dedupe step. */
  scanCandidates: number;
  /** Planned items per link-check + AI step (≤ 6 HTTP hops + 2 AI calls each). */
  processBatch: number;
  /** Link checks per run (the rest import as "unchecked"; approval re-checks). */
  maxLinkChecks: number;
  /** Wiki pages fetched per run (one step each). */
  maxWikiPages: number;
  /** RSS feeds fetched per run (one step each). */
  maxFeeds: number;
  gdeltEnabled: boolean;
  gdeltQueries: number;
  /** GDELT runs only when approved RSS feeds yielded fewer Florida items than this. */
  gdeltMinRssItems: number;
  maxAiRequests: number;
  maxNeurons: number;
  /** Hard stop before a run could exceed this many steps (Free: 1,024 per instance). */
  maxSteps: number;
  lowInventoryDays: number;
};

export type LimitVars = Partial<Record<
  | 'SCAN_PAGE_SIZE'
  | 'SCAN_CANDIDATES'
  | 'PROCESS_BATCH'
  | 'MAX_LINK_CHECKS'
  | 'MAX_WIKI_PAGES'
  | 'MAX_FEEDS'
  | 'GDELT_ENABLED'
  | 'GDELT_QUERIES'
  | 'GDELT_MIN_RSS_ITEMS'
  | 'MAX_AI_REQUESTS'
  | 'MAX_NEURONS'
  | 'MAX_STEPS'
  | 'LOW_INVENTORY_DAYS',
  string
>>;

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export function parseLimits(v: LimitVars): IngestLimits {
  return {
    scanPageSize: int(v.SCAN_PAGE_SIZE, 25, 1, 500),
    scanCandidates: int(v.SCAN_CANDIDATES, 10, 1, 500),
    processBatch: int(v.PROCESS_BATCH, 4, 1, 20),
    maxLinkChecks: int(v.MAX_LINK_CHECKS, 15, 0, 500),
    maxWikiPages: int(v.MAX_WIKI_PAGES, 15, 0, 500),
    maxFeeds: int(v.MAX_FEEDS, 5, 0, 50),
    gdeltEnabled: v.GDELT_ENABLED === 'true',
    gdeltQueries: int(v.GDELT_QUERIES, 1, 0, 6),
    gdeltMinRssItems: int(v.GDELT_MIN_RSS_ITEMS, 10, 0, 10_000),
    maxAiRequests: int(v.MAX_AI_REQUESTS, 30, 0, AI_DEFAULT_BUDGET.maxRequestsPerRun * 10),
    maxNeurons: int(v.MAX_NEURONS, AI_DEFAULT_BUDGET.maxNeuronsPerRun, 0, 10_000),
    maxSteps: int(v.MAX_STEPS, 900, 50, 25_000),
    lowInventoryDays: int(v.LOW_INVENTORY_DAYS, LOW_INVENTORY_DAYS, 1, 365),
  };
}
