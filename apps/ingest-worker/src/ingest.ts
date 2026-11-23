/**
 * Durable ingestion run, expressed as bounded Workflow steps.
 *
 *   checkpoints → discovery (one step per RSS feed / GDELT query / wiki member page / wiki page)
 *   → exact dedupe against D1 → paged fuzzy dedupe (page × candidate-chunk steps)
 *   → plan → link check + AI in small batches → import in chunks of ≤ 20 → inventory check
 *
 * Every phase reuses the shared, tested logic in @gof/ingest; the API Worker stays the only
 * writer to D1 and the enforcement point for source policy and the auto-publish gate.
 * Nothing here can approve or publish: imported items are candidates for human review.
 *
 * Determinism: Workflows may replay `run()` and return cached step results, so everything
 * outside a step is pure bookkeeping over earlier step outputs (no clocks, no randomness, no I/O).
 */
import { formatIssues, importItemSchema, MAX_IMPORT_ITEMS, parse, type ImportItem, type RunReport, type ScheduleResponse } from '@gof/core';
import { NEURON_RATES, sourceById } from '@gof/config';
import { createWikiClient } from '@gof/ingest/adapters/grandtheftwiki.ts';
import { allowedFeeds } from '@gof/ingest/adapters/rss.ts';
import { createBudget, restoreBudget, snapshotBudget, type AiProvider, type BudgetSnapshot } from '@gof/ingest/classify.ts';
import { reducedExisting, indexPage, scanExisting, type ScanHit } from '@gof/ingest/dedupe-scan.ts';
import { discoverGdelt, discoverRss, wikiPageRecords, wikiTargets, type DiscoveryResult, type Log } from '@gof/ingest/discover.ts';
import type { ExistingTitle } from '@gof/ingest/deduplicate.ts';
import type { WorkerClient } from '@gof/ingest/import.ts';
import type { SourcesConfig } from '@gof/ingest/normalize.ts';
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

export type StepConfig = { retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: string | number };
/** The subset of WorkflowStep we use (lets tests drive the run without workerd). */
export interface StepLike {
  do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>;
}

export type IngestParams = { dryRun?: boolean; sources?: 'all' | 'florida' | 'gta' };

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
};

export class StepBudgetError extends Error {
  constructor(max: number) {
    super(`run would exceed MAX_STEPS=${max}; raise SCAN_PAGE_SIZE/SCAN_CANDIDATES/PROCESS_BATCH (Workers Paid) or lower discovery caps`);
    this.name = 'StepBudgetError';
  }
}

// Retry policies. Discovery and AI steps barely retry (errors are recorded as data; AI costs neurons).
const DISCOVER: StepConfig = { retries: { limit: 1, delay: '30 seconds', backoff: 'constant' }, timeout: '5 minutes' };
const INTERNAL: StepConfig = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' };
const PROCESS: StepConfig = { retries: { limit: 1, delay: '30 seconds', backoff: 'constant' }, timeout: '10 minutes' };
const IMPORT: StepConfig = { retries: { limit: 4, delay: '15 seconds', backoff: 'exponential' }, timeout: '2 minutes' };

const KINDS = ['FLORIDA_NEWS', 'GTA_CANON'] as const;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 280);

