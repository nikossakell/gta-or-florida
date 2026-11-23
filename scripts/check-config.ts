/**
 * Configuration self-checks run by `npm run validate` (and CI):
 *  - the source policy registry parses and its invariants hold
 *  - wrangler.jsonc envs are isolated (distinct DB names/ids, no shared ids)
 *  - workflow YAML parses and scheduled jobs use non-overlapping concurrency groups
 *  - .env.example documents every variable the code reads from process.env / Worker env
 * Prints warnings (not failures) for placeholders that the owner must still fill in.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { REGISTRY } from '@gof/config';

const ROOT = resolve(import.meta.dirname, '..');
const problems: string[] = [];
const warnings: string[] = [];

// 1. registry (loading it already validated invariants)
const approved = REGISTRY.sources.filter((s) => s.licenseStatus === 'approved');
if (approved.length === 0) warnings.push('No source is approved in packages/config/sources.policy.json yet — nothing can be published until the owner reviews sources.');

// 2. wrangler environments
export function stripJsonc(text: string): string {
  return text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str: string | undefined) => str ?? '');
}
const wrangler = JSON.parse(stripJsonc(readFileSync(resolve(ROOT, 'apps/worker/wrangler.jsonc'), 'utf8'))) as {
  env: Record<string, { vars?: Record<string, string>; d1_databases?: { database_name: string; database_id: string }[] }>;
};
const dbs = Object.entries(wrangler.env).map(([env, cfg]) => ({ env, db: cfg.d1_databases?.[0], vars: cfg.vars ?? {} }));
for (const { env, db, vars } of dbs) {
  if (!db) problems.push(`wrangler env ${env} has no D1 binding`);
  if (vars.APP_ENV !== env) problems.push(`wrangler env ${env}: APP_ENV must be "${env}"`);
  if (env !== 'local' && vars.AUTO_PUBLISH_MODE && vars.AUTO_PUBLISH_MODE !== 'shadow') warnings.push(`wrangler env ${env}: AUTO_PUBLISH_MODE=${vars.AUTO_PUBLISH_MODE} (default should stay shadow until a benchmark exists)`);
  if (db?.database_id.startsWith('REPLACE_WITH')) warnings.push(`wrangler env ${env}: database_id is still a placeholder (run \`wrangler d1 create ${db.database_name}\`)`);
}
const names = dbs.map((d) => d.db?.database_name);
const ids = dbs.map((d) => d.db?.database_id).filter((id) => id && !id.startsWith('REPLACE_WITH'));
if (new Set(names).size !== names.length) problems.push('wrangler envs share a D1 database_name');
if (new Set(ids).size !== ids.length) problems.push('wrangler envs share a D1 database_id (staging and production must be isolated)');

// 2b. ingestion Worker: each env talks only to its own API Worker; Workflow names are account-global
type IngestEnv = { vars?: Record<string, string>; services?: { binding: string; service: string }[]; workflows?: { name: string }[]; d1_databases?: unknown[]; triggers?: { crons?: string[] } };
const ingest = JSON.parse(stripJsonc(readFileSync(resolve(ROOT, 'apps/ingest-worker/wrangler.jsonc'), 'utf8'))) as { env: Record<string, IngestEnv> };
const wfNames: string[] = [];
for (const [env, cfg] of Object.entries(ingest.env)) {
  const vars = cfg.vars ?? {};
  if (vars.APP_ENV !== env) problems.push(`ingest wrangler env ${env}: APP_ENV must be "${env}"`);
  const api = cfg.services?.find((s) => s.binding === 'API')?.service;
  if (api !== `gta-florida-api-${env}`) problems.push(`ingest wrangler env ${env}: API service binding must be gta-florida-api-${env} (got ${api ?? 'none'})`);
  if (cfg.d1_databases?.length) problems.push(`ingest wrangler env ${env}: must not bind D1 directly (the API Worker is the only writer)`);
  for (const w of cfg.workflows ?? []) {
    if (!w.name.endsWith(`-${env}`)) problems.push(`ingest wrangler env ${env}: workflow name ${w.name} must end with -${env}`);
    wfNames.push(w.name);
  }
  if (env !== 'local' && vars.AI_PROVIDER === 'mock') warnings.push(`ingest wrangler env ${env}: AI_PROVIDER=mock`);
}
if (new Set(wfNames).size !== wfNames.length) problems.push('ingest wrangler envs share a Workflow name');
// Workers Free: 5 Cron Triggers per account (API + ingestion, staging + production).
const cronCount = [wrangler.env, ingest.env]
  .flatMap((envs) => Object.entries(envs).filter(([env]) => env !== 'local').map(([, cfg]) => ((cfg as IngestEnv).triggers?.crons ?? []).length))
  .reduce((a, b) => a + b, 0);
if (cronCount > 5) warnings.push(`${cronCount} Cron Triggers across deployed envs; Workers Free allows 5 per account`);

// 3. workflows
const wfDir = resolve(ROOT, '.github/workflows');
const groups = new Map<string, string>();
for (const file of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
  let wf: { on?: unknown; concurrency?: { group?: string } | string; jobs?: Record<string, unknown> };
  try {
    wf = parseYaml(readFileSync(resolve(wfDir, file), 'utf8'));
  } catch (error) {
    problems.push(`${file}: invalid YAML (${(error as Error).message})`);
    continue;
  }
  if (!wf.jobs) problems.push(`${file}: no jobs`);
  const group = typeof wf.concurrency === 'string' ? wf.concurrency : wf.concurrency?.group;
  const scheduled = typeof wf.on === 'object' && wf.on !== null && 'schedule' in wf.on;
  if (scheduled && !group) problems.push(`${file}: scheduled workflow without a concurrency group (runs could overlap)`);
  if (group && !group.includes('${{')) {
    if (groups.has(group)) problems.push(`${file}: concurrency group "${group}" also used by ${groups.get(group)}`);
    groups.set(group, file);
  }
}

// 4. env documentation
const example = readFileSync(resolve(ROOT, '.env.example'), 'utf8');
const used = new Set<string>();
const scan = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'test', '.wrangler'].includes(entry.name)) scan(p);
    } else if (/\.tsx?$/.test(entry.name)) {
      for (const m of readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) used.add((m[1] ?? m[2])!);
    }
  }
};
for (const d of ['apps/ingest/src', 'apps/web/src', 'scripts']) scan(resolve(ROOT, d));
for (const line of readFileSync(resolve(ROOT, 'apps/worker/src/env.ts'), 'utf8').matchAll(/^\s+([A-Z][A-Z0-9_]+)\??:/gm)) used.add(line[1]!);
for (const line of readFileSync(resolve(ROOT, 'apps/ingest-worker/src/index.ts'), 'utf8').matchAll(/^\s+([A-Z][A-Z0-9_]+)\??:/gm)) used.add(line[1]!);
for (const m of readFileSync(resolve(ROOT, 'apps/ingest-worker/src/limits.ts'), 'utf8').matchAll(/\| '([A-Z][A-Z0-9_]+)'/g)) used.add(m[1]!);
const IGNORED = new Set(['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'DB', 'RATE_LIMITER', 'BASE_PATH', 'NODE_ENV', 'API', 'AI', 'INGEST_WORKFLOW']);
for (const name of used) if (!IGNORED.has(name) && !new RegExp(`\\b${name}\\b`).test(example)) problems.push(`.env.example does not document ${name}`);

for (const w of warnings) console.warn(`warning: ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`error: ${p}`);
  process.exit(1);
}
console.log(`config ok: ${REGISTRY.sources.length} sources (${approved.length} approved, policy ${REGISTRY.policyVersion}), ${dbs.length} wrangler envs, ${wfNames.length} ingestion workflows, ${cronCount} cron triggers, ${groups.size} GitHub workflow concurrency groups`);
