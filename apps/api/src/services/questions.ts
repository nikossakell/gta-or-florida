import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  hasErrors,
  validateQuestionBank,
  validateSchedule,
  type Question,
  type QuestionBankFile,
  type ScheduleDay,
  type ScheduleFile,
} from '@gof/core';

export type ContentSnapshot = {
  questions: Map<string, Question>;
  schedule: ScheduleFile | null;
  days: Map<string, ScheduleDay>;
  loadedAt: Date;
  /** Set when the most recent load attempt failed (we may still be serving the last good data). */
  error?: string;
};

export type ContentStore = { get(): ContentSnapshot };

const EMPTY: Omit<ContentSnapshot, 'loadedAt'> = { questions: new Map(), schedule: null, days: new Map() };

function parse<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Load + validate both files. Throws with a readable message on any problem. */
export function loadContent(dataDir: string): Omit<ContentSnapshot, 'error'> {
  const bank = parse<QuestionBankFile>(resolve(dataDir, 'questions.approved.json'));
  if (bank?.version !== 1 || !Array.isArray(bank.questions)) throw new Error('questions.approved.json has an unexpected shape');
  const bankIssues = validateQuestionBank(bank.questions).filter((i) => i.level === 'error');
  if (bankIssues.length) throw new Error(`Question bank invalid: ${bankIssues.slice(0, 3).map((i) => i.message).join('; ')}`);

  const schedule = parse<ScheduleFile>(resolve(dataDir, 'daily-schedule.json'));
  const scheduleIssues = validateSchedule(schedule, bank.questions);
  if (hasErrors(scheduleIssues)) {
    throw new Error(`Schedule invalid: ${scheduleIssues.slice(0, 3).map((i) => i.message).join('; ')}`);
  }

  const questions = new Map(bank.questions.filter((q) => q.status === 'verified').map((q) => [q.id, q]));
  return { questions, schedule, days: new Map(schedule.days.map((d) => [d.date, d])), loadedAt: new Date() };
}

/**
 * File-backed content with hot reload. If a new version of the JSON fails to
 * parse or validate (e.g. a bad manual edit), the last good snapshot keeps
 * being served and the error is reported via /api/health.
 */
export function createContentStore(
  dataDir: string,
  onError: (msg: string) => void = console.error,
  checkIntervalMs = 2000,
): ContentStore {
  const files = [resolve(dataDir, 'questions.approved.json'), resolve(dataDir, 'daily-schedule.json')];
  let snapshot: ContentSnapshot = { ...EMPTY, loadedAt: new Date(0) };
  let signature = '';
  let lastCheck = 0;

  function currentSignature(): string {
    return files
      .map((f) => {
        try {
          const s = statSync(f);
          return `${s.mtimeMs}:${s.size}`;
        } catch {
          return 'missing';
        }
      })
      .join('|');
  }

  function refresh(): void {
    const sig = currentSignature();
    if (sig === signature) return;
    signature = sig;
    try {
      snapshot = loadContent(dataDir);
    } catch (error) {
      const message = (error as Error).message;
      onError(`[content] ${message}${snapshot.schedule ? ' — keeping previously loaded content' : ''}`);
      snapshot = { ...snapshot, error: message };
    }
  }

  refresh();
  return {
    get() {
      const now = Date.now();
      if (now - lastCheck >= checkIntervalMs) {
        lastCheck = now;
        refresh();
      }
      return snapshot;
    },
  };
}

/** Fixed in-memory store, for tests. */
export function createStaticStore(questions: Question[], schedule: ScheduleFile | null): ContentStore {
  const snap: ContentSnapshot = {
    questions: new Map(questions.filter((q) => q.status === 'verified').map((q) => [q.id, q])),
    schedule,
    days: new Map((schedule?.days ?? []).map((d) => [d.date, d])),
    loadedAt: new Date(),
  };
  return { get: () => snap };
}
