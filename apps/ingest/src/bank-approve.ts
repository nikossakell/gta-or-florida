/**
 * `npm run bank:approve -- --file <approved-export.json> --env staging [--dry-run]`
 *
 * Approves, in the Worker, the curated questions the owner approved in the local editorial review
 * dashboard (its "Approved" export). Owner decision (2026-11-28): these AI-assisted drafts, whose facts
 * were verified against their sources during research and whose wording the owner reviewed and approved
 * unchanged, are approved as reviewed drafts — textOrigin `machine_draft_reviewed`, humanWritten false —
 * never as text written by the reviewer.
 *
 * Every question must first be imported with `npm run bank:import` (same file). For each one this command:
 *   - requires the dashboard's approval record in `notes` (no record → not approved here);
 *   - finds the candidate by its bank key and checks its stored text is exactly the reviewed text;
 *   - runs a fresh, SSRF-safe link check from this machine (or --link-verified-manually);
 *   - calls the normal /review approval (factual_summary): every Worker check still applies.
 * Re-running is safe: already approved questions are skipped.
 *
 * Env: ADMIN_API_URL (or INGESTION_API_URL / --to), ADMIN_TOKEN, REVIEWER (audit name).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { cleanText, type LinkCheck } from '@gof/core';
import { approvalRequest, DASHBOARD_DECISION as DECISION } from './bank-approval.ts';
import { entryKey, parseBankFile, validateBank, type BankEntry } from './bank.ts';
import { loadSourcesConfig } from './config-file.ts';
import { createWorkerClient, WorkerApiError, type WorkerClient } from './import.ts';
import { targetProblem, TARGET_ENVS, type TargetEnv } from './ingest-url.ts';
import type { SourcesConfig } from './normalize.ts';
import { REPO_ROOT } from './paths.ts';
import { checkLink, toLinkCheck } from './verify.ts';

const HELP = `Approve the questions the owner approved in the editorial review dashboard (its "Approved" export).

  npm run bank:approve -- --file <approved-export.json> [--env staging|local|production] [--dry-run]

  --file <path>              the dashboard's Approved export (question-bank schema); import it first with bank:import
  --env <name>               target Worker (default staging); must match the Worker URL
  --to <url>                 Worker URL (default ADMIN_API_URL or INGESTION_API_URL)
  --dry-run                  offline checks only; no network
  --link-verified-manually   skip the live link check (you opened every source yourself)
  --delay-ms <n>             pause between link checks to the same host (default 2000)
  --allow-production         required together with --env production

Exit codes: 0 ok · 1 error · 2 some questions were refused or are missing.`;

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
export type BankApproveDeps = {
  log?: Log;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  cfg?: SourcesConfig;
  readFile?: (path: string) => string;
  createClient?: (opts: { baseUrl: string; token: string; actor: string }) => WorkerClient;
  linkCheck?: (url: string) => Promise<LinkCheck>;
  sleep?: (ms: number) => Promise<void>;
};

const defaultLog: Log = { info: (m) => console.log(m), warn: (m) => console.warn(`WARN ${m}`), error: (m) => console.error(`ERROR ${m}`) };

export async function main(argv = process.argv.slice(2), deps: BankApproveDeps = {}): Promise<number> {
  const log = deps.log ?? defaultLog;
  const env = deps.env ?? process.env;
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      file: { type: 'string' },
      env: { type: 'string', default: 'staging' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'link-verified-manually': { type: 'boolean', default: false },
      'delay-ms': { type: 'string', default: '2000' },
      'allow-production': { type: 'boolean', default: false },
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
  const delayMs = Number(values['delay-ms']);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    log.error('--delay-ms must be 0-60000');
    return 2;
  }

  // 1. Offline: the file is a valid batch, and every question carries the dashboard's approval record.
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
  if (file.fixture) {
    log.error('Refused: fixture batches are never approved as real questions.');
    return 2;
  }
  const cfg = deps.cfg ?? loadSourcesConfig(resolve(REPO_ROOT, 'data'));
  const bad = validateBank(file, cfg).filter((r) => r.problems.length);
  const noRecord = file.questions.filter((e) => !DECISION.test(e.notes ?? ''));
  for (const r of bad) log.error(`${r.eventId}: ${r.problems.join('; ')}`);
  for (const e of noRecord) log.error(`${e.eventId}: no approval record from the review dashboard in notes; it is not approved here`);
  if (bad.length || noRecord.length) {
    log.error('Nothing was approved. Use the dashboard\'s "Approved" export, unchanged.');
    return 2;
  }
  log.info(`${file.questions.length} reviewed question(s) (${file.questions.filter((e) => e.origin === 'FLORIDA').length} Florida / ${file.questions.filter((e) => e.origin === 'GTA').length} GTA), each with a dashboard approval record.`);
  if (values['dry-run']) {
    log.info('Dry run: nothing was sent.');
    return 0;
  }

  // 2. Online: approve through the Worker's normal review route.
  const workerUrl = values.to ?? env.ADMIN_API_URL ?? env.INGESTION_API_URL;
  const token = env.ADMIN_TOKEN;
  if (!workerUrl || !token) {
    log.error('ADMIN_API_URL (or INGESTION_API_URL / --to) and ADMIN_TOKEN are required (or pass --dry-run).');
    return 1;
  }
  const problem = targetProblem(target, workerUrl, values['allow-production']!);
  if (problem) {
    log.error(`Refused: ${problem}`);
    return 2;
  }
  const actor = (env.REVIEWER || userInfo().username).replace(/[^A-Za-z0-9 ._@-]/g, '').slice(0, 64) || 'admin';
  const api = (deps.createClient ?? ((o) => createWorkerClient(o)))({ baseUrl: workerUrl, token, actor });
  const linkCheck = deps.linkCheck ?? (async (u: string) => toLinkCheck(await checkLink(u)));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lastHit = new Map<string, number>();

  const tally = { approved: 0, already: 0, missing: 0, refused: 0 };
  for (const [n, e] of file.questions.entries()) {
    const tag = `[${n + 1}/${file.questions.length}] ${e.eventId}`;
    const decision = DECISION.exec(e.notes!)!;
    let c: { question_id: string; quality_state: string; play_title: string; explanation: string };
    try {
      c = (await api.candidate(`bank:${entryKey(e)}`)) as typeof c;
    } catch (error) {
      if (error instanceof WorkerApiError && error.status === 404) {
        tally.missing++;
        log.warn(`${tag}: not in the Worker; run bank:import with this file first`);
        continue;
      }
      throw error;
    }
    if (c.quality_state === 'approved') {
      tally.already++;
      continue;
    }
    if (c.quality_state !== 'candidate') {
      tally.refused++;
      log.warn(`${tag}: question is ${c.quality_state}; not approved`);
      continue;
    }
    if (c.play_title !== cleanText(e.headline, 240) || c.explanation !== cleanText(e.explanation, 800)) {
      tally.refused++;
      log.warn(`${tag}: the Worker's stored text differs from the reviewed text; not approved`);
      continue;
    }
    let link: { check?: LinkCheck; manual?: boolean } = { manual: true };
    if (!values['link-verified-manually']) {
      const host = new URL(e.sourceUrl).hostname;
      const wait = (lastHit.get(host) ?? 0) + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastHit.set(host, Date.now());
      link = { check: await linkCheck(e.sourceUrl) };
      if (link.check!.status !== 'ok') {
        tally.refused++;
        log.warn(`${tag}: link check ${link.check!.status}${link.check!.httpStatus ? ` (HTTP ${link.check!.httpStatus})` : ''}; open it yourself and re-run with --link-verified-manually`);
        continue;
      }
    }
    try {
      await api.review(approvalRequest(e, c.question_id, { reviewer: decision[1]!, at: decision[2]! }, link));
      tally.approved++;
      log.info(`${tag}: approved`);
    } catch (error) {
      if (error instanceof WorkerApiError && Array.isArray(error.details)) {
        tally.refused++;
        log.warn(`${tag}: refused by the Worker:\n    - ${(error.details as string[]).join('\n    - ')}`);
        continue;
      }
      throw error;
    }
  }
  log.info(`Approved ${tally.approved}, already approved ${tally.already}, not imported ${tally.missing}, refused ${tally.refused}.`);
  if (tally.approved) log.info('Next: npm run admin -- schedule --days 30 --dry-run, then without --dry-run.');
  return tally.missing || tally.refused ? 2 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof WorkerApiError ? `${error.code}: ${error.message}` : (error as Error).message);
      process.exit(1);
    },
  );
}
