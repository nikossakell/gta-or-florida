/**
 * Local-only persistence. Nothing here leaves the device.
 *
 * This is a casual anti-repeat mechanism, not tamper-proof: clearing site data
 * or using another browser allows another attempt. That's acceptable for a
 * small anonymous game without accounts.
 */
import { addDays, type PlayerChoice, type ResultCell, type RevealedQuestion } from '@gof/core';

const PREFIX = 'gof:v1:';
const RESULTS_KEY = `${PREFIX}results`;
const progressKey = (date: string) => `${PREFIX}progress:${date}`;

export type PlayMode = 'daily' | 'archive';

export type StoredResult = {
  date: string;
  number: number;
  mode: PlayMode;
  score: number;
  total: number;
  cells: ResultCell[];
  choices: PlayerChoice[];
  seconds: number;
  timedOut: boolean;
  completedAt: string;
  sample: boolean;
  questions: RevealedQuestion[];
};

export type AnswerRecord = {
  questionId: string;
  choice: PlayerChoice;
  correct: boolean;
  question: RevealedQuestion;
};

export type StoredProgress = {
  date: string;
  questionIds: string[];
  mode: PlayMode;
  index: number;
  phase: 'question' | 'reveal' | 'timeup';
  elapsedMs: number;
  answers: AnswerRecord[];
  updatedAt: string;
};

function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    const probe = `${PREFIX}probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null; // private mode, disabled storage, SSR
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function isStorageAvailable(): boolean {
  return storage() !== null;
}

export function getResults(): Record<string, StoredResult> {
  const all = readJson<Record<string, StoredResult>>(RESULTS_KEY);
  return all && typeof all === 'object' ? all : {};
}

export function getResult(date: string): StoredResult | null {
  return getResults()[date] ?? null;
}

/** Store the first scored attempt for a date. Later attempts (replays) never overwrite it. */
export function saveResult(result: StoredResult): StoredResult {
  const all = getResults();
  const existing = all[result.date];
  if (existing) return existing;
  all[result.date] = result;
  writeJson(RESULTS_KEY, all);
  return result;
}

export function getProgress(date: string): StoredProgress | null {
  return readJson<StoredProgress>(progressKey(date));
}

export function saveProgress(progress: StoredProgress): void {
  writeJson(progressKey(progress.date), progress);
}

export function clearProgress(date: string): void {
  try {
    storage()?.removeItem(progressKey(date));
  } catch {
    /* ignore */
  }
}

export function clearAllLocalData(): void {
  try {
    const s = storage();
    if (!s) return;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => s.removeItem(k));
  } catch {
    /* ignore */
  }
}

export type Stats = { played: number; streak: number; best: { score: number; total: number } | null };

/**
 * - played: all scored rounds (daily + archive)
 * - streak: consecutive UTC days with a *daily* completion, ending today or yesterday
 *   (archive plays never extend a streak)
 * - best: highest score ratio
 */
export function computeStats(results: Record<string, StoredResult>, today: string): Stats {
  const list = Object.values(results);
  const dailyDates = new Set(list.filter((r) => r.mode === 'daily').map((r) => r.date));

  let streak = 0;
  let cursor = dailyDates.has(today) ? today : addDays(today, -1);
  while (dailyDates.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }

  let best: Stats['best'] = null;
  for (const r of list) {
    if (r.total <= 0) continue;
    if (!best || r.score / r.total > best.score / best.total) best = { score: r.score, total: r.total };
  }
  return { played: list.length, streak, best };
}
