/**
 * Durable ingestion run, expressed as bounded Workflow steps.
 *
 *   checkpoints → discovery (one step per DOJ page / RSS feed / dataset day / GDELT / wiki page)
 *   → exact dedupe against D1 → paged fuzzy dedupe (title pages read once, scanned in slices)
 *   → plan → link check + AI in small batches → import in chunks of ≤ 20 → inventory check
 *
 * Subrequests are budgeted for the WHOLE instance (Workers Free: 50 per invocation, not reset by
 * steps — see subrequests.ts). Every request-making step first reserves its worst case; the tail
 * (dedupe, import, checkpoints, inventory) is always kept in reserve. A step that does not fit is
 * deferred: its cursor is not advanced, so the next run continues exactly there.
 *
 * mode "backfill": historical DOJ pages only, one page per step, persisted cursor, a lease so only
 * one backfill instance works at a time, and (when not done) a successor instance started at the end.
 *
 * Every phase reuses the shared, tested logic in @gof/ingest; the API Worker stays the only
 * writer to D1 and the enforcement point for source policy and the auto-publish gate.
 * Nothing here can approve or publish: imported items are candidates for human review.
 *
 * Determinism: Workflows may replay `run()` and return cached step results, so everything
 * outside a step is pure bookkeeping over earlier step outputs (no clocks, no randomness, no I/O).
 */
import { formatIssues, importItemSchema, MAX_IMPORT_ITEMS, parse, type ImportItem, type RunReport, type ScheduleResponse, type SourcePolicy } from '@gof/core';
import { NEURON_RATES, sourceById } from '@gof/config';
import { createWikiClient } from '@gof/ingest/adapters/grandtheftwiki.ts';
import { allowedFeeds } from '@gof/ingest/adapters/rss.ts';
import { createBudget, restoreBudget, snapshotBudget, type AiProvider, type BudgetSnapshot } from '@gof/ingest/classify.ts';
import { reducedExisting, indexPage, scanExisting, type ScanHit } from '@gof/ingest/dedupe-scan.ts';
import { discoverDoj, discoverDojBackfill, discoverFloridaManDataset, discoverGdelt, discoverRss, wikiPageRecords, wikiTargets, type DiscoveryResult, type Log } from '@gof/ingest/discover.ts';
import type { ExistingTitle } from '@gof/ingest/deduplicate.ts';
import type { WorkerClient } from '@gof/ingest/import.ts';
import type { SourcesConfig } from '@gof/ingest/normalize.ts';
import { fetchVerdict, OFFICIAL_ADAPTERS } from '@gof/ingest/official.ts';
import {
  buildImportItem,
  classifyOne,
  emptyStats,
  linkCheckOne,
  needsAi,
  needsLinkCheck,
  planCandidates,
  uniqueWithinRun,
  type Discovered,
  type PipelineStats,
  type Planned,
} from '@gof/ingest/pipeline.ts';
import { checkLinkWith, fetchLinkRequest, toLinkCheck } from '@gof/ingest/url-safety.ts';
import type { IngestLimits } from './limits.ts';
import { COST, isSubrequestLimitError, LINK_MAX_REDIRECTS, MAX_ITEMS, meteredFetch, SubrequestMeter, SubrequestPlan, tailCost, type SubrequestCategory } from './subrequests.ts';

export type StepConfig = { retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: string | number };
/** The subset of WorkflowStep we use (lets tests drive the run without workerd). */
export interface StepLike {
  do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>;
}

export type IngestParams = { dryRun?: boolean; sources?: 'all' | 'florida' | 'gta'; mode?: 'run' | 'backfill' };

