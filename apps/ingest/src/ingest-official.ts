/**
 * `npm run ingest:official -- --url <official-report-url> [--url …] [--urls-file list.txt] [options]`
 *
 * Supervised pilot for official incident publications (FWC weekly reports, Flagler County Sheriff
 * releases). For each OWNER-SUPPLIED URL (no crawling, no discovery):
 *
 *   registry source (path-aware) → adapter → access verdict (blocked / denied fetch refused) →
 *   paced, SSRF-safe fetch with 429/5xx backoff and 401/403 stop → passages (one per incident) →
 *   facts + safety + quality + facts-first draft (validated) → incident dedupe (run + D1) →
 *   import of candidates as `official_report` items (never approved; rejections only counted)
 *
 * Idempotent: provider keys are per passage, D1 refuses known keys/URLs, and imported documents are
 * check-pointed (provider "official_report", key "doc:<id>") so a re-run skips them unless --force.
 * A local --state file makes long URL lists resumable without a Worker.
 *
 * Env: INGESTION_API_URL (or --to), INGESTION_IMPORT_TOKEN (never printed), REVIEWER (audit name).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatIssues, importItemSchema, MAX_IMPORT_ITEMS, OFFICIAL_PROVIDER, OFFICIAL_PUBLISH_OPERATIONS, accessOperationProblems, parse, type ImportItem, type ImportItemResult, type LinkCheck, type RunReport, type SourcePolicy } from '@gof/core';
import { sourceForUrl } from '@gof/config';
import { ArticleHttpError, ArticleRefusedError, articleUrlProblem, fetchArticle, type ArticleRequest } from './adapters/article.ts';
import { OfficialParseError } from './adapters/official-document.ts';
import { loadSourcesConfig } from './config-file.ts';
import type { Log } from './discover.ts';
import { createWorkerClient, WorkerApiError, type WorkerClient } from './import.ts';
import type { SourcesConfig } from './normalize.ts';
import { adapterForUrl, evaluateDocument, fetchVerdict, possibleDuplicate, toDiscovered, type EvaluatedIncident } from './official.ts';
import { buildImportItem, emptyStats, planCandidates, uniqueWithinRun, type ExistingTitle } from './pipeline.ts';
import { REPO_ROOT } from './paths.ts';
import { USER_AGENT } from './run.ts';
import { targetProblem, TARGET_ENVS, type TargetEnv } from './ingest-url.ts';

const HELP = `Evaluate official incident reports (owner-supplied URLs only) and queue candidates for human review.

  npm run ingest:official -- --url <https-url> [--url …] [--urls-file list.txt] [--dry-run] [--env staging]

  --url <url>             an FWC weekly report (content.govdelivery.com/accounts/FLFFWCC/bulletins/…) or a
                          Flagler County Sheriff release (flaglersheriff.com/news/…); repeatable
  --urls-file <path>      one URL per line (# comments); an explicit, owner-approved archive list
  --dry-run               fetch, extract, score and draft; never import (read-only Worker lookups if a token is set)
  --env staging|local|production   target Worker (default staging); must match the Worker URL
  --to <url>              Worker URL (default INGESTION_API_URL)
  --allow-production      required together with --env production
  --state <path>          local progress file: finished URLs are skipped on the next run (resumable lists)
  --force                 re-evaluate documents already check-pointed in D1 / the state file
  --max-docs <n>          stop after n documents (default 20)
  --report <path>         write the full evaluation (no source text) as JSON
  --json                  print the evaluation as JSON

Exit codes: 0 done (or dry run) · 1 errors · 2 every URL refused by policy/access.`;

export type OfficialDeps = {
  log?: Log;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  cfg?: Pick<SourcesConfig, 'domains'>;
  requestImpl?: ArticleRequest;
  createClient?: (opts: { baseUrl: string; token: string; actor: string }) => WorkerClient;
  sleep?: (ms: number) => Promise<void>;
  lookup?: (url: string) => SourcePolicy;
};

type DocOutcome = {
  url: string;
  sourceId: string | null;
  status: 'evaluated' | 'refused' | 'access_denied' | 'failed' | 'skipped_checkpoint';
  documentId?: string;
  title?: string;
  passages?: number;
  problems?: string[];
  warnings?: string[];
  bytes?: number;
  ms?: number;
  incidents?: ReturnType<typeof incidentReport>[];
};

function incidentReport(i: EvaluatedIncident, duplicateOf: string | null) {
  return {
    passage: i.passage.id,
    heading: i.passage.heading,
    providerKey: i.providerKey,
    decision: i.decision,
    reasons: i.reasons,
    score: i.facts.quality.total,
    scores: i.facts.quality.scores,
    incidentType: i.facts.incidentType,
    legalStage: i.facts.legalStage,
    location: i.facts.location,
    eventDate: i.facts.eventDate,
    objects: i.facts.objects,
    claims: i.facts.claims.length,
    safetyFlags: i.facts.safetyFlags,
    redactions: i.facts.redactions,
    draft: i.draft,
    draftProblems: i.facts.draft?.problems ?? [],
    duplicateOf,
    phaseB: i.facts.phaseB,
  };
}

const defaultLog: Log = { info: (m) => console.log(m), warn: (m) => console.warn(`WARN ${m}`), error: (m) => console.error(`ERROR ${m}`) };

/** Fetch with polite retries: 429/5xx back off (honouring Retry-After ≤ 60 s), 401/403 stop at once. */
async function fetchWithBackoff(
  url: string,
  opts: { cfg: Pick<SourcesConfig, 'domains'>; userAgent: string; requestImpl?: ArticleRequest; sleep: (ms: number) => Promise<void>; log: Log },
) {
  const delays = [2_000, 8_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchArticle(url, { cfg: opts.cfg, userAgent: opts.userAgent, requestImpl: opts.requestImpl });
    } catch (error) {
      const retryable = error instanceof ArticleHttpError && (error.status === 429 || error.status >= 500);
      if (!retryable || attempt >= delays.length) throw error;
      const wait = Math.min(60_000, (error as ArticleHttpError).retryAfterSeconds !== null ? (error as ArticleHttpError).retryAfterSeconds! * 1000 : delays[attempt]!);
      opts.log.warn(`${(error as Error).message}; retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 2}/${delays.length + 1})`);
      await opts.sleep(wait);
    }
  }
}

