#!/usr/bin/env -S npx tsx
/**
 * Validate the approved question bank, the candidate queue and the daily
 * schedule. Intended for CI: exits non-zero on any error.
 *
 *   npm run validate
 *   npm run validate -- --production     # also fail on placeholder content
 *   npm run validate -- --min-runway 14  # fail if fewer than 14 days are scheduled ahead
 */
import { parseArgs } from 'node:util';
import {
  addDays,
  hasErrors,
  utcDate,
  validateQuestionBank,
  validateSchedule,
  type CandidateFile,
  type Issue,
  type Question,
  type QuestionBankFile,
  type ScheduleFile,
} from '@gof/core';
import { log, paths, readJson, readJsonIfExists } from './lib/io.ts';

function print(label: string, issues: Issue[]): void {
  for (const i of issues) {
    const where = [i.date, i.questionId].filter(Boolean).join(' ');
    const line = `${label}: [${i.code}]${where ? ` ${where}:` : ''} ${i.message}`;
    if (i.level === 'error') log.error(line);
    else log.warn(line);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      production: { type: 'boolean', default: false },
      'min-runway': { type: 'string' },
      strict: { type: 'boolean', default: false },
      today: { type: 'string' },
    },
  });
  const today = values.today ?? utcDate();
  const issues: Issue[] = [];

  const bank = await readJson<QuestionBankFile>(paths.approved);
  if (bank.version !== 1 || !Array.isArray(bank.questions)) {
    log.error('questions.approved.json must be { "version": 1, "questions": [...] }');
    return 1;
  }
  const bankIssues = validateQuestionBank(bank.questions);
  const wrongStatus = (bank.questions as Question[]).filter((q) => q?.status !== 'verified');
  for (const q of wrongStatus) {
    bankIssues.push({ level: 'error', code: 'unapproved_in_bank', message: `Approved bank contains a "${q?.status}" question`, questionId: q?.id });
  }
  if (values.production) {
    for (const q of bank.questions.filter((q) => q.placeholder)) {
      bankIssues.push({ level: 'error', code: 'placeholder_in_production', message: 'Placeholder content is not allowed in production', questionId: q.id });
    }
  }
  print('bank', bankIssues);
  issues.push(...bankIssues);

  const candidates = await readJsonIfExists<CandidateFile>(paths.candidates);
  if (candidates) {
    const candIssues: Issue[] = [];
    if (candidates.version !== 1 || !Array.isArray(candidates.candidates)) {
      candIssues.push({ level: 'error', code: 'candidates_shape', message: 'questions.candidates.json must be { "version": 1, "candidates": [...] }' });
    } else {
      const ids = new Set<string>();
      for (const c of candidates.candidates) {
        if (ids.has(c.id)) candIssues.push({ level: 'error', code: 'duplicate_candidate', message: `Duplicate candidate id ${c.id}` });
        ids.add(c.id);
      }
    }
    print('candidates', candIssues);
    issues.push(...candIssues);
  }

  const schedule = await readJsonIfExists<ScheduleFile>(paths.schedule);
  const verified = bank.questions.filter((q) => q.status === 'verified');
  if (!schedule) {
    issues.push({ level: 'error', code: 'missing_schedule', message: 'data/daily-schedule.json not found; run npm run schedule:build' });
    log.error('schedule: data/daily-schedule.json not found; run npm run schedule:build');
  } else {
    const schedIssues = validateSchedule(schedule, bank.questions, { forbidPlaceholders: values.production });
    print('schedule', schedIssues);
    issues.push(...schedIssues);

    const ahead = schedule.days.filter((d) => d.date >= today);
    const lastDate = schedule.days.at(-1)?.date;
    const usedIds = new Set(schedule.days.flatMap((d) => d.questionIds));
    const unused = verified.filter((q) => !usedIds.has(q.id) && (!values.production || !q.placeholder));
    log.info(
      `\nInventory: ${verified.length} verified (${verified.filter((q) => q.answer === 'florida').length} Florida / ` +
        `${verified.filter((q) => q.answer === 'gta').length} GTA-style), ${unused.length} never scheduled.`,
    );
    log.info(`Schedule: ${schedule.days.length} days total, ${ahead.length} from ${today}${lastDate ? `, last ${lastDate}` : ''}.`);

    if (!schedule.days.some((d) => d.date === today)) {
      issues.push({ level: 'warning', code: 'today_unscheduled', message: `No challenge scheduled for ${today}; players will see the empty state.` });
      log.warn(`schedule: no challenge for today (${today}); players will see the "no challenge" fallback.`);
    }
    if (values['min-runway']) {
      const need = Number(values['min-runway']);
      const target = addDays(today, need - 1);
      if (!lastDate || lastDate < target) {
        issues.push({ level: 'error', code: 'insufficient_runway', message: `Schedule must cover through ${target}` });
        log.error(`schedule: must be scheduled through ${target} (min runway ${need} days), currently ${lastDate ?? 'empty'}.`);
      }
    }
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  if (hasErrors(issues) || (values.strict && warnings > 0)) {
    log.error(`Validation failed: ${errors} error(s), ${warnings} warning(s).`);
    return 1;
  }
  log.ok(`Validation passed${warnings ? ` with ${warnings} warning(s)` : ''}.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error((error as Error).message);
    process.exit(1);
  },
);
