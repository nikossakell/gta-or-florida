import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(here, '..', '..');
export const DATA_DIR = resolve(process.env.DATA_DIR ?? resolve(REPO_ROOT, 'data'));

export const paths = {
  approved: resolve(DATA_DIR, 'questions.approved.json'),
  candidates: resolve(DATA_DIR, 'questions.candidates.json'),
  schedule: resolve(DATA_DIR, 'daily-schedule.json'),
  sources: resolve(DATA_DIR, 'sources.json'),
};

export async function readJson<T>(file: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${(error as Error).message}`);
  }
}

export async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try {
    await readFile(file);
  } catch {
    return null;
  }
  return readJson<T>(file);
}

/** Write via temp file + rename so a crash never leaves half-written JSON. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export const log = {
  info: (msg: string) => console.log(msg),
  ok: (msg: string) => console.log(`✔ ${msg}`),
  warn: (msg: string) => console.warn(`⚠ ${msg}`),
  error: (msg: string) => console.error(`✖ ${msg}`),
};
