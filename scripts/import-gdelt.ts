#!/usr/bin/env -S npx tsx
/**
 * Discover Florida news *candidates* via the GDELT DOC 2.0 API.
 *
 *   npm run import:gdelt                       # next 3 query batches (rotating)
 *   npm run import:gdelt -- --batch florida-woman
 *   npm run import:gdelt -- --queries 1 --dry-run
 *
 * Output goes ONLY to data/questions.candidates.json. Candidates are raw
 * metadata (title, URL, publisher, date). They are never published: a human
 * must open the original article, confirm the event happened in Florida,
 * write an original short headline + explanation, and add it to
 * questions.approved.json with status "verified".
 *
 * Pacing: at least 5 s between requests, bounded retries with exponential
 * backoff, response cache in .cache/gdelt. Data: https://www.gdeltproject.org/
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { CandidateFile, QuestionBankFile } from '@gof/core';
import { mergeCandidates, selectBatches, type SourcesConfig } from './lib/candidates.ts';
import { buildGdeltUrl, createPacer, fetchGdeltArticles, GdeltError, type GdeltArticle } from './lib/gdelt.ts';
import { log, paths, readJson, readJsonIfExists, writeJsonAtomic } from './lib/io.ts';

const HELP = `Usage: npm run import:gdelt -- [options]

  --queries <n>        Number of query batches to run (default from sources.json, max 6)
  --batch <id>         Run only this batch id (see data/sources.json)
  --max-records <n>    Records per query, 1-250 (default from sources.json)
  --timespan <span>    GDELT timespan, e.g. 7d, 2w, 3m (default from sources.json)
  --delay <seconds>    Seconds between requests (minimum 5)
  --cache-ttl <hours>  Reuse cached responses younger than this (default 6, 0 disables)
  --dry-run            Fetch and report, but do not write candidates
  -h, --help           Show this help`;

type CacheEntry = { fetchedAt: string; url: string; articles: GdeltArticle[] };

async function readCache(url: URL, ttlHours: number): Promise<GdeltArticle[] | null> {
  if (ttlHours <= 0) return null;
  const file = cacheFile(url);
  try {
    const entry = JSON.parse(await readFile(file, 'utf8')) as CacheEntry;
    const age = Date.now() - Date.parse(entry.fetchedAt);
    if (entry.url === url.toString() && Array.isArray(entry.articles) && age >= 0 && age < ttlHours * 3_600_000) return entry.articles;
  } catch {
    /* cache miss */
  }
  return null;
}

async function writeCache(url: URL, articles: GdeltArticle[]): Promise<void> {
  await mkdir(paths.cache, { recursive: true });
  const entry: CacheEntry = { fetchedAt: new Date().toISOString(), url: url.toString(), articles };
  await writeFile(cacheFile(url), JSON.stringify(entry), 'utf8');
}