export type IngestDeps = {
  cfg: SourcesConfig;
  limits: IngestLimits;
  client: WorkerClient;
  ai: AiProvider | null;
  fetchImpl: typeof fetch;
  userAgent: string;
  wikiApi: string;
  /** Structured event log (Workers Logs). Called only inside steps, so replays don't duplicate it. */
  event: (name: string, data: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between wiki page fetches (politeness). */
  wikiPaceMs?: number;
  /** Source policy lookup (tests); defaults to the bundled registry. */
  lookup?: (id: string) => SourcePolicy | undefined;
  /** Worker APP_ENV: staging-only sources are refused in production. */
  appEnv?: 'local' | 'staging' | 'production';
  /** Runtime subrequest meter shared with the API client (built with meteredFetch(…, 'api')). */
  meter?: SubrequestMeter;
  /** Start another instance of this Workflow (backfill chaining). */
  spawn?: (id: string, params: IngestParams) => Promise<void>;
  /** Wrap errors a retry cannot fix (Workflows: NonRetryableError). */
  nonRetryable?: (e: Error) => Error;
};

export type IngestSummary = {
  runId: string;
  dryRun: boolean;
  status: RunReport['status'];
  steps: number;
  discovered: number;
  toImport: number;
  outcomes: Record<string, number>;
  stats: PipelineStats;
  ai: { requests: number; neurons: number; stopped: string | null };
  errors: string[];
  inventory: ScheduleResponse['inventory'] | null;
  lowInventory: boolean;
  gdelt: 'not_needed' | 'disabled' | 'cooldown' | 'ran';
  mode: 'run' | 'backfill';
  /** Worst-case reservations (deterministic) and actual calls made in this invocation, per category. */
  subrequests: { limit: number; reserved: Record<SubrequestCategory, number>; actual: Record<SubrequestCategory, number>; deferred: string[] };
  backfill?: { from: string; to: string; pages: number; done: boolean; next: string | null; skipped?: string };
  /**
   * Official-report sources (FWC, sheriff newsrooms). Unattended runs never fetch them until the owner clears
   * discover/fetch/extractFacts and an automated acquisition method; until then each one is reported as
   * explicitly SKIPPED with its reasons, so a "Completed" run is never mistaken for ingested official content.
   */
  official: { sourceId: string; adapter: string; status: 'skipped'; reasons: string[] }[];
};

/** Pure (registry only): why each official-report adapter did not run unattended. */
export function officialSkips(lookup: (id: string) => SourcePolicy | undefined): IngestSummary['official'] {
  return OFFICIAL_ADAPTERS.map((a) => {
    const src = lookup(a.sourceId);
    if (!src) return { sourceId: a.sourceId, adapter: a.id, status: 'skipped' as const, reasons: ['SOURCE_NOT_IN_REGISTRY'] };
    const v = fetchVerdict(src, 'automated');
    // Even with every operation cleared, no unattended discovery adapter exists yet (explicit URLs only).
    const reasons = v.allowed ? ['AUTOMATED_DISCOVERY_NOT_IMPLEMENTED'] : v.problems.map((p) => p.split(':')[0]!);
    return { sourceId: a.sourceId, adapter: a.id, status: 'skipped' as const, reasons: [...new Set(reasons)] };
  });
}

export class StepBudgetError extends Error {
  constructor(max: number) {
    super(`run would exceed MAX_STEPS=${max}; raise SCAN_PAGE_SIZE/SCAN_CANDIDATES/PROCESS_BATCH (Workers Paid) or lower discovery caps`);
    this.name = 'StepBudgetError';
  }
}

// No step that makes subrequests is retried: a retry re-spends the instance's subrequest budget in the
// same invocation. Discovery errors are recorded as data; a failed import fails the run WITHOUT advancing
// any cursor, and the next run (cron or manual) repeats the work idempotently.
const DISCOVER: StepConfig = { retries: { limit: 0, delay: '10 seconds' }, timeout: '5 minutes' };
const INTERNAL: StepConfig = { retries: { limit: 0, delay: '10 seconds' }, timeout: '2 minutes' };
const PROCESS: StepConfig = { retries: { limit: 0, delay: '10 seconds' }, timeout: '10 minutes' };
const IMPORT: StepConfig = { retries: { limit: 0, delay: '10 seconds' }, timeout: '2 minutes' };
/** Steps without I/O may retry (pure CPU). */
const LOCAL: StepConfig = { retries: { limit: 2, delay: '5 seconds', backoff: 'constant' }, timeout: '2 minutes' };

const KINDS = ['FLORIDA_NEWS', 'GTA_CANON'] as const;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 280);
/** Incidents per title-index page fetched in ONE call (API max); scanned in slices of SCAN_PAGE_SIZE. */
export const TITLE_PAGE = 500;
const LEASE_KEY = 'backfillLease';

