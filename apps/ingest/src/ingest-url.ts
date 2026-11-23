/**
 * `npm run ingest:url -- <article-url> [options]` — manually ingest ONE Florida
 * news article when discovery (GDELT/RSS) is unavailable.
 *
 *   validate URL + source policy → SSRF-safe fetch (per-hop checks) → metadata
 *   extraction → floridaRecord (same as GDELT/RSS) → processDiscovered (dedupe,
 *   prefilter, AI) → authenticated Worker import → candidate for human review
 *
 * It never approves or publishes: the item is imported with provider "manual",
 * which the Worker's gate always routes to a human (MANUAL_SUBMISSION).
 * Unknown publishers are registered by the Worker as `unreviewed`.
 *
 * Env: INGESTION_API_URL (or --to), INGESTION_IMPORT_TOKEN, AI_PROVIDER,
 * CF_AI_ACCOUNT_ID / CF_AI_API_TOKEN, REVIEWER (audit name).
 */
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatIssues, importItemSchema, MANUAL_PROVIDER, parse, type LinkCheck, type RunReport } from '@gof/core';
import { AI_DEFAULT_BUDGET, REGISTRY, sourceForHost } from '@gof/config';
import { ArticleRefusedError, articleUrlProblem, chooseCanonical, extractArticleMeta, fetchArticle, type ArticleRequest } from './adapters/article.ts';
import { createBudget, type AiProvider } from './classify.ts';
import { floridaRecord, type Log } from './discover.ts';
import { createWorkerClient, WorkerApiError, type WorkerClient } from './import.ts';
import { loadSourcesConfig } from './config-file.ts';
import type { SourcesConfig } from './normalize.ts';
import { processDiscovered } from './pipeline.ts';
import { REPO_ROOT } from './paths.ts';
import { aiProvider, USER_AGENT } from './run.ts';

export const TARGET_ENVS = ['local', 'staging', 'production'] as const;
export type TargetEnv = (typeof TARGET_ENVS)[number];

const HELP = `Manually ingest one Florida news article URL as a review candidate.

  npm run ingest:url -- <https-article-url> [--env staging] [--dry-run] [--ai auto|workers-ai|mock|off] [--to <worker-url>]

  --env staging|local|production   target Worker (default staging); must match the Worker URL
  --to <url>                       Worker URL (default INGESTION_API_URL)
  --dry-run                        fetch, extract, dedupe and classify; never import (read-only Worker lookups if a token is set)
  --ai <provider>                  default AI_PROVIDER or auto
  --allow-production               required together with --env production
  --json                           print the import item / results as JSON

Exit codes: 0 imported, already known, or dry run OK · 1 error · 2 refused by URL/source policy or filters.`;

/** Refuse to write anywhere but the environment the owner named. */
export function targetProblem(env: TargetEnv, workerUrl: string, allowProduction: boolean): string | null {
  let host: string;
  try {
    host = new URL(workerUrl).hostname.toLowerCase();
  } catch {
    return `invalid Worker URL: ${workerUrl}`;
  }
  const local = host === 'localhost' || host === '127.0.0.1';
  if (env === 'local') return local ? null : `--env local needs a localhost Worker URL, got ${host}`;
  if (env === 'staging') return host.includes('staging') && !host.includes('production') ? null : `--env staging needs a staging Worker URL, got ${host}`;
  if (!allowProduction) return '--env production also requires --allow-production';
  return host.includes('staging') || local ? `--env production must not target ${host}` : null;
}

export type IngestUrlDeps = {
  log?: Log;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  cfg?: SourcesConfig;
  requestImpl?: ArticleRequest;
  createClient?: (opts: { baseUrl: string; token: string; actor: string }) => WorkerClient;
  ai?: AiProvider | null;
};

const defaultLog: Log = { info: (m) => console.log(m), warn: (m) => console.warn(`WARN ${m}`), error: (m) => console.error(`ERROR ${m}`) };