type StateFile = { version: 1; docs: Record<string, { status: string; at: string; candidates: number }> };

function readState(path: string | undefined): StateFile {
  if (!path || !existsSync(path)) return { version: 1, docs: {} };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as StateFile;
  if (raw?.version !== 1 || typeof raw.docs !== 'object') throw new Error(`${path} is not an ingest:official state file`);
  return raw;
}

export async function main(argv = process.argv.slice(2), deps: OfficialDeps = {}): Promise<number> {
  const log = deps.log ?? defaultLog;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lookup = deps.lookup ?? ((u: string) => sourceForUrl(u));
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      url: { type: 'string', multiple: true },
      'urls-file': { type: 'string' },
      env: { type: 'string', default: 'staging' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'allow-production': { type: 'boolean', default: false },
      state: { type: 'string' },
      force: { type: 'boolean', default: false },
      'max-docs': { type: 'string', default: '20' },
      report: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    log.info(HELP);
    return 0;
  }
  const fromFile = values['urls-file']
    ? readFileSync(values['urls-file'], 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean)
    : [];
  const urls = [...new Set([...(values.url ?? []), ...fromFile])];
  if (urls.length === 0) {
    log.error(`at least one --url (or --urls-file) is required\n\n${HELP}`);
    return 2;
  }
  const maxDocs = Number(values['max-docs']);
  if (!Number.isInteger(maxDocs) || maxDocs < 1 || maxDocs > 500) {
    log.error('--max-docs must be an integer 1-500');
    return 2;
  }
  const target = values.env as TargetEnv;
  if (!TARGET_ENVS.includes(target)) {
    log.error(`--env must be one of ${TARGET_ENVS.join(', ')}`);
    return 2;
  }
  const dryRun = values['dry-run']!;
  const cfg = deps.cfg ?? loadSourcesConfig(resolve(REPO_ROOT, 'data'));

  // Worker (optional for dry runs): exact dedupe, title index, checkpoints, import.
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
  } else log.info('Dry run without Worker credentials: duplicate checks against D1 are skipped.');

  const state = readState(values.state);
  const checkpoints = client ? await client.checkpoints(OFFICIAL_PROVIDER) : new Map<string, string>();
  const existingTitles: ExistingTitle[] = client ? await client.titles('FLORIDA_NEWS') : [];
  const startedAt = now();
  const outcomes: DocOutcome[] = [];
  const lastFetch = new Map<string, number>();
  const deniedSources = new Set<string>();
  const evaluated: { doc: DocOutcome; incidents: EvaluatedIncident[]; link: LinkCheck; docMeta: Parameters<typeof toDiscovered>[0] }[] = [];
  let bytes = 0;

  for (const raw of urls.slice(0, maxDocs)) {
    const out: DocOutcome = { url: raw.slice(0, 300), sourceId: null, status: 'refused' };
    outcomes.push(out);
    const shape = articleUrlProblem(raw, cfg);
    if (shape) {
      out.problems = [`URL_REFUSED: ${shape}`];
      continue;
    }
    const url = new URL(raw);
    const source = lookup(url.href);
    out.sourceId = source.id;
    const adapter = adapterForUrl(url);
    if (!adapter || adapter.sourceId !== source.id) {
      out.problems = [`NO_OFFICIAL_ADAPTER: ${source.id} has no official-report adapter for this URL (FWC weekly bulletins and Flagler County Sheriff releases only)`];
      continue;
    }
    if (deniedSources.has(source.id)) {
      out.status = 'access_denied';
      out.problems = [`SOURCE_REFUSED_AUTOMATION: ${source.id} answered 401/403 earlier in this run; not retried`];
      continue;
    }
    const verdict = fetchVerdict(source, 'pilot');
    out.warnings = verdict.warnings;
    if (!verdict.allowed) {
      out.problems = verdict.problems;
      continue;
    }
    const documentId = adapter.documentId(url);
    out.documentId = documentId;
    if (!values.force && (checkpoints.has(`doc:${documentId}`) || state.docs[url.href]?.status === 'imported')) {
      out.status = 'skipped_checkpoint';
      continue;
    }

    // Politeness: one request per source per minIntervalMs.
    const gap = source.access?.minIntervalMs ?? 5000;
    const last = lastFetch.get(source.id);
    if (last !== undefined) {
      const wait = gap - (now().getTime() - last);
      if (wait > 0) await sleep(wait);
    }
    const t0 = Date.now();
    let fetched;
    try {
      fetched = await fetchWithBackoff(url.href, { cfg, userAgent: env.HTTP_USER_AGENT || USER_AGENT, requestImpl: deps.requestImpl, sleep, log });
    } catch (error) {
      lastFetch.set(source.id, now().getTime());
      if (error instanceof ArticleHttpError && (error.status === 401 || error.status === 403)) {
        // Explicit refusal (login wall, bot challenge): never bypassed, never retried, stop for this source.
        deniedSources.add(source.id);
        out.status = 'access_denied';
        out.problems = [`ACCESS_DENIED: HTTP ${error.status} from ${url.hostname}; the source refuses automated access — do not work around it`];
      } else {
        out.status = error instanceof ArticleRefusedError ? 'refused' : 'failed';
        out.problems = [`FETCH_${error instanceof ArticleRefusedError ? 'REFUSED' : 'FAILED'}: ${(error as Error).message.slice(0, 200)}`];
      }
      continue;
    }
    lastFetch.set(source.id, now().getTime());
    if (lookup(fetched.finalUrl).id !== source.id || !adapter.matches(new URL(fetched.finalUrl))) {
      out.status = 'refused';
      out.problems = [`REDIRECT_OFF_SOURCE: ended on ${new URL(fetched.finalUrl).hostname}`];
      continue;
    }
    bytes += fetched.html.length;
    out.bytes = fetched.html.length;
    let doc;
    try {
      doc = adapter.parse(fetched.html, new URL(fetched.finalUrl), now());
    } catch (error) {
      out.status = 'failed';
      out.problems = [`PARSE_FAILED: ${(error as Error).message.slice(0, 200)}`];
      continue;
    }
    const ev = evaluateDocument(doc, { source, existingTitles: existingTitles.map((t) => ({ id: t.incidentKey, title: t.title })) });
    out.ms = Date.now() - t0;
    out.status = 'evaluated';
    out.title = doc.title;
    out.passages = doc.passages.length;
    const link: LinkCheck = { status: 'ok', httpStatus: fetched.httpStatus, finalUrl: fetched.finalUrl.slice(0, 2048), checkedAt: now().toISOString() };
    evaluated.push({ doc: out, incidents: ev.incidents, link, docMeta: doc });
  }

  // Incident dedupe across the run and against D1 titles; then the shared pipeline (exact keys, fuzzy titles).
  const all = evaluated.flatMap((e) => e.incidents);
  const dupByKey = new Map<string, { key: string; similarity: number }>();
  all.forEach((inc, idx) => {
    const d = possibleDuplicate(inc, all.slice(0, idx), existingTitles, inc.facts.eventDate.to);
    if (d) dupByKey.set(inc.providerKey, d);
  });
  for (const e of evaluated) e.doc.incidents = e.incidents.map((i) => incidentReport(i, dupByKey.get(i.providerKey)?.key ?? null));

  const seenAt = startedAt.toISOString();
  const discovered = evaluated.flatMap((e) => e.incidents.filter((i) => i.decision !== 'reject').map((i) => ({ d: toDiscovered(e.docMeta, i, seenAt), link: e.link, docId: e.docMeta.documentId })));
  const stats = emptyStats(discovered.length);
  const unique = uniqueWithinRun(discovered.map((x) => x.d), stats);
  let known = { canonicalUrls: [] as string[], providerKeys: [] as string[] };
  if (client && unique.length) {
    const r = await client.known(unique.map((d) => d.canonicalUrl).slice(0, 90), unique.map((d) => d.providerKey!).slice(0, 90));
    known = r;
  }
  const planned = planCandidates(unique, known, existingTitles, stats);
  const items: { item: ImportItem; docId: string }[] = [];
  for (const p of planned) {
    const src = discovered.find((x) => x.d === p.d)!;
    p.link = src.link;
    const extra = dupByKey.get(p.d.providerKey!);
    if (!p.dupOf && !p.attachTo && extra) p.dupOf = extra.key.startsWith('official:') ? undefined : extra;
    const item = buildImportItem(p);
    const checked = parse(importItemSchema, item);
    if (!checked.ok) {
      log.error(`Import item for ${p.d.providerKey} failed the contract check: ${formatIssues(checked.issues, 5)}`);
      return 1;
    }
    items.push({ item, docId: src.docId });
  }

  // Measured results (a candidate is never "publishable" before every eligibility check passes).
  const incidentsAll = evaluated.flatMap((e) => e.incidents);
  const totals = {
    documentsRequested: urls.length,
    documentsProcessed: evaluated.length,
    documentsRefused: outcomes.filter((o) => o.status === 'refused' || o.status === 'access_denied').length,
    documentsFailed: outcomes.filter((o) => o.status === 'failed').length,
    documentsSkipped: outcomes.filter((o) => o.status === 'skipped_checkpoint').length,
    incidentsExtracted: incidentsAll.length,
    rejected: incidentsAll.filter((i) => i.decision === 'reject').length,
    toReview: incidentsAll.filter((i) => i.decision !== 'reject').length,
    safetyReview: incidentsAll.filter((i) => i.decision === 'safety_review').length,
    withValidDraft: incidentsAll.filter((i) => i.decision !== 'reject' && i.facts.draft && i.facts.draft.problems.length === 0).length,
    newForImport: items.length,
    alreadyKnown: stats.duplicates,
    // Publication needs the owner to clear fetch/extractFacts/publishSummary AND a human approval.
    eligibleForPublication: 0,
    sourcesBlockingPublication: [...new Set(evaluated.filter((e) => accessOperationProblems(lookup(e.docMeta.url), OFFICIAL_PUBLISH_OPERATIONS).length > 0).map((e) => e.doc.sourceId!))],
    cost: { bytesFetched: bytes, aiRequests: 0, neurons: 0 },
  };
  const rejectReasons: Record<string, number> = {};
  for (const i of incidentsAll.filter((x) => x.decision === 'reject')) for (const r of i.reasons) rejectReasons[r] = (rejectReasons[r] ?? 0) + 1;

  const warned = new Set<string>();
  for (const o of outcomes) {
    log.info(`${o.status.toUpperCase().padEnd(18)} ${o.url}${o.sourceId ? ` [${o.sourceId}]` : ''}`);
    for (const p of o.problems ?? []) log.info(`    ✗ ${p}`);
    if (o.sourceId && !warned.has(o.sourceId)) for (const w of o.warnings ?? []) log.info(`    ! ${w}`);
    if (o.sourceId && o.warnings?.length) warned.add(o.sourceId);
    for (const i of o.incidents ?? []) {
      if (i.decision === 'reject') continue;
      log.info(`    [${i.decision}] ${i.heading ?? i.passage} · score ${i.score} · ${i.incidentType} · legal ${i.legalStage}${i.reasons.length ? ` · ${i.reasons.join(', ')}` : ''}`);
      if (i.draft) {
        log.info(`        title:       ${i.draft.playTitle}`);
        log.info(`        explanation: ${i.draft.explanation}`);
      }
      for (const p of i.draftProblems) log.info(`        draft problem: ${p}`);
      if (i.duplicateOf) log.info(`        possible duplicate of ${i.duplicateOf}`);
    }
  }
  log.info(`Totals: ${JSON.stringify({ ...totals, rejectReasons })}`);
  log.info('(rejectReasons counts reasons, not items: one rejected incident can carry several, e.g. a note such as WEAPON_MENTIONED.)');
  const report = { startedAt: seenAt, dryRun, target, totals, rejectReasons, documents: outcomes };
  if (values.report) writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
  if (values.json) log.info(JSON.stringify(report, null, 2));

  const allRefused = evaluated.length === 0 && outcomes.every((o) => o.status === 'refused' || o.status === 'access_denied');
  if (dryRun) {
    log.info(`Dry run: nothing imported (${items.length} new candidate(s) would be queued for review).`);
    if (values.state) {
      for (const e of evaluated) state.docs[e.docMeta.url] = { status: 'evaluated', at: seenAt, candidates: e.incidents.filter((i) => i.decision !== 'reject').length };
      writeFileSync(values.state, `${JSON.stringify(state, null, 2)}\n`);
    }
    return allRefused ? 2 : outcomes.some((o) => o.status === 'failed') ? 1 : 0;
  }

  // Import per document, so a failure never leaves a document half-recorded: its checkpoint is written
  // in the same Worker batch (one D1 transaction) as its items, and only when all of them were sent.
  const runId = `official_${startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;
  const results: ImportItemResult[] = [];
  const importErrors: string[] = [];
  const docIds = [...new Set(evaluated.map((e) => e.docMeta.documentId))];
  for (const [n, docId] of docIds.entries()) {
    const docItems = items.filter((x) => x.docId === docId).map((x) => x.item);
    const e = evaluated.find((x) => x.docMeta.documentId === docId)!;
    const cp = { provider: OFFICIAL_PROVIDER, key: `doc:${docId}`, value: JSON.stringify({ at: seenAt, candidates: docItems.length, passages: e.incidents.length }).slice(0, 2000) };
    const last = n === docIds.length - 1;
    const run: RunReport = {
      id: runId,
      provider: OFFICIAL_PROVIDER,
      startedAt: seenAt,
      finishedAt: last ? now().toISOString() : null,
      status: last ? (importErrors.length || totals.documentsFailed ? (results.length ? 'partial' : 'failed') : 'ok') : 'running',
      fetched: totals.documentsProcessed,
      newCount: results.filter((r) => r.outcome === 'inserted').length,
      duplicates: stats.duplicates,
      rejected: totals.rejected,
      errors: [...importErrors, ...outcomes.flatMap((o) => (o.status === 'failed' ? (o.problems ?? []) : []))].slice(0, 50).map((x) => x.slice(0, 300)),
      aiRequests: 0,
      tokensIn: 0,
      tokensOut: 0,
      neuronsEstimate: 0,
      models: [],
    };
    try {
      for (let i = 0; i < Math.max(docItems.length, 1); i += MAX_IMPORT_ITEMS) {
        const chunk = docItems.slice(i, i + MAX_IMPORT_ITEMS);
        const final = i + MAX_IMPORT_ITEMS >= docItems.length;
        results.push(...(await client!.importItems(runId, chunk, run, final ? [cp] : undefined)));
      }
      if (values.state) state.docs[e.docMeta.url] = { status: 'imported', at: seenAt, candidates: docItems.length };
    } catch (error) {
      importErrors.push(`${docId}: ${error instanceof WorkerApiError ? `${error.code} ${error.message}` : (error as Error).message}`.slice(0, 300));
    }
  }
  if (values.state) writeFileSync(values.state, `${JSON.stringify(state, null, 2)}\n`);
  const tally: Record<string, number> = {};
  for (const r of results) {
    const k = r.questionState ? `${r.outcome}:${r.questionState}` : r.outcome;
    tally[k] = (tally[k] ?? 0) + 1;
    if (r.questionState === 'approved') log.warn(`Worker reports ${r.incidentKey} as APPROVED — official-report items must stay in review; check the Worker version.`);
    if (r.outcome === 'invalid') log.warn(`Worker refused ${r.incidentKey}: ${(r.errors ?? []).join('; ')}`);
  }
  log.info(`Imported (${runId}): ${JSON.stringify(tally)}${importErrors.length ? ` · errors: ${importErrors.join(' | ')}` : ''}`);
  log.info('Next: npm run admin -- candidates:list --kind FLORIDA_NEWS --state candidate');
  if (importErrors.length) return 1;
  return allRefused ? 2 : outcomes.some((o) => o.status === 'failed') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`ERROR ${(error as Error).message}`);
      process.exit(1);
    },
  );
}

export { OfficialParseError };