export async function runIngestion(input: { runId: string; startedAt: string; params: IngestParams }, step: StepLike, deps: IngestDeps): Promise<IngestSummary> {
  const { limits, cfg } = deps;
  const { runId, params } = input;
  const dryRun = params.dryRun === true;
  const mode = params.mode === 'backfill' ? 'backfill' : 'run';
  const sources = mode === 'backfill' ? 'florida' : (params.sources ?? 'all');
  const want = (s: 'florida' | 'gta') => sources === 'all' || sources === s;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = new Date(input.startedAt);
  const log: Log = {
    info: (m) => deps.event('ingest.info', { runId, message: m }),
    warn: (m) => deps.event('ingest.warn', { runId, message: m }),
    error: (m) => deps.event('ingest.error', { runId, message: m }),
  };

  // ---- subrequest accounting (deterministic plan + runtime meter) --------------------------------
  const plan = new SubrequestPlan(limits.subrequestBudget);
  const meter = deps.meter ?? new SubrequestMeter(limits.subrequestBudget);
  const client = deps.client;
  const discoveryFetch = meteredFetch(deps.fetchImpl, meter, 'discovery');
  const linkFetch = meteredFetch(deps.fetchImpl, meter, 'link_check');
  const fetchImpl = (u: URL | string, init?: RequestInit) => discoveryFetch(u.toString(), init);
  const ai: AiProvider | null = deps.ai ? { name: deps.ai.name, run: (model, messages, max) => (meter.take('ai'), deps.ai!.run(model, messages, max)) } : null;
  const deferred: string[] = [];
  const kindsWanted = (want('florida') ? 1 : 0) + (want('gta') ? 1 : 0);
  const chainPossible = mode === 'backfill' && !dryRun && limits.dojBackfillChain && !!deps.spawn;
  const tail = (items: number) =>
    tailCost({ items, kinds: kindsWanted, titlePagesPerKind: limits.titlePagesPerKind, dryRun }) + (chainPossible ? COST.workflowCreate : 0);

  let steps = 0;
  const run = async <T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T> => {
    if (++steps > limits.maxSteps) throw new StepBudgetError(limits.maxSteps);
    try {
      return await step.do(name.slice(0, 256), config, fn);
    } catch (e) {
      // Resource-limit failures are deterministic: never retry them.
      if (isSubrequestLimitError(e) && deps.nonRetryable) throw deps.nonRetryable(e as Error);
      throw e;
    }
  };

  // The historical dataset is development material: never in production, whatever the vars say.
  const datasetOn = mode === 'run' && limits.datasetEnabled && deps.appEnv !== 'production';
  const errors: string[] = [];
  const checkpoints: { provider: string; key: string; value: string }[] = [];
  /** Rate-limit cooldowns: persisted even for failed and dry runs. */
  const guards: { provider: string; key: string; value: string }[] = [];
  const discovered: Discovered[] = [];
  let fetched = 0;
  const absorb = (r: DiscoveryResult) => {
    // Adapters record fetch errors as data; a subrequest-limit error must instead stop the run (non-retryable).
    const limitError = r.errors.find((e) => isSubrequestLimitError(e));
    if (limitError) {
      const e = new Error(`subrequest limit reached during discovery: ${limitError}`);
      throw deps.nonRetryable ? deps.nonRetryable(e) : e;
    }
    discovered.push(...r.items);
    errors.push(...r.errors);
    checkpoints.push(...r.checkpoints);
    guards.push(...(r.guards ?? []));
    fetched += r.fetched;
  };
  /**
   * Worst-case Workflow steps still needed after discovery for `n` items (full title pages assumed):
   * known + titles/scan slices + plan + process + imports + inventory + chain + summary.
   */
  const slicesPerTitlePage = Math.ceil((TITLE_PAGE * 2) / (limits.scanPageSize * 2));
  const tailSteps = (n: number) =>
    1 +
    kindsWanted * limits.titlePagesPerKind * (1 + slicesPerTitlePage * Math.max(1, Math.ceil(n / limits.scanCandidates))) +
    1 +
    Math.ceil(n / limits.processBatch) +
    (dryRun ? 1 : Math.max(1, Math.ceil(n / MAX_IMPORT_ITEMS))) +
    3;
  /** Reserve a discovery step's worst case if the tail (subrequests AND steps) for (items so far + its worst-case items) still fits. */
  const admit = (name: string, external: number, worstItems: number, api = 0, category: SubrequestCategory = 'discovery'): boolean => {
    const keep = tail(discovered.length + worstItems);
    if (plan.remaining() - external - api < keep || steps + 1 + tailSteps(discovered.length + worstItems) > limits.maxSteps) {
      deferred.push(name);
      return false;
    }
    plan.reserve(category, external);
    if (api) plan.reserve('api', api);
    return true;
  };

  // 1. checkpoints (cursors advance only with the final import chunk)
  const providers = [
    ...(mode === 'backfill' ? ['doj'] : []),
    ...(mode === 'run' && want('florida') ? ['gdelt', 'rss', ...(datasetOn ? ['floridaman_dataset'] : [])] : []),
    ...(mode === 'run' && want('gta') ? ['grandtheftwiki'] : []),
  ];
  plan.reserve('api', providers.length * COST.apiCall);
  const cpRaw = await run('checkpoints', INTERNAL, async () => {
    const out: Record<string, Record<string, string>> = {};
    for (const p of providers) out[p] = Object.fromEntries(await client.checkpoints(p));
    return out;
  });
  const cp = { gdelt: cpRaw.gdelt ?? {}, rss: cpRaw.rss ?? {}, dataset: cpRaw.floridaman_dataset ?? {}, doj: cpRaw.doj ?? {}, wiki: cpRaw.grandtheftwiki ?? {} };

  let gdelt: IngestSummary['gdelt'] = 'not_needed';
  let backfill: IngestSummary['backfill'];

  // 2-backfill. Historical DOJ pages, one per step, from the persisted cursor.
  if (mode === 'backfill') {
    const from = cp.doj.backfillPage ?? '0';
    let cursor = from;
    let pages = 0;
    let skipped: string | undefined;
    const [holder, until] = (cp.doj[LEASE_KEY] ?? '').split('|');
    if (from === 'done') skipped = 'backfill already complete';
    else if (holder && holder !== runId && Date.parse(until ?? '') > startedAt.getTime()) skipped = `another backfill instance holds the lease (${holder}) until ${until}`;
    if (!skipped && !dryRun) {
      // Lease: one backfill instance at a time. Expires on its own if this instance dies.
      plan.reserve('api', COST.apiCall);
      const lease = `${runId}|${new Date(startedAt.getTime() + limits.dojBackfillLeaseMinutes * 60_000).toISOString()}`;
      await run('backfill:lease', INTERNAL, async () => {
        await client.importChunk(`${runId}-lease`, 0, [], undefined, [{ provider: 'doj', key: LEASE_KEY, value: lease }]);
        return true;
      });
    }
    while (!skipped && cursor !== 'done' && pages < limits.dojBackfillPagesPerRun) {
      if (!admit(`doj:backfill:p${cursor}`, COST.dojPage, MAX_ITEMS.dojPage)) break;
      const at = cursor;
      const r = await run(`doj:backfill:p${at}`, DISCOVER, () =>
        discoverDojBackfill(cfg, { userAgent: deps.userAgent, fetchImpl: fetchImpl as never, now: startedAt, checkpoint: new Map([['backfillPage', at]]), days: limits.dojBackfillDays, pages: 1, includeAllegations: limits.dojIncludeAllegations, minUnusual: limits.dojMinUnusual, sleep, log }),
      );
      absorb({ ...r, checkpoints: [] }); // only the final cursor is saved (below)
      if (r.errors.length || (!r.done && r.nextPage === null)) break; // retry this page next instance
      pages++;
      cursor = r.done ? 'done' : String(r.nextPage);
    }
    if (!skipped && cursor !== from) checkpoints.push({ provider: 'doj', key: 'backfillPage', value: cursor });
    if (!skipped && !dryRun) checkpoints.push({ provider: 'doj', key: LEASE_KEY, value: '' }); // release
    backfill = { from, to: cursor, pages, done: cursor === 'done', next: cursor !== 'done' ? cursor : null, ...(skipped ? { skipped } : {}) };
  }

  // 2a. Florida (regular runs), most trustworthy first: DOJ → allowed RSS → dataset (staging) → GDELT fallback.
  if (mode === 'run' && want('florida')) {
    const lookup = deps.lookup ?? ((id: string) => sourceById(id));
    const { allowed, refused } = allowedFeeds(cfg.rss ?? [], lookup);
    const rssCache = new Map(Object.entries(cp.rss));
    let rssItems = 0;
    if (limits.dojEnabled) {
      // Recent releases, one page per step, newest first until the lookback window is covered.
      let page = '0';
      for (let n = 0; n < limits.dojMaxPages && page !== 'done'; n++) {
        if (!admit(`doj:p${page}`, COST.dojPage, MAX_ITEMS.dojPage)) break;
        const at = page;
        const r = await run(`doj:p${at}`, DISCOVER, () =>
          discoverDojBackfill(cfg, { userAgent: deps.userAgent, fetchImpl: fetchImpl as never, now: startedAt, checkpoint: new Map([['backfillPage', at]]), days: limits.dojLookbackDays, pages: 1, includeAllegations: limits.dojIncludeAllegations, minUnusual: limits.dojMinUnusual, sleep, log }),
        );
        absorb({ ...r, checkpoints: [] }); // the daily window needs no cursor
        rssItems += r.items.filter((i) => i.prefilter.decision === 'candidate').length;
        if (r.errors.length || r.done || r.nextPage === null) break;
        page = String(r.nextPage);
      }
    }
    for (const feed of allowed.slice(0, limits.maxFeeds)) {
      if (!admit(`rss:${feed.id}`, COST.rssFeed, MAX_ITEMS.rssFeed)) break;
      const r = await run(`rss:${feed.id}`, DISCOVER, () => discoverRss(cfg, { userAgent: deps.userAgent, fetchImpl: fetchImpl as never, checkpoint: rssCache, feeds: [feed], lookup, log }));
      absorb(r);
      rssItems += r.items.length;
    }
    if (datasetOn) {
      let day = cp.dataset.nextDay ?? '0';
      for (let n = 0; n < limits.datasetDaysPerRun; n++) {
        if (!admit(`floridaman_dataset:${day}`, COST.datasetDay, MAX_ITEMS.datasetDay)) break;
        const at = day;
        const r = await run(`floridaman_dataset:${at}`, DISCOVER, () =>
          discoverFloridaManDataset(cfg, { userAgent: deps.userAgent, fetchImpl: fetchImpl as never, checkpoint: new Map([['nextDay', at]]), daysPerRun: 1, log }),
        );
        absorb({ ...r, checkpoints: [] });
        rssItems += r.items.filter((i) => i.prefilter.decision === 'candidate').length;
        const next = r.checkpoints.find((c) => c.key === 'nextDay')?.value;
        if (r.errors.length || next === undefined) break;
        day = next;
      }
      if (day !== (cp.dataset.nextDay ?? '0')) checkpoints.push({ provider: 'floridaman_dataset', key: 'nextDay', value: day });
    }
    const cooldownUntil = Date.parse(cp.gdelt.cooldownUntil ?? '');
    if (rssItems >= limits.gdeltMinRssItems) gdelt = 'not_needed';
    else if (!limits.gdeltEnabled || limits.gdeltQueries === 0) gdelt = 'disabled';
    else if (!Number.isNaN(cooldownUntil) && startedAt.getTime() < cooldownUntil) gdelt = 'cooldown';
    else if (admit('gdelt', COST.gdeltQuery * limits.gdeltQueries, MAX_ITEMS.gdeltQuery * limits.gdeltQueries)) {
      gdelt = 'ran';
      const r = await run('gdelt', DISCOVER, async () => {
        deps.event('ingest.gdelt', { runId, reason: `florida items ${rssItems} < ${limits.gdeltMinRssItems}`, allowedFeeds: allowed.length, refusedFeeds: refused.length });
        return discoverGdelt(cfg, { checkpoint: new Map(Object.entries(cp.gdelt)), queries: limits.gdeltQueries, userAgent: deps.userAgent, fetchImpl: fetchImpl as never, sleep, log, now: startedAt });
      });
      absorb(r);
    }
  }

  // 2b. GTA: Grand Theft Wiki, round-robin over categories, bounded pages per run.
  if (mode === 'run' && want('gta')) {
    const wiki = createWikiClient({ apiUrl: deps.wikiApi, userAgent: deps.userAgent, minIntervalMs: 0, maxRetries: 1, fetchImpl: fetchImpl as never, sleep });
    const cats = cfg.grandTheftWiki?.categories ?? [];
    const start = cats.length ? (Number(cp.wiki.nextCategory ?? 0) || 0) % cats.length : 0;
    let pageBudget = limits.maxWikiPages;
    let nextCategory: number | null = null;
    let visited = 0;
    for (; visited < cats.length && pageBudget > 0; visited++) {
      const ci = (start + visited) % cats.length;
      const cat = cats[ci]!;
      const contKey = `cmcontinue:${cat.name}`;
      const offKey = `offset:${cat.name}`;
      const cont = cp.wiki[contKey] || undefined;
      const offset = Number(cp.wiki[offKey] ?? 0) || 0;
      if (!admit(`wiki:${ci}:members`, COST.wikiMembersExternal, 0, COST.wikiMembersApi)) {
        nextCategory ??= ci;
        break;
      }
      let members: { total: number; next: string | null; rest: { pageId: number; aliases: string[] }[]; knownPages: string[] };
      try {
        members = await run(`wiki:${ci}:members:${offset}`, DISCOVER, async () => {
          const t = await wikiTargets(wiki, cat.name, cont);
          const rest = t.targets.slice(offset);
          // Whole-page items are keyed by page id, so pages already in D1 are skipped before fetching.
          const knownPages = cat.mode === 'pages' && rest.length ? (await client.known([], rest.slice(0, 90).map((x) => String(x.pageId)))).providerKeys : [];
          return { total: t.targets.length, next: t.next, rest, knownPages };
        });
      } catch (e) {
        if (isSubrequestLimitError(e)) throw e;
        errors.push(`wiki:${cat.name}: ${msg(e)}`);
        nextCategory ??= ci;
        break; // a failing wiki (429, outage) fails every category the same way
      }
      const known = new Set(members.knownPages);
      let consumed = 0;
      let outOfBudget = false;
      for (const t of members.rest) {
        if (pageBudget <= 0) break;
        if (!known.has(String(t.pageId)) && !admit(`wiki:${ci}:page:${t.pageId}`, COST.wikiPage, MAX_ITEMS.wikiPage)) {
          outOfBudget = true;
          break; // this page is consumed next run (offset not advanced past it)
        }
        consumed++;
        if (known.has(String(t.pageId))) continue;
        pageBudget--;
        try {
          const recs = await run(`wiki:${ci}:page:${t.pageId}`, DISCOVER, async () => {
            await sleep(deps.wikiPaceMs ?? 1500);
            return (await wikiPageRecords(wiki, cat, t.pageId, t.aliases)).slice(0, MAX_ITEMS.wikiPage);
          });
          fetched += recs.length;
          discovered.push(...recs);
        } catch (e) {
          if (isSubrequestLimitError(e)) throw e;
          errors.push(`wiki:page:${t.pageId}: ${msg(e)}`);
        }
      }
      const pageDone = offset + consumed >= members.total;
      checkpoints.push({ provider: 'grandtheftwiki', key: contKey, value: pageDone ? (members.next ?? '') : (cont ?? '') });
      checkpoints.push({ provider: 'grandtheftwiki', key: offKey, value: pageDone ? '0' : String(offset + consumed) });
      // Stay on a category until it is fully walked; then rotate so no category starves.
      if (!(pageDone && members.next === null)) nextCategory ??= ci;
      if (outOfBudget) break;
    }
    if (cats.length) checkpoints.push({ provider: 'grandtheftwiki', key: 'nextCategory', value: String(nextCategory ?? (start + visited) % cats.length) });
  }

  // From here on, the tail for the ACTUAL item count is reserved (it always fits: every discovery step
  // above was admitted only if the tail for its worst case still fitted).
  plan.reserve('api', tailCost({ items: discovered.length, kinds: kindsWanted, titlePagesPerKind: limits.titlePagesPerKind, dryRun }));
  if (chainPossible) plan.reserve('workflow', COST.workflowCreate);

  // 3. exact identity: within the run, then against D1 (any state, incl. rejected)
  const pre = await run('dedupe:known', INTERNAL, async () => {
    const stats = emptyStats(discovered.length);
    const unique = uniqueWithinRun(discovered, stats);
    const canonicalUrls: string[] = [];
    const providerKeys: string[] = [];
    for (let i = 0; i < unique.length; i += 90) {
      const chunk = unique.slice(i, i + 90);
      const r = await client.known(chunk.map((d) => d.canonicalUrl), chunk.map((d) => d.providerKey).filter((k): k is string => !!k));
      canonicalUrls.push(...r.canonicalUrls);
      providerKeys.push(...r.providerKeys);
    }
    deps.event('ingest.discovered', { runId, discovered: discovered.length, unique: unique.length, known: canonicalUrls.length + providerKeys.length });
    return { unique, known: { canonicalUrls, providerKeys }, stats };
  });

  // 4. paged fuzzy dedupe: each title page (≤ 500 incidents) is read ONCE, then scanned in CPU-bounded slices.
  const knownUrls = new Set(pre.known.canonicalUrls);
  const knownKeys = new Set(pre.known.providerKeys);
  const fresh = pre.unique.filter((d) => !knownUrls.has(d.canonicalUrl) && !(d.providerKey && knownKeys.has(d.providerKey)));
  const reduced: ExistingTitle[] = [];
  let dedupeIncomplete = false;
  for (const kind of KINDS) {
    const cands = fresh.filter((d) => d.kind === kind).map((d) => ({ kind, title: d.title }));
    if (cands.length === 0) continue;
    const hitsByChunk: (ScanHit[] | undefined)[] = [];
    let cursor: string | null = null;
    let pageNo = 0;
    do {
      if (pageNo >= limits.titlePagesPerKind) {
        // More history than this run reserved calls for: do not import possibly-duplicate items.
        dedupeIncomplete = true;
        errors.push(`dedupe: ${kind} title index needs more than ${limits.titlePagesPerKind} page(s) of ${TITLE_PAGE}; raise TITLE_PAGES_PER_KIND/SUBREQUEST_BUDGET (Workers Paid)`);
        break;
      }
      const at: string | null = cursor;
      const pn = pageNo;
      const page: { items: ExistingTitle[]; next: string | null } = await run(`dedupe:titles:${kind}:p${pn}`, INTERNAL, async () => {
        const res = await client.titlesPage(kind, at, TITLE_PAGE);
        return { items: res.items.map((e) => ({ incidentKey: e.incidentKey, title: e.title, seenAt: e.seenAt })), next: res.nextCursor };
      });
      for (let c = 0; c < cands.length; c += limits.scanCandidates) {
        const chunk = cands.slice(c, c + limits.scanCandidates);
        const ci = c / limits.scanCandidates;
        // Slices of SCAN_PAGE_SIZE incidents keep each step's CPU bounded (Free: 10 ms).
        for (let off = 0; off < page.items.length; off += limits.scanPageSize * 2) {
          const prior = hitsByChunk[ci];
          const slice = page.items.slice(off, off + limits.scanPageSize * 2);
          const order = pn * TITLE_PAGE * 2 + off;
          hitsByChunk[ci] = await run(`dedupe:scan:${kind}:p${pn}:o${off}:c${ci}`, LOCAL, async () =>
            scanExisting(chunk, indexPage(slice, 0, 1).map((e, i) => ({ ...e, order: order + i })), prior),
          );
        }
      }
      cursor = page.next;
      pageNo++;
    } while (cursor);
    reduced.push(...reducedExisting(hitsByChunk.flatMap((h) => h ?? [])));
  }

  // 5. plan: the shared run deduper, seeded with the reduced (order-preserving) set
  const planned0 = await run('plan', LOCAL, async () => {
    const stats: PipelineStats = { ...pre.stats, rejectReasons: { ...pre.stats.rejectReasons } };
    const planned = planCandidates(pre.unique, pre.known, reduced, stats);
    deps.event('ingest.planned', { runId, planned: planned.length, duplicates: stats.duplicates, attached: stats.attached, flagged: stats.flaggedForReview, prefilterRejected: stats.prefilterRejected });
    return { planned, stats };
  });

  // 6. link checks + AI in small batches, only within what is left of the subrequest plan
  let stats = planned0.stats;
  let budget: BudgetSnapshot = snapshotBudget(createBudget(limits.maxAiRequests, limits.maxNeurons));
  let linkQuota = limits.maxLinkChecks;
  let aiQuota = Math.floor(limits.maxAiRequests / COST.aiItem);
  const processed: Planned[] = [];
  const checkLink = async (url: string) => toLinkCheck(await checkLinkWith(url, fetchLinkRequest({ userAgent: deps.userAgent, fetchImpl: linkFetch }), { maxRedirects: LINK_MAX_REDIRECTS }));
  for (let i = 0; i < planned0.planned.length; i += limits.processBatch) {
    const batch = planned0.planned.slice(i, i + limits.processBatch);
    const linkFor = new Set<number>();
    const aiFor = new Set<number>();
    batch.forEach((p, j) => {
      if (needsLinkCheck(p) && linkQuota > 0 && plan.tryReserve('link_check', COST.linkCheck)) {
        linkFor.add(j);
        linkQuota--;
      }
      // Reserved even if the link check later marks the item broken (then simply unused).
      if (ai && needsAi(p) && aiQuota > 0 && plan.tryReserve('ai', COST.aiItem)) {
        aiFor.add(j);
        aiQuota--;
      }
    });
    if (linkFor.size === 0 && aiFor.size === 0) {
      // Nothing to do (or no budget left): these items import unchecked / without AI → human review.
      const skipped = batch.filter((p) => needsAi(p)).length;
      stats = { ...stats, aiSkipped: stats.aiSkipped + skipped };
      processed.push(...batch);
      continue;
    }
    const before = budget;
    const prevStats = stats;
    const r = await run(`process:${i / limits.processBatch}`, PROCESS, async () => {
      const items: Planned[] = structuredClone(batch);
      const st: PipelineStats = { ...prevStats, rejectReasons: { ...prevStats.rejectReasons } };
      const b = restoreBudget(before);
      for (const [j, p] of items.entries()) {
        if (linkFor.has(j)) await linkCheckOne(p, checkLink, st);
        if (needsAi(p)) {
          if (aiFor.has(j)) await classifyOne(p, ai!, b, st);
          else st.aiSkipped++;
        }
      }
      deps.event('ingest.processed', { runId, batch: i / limits.processBatch, items: items.length, aiRequests: b.requests, neurons: Math.round(b.neurons * 100) / 100, aiStopped: b.stopped });
      return { items, stats: st, budget: snapshotBudget(b) };
    });
    processed.push(...r.items);
    stats = r.stats;
    budget = r.budget;
  }
  if (budget.stopped) errors.push(`ai: ${budget.stopped}`);

  // 7. build + contract self-check (cheap, deterministic)
  const valid: ImportItem[] = [];
  for (const p of processed) {
    const item = buildImportItem(p);
    const r = parse(importItemSchema, item);
    if (r.ok) valid.push(item);
    else errors.push(`invalid item ${item.incidentKey}: ${formatIssues(r.issues, 3)}`.slice(0, 300));
  }
  stats = { ...stats, toImport: valid.length };
  // Incomplete dedupe → nothing is imported and no cursor moves (the next run, with more budget, redoes it).
  const status: RunReport['status'] = dedupeIncomplete ? 'failed' : errors.length === 0 ? 'ok' : discovered.length > 0 ? 'partial' : 'failed';
  const toImport = dedupeIncomplete ? [] : valid;

  // 8. import in chunks; the run report and checkpoints ride on the last chunk only
  const outcomes: Record<string, number> = {};
  if (dryRun && guards.length) {
    // A dry run imports nothing, but a GDELT cooldown must still stick (no candidates, no run report).
    await run('guards', IMPORT, async () => {
      await client.importChunk(runId, 0, [], undefined, guards);
      return true;
    });
  }
  if (!dryRun) {
    const chunks: ImportItem[][] = [];
    for (let i = 0; i < toImport.length; i += MAX_IMPORT_ITEMS) chunks.push(toImport.slice(i, i + MAX_IMPORT_ITEMS));
    if (chunks.length === 0) chunks.push([]);
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1;
      const results = await run(`import:${i}`, IMPORT, async () => {
        const report: RunReport | undefined = last
          ? {
              id: runId,
              provider: mode === 'backfill' ? 'doj_backfill' : sources === 'all' ? 'all' : sources,
              startedAt: input.startedAt,
              finishedAt: new Date().toISOString(),
              status,
              fetched,
              newCount: toImport.filter((v) => !v.attachToIncidentKey).length,
              duplicates: stats.duplicates,
              rejected: stats.prefilterRejected,
              errors: errors.slice(0, 50).map((e) => e.slice(0, 300)),
              aiRequests: budget.requests,
              tokensIn: budget.tokensIn,
              tokensOut: budget.tokensOut,
              neuronsEstimate: Math.round(budget.neurons * 100) / 100,
              models: budget.models.slice(0, 4),
            }
          : undefined;
        // Cursors advance only when the run did not fail; cooldown guards are always saved.
        const cps = last ? [...(status !== 'failed' ? checkpoints : []), ...guards] : undefined;
        const res = await client.importChunk(runId, i, chunk, report, cps);
        const tally: Record<string, number> = {};
        for (const x of res) {
          const k = x.questionState ? `${x.outcome}:${x.questionState}` : x.outcome;
          tally[k] = (tally[k] ?? 0) + 1;
          // Manual review gate: an import must never come back approved while auto-approval is unvalidated.
          if (x.questionState === 'approved') deps.event('ingest.unexpected_approval', { runId, incidentKey: x.incidentKey, gate: x.gate });
        }
        deps.event('ingest.imported', { runId, chunk: i, items: chunk.length, outcomes: tally });
        return tally;
      });
      for (const [k, n] of Object.entries(results)) outcomes[k] = (outcomes[k] ?? 0) + n;
    }
  }

  // 9. inventory (read-only dry-run schedule): the low-content alarm
  let inventory: ScheduleResponse['inventory'] | null = null;
  try {
    inventory = await run('inventory', INTERNAL, async () => {
      const s = await client.schedule(30, { dryRun: true });
      const low = s.inventory.runwayDays < limits.lowInventoryDays;
      deps.event(low ? 'ingest.inventory_low' : 'ingest.inventory', { runId, ...s.inventory, shortageDate: s.shortageDate, thresholdDays: limits.lowInventoryDays });
      return s.inventory;
    });
  } catch (e) {
    if (isSubrequestLimitError(e)) throw e;
    errors.push(`inventory: ${msg(e)}`);
  }

  // 10. backfill chaining: one successor at a time, only after this instance's cursor was saved.
  if (chainPossible && backfill && !backfill.skipped && !backfill.done && status !== 'failed' && backfill.pages > 0) {
    const nextId = `backfill-${deps.appEnv ?? 'env'}-p${backfill.to}`.slice(0, 100);
    await run('backfill:next', INTERNAL, async () => {
      meter.take('workflow');
      await deps.spawn!(nextId, { mode: 'backfill' });
      deps.event('ingest.backfill_next', { runId, nextId, cursor: backfill!.to });
      return true;
    });
  }

  const summary: IngestSummary = {
    runId,
    dryRun,
    status,
    steps: steps + 1, // includes the final summary step below
    discovered: discovered.length,
    toImport: toImport.length,
    outcomes,
    stats,
    ai: { requests: budget.requests, neurons: Math.round(budget.neurons * 100) / 100, stopped: budget.stopped },
    errors: errors.slice(0, 20),
    inventory,
    lowInventory: inventory ? inventory.runwayDays < limits.lowInventoryDays : false,
    gdelt,
    mode,
    subrequests: { limit: plan.limit, reserved: { ...plan.reserved }, actual: { ...meter.used }, deferred },
    ...(backfill ? { backfill } : {}),
    official: mode === 'run' && want('florida') ? officialSkips(deps.lookup ?? ((id: string) => sourceById(id))) : [],
  };
  await run('summary', LOCAL, async () => {
    for (const o of summary.official) deps.event('ingest.official_skipped', { runId, ...o });
    deps.event('ingest.run', { ...summary, neuronRates: Object.keys(NEURON_RATES) });
    return true;
  });
  return summary;
}
