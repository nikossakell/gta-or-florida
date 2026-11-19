import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Works from both src/ (tsx) and dist/ (bundled): each is apps/api/<dir>.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  /** Built web app to serve, or null to run API-only. */
  webDistDir: string | null;
  /** Serve development placeholder questions. Defaults to true outside production. */
  allowPlaceholders: boolean;
  archiveDays: number;
  timeLimitSeconds: number;
  rateLimit: { windowMs: number; max: number };
  trustProxy: boolean;
  maxBodyBytes: number;
  logRequests: boolean;
};

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid integer config value "${value}" (expected ${min}-${max})`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const webDist = resolve(env.WEB_DIST_DIR ?? resolve(repoRoot, 'apps', 'web', 'dist'));
  return {
    port: int(env.PORT, 8787, 0, 65535),
    host: env.HOST ?? '127.0.0.1',
    dataDir: resolve(env.DATA_DIR ?? resolve(repoRoot, 'data')),
    webDistDir: env.SERVE_WEB === 'false' || !existsSync(resolve(webDist, 'index.html')) ? null : webDist,
    allowPlaceholders: bool(env.ALLOW_PLACEHOLDER_CONTENT, !production),
    archiveDays: int(env.ARCHIVE_DAYS, 7, 0, 366),
    timeLimitSeconds: int(env.TIME_LIMIT_SECONDS, 60, 0, 3600),
    rateLimit: { windowMs: 60_000, max: int(env.RATE_LIMIT_PER_MINUTE, 120, 1, 100_000) },
    trustProxy: bool(env.TRUST_PROXY, false),
    maxBodyBytes: 4096,
    logRequests: bool(env.LOG_REQUESTS, false),
  };
}
