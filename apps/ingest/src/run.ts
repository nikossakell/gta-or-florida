/**
 * `npm run ingest:batch` — the scheduled/manual batch job (GitHub Actions).
 *
 *   discover (GDELT, approved RSS, Grand Theft Wiki) → pipeline (dedupe, filters,
 *   link check, Workers AI) → authenticated chunked import → optional scheduling
 *
 * Env (see .env.example): INGESTION_API_URL, INGESTION_IMPORT_TOKEN,
 * CF_AI_ACCOUNT_ID, CF_AI_API_TOKEN, AI_PROVIDER=workers-ai|mock|off.
 * --dry-run: no Worker calls, no writes; prints what would be imported.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatIssues, importItemSchema, parse, type RunReport } from '@gof/core';
import { AI_DEFAULT_BUDGET, NEURON_RATES } from '@gof/config';
import { createWikiClient } from './adapters/grandtheftwiki.ts';
import { createBudget, createMockAiProvider, createWorkersAiProvider, type AiProvider } from './classify.ts';
import { discoverDoj, discoverFloridaManDataset, discoverGdelt, discoverRss, discoverWiki, type DiscoveryResult, type Log } from './discover.ts';
import { createWorkerClient, type WorkerClient } from './import.ts';
import { loadSourcesConfig } from './config-file.ts';
import { processDiscovered } from './pipeline.ts';
import { checkLink, toLinkCheck } from './verify.ts';
import { REPO_ROOT } from './paths.ts';

const log: Log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARN ${m}`),
  error: (m) => console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`),
};

export const USER_AGENT = process.env.HTTP_USER_AGENT || 'gta-or-florida-ingest/0.3 (unofficial fan trivia project; metadata only)';

export function aiProvider(choice: string): AiProvider | null {
  if (choice === 'off') return null;
  if (choice === 'mock') return createMockAiProvider();
  const accountId = process.env.CF_AI_ACCOUNT_ID ?? '';
  const apiToken = process.env.CF_AI_API_TOKEN ?? '';
  if (choice === 'workers-ai' || (choice === 'auto' && accountId && apiToken)) return createWorkersAiProvider({ accountId, apiToken });
  return createMockAiProvider();
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string', default: 'all' },
      'dry-run': { type: 'boolean', default: false },
      queries: { type: 'string', default: '3' },
      'gdelt-min-rss-items': { type: 'string', default: '10' },
      doj: { type: 'string', default: 'true' },
      'doj-include-allegations': { type: 'boolean', default: false },
      dataset: { type: 'boolean', default: false },
      'wiki-pages': { type: 'string', default: '1' },
      'max-link-checks': { type: 'string', default: '40' },
      'max-ai-requests': { type: 'string', default: String(AI_DEFAULT_BUDGET.maxRequestsPerRun) },
      'max-neurons': { type: 'string', default: String(AI_DEFAULT_BUDGET.maxNeuronsPerRun) },
      ai: { type: 'string', default: process.env.AI_PROVIDER ?? 'auto' },
      schedule: { type: 'boolean', default: false },
      report: { type: 'string' },
    },
  });
  const dryRun = values['dry-run']!;
  const runId = `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const cfg = loadSourcesConfig(resolve(REPO_ROOT, 'data'));

  let client: WorkerClient | null = null;
  if (!dryRun) {
    const url = process.env.INGESTION_API_URL;
    const token = process.env.INGESTION_IMPORT_TOKEN;
    if (!url || !token) throw new Error('INGESTION_API_URL and INGESTION_IMPORT_TOKEN are required (or pass --dry-run)');
    client = createWorkerClient({ baseUrl: url, token });
  }
  const ai = aiProvider(values.ai!);
  const budget = createBudget(Number(values['max-ai-requests']), Number(values['max-neurons']));
  log.info(`[run ${runId}] source=${values.source} ai=${ai?.name ?? 'off'} dryRun=${dryRun}`);

  const want = (s: string) => values.source === 'all' || values.source === s;
  const results: DiscoveryResult[] = [];
  if (want('florida')) {
    // DOJ (public domain) → allowed RSS → dataset (dev only) → GDELT only as a fallback (never during its cooldown).
    let florida = 0;
    if (values.doj !== 'false') {
      const doj = await discoverDoj(cfg, { userAgent: USER_AGENT, lookbackDays: 2, maxPages: 6, includeAllegations: values['doj-include-allegations']!, log });
      results.push(doj);
      florida += doj.items.filter((i) => i.prefilter.decision === 'candidate').length;
    }
    const rssCp = client ? await client.checkpoints('rss') : new Map<string, string>();
    const rss = await discoverRss(cfg, { userAgent: USER_AGENT, checkpoint: rssCp, log });
    results.push(rss);
    florida += rss.items.length;
    if (values.dataset) {
      if (/production/i.test(process.env.INGESTION_API_URL ?? '')) throw new Error('--dataset is staging/development only');
      const dcp = client ? await client.checkpoints('floridaman_dataset') : new Map<string, string>();
      const ds = await discoverFloridaManDataset(cfg, { userAgent: USER_AGENT, checkpoint: dcp, daysPerRun: 2, log });
      results.push(ds);
      florida += ds.items.filter((i) => i.prefilter.decision === 'candidate').length;
    }
    if (florida < Number(values['gdelt-min-rss-items'])) {
      const cp = client ? await client.checkpoints('gdelt') : new Map<string, string>();
      results.push(await discoverGdelt(cfg, { checkpoint: cp, queries: Number(values.queries), userAgent: USER_AGENT, log }));
    }
  }
  if (want('gta')) {
    const cp = client ? await client.checkpoints('grandtheftwiki') : new Map<string, string>();
    const wiki = createWikiClient({ apiUrl: process.env.GRAND_THEFT_WIKI_API ?? 'https://www.grandtheftwiki.com/api.php', userAgent: USER_AGENT, minIntervalMs: 1500 });
    results.push(await discoverWiki(cfg, wiki, { checkpoint: cp, maxMemberPages: Number(values['wiki-pages']), log }));
  }
  const discovered = results.flatMap((r) => r.items);
  const errors = results.flatMap((r) => r.errors);

  const existingTitles = client ? [...(await client.titles('FLORIDA_NEWS')), ...(await client.titles('GTA_CANON'))] : [];
  const { items, stats } = await processDiscovered(discovered, {
    client,
    ai,
    budget,
    checkLink: async (u) => toLinkCheck(await checkLink(u, { userAgent: USER_AGENT })),
    maxLinkChecks: Number(values['max-link-checks']),
    aiConcurrency: AI_DEFAULT_BUDGET.concurrency,
    existingTitles,
  });
  if (budget.stopped) errors.push(`ai: ${budget.stopped}`);

  // Self-check against the Worker's contract before sending anything.
  const valid = items.filter((it) => {
    const r = parse(importItemSchema, it);
    if (!r.ok) errors.push(`invalid item ${it.incidentKey}: ${formatIssues(r.issues, 3)}`.slice(0, 300));
    return r.ok;
  });

  const status: RunReport['status'] = errors.length === 0 ? 'ok' : discovered.length > 0 ? 'partial' : 'failed';
  const models = [...budget.models];
  const run: RunReport = {
    id: runId,
    provider: values.source === 'all' ? 'all' : values.source!,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    fetched: results.reduce((n, r) => n + r.fetched, 0),
    newCount: valid.filter((i) => !i.attachToIncidentKey).length,
    duplicates: stats.duplicates,
    rejected: stats.prefilterRejected,
    errors: errors.slice(0, 50),
    aiRequests: budget.requests,
    tokensIn: budget.tokensIn,
    tokensOut: budget.tokensOut,
    neuronsEstimate: Math.round(budget.neurons * 100) / 100,
    models,
  };

  let imported: { outcome: string; questionState?: string }[] = [];
  let schedule: unknown = null;
  if (client) {
    // Cursors advance only with the final chunk; a failed run is retried from the same place.
    // Cooldown guards are saved even for a failed run, so a 429 is never followed by more requests.
    const checkpoints = [...(status === 'failed' ? [] : results.flatMap((r) => r.checkpoints)), ...results.flatMap((r) => r.guards ?? [])];
    imported = await client.importItems(runId, valid, run, checkpoints);
    if (values.schedule) schedule = await client.schedule(30);
  }

  const outcome: Record<string, number> = {};
  for (const r of imported) {
    const k = r.questionState ? `${r.outcome}:${r.questionState}` : r.outcome;
    outcome[k] = (outcome[k] ?? 0) + 1;
  }
  const report = { run, stats, outcome, schedule, neuronRates: NEURON_RATES, dryRun, sample: dryRun ? valid.slice(0, 5).map((i) => ({ kind: i.kind, title: i.reference.originalTitle, url: i.reference.canonicalUrl, prefilter: i.prefilter, ai: i.ai })) : undefined };
  const reportPath = values.report ?? resolve(REPO_ROOT, 'reports', `${runId}.json`);
  mkdirSync(resolve(reportPath, '..'), { recursive: true });
  // Sanitized: no tokens, no article bodies — titles/URLs are public metadata.
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log.info(`[run ${runId}] ${status}: discovered ${stats.discovered}, to import ${valid.length}, duplicates ${stats.duplicates}, prefilter-rejected ${stats.prefilterRejected}, AI ${budget.requests} req (~${run.neuronsEstimate} neurons) → ${reportPath}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `## Ingestion ${runId} — ${status}`,
        `| discovered | new | attached | duplicates | prefilter rejected | link broken | AI requests | est. neurons |`,
        `|---|---|---|---|---|---|---|---|`,
        `| ${stats.discovered} | ${run.newCount} | ${stats.attached} | ${stats.duplicates} | ${stats.prefilterRejected} | ${stats.linkBroken} | ${budget.requests} | ${run.neuronsEstimate} |`,
        '',
        `Outcomes: ${JSON.stringify(outcome)}`,
        errors.length ? `\nErrors:\n${errors.slice(0, 10).map((e) => `- ${e}`).join('\n')}` : '',
        '',
      ].join('\n'),
    );
  }
  // Upstream rate limits are expected and handled; only a run that produced nothing at all fails the job.
  return status === 'failed' ? 1 : 0;
}

// pathToFileURL: a plain `file://${argv[1]}` never matches on Windows (backslashes, drive letter).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      log.error((error as Error).message);
      process.exit(1);
    },
  );
}
