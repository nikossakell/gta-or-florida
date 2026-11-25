/**
 * `npm run bank:import -- --file <batch.json> [--env staging] [--dry-run]`
 *
 * Imports a curated question-bank batch (docs/question-bank.md) as review candidates:
 *   offline validation (original wording, no giveaways, not copied from the source headline,
 *   allowed source, one origin per event) → authenticated Worker /import as `manual` submissions.
 * The Worker routes every manual submission to a human; approval is `npm run admin -- questions:approve`.
 * Re-running the same file is safe: already imported drafts come back as duplicates.
 *
 * Env: INGESTION_API_URL (or --to), INGESTION_IMPORT_TOKEN, REVIEWER (audit name).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { ImportItemResult } from '@gof/core';
import { parseBankFile, toImportItem, validateBank } from './bank.ts';
import { loadSourcesConfig } from './config-file.ts';
import { createWorkerClient, type WorkerClient } from './import.ts';
import { targetProblem, TARGET_ENVS, type TargetEnv } from './ingest-url.ts';
import type { SourcesConfig } from './normalize.ts';
import { REPO_ROOT } from './paths.ts';

const HELP = `Import a curated question-bank batch as review candidates (nothing is approved).

  npm run bank:import -- --file <batch.json> [--env staging|local|production] [--dry-run] [--skip-invalid]

  --file <path>        batch file (format: docs/question-bank.md)
  --env <name>         target Worker (default staging); must match the Worker URL
  --to <url>           Worker URL (default INGESTION_API_URL)
  --dry-run            validate and print; no network
  --skip-invalid       import the valid entries even if others have problems
  --allow-production   required together with --env production
  --json               print the validation report and results as JSON

Exit codes: 0 ok · 1 error · 2 validation problems or refused.`;

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
export type BankImportDeps = {
  log?: Log;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  cfg?: SourcesConfig;
  readFile?: (path: string) => string;
  createClient?: (opts: { baseUrl: string; token: string; actor: string }) => WorkerClient;
};

const defaultLog: Log = { info: (m) => console.log(m), warn: (m) => console.warn(`WARN ${m}`), error: (m) => console.error(`ERROR ${m}`) };

export async function main(argv = process.argv.slice(2), deps: BankImportDeps = {}): Promise<number> {
  const log = deps.log ?? defaultLog;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      file: { type: 'string' },
      env: { type: 'string', default: 'staging' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'skip-invalid': { type: 'boolean', default: false },
      'allow-production': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.file) {
    (values.help ? log.info : log.error)(HELP);
    return values.help ? 0 : 2;
  }
  const target = values.env as TargetEnv;
  if (!TARGET_ENVS.includes(target)) {
    log.error(`--env must be one of ${TARGET_ENVS.join(', ')}`);
    return 2;
  }

  // 1. Parse + validate (offline)
  let raw: unknown;
  try {
    raw = JSON.parse((deps.readFile ?? ((p) => readFileSync(p, 'utf8')))(resolve(values.file)));
  } catch (error) {
    log.error(`Cannot read ${values.file}: ${(error as Error).message}`);
    return 1;
  }
  const parsed = parseBankFile(raw);
  if (!parsed.ok) {
    log.error(`${values.file} is not a valid batch:\n${parsed.error}`);
    return 2;
  }
  const file = parsed.file;
  if (file.fixture && target !== 'local') {
    log.error('Refused: fixture batches (placeholder content) can only be imported into the local Worker (--env local).');
    return 2;
  }
  const cfg = deps.cfg ?? loadSourcesConfig(resolve(REPO_ROOT, 'data'));
  const reports = validateBank(file, cfg);
  const bad = reports.filter((r) => r.problems.length);
  for (const r of reports) {
    if (!r.problems.length && !r.warnings.length) continue;
    log.info(`#${r.index + 1} [${r.eventId}] ${r.headline.slice(0, 90)}`);
    for (const p of r.problems) log.info(`    problem: ${p}`);
    for (const w of r.warnings) log.info(`    note:    ${w}`);
  }
  const valid = file.questions.filter((_, i) => !reports[i]!.problems.length);
  const events = new Set(valid.map((e) => e.eventId));
  log.info(
    `Batch "${file.batch}"${file.fixture ? ' (DEV FIXTURES)' : ''}: ${file.questions.length} draft(s), ${valid.length} valid ` +
      `(${valid.filter((e) => e.origin === 'FLORIDA').length} Florida / ${valid.filter((e) => e.origin === 'GTA').length} GTA, ${events.size} event(s)), ${bad.length} with problems.`,
  );
  if (bad.length && !values['skip-invalid']) {
    log.error('Fix the problems above (or pass --skip-invalid to import only the valid drafts). Nothing was imported.');
    return 2;
  }
  if (values['dry-run']) {
    if (values.json) log.info(JSON.stringify({ reports }, null, 2));
    log.info('Dry run: nothing was sent.');
    return 0;
  }
  if (!valid.length) {
    log.error('No valid drafts to import.');
    return 2;
  }

  // 2. Import as candidates (writes only to the named environment)
  const workerUrl = values.to ?? env.INGESTION_API_URL;
  const token = env.INGESTION_IMPORT_TOKEN;
  if (!workerUrl || !token) {
    log.error('INGESTION_API_URL (or --to) and INGESTION_IMPORT_TOKEN are required (or pass --dry-run).');
    return 1;
  }
  const problem = targetProblem(target, workerUrl, values['allow-production']!);
  if (problem) {
    log.error(`Refused: ${problem}`);
    return 2;
  }
  const actor = (env.REVIEWER || userInfo().username).replace(/[^A-Za-z0-9 ._@-]/g, '').slice(0, 64) || 'admin';
  const client = (deps.createClient ?? ((o) => createWorkerClient(o)))({ baseUrl: workerUrl, token, actor });
  const stamp = now();
  const items = valid.map((e) => toImportItem(e, file, stamp));
  const runId = `bank-${file.batch.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40)}-${stamp.toISOString().replace(/\D/g, '').slice(0, 14)}`;
  let results: ImportItemResult[];
  try {
    results = await client.importItems(runId, items);
  } catch (error) {
    log.error(`Import failed: ${(error as Error).message}`);
    return 1;
  }
  const by = (o: string) => results.filter((r) => r.outcome === o);
  log.info(`Imported: ${by('inserted').length} new candidate(s), ${by('duplicate').length} already known, ${by('attached').length} attached, ${by('invalid').length} refused.`);
  for (const r of by('invalid')) log.info(`  refused ${r.incidentKey}: ${(r.errors ?? []).join('; ')}`);
  if (values.json) log.info(JSON.stringify({ reports, results }, null, 2));
  log.info(
    'Next: review each candidate (npm run admin -- candidates:list --state candidate), then approve with your verification, e.g.\n' +
      '  npm run admin -- questions:approve --id <q> --factual-summary --attest-human-written --attest-incident --attest-claims --attest-privacy \\\n' +
      '    --verified-date YYYY-MM-DD --verified-location "…" --evidence-url <https> [--game GTA_V | --location-verified --published-at … --publisher "…"]\n' +
      'and generate days with: npm run admin -- schedule --days 30 --dry-run',
  );
  return by('invalid').length ? 2 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
