#!/usr/bin/env -S npx tsx
/**
 * Turn the Vite build (apps/web/dist-pages, built with `--mode pages`) into a fully
 * static site for GitHub Pages:
 *
 *   1. validate the question bank + schedule (fails the build on errors)
 *   2. write per-day JSON under dist/data/ (see scripts/lib/static-site.ts)
 *   3. copy index.html → 404.html so deep links like /archive work on Pages
 *
 *   npm run build:pages
 *   npm run build:pages -- --today 2026-11-19 --lead-days 0
 *
 * Re-run daily (the Pages workflow does this on a cron) so each new round is
 * published on its day and never earlier.
 */
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  hasErrors,
  isIsoDate,
  utcDate,
  validateQuestionBank,
  validateSchedule,
  type QuestionBankFile,
  type ScheduleFile,
} from '@gof/core';
import { log, paths, readJson, REPO_ROOT } from './lib/io.ts';
import { buildStaticSite } from './lib/static-site.ts';

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${name} must be an integer 0-${max}`);
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dist: { type: 'string' },
      today: { type: 'string' },
      'lead-days': { type: 'string' },
      'archive-days': { type: 'string' },
      'allow-placeholders': { type: 'boolean' },
    },
  });

  const dist = resolve(values.dist ?? resolve(REPO_ROOT, 'apps', 'web', 'dist-pages'));
  const indexHtml = resolve(dist, 'index.html');
  try {
    await stat(indexHtml);
  } catch {
    log.error(`${indexHtml} not found. Run the web build first: npm run build:pages`);
    return 1;
  }

  const today = values.today ?? utcDate();
  if (!isIsoDate(today)) throw new Error(`--today must be YYYY-MM-DD, got ${today}`);
  const leadDays = int(values['lead-days'], 0, '--lead-days', 7);
  const archiveDays = int(values['archive-days'] ?? process.env.ARCHIVE_DAYS, 7, 'archive days', 366);
  const timeLimitSeconds = int(process.env.TIME_LIMIT_SECONDS, 60, 'TIME_LIMIT_SECONDS', 3600);
  const allowPlaceholders = values['allow-placeholders'] ?? envBool(process.env.ALLOW_PLACEHOLDER_CONTENT, false);

  const bank = await readJson<QuestionBankFile>(paths.approved);
  const schedule = await readJson<ScheduleFile>(paths.schedule);
  const issues = [...validateQuestionBank(bank.questions), ...validateSchedule(schedule, bank.questions)].filter((i) => i.level === 'error');
  if (hasErrors(issues)) {
    for (const i of issues) log.error(`[${i.code}] ${i.date ?? i.questionId ?? ''} ${i.message}`);
    log.error('Content is invalid; refusing to publish.');
    return 1;
  }

  const site = buildStaticSite({ questions: bank.questions, schedule, today, archiveDays, leadDays, timeLimitSeconds, allowPlaceholders });

  const dataDir = resolve(dist, 'data');
  await rm(dataDir, { recursive: true, force: true });
  for (const [rel, content] of site.files) {
    const file = resolve(dist, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(content), 'utf8');
  }
  // GitHub Pages has no rewrites: unknown paths get 404.html, which boots the SPA router.
  await copyFile(indexHtml, resolve(dist, '404.html'));
  // Artifact-based deploys skip Jekyll anyway; this keeps branch-based deploys safe too.
  await writeFile(resolve(dist, '.nojekyll'), '', 'utf8');

  log.ok(`Static data for ${site.published.length} day(s) written to ${dataDir} (today ${today}, lead ${leadDays}, archive ${archiveDays})`);
  if (!site.published.includes(today)) log.warn(`No round published for ${today}: players will see "No headlines today".`);
  if (site.skippedPlaceholderDays.length) {
    log.warn(`Skipped ${site.skippedPlaceholderDays.length} day(s) with placeholder content (set ALLOW_PLACEHOLDER_CONTENT=true to include sample data).`);
  }
  if (leadDays > 0) log.warn(`--lead-days ${leadDays}: answers for future rounds are publicly downloadable.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error((error as Error).message);
    process.exit(1);
  },
);
