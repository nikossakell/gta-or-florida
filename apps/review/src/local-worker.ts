/**
 * The real API Worker, run in-process against a persisted LOCAL D1 (workerd SQLite via wrangler's
 * getPlatformProxy — the same mechanism the Worker's own tests use). Approvals therefore go through the
 * existing /api/v1/admin/review route: schema validation, `review()` checks and the review_log audit trail.
 *
 * Nothing here opens a network connection to Cloudflare: the D1 binding is the `local` environment's
 * emulator, the admin client's fetch is routed straight into `handleRequest`, and any other URL is refused.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../../worker/src/env.ts';
import { handleRequest } from '../../worker/src/index.ts';
import { createWorkerClient, type WorkerClient } from '../../ingest/src/import.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const WORKER_DIR = resolve(here, '../../worker');

/** In-process base URL: never resolvable, so a mis-routed request cannot leave the machine. */
const IN_PROCESS_ORIGIN = 'https://in-process.worker.invalid';

/** Statements of one migration file (comments stripped), same splitting as the Worker test harness. */
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/\s+--.*$/, '').replace(/^--.*$/, ''))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Apply the Worker's migrations that this database has not seen yet (wrangler's d1_migrations bookkeeping). */
export async function applyMigrations(db: D1Database): Promise<string[]> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  const done = new Set((await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map((r) => r.name));
  const dir = resolve(WORKER_DIR, 'migrations');
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const stmts = splitStatements(readFileSync(resolve(dir, file), 'utf8')).map((s) => db.prepare(s));
    await db.batch([...stmts, db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(file)]);
    applied.push(file);
  }
  return applied;
}

export type LocalWorker = {
  db: D1Database;
  env: Env;
  /** Admin client (questions:approve etc.) bound to this in-process Worker. */
  admin: WorkerClient;
  /** Service client (import), same Worker. */
  service: WorkerClient;
  dispose(): Promise<void>;
};

export type LocalWorkerOptions = {
  /** Directory for the persisted local D1 (created if missing). `false` = in-memory (tests). */
  persistDir: string | false;
  /** Audit name recorded in review_log (sanitised like the admin CLI does). */
  reviewer: string;
  now?: () => Date;
};

export function sanitizeActor(name: string): string {
  return name.replace(/[^A-Za-z0-9 ._@-]/g, '').slice(0, 64) || 'reviewer';
}

export async function openLocalWorker(opts: LocalWorkerOptions): Promise<LocalWorker> {
  // No telemetry from the wrangler library (it only runs the local emulator here).
  process.env.WRANGLER_SEND_METRICS = 'false';
  const { getPlatformProxy } = await import('wrangler');
  if (opts.persistDir) mkdirSync(opts.persistDir, { recursive: true, mode: 0o700 });
  const proxy = await getPlatformProxy<Env>({
    configPath: resolve(WORKER_DIR, 'wrangler.jsonc'),
    environment: 'local',
    persist: opts.persistDir ? { path: opts.persistDir } : false,
  });
  const db = proxy.env.DB;
  await applyMigrations(db);
  // Fresh random tokens per process: nothing is read from .env / .dev.vars, nothing is written to disk.
  const adminToken = randomBytes(32).toString('hex');
  const serviceToken = randomBytes(32).toString('hex');
  const env: Env = { DB: db, APP_ENV: 'local', AUTO_PUBLISH_MODE: 'shadow', ADMIN_TOKEN: adminToken, INGESTION_IMPORT_TOKEN: serviceToken };
  const now = opts.now ?? (() => new Date());
  const inProcessFetch: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith(`${IN_PROCESS_ORIGIN}/`)) throw new Error('Refused: the review dashboard only talks to its in-process local Worker.');
    return handleRequest(req, env, now);
  };
  const actor = sanitizeActor(opts.reviewer);
  const client = (token: string) => createWorkerClient({ baseUrl: IN_PROCESS_ORIGIN, token, actor, fetchImpl: inProcessFetch, maxRetries: 0 });
  return { db, env, admin: client(adminToken), service: client(serviceToken), dispose: () => proxy.dispose() };
}