export async function main(argv = process.argv.slice(2), deps: IngestUrlDeps = {}): Promise<number> {
  const log = deps.log ?? defaultLog;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: 'string' },
      env: { type: 'string', default: 'staging' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      ai: { type: 'string' },
      'allow-production': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    log.info(HELP);
    return 0;
  }
  const urls = [...(values.url ? [values.url] : []), ...positionals];
  if (urls.length !== 1) {
    log.error(`exactly one article URL is required (got ${urls.length})\n\n${HELP}`);
    return 2;
  }
  const raw = urls[0]!.trim();
  const target = values.env as TargetEnv;
  if (!TARGET_ENVS.includes(target)) {
    log.error(`--env must be one of ${TARGET_ENVS.join(', ')}`);
    return 2;
  }
  const dryRun = values['dry-run']!;
  const cfg = deps.cfg ?? loadSourcesConfig(resolve(REPO_ROOT, 'data'));

  // 1. URL + source policy (no network yet)
  const problem = articleUrlProblem(raw, cfg);
  if (problem) {
    log.error(`Refused ${raw.slice(0, 200)}: ${problem}`);
    return 2;
  }
  const source = sourceForHost(new URL(raw).hostname);
  const registered = REGISTRY.sources.some((s) => s.id === source.id);
  log.info(`Source: ${source.id} — ${source.licenseStatus}${registered ? '' : ' (not in the registry; the Worker registers it as unreviewed)'}`);
  if (source.autoPublishAllowed) {
    // Defense in depth for Workers that predate the MANUAL_SUBMISSION gate reason.
    log.error(`Refused: ${source.id} allows auto-publish; manual submissions must stay in human review. Use the batch job for this source.`);
    return 2;
  }

  // 2. Worker target (writes only to the named environment)
  const workerUrl = values.to ?? env.INGESTION_API_URL;
  const token = env.INGESTION_IMPORT_TOKEN;
  let client: WorkerClient | null = null;
  if (workerUrl && token) {
    const bad = targetProblem(target, workerUrl, values['allow-production']!);
    if (bad) {
      log.error(`Refused: ${bad}`);
      return 2;
    }
    const actor = (env.REVIEWER || userInfo().username).replace(/[^A-Za-z0-9 ._@-]/g, '').slice(0, 64) || 'admin';
    client = (deps.createClient ?? ((o) => createWorkerClient(o)))({ baseUrl: workerUrl, token, actor });
  } else if (!dryRun) {
    log.error('INGESTION_API_URL (or --to) and INGESTION_IMPORT_TOKEN are required (or pass --dry-run)');
    return 1;
  } else log.info('Dry run without Worker credentials: duplicate check against D1 is skipped.');

  // 3. Fetch + extract metadata
  let fetched;
  try {
    fetched = await fetchArticle(raw, { cfg, userAgent: env.HTTP_USER_AGENT || USER_AGENT, requestImpl: deps.requestImpl });
  } catch (error) {
    log.error(`Fetch ${error instanceof ArticleRefusedError ? 'refused' : 'failed'}: ${(error as Error).message}`);
    return error instanceof ArticleRefusedError ? 2 : 1;
  }
  const checkedAt = now();
  const meta = extractArticleMeta(fetched.html, fetched.finalUrl, checkedAt);
  if (!meta.title) {
    log.error(`No title found on ${fetched.finalUrl}; is this an article page?`);
    return 2;
  }
  const canonicalUrl = chooseCanonical(meta, fetched.finalUrl, cfg);
  const actorNote = env.REVIEWER ? ` by ${env.REVIEWER.replace(/[^A-Za-z0-9 ._@-]/g, '').slice(0, 64)}` : '';
  const record = floridaRecord(cfg, {
    title: meta.title,
    url: fetched.finalUrl,
    canonicalUrl,
    publishedAt: meta.publishedAt,
    seenAt: checkedAt.toISOString(),
    provider: MANUAL_PROVIDER,
    notes: [`Manual submission (ingest:url)${actorNote}. Location, date and source rights still need human review.`, meta.siteName ? `Site name: ${meta.siteName}` : null]
      .filter(Boolean)
      .join('\n'),
  });
  if (!record) {
    log.error(`Could not build a Florida record from ${fetched.finalUrl}`);
    return 2;
  }
  log.info(`Title:     ${record.title}`);
  log.info(`URL:       ${record.canonicalUrl}${fetched.redirects ? ` (after ${fetched.redirects} redirect(s))` : ''}`);
  log.info(`Published: ${record.publishedAt ?? 'unknown'} · Florida signal: ${record.floridaSignal}${record.floridaEvidence ? ` (“${record.floridaEvidence}”)` : ''}`);

  // 4. Deterministic prefilter: a refused item is not sent (sending it would store it as rejected forever).
  if (record.prefilter.decision === 'reject') {
    log.error(`Refused by the deterministic prefilter: ${record.prefilter.reasonCodes.join(', ')}. Nothing was imported.`);
    return 2;
  }

  // 5. Shared pipeline: exact + fuzzy dedupe against D1, AI classification (budgeted)
  const ai = deps.ai !== undefined ? deps.ai : aiProvider(values.ai ?? env.AI_PROVIDER ?? 'auto');
  const budget = createBudget(Math.min(4, AI_DEFAULT_BUDGET.maxRequestsPerRun), AI_DEFAULT_BUDGET.maxNeuronsPerRun);
  const linkCheck: LinkCheck = { status: 'ok', httpStatus: fetched.httpStatus, finalUrl: fetched.finalUrl.slice(0, 2048), checkedAt: checkedAt.toISOString() };
  const existingTitles = client ? await client.titles('FLORIDA_NEWS') : [];
  const { items, stats } = await processDiscovered([record], {
    client,
    ai,
    budget,
    checkLink: async () => linkCheck,
    maxLinkChecks: 1,
    aiConcurrency: 1,
    existingTitles,
  });
  if (items.length === 0) {
    log.info('Already known in D1 (any state, including rejected) or a duplicate incident: nothing to import.');
    return 0;
  }
  const item = items[0]!;
  const checked = parse(importItemSchema, item);
  if (!checked.ok) {
    log.error(`Import item failed the contract check: ${formatIssues(checked.issues, 5)}`);
    return 1;
  }
  if (item.attachToIncidentKey) log.info(`Matches existing incident ${item.attachToIncidentKey}: will attach as an extra source.`);
  if (item.incident.possibleDuplicateOfKey) log.info(`Possible duplicate of ${item.incident.possibleDuplicateOfKey} (similarity ${item.incident.similarity}); flagged for the reviewer.`);
  log.info(`AI: ${item.ai ? `${item.ai.models.join("+")} relevant=${item.ai.relevant} sensitive=${item.ai.sensitive} needsReview=${item.ai.needsReview}` : `not run (${ai?.name ?? 'off'}${budget.stopped ? `; ${budget.stopped}` : ''})`}`);
  log.info(`Draft play title: ${item.question.playTitleDraft}`);
  if (values.json) log.info(JSON.stringify(item, null, 2));

  if (dryRun) {
    log.info(`Dry run: nothing imported (${stats.duplicates} duplicate(s), ${stats.attached} attach).`);
    return 0;
  }

  // 6. Import (the Worker re-validates, resolves source policy itself and runs the gate)
  const runId = `manual_${checkedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;
  const run: RunReport = {
    id: runId,
    provider: MANUAL_PROVIDER,
    startedAt: checkedAt.toISOString(),
    finishedAt: now().toISOString(),
    status: 'ok',
    fetched: 1,
    newCount: item.attachToIncidentKey ? 0 : 1,
    duplicates: 0,
    rejected: 0,
    errors: [],
    aiRequests: budget.requests,
    tokensIn: budget.tokensIn,
    tokensOut: budget.tokensOut,
    neuronsEstimate: Math.round(budget.neurons * 100) / 100,
    models: [...budget.models],
  };
  let results;
  try {
    results = await client!.importItems(runId, [item], run);
  } catch (error) {
    log.error(error instanceof WorkerApiError ? `Import failed: ${error.code} ${error.message}` : `Import failed: ${(error as Error).message}`);
    return 1;
  }
  if (values.json) log.info(JSON.stringify(results, null, 2));
  const r = results[0];
  if (!r) {
    log.error('Worker returned no result for the item.');
    return 1;
  }
  if (r.outcome === 'invalid') {
    log.error(`Worker refused the item: ${(r.errors ?? []).join('; ')}`);
    return 2;
  }
  if (r.questionState === 'approved') log.warn('Worker reports the item as APPROVED — this must not happen for manual submissions; check the Worker version.');
  log.info(`Imported (${runId}): ${r.outcome}${r.questionState ? ` → ${r.questionState}` : ''}${r.gate ? ` · gate ${r.gate.decision}/${r.gate.effective}` : ''}`);
  log.info('Next: npm run admin -- candidates:list --kind FLORIDA_NEWS --state candidate');
  return 0;
}

// pathToFileURL: a plain `file://${argv[1]}` never matches on Windows (backslashes, drive letter).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`ERROR ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