function cacheFile(url: URL): string {
  return resolve(paths.cache, `${createHash('sha256').update(url.toString()).digest('hex').slice(0, 24)}.json`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      queries: { type: 'string' },
      batch: { type: 'string' },
      'max-records': { type: 'string' },
      timespan: { type: 'string' },
      delay: { type: 'string' },
      'cache-ttl': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    log.info(HELP);
    return 0;
  }

  const config = await readJson<SourcesConfig>(paths.sources);
  const candidates = (await readJsonIfExists<CandidateFile>(paths.candidates)) ?? { version: 1, candidates: [] };
  const approved = await readJson<QuestionBankFile>(paths.approved);

  const queriesPerRun = Math.min(Number(values.queries ?? config.gdelt.queriesPerRun), 6);
  const maxRecords = Number(values['max-records'] ?? config.gdelt.maxRecords);
  const timespan = values.timespan ?? config.gdelt.timespan;
  const delaySeconds = Math.max(Number(values.delay ?? config.gdelt.minDelaySeconds), 5);
  const cacheTtl = Number(values['cache-ttl'] ?? 6);
  if (!Number.isInteger(queriesPerRun) || queriesPerRun < 1) throw new Error('--queries must be a positive integer');
  if (!Number.isFinite(cacheTtl) || cacheTtl < 0) throw new Error('--cache-ttl must be >= 0');

  let selected: SourcesConfig['gdelt']['batches'];
  let nextBatchIndex = candidates.nextBatchIndex ?? 0;
  if (values.batch) {
    const one = config.gdelt.batches.find((b) => b.id === values.batch);
    if (!one) throw new Error(`Unknown batch "${values.batch}". Known: ${config.gdelt.batches.map((b) => b.id).join(', ')}`);
    selected = [one];
  } else {
    const pick = selectBatches(config.gdelt.batches, nextBatchIndex, queriesPerRun);
    selected = pick.selected;
    nextBatchIndex = pick.next;
  }

  log.info(`GDELT DOC 2.0 candidate import — ${selected.length} quer${selected.length === 1 ? 'y' : 'ies'}, ≥${delaySeconds}s apart`);
  log.info('Data: The GDELT Project (https://www.gdeltproject.org/). Metadata only; link back to publishers.\n');

  const pace = createPacer(delaySeconds * 1000);
  const collected: { article: GdeltArticle; query: string }[] = [];
  const failures: { batch: string; error: GdeltError | Error }[] = [];

  for (const batch of selected) {
    const query = [batch.query, config.gdelt.queryOperators].filter(Boolean).join(' ');
    let url: URL;
    try {
      url = buildGdeltUrl({ query, maxRecords, timespan, sort: config.gdelt.sort, endpoint: config.gdelt.endpoint });
    } catch (error) {
      failures.push({ batch: batch.id, error: error as Error });
      log.error(`[${batch.id}] invalid query settings: ${(error as Error).message}`);
      continue;
    }

    const cached = await readCache(url, cacheTtl);
    if (cached) {
      log.info(`[${batch.id}] ${cached.length} articles (cached)`);
      collected.push(...cached.map((article) => ({ article, query: batch.query })));
      continue;
    }

    try {
      await pace();
      const articles = await fetchGdeltArticles(url, {
        onRetry: (attempt, error, wait) => log.warn(`[${batch.id}] ${error.message}; retry ${attempt} in ${Math.round(wait / 1000)}s`),
      });
      await writeCache(url, articles);
      log.ok(`[${batch.id}] ${articles.length} articles`);
      collected.push(...articles.map((article) => ({ article, query: batch.query })));
    } catch (error) {
      const e = error as GdeltError | Error;
      failures.push({ batch: batch.id, error: e });
      log.error(`[${batch.id}] ${e.message}`);
      if (e instanceof GdeltError && e.kind === 'rate_limited') {
        log.warn('Rate limited even after backoff — stopping this run early. Try again later.');
        break;
      }
    }
  }

  const { file, stats } = mergeCandidates({ file: candidates, approved: approved.questions, articles: collected, config, now: new Date() });
  file.nextBatchIndex = nextBatchIndex;

  log.info(
    `\nFetched ${stats.fetched} · new ${stats.added} (${stats.flaggedForReview} flagged as possible duplicates) · ` +
      `duplicates ${stats.duplicates} · blocked ${stats.blocked} · invalid ${stats.invalid}`,
  );
  const newOnes = stats.added > 0 ? file.candidates.slice(-stats.added) : [];
  const noSignal = newOnes.filter((c) => c.floridaSignal === 'none').length;
  if (noSignal) log.warn(`${noSignal} new candidates have no Florida signal in title or domain — verify location carefully.`);

  if (values['dry-run']) {
    log.info('Dry run: candidates file not written.');
  } else if (stats.added > 0 || nextBatchIndex !== candidates.nextBatchIndex) {
    await writeJsonAtomic(paths.candidates, file);
    log.ok(`Wrote ${paths.candidates}`);
  }
  log.info('Nothing was published. Review candidates by hand before adding anything to questions.approved.json.');

  if (failures.length > 0 && failures.length === selected.length) {
    log.error('All queries failed. Existing approved questions and schedules are unaffected.');
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error((error as Error).message);
    process.exit(1);
  },
);
