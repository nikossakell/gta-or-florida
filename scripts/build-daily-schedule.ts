#!/usr/bin/env -S npx tsx
/**
 * Deterministically extend data/daily-schedule.json from the approved bank.
 *
 *   npm run schedule:build                          # next 30 days from today (UTC)
 *   npm run schedule:build -- --days 60
 *   npm run schedule:build -- --start 2026-12-01 --dry-run
 *   npm run schedule:build -- --allow-placeholders  # local development with sample data
 *
 * Existing days are never changed. If inventory runs out, the run stops at the
 * first unfillable date and reports the shortage (exit code 2 with --strict).
 */
import { parseArgs } from 'node:util';
import {
  buildSchedule,
  DEFAULT_COOLDOWN_DAYS,
  DEFAULT_SEED,
  DEFAULT_SIZE,
  hasErrors,
  isIsoDate,
  utcDate,
  validateQuestionBank,
  validateSchedule,
  type QuestionBankFile,
  type ScheduleFile,
} from '@gof/core';
import { log, paths, readJson, readJsonIfExists, writeJsonAtomic } from './lib/io.ts';

const HELP = `Usage: npm run schedule:build -- [options]

  --start <YYYY-MM-DD>   First date to fill (default: today, UTC)
  --days <n>             Days to fill from start (default 30, max 366)
  --size <n>             Questions per day (default: existing schedule or ${DEFAULT_SIZE})
  --cooldown <days>      Minimum days before a question/event may repeat (default: existing or ${DEFAULT_COOLDOWN_DAYS})
  --seed <text>          Seed for deterministic selection (default: existing or "${DEFAULT_SEED}")
  --allow-placeholders   Include placeholder sample content (development only)
  --dry-run              Print the result without writing
  --strict               Exit 2 if the full range could not be filled
  -h, --help             Show this help`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      start: { type: 'string' },
      days: { type: 'string', default: '30' },
      size: { type: 'string' },
      cooldown: { type: 'string' },
      seed: { type: 'string' },
      'allow-placeholders': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    log.info(HELP);
    return 0;
  }

  const startDate = values.start ?? utcDate();
  if (!isIsoDate(startDate)) throw new Error(`--start must be YYYY-MM-DD, got ${startDate}`);
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('--days must be an integer 1-366');
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
    return n;
  };

  const bank = await readJson<QuestionBankFile>(paths.approved);
  const bankIssues = validateQuestionBank(bank.questions);
  if (hasErrors(bankIssues)) {
    for (const i of bankIssues.filter((x) => x.level === 'error')) log.error(`[${i.code}] ${i.questionId ?? ''} ${i.message}`);
    log.error('Fix the question bank before scheduling (npm run validate).');
    return 1;
  }

  const existing = await readJsonIfExists<ScheduleFile>(paths.schedule);
  if (existing) {
    const existingIssues = validateSchedule(existing, bank.questions);
    if (hasErrors(existingIssues)) {
      for (const i of existingIssues) log.error(`[${i.code}] ${i.message}`);
      log.error('Existing schedule is invalid; refusing to extend it.');
      return 1;
    }
  }

  const result = buildSchedule({
    questions: bank.questions,
    existing,
    startDate,
    days,
    size: num(values.size, 'size'),
    cooldownDays: num(values.cooldown, 'cooldown'),
    seed: values.seed,
    allowPlaceholders: values['allow-placeholders'],
  });

  const finalIssues = validateSchedule(result.schedule, bank.questions);
  if (hasErrors(finalIssues)) {
    for (const i of finalIssues) log.error(`[${i.code}] ${i.message}`);
    log.error('Generated schedule failed validation; nothing written.');
    return 1;
  }

  for (const w of result.warnings) log.warn(w.message);
  log.info(`Added ${result.added.length} day(s)${result.added.length ? `: ${result.added[0]} → ${result.added.at(-1)}` : ''}; kept ${result.kept.length} existing.`);

  if (values['dry-run']) {
    log.info(JSON.stringify(result.schedule.days.filter((d) => result.added.includes(d.date)), null, 2));
    log.info('Dry run: schedule not written.');
  } else if (result.added.length > 0) {
    await writeJsonAtomic(paths.schedule, { ...result.schedule, generatedAt: new Date().toISOString() });
    log.ok(`Wrote ${paths.schedule}`);
  }

  if (result.shortageDate) {
    log.error(`Inventory shortage from ${result.shortageDate}. Players will see the "no challenge" state on unscheduled days.`);
    return values.strict ? 2 : 0;
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
