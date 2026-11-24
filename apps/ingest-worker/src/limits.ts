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
  /** DOJ press releases from Florida's three U.S. Attorney's Offices (public domain). */
  dojEnabled: boolean;
  dojLookbackDays: number;
  dojMaxPages: number;
  /** false (default): charges/arrests are recorded as rejected (ALLEGATION_ONLY); only convictions/pleas/sentences flow. */
  dojIncludeAllegations: boolean;
  /** Florida Man API dataset (staging/dev only; refused in production regardless of this flag). */
  datasetEnabled: boolean;
  datasetDaysPerRun: number;
  /** DOJ releases below this unusualness score are recorded as NOT_UNUSUAL (0 = off). */
  dojMinUnusual: number;
  /** Historical DOJ backfill: pages per run (≤ 10 per step, 1 s apart) until `dojBackfillDays` are covered. */
  dojBackfillEnabled: boolean;
  dojBackfillDays: number;
  dojBackfillPagesPerRun: number;
  /** Start a successor backfill instance when one finishes with pages left. */
  dojBackfillChain: boolean;
  /** One backfill instance at a time: lease length. */
  dojBackfillLeaseMinutes: number;
  /** Planned subrequests per Workflow INSTANCE (Workers Free: 50 per invocation; keep headroom). */
  subrequestBudget: number;
  /** Title-index pages (500 incidents each) reserved per content kind for fuzzy dedupe. */
  titlePagesPerKind: number;
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
  | 'LOW_INVENTORY_DAYS'
  | 'DOJ_ENABLED'
  | 'DOJ_LOOKBACK_DAYS'
  | 'DOJ_MAX_PAGES'
  | 'DOJ_INCLUDE_ALLEGATIONS'
  | 'FM_DATASET_ENABLED'
  | 'FM_DATASET_DAYS_PER_RUN'
  | 'DOJ_MIN_UNUSUAL'
  | 'DOJ_BACKFILL_ENABLED'
  | 'DOJ_BACKFILL_DAYS'
  | 'DOJ_BACKFILL_PAGES_PER_RUN'
  | 'DOJ_BACKFILL_CHAIN'
  | 'DOJ_BACKFILL_LEASE_MINUTES'
  | 'SUBREQUEST_BUDGET'
  | 'TITLE_PAGES_PER_KIND',
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
    dojEnabled: v.DOJ_ENABLED === 'true',
    dojLookbackDays: int(v.DOJ_LOOKBACK_DAYS, 2, 1, 14),
    // ~62 releases/day department-wide, 50 per page (measured 2026-11-23): 2 days ≈ 3 pages.
    dojMaxPages: int(v.DOJ_MAX_PAGES, 6, 1, 20),
    dojIncludeAllegations: v.DOJ_INCLUDE_ALLEGATIONS === 'true',
    datasetEnabled: v.FM_DATASET_ENABLED === 'true',
    datasetDaysPerRun: int(v.FM_DATASET_DAYS_PER_RUN, 2, 1, 10),
    dojMinUnusual: int(v.DOJ_MIN_UNUSUAL, 2, 0, 20),
    dojBackfillEnabled: v.DOJ_BACKFILL_ENABLED === 'true',
    dojBackfillDays: int(v.DOJ_BACKFILL_DAYS, 365, 7, 3650),
    // Per backfill INSTANCE (one page per step). Also capped by the subrequest plan (≈30 fit in 45).
    dojBackfillPagesPerRun: int(v.DOJ_BACKFILL_PAGES_PER_RUN, 25, 0, 200),
    dojBackfillChain: v.DOJ_BACKFILL_CHAIN !== 'false',
    dojBackfillLeaseMinutes: int(v.DOJ_BACKFILL_LEASE_MINUTES, 60, 5, 720),
    // Workers Free: 50 subrequests per invocation incl. Service Binding calls; 5 kept as headroom.
    subrequestBudget: int(v.SUBREQUEST_BUDGET, 45, 12, 10_000),
    titlePagesPerKind: int(v.TITLE_PAGES_PER_KIND, 2, 1, 100),
  };
}