export async function runIngestion(input: { runId: string; startedAt: string; params: IngestParams }, step: StepLike, deps: IngestDeps): Promise<IngestSummary> {
  const { limits, client, cfg } = deps;
  const { runId, params } = input;
  const dryRun = params.dryRun === true;
  const sources = params.sources ?? 'all';
  const want = (s: 'florida' | 'gta') => sources === 'all' || sources === s;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = (u: URL | string, init?: RequestInit) => deps.fetchImpl(u.toString(), init);
  const log: Log = {
    info: (m) => deps.event('ingest.info', { runId, message: m }),
    warn: (m) => deps.event('ingest.warn', { runId, message: m }),
    error: (m) => deps.event('ingest.error', { runId, message: m }),
  };

  let steps = 0;
  const run = <T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T> => {
    if (++steps > limits.maxSteps) throw new StepBudgetError(limits.maxSteps);
    return step.do(name.slice(0, 256), config, fn);
  };

  const errors: string[] = [];
  const checkpoints: { provider: string; key: string; value: string }[] = [];
  const discovered: Discovered[] = [];
  let fetched = 0;
  const absorb = (r: DiscoveryResult) => {
    discovered.push(...r.items);
    errors.push(...r.errors);
    checkpoints.push(...r.checkpoints);
    fetched += r.fetched;
  };

  // 1. checkpoints (cursors advance only with the final import chunk)
  const cp = await run('checkpoints', INTERNAL, async () => ({
    gdelt: want('florida') ? Object.fromEntries(await client.checkpoints('gdelt')) : ({} as Record<string, string>),
    wiki: want('gta') ? Object.fromEntries(await client.checkpoints('grandtheftwiki')) : ({} as Record<string, string>),
  }));

  // 2a. Florida: approved RSS feeds first; GDELT only as a rate-limited fallback.
  if (want('florida')) {
    const { allowed, refused } = allowedFeeds(cfg.rss ?? [], (id) => sourceById(id));
    let rssItems = 0;
    for (const feed of allowed.slice(0, limits.maxFeeds)) {
      const r = await run(`rss:${feed.id}`, DISCOVER, () =>
        discoverRss({ ...cfg, rss: [feed] }, { userAgent: deps.userAgent, minIntervalMs: 0, fetchImpl: fetchImpl as never, log }),
      );
      absorb(r);
      rssItems += r.items.length;
    }
    if (limits.gdeltEnabled && limits.gdeltQueries > 0 && rssItems < limits.gdeltMinRssItems) {
      const r = await run('gdelt', DISCOVER, async () => {
        deps.event('ingest.gdelt', { runId, reason: `rss items ${rssItems} < ${limits.gdeltMinRssItems}`, approvedFeeds: allowed.length, refusedFeeds: refused.length });
        return discoverGdelt(cfg, { checkpoint: new Map(Object.entries(cp.gdelt)), queries: limits.gdeltQueries, userAgent: deps.userAgent, fetchImpl: fetchImpl as never, sleep, log });
      });
      absorb(r);
    }
  }

  // 2b. GTA: Grand Theft Wiki, round-robin over categories, bounded pages per run.
  if (want('gta')) {
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
        errors.push(`wiki:${cat.name}: ${msg(e)}`);
        nextCategory ??= ci;
        break; // a failing wiki (429, outage) fails every category the same way
      }
      const known = new Set(members.knownPages);
      let consumed = 0;
      for (const t of members.rest) {
        if (pageBudget <= 0) break;
        consumed++;
        if (known.has(String(t.pageId))) continue;
        pageBudget--;
        try {
          const recs = await run(`wiki:${ci}:page:${t.pageId}`, DISCOVER, async () => {
            await sleep(deps.wikiPaceMs ?? 1500);
            return wikiPageRecords(wiki, cat, t.pageId, t.aliases);
          });
          fetched += recs.length;
          discovered.push(...recs);
        } catch (e) {
          errors.push(`wiki:page:${t.pageId}: ${msg(e)}`);
        }
      }
      const pageDone = offset + consumed >= members.total;
      checkpoints.push({ provider: 'grandtheftwiki', key: contKey, value: pageDone ? (members.next ?? '') : (cont ?? '') });
      checkpoints.push({ provider: 'grandtheftwiki', key: offKey, value: pageDone ? '0' : String(offset + consumed) });
      // Stay on a category until it is fully walked; then rotate so no category starves.
      if (!(pageDone && members.next === null)) nextCategory ??= ci;
    }
    if (cats.length) checkpoints.push({ provider: 'grandtheftwiki', key: 'nextCategory', value: String(nextCategory ?? (start + visited) % cats.length) });
  }

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

  // 4. paged fuzzy dedupe (only items not already exact duplicates need it)
  const knownUrls = new Set(pre.known.canonicalUrls);
  const knownKeys = new Set(pre.known.providerKeys);
  const fresh = pre.unique.filter((d) => !knownUrls.has(d.canonicalUrl) && !(d.providerKey && knownKeys.has(d.providerKey)));
  const reduced: ExistingTitle[] = [];
  for (const kind of KINDS) {
    const cands = fresh.filter((d) => d.kind === kind).map((d) => ({ kind, title: d.title }));
    const allHits: ScanHit[] = [];
    for (let c = 0; c < cands.length; c += limits.scanCandidates) {
      const chunk = cands.slice(c, c + limits.scanCandidates);
      let hits: ScanHit[] | undefined;
      let cursor: string | null = null;
      let page = 0;
      do {
        const prior: ScanHit[] | undefined = hits;
        const at: string | null = cursor;
        const pageNo = page;
        const r: { hits: ScanHit[]; next: string | null } = await run(`dedupe:scan:${kind}:c${c / limits.scanCandidates}:p${pageNo}`, INTERNAL, async () => {
          const res = await client.titlesPage(kind, at, limits.scanPageSize);
          return { hits: scanExisting(chunk, indexPage(res.items, pageNo, limits.scanPageSize), prior), next: res.nextCursor };
        });
        hits = r.hits;
        cursor = r.next;
        page++;
      } while (cursor);
      allHits.push(...(hits ?? []));
    }
    reduced.push(...reducedExisting(allHits));
  }

  // 5. plan: the shared run deduper, seeded with the reduced (order-preserving) set
  const plan = await run('plan', INTERNAL, async () => {
    const stats: PipelineStats = { ...pre.stats, rejectReasons: { ...pre.stats.rejectReasons } };
    const planned = planCandidates(pre.unique, pre.known, reduced, stats);
    deps.event('ingest.planned', { runId, planned: planned.length, duplicates: stats.duplicates, attached: stats.attached, flagged: stats.flaggedForReview, prefilterRejected: stats.prefilterRejected });
    return { planned, stats };
  });

  // 6. link checks + AI in small batches (budget carried between steps as plain JSON)
  let stats = plan.stats;
  let budget: BudgetSnapshot = snapshotBudget(createBudget(limits.maxAiRequests, limits.maxNeurons));
  let linkQuota = limits.maxLinkChecks;
  const processed: Planned[] = [];
  const checkLink = async (url: string) => toLinkCheck(await checkLinkWith(url, fetchLinkRequest({ userAgent: deps.userAgent, fetchImpl: deps.fetchImpl })));
  for (let i = 0; i < plan.planned.length; i += limits.processBatch) {
    const batch = plan.planned.slice(i, i + limits.processBatch);
    const linkFor = new Set<number>();
    batch.forEach((p, j) => {
      if (needsLinkCheck(p) && linkQuota > 0) {
        linkFor.add(j);
        linkQuota--;
      }
    });
    const work = batch.some((p, j) => linkFor.has(j) || needsAi(p));
    if (!work) {
      // Attached / prefilter-rejected items need neither; count AI skips exactly like processDiscovered.
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
          if (deps.ai) await classifyOne(p, deps.ai, b, st);
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
  const status: RunReport['status'] = errors.length === 0 ? 'ok' : discovered.length > 0 ? 'partial' : 'failed';

  // 8. import in chunks; the run report and checkpoints ride on the last chunk only
  const outcomes: Record<string, number> = {};
  if (!dryRun) {
    const chunks: ImportItem[][] = [];
    for (let i = 0; i < valid.length; i += MAX_IMPORT_ITEMS) chunks.push(valid.slice(i, i + MAX_IMPORT_ITEMS));
    if (chunks.length === 0) chunks.push([]);
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1;
      const results = await run(`import:${i}`, IMPORT, async () => {
        const report: RunReport | undefined = last
          ? {
              id: runId,
              provider: sources === 'all' ? 'all' : sources,
              startedAt: input.startedAt,
              finishedAt: new Date().toISOString(),
              status,
              fetched,
              newCount: valid.filter((v) => !v.attachToIncidentKey).length,
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
        const res = await client.importChunk(runId, i, chunk, report, last && status !== 'failed' ? checkpoints : undefined);
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
    errors.push(`inventory: ${msg(e)}`);
  }

  const summary: IngestSummary = {
    runId,
    dryRun,
    status,
    steps: steps + 1, // includes the final summary step below
    discovered: discovered.length,
    toImport: valid.length,
    outcomes,
    stats,
    ai: { requests: budget.requests, neurons: Math.round(budget.neurons * 100) / 100, stopped: budget.stopped },
    errors: errors.slice(0, 20),
    inventory,
    lowInventory: inventory ? inventory.runwayDays < limits.lowInventoryDays : false,
  };
  await run('summary', INTERNAL, async () => {
    deps.event('ingest.run', { ...summary, neuronRates: Object.keys(NEURON_RATES) });
    return true;
  });
  return summary;
}
