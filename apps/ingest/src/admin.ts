/**
 * Owner CLI for editorial review over the Worker's admin API (bearer ADMIN_TOKEN).
 *
 *   npm run admin -- <command> [options]
 *
 * Env: ADMIN_API_URL (or INGESTION_API_URL), ADMIN_TOKEN, REVIEWER (audit name).
 * `questions:approve` runs an SSRF-safe link check from this machine first.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { userInfo } from 'node:os';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { POLICY_VERSION } from '@gof/config';
import { createWorkerClient, WorkerApiError } from './import.ts';
import { checkLink, toLinkCheck } from './verify.ts';

const OPTIONS: ParseArgsConfig['options'] = {
  id: { type: 'string' },
  kind: { type: 'string' },
  state: { type: 'string' },
  decision: { type: 'string' },
  limit: { type: 'string' },
  offset: { type: 'string' },
  'play-title': { type: 'string' },
  explanation: { type: 'string' },
  category: { type: 'string' },
  difficulty: { type: 'string' },
  game: { type: 'string' },
  'location-verified': { type: 'boolean' },
  'published-at': { type: 'string' },
  publisher: { type: 'string' },
  'not-duplicate': { type: 'boolean' },
  'link-verified-manually': { type: 'boolean' },
  'factual-summary': { type: 'boolean' },
  'verified-date': { type: 'string' },
  'verified-location': { type: 'string' },
  'evidence-url': { type: 'string', multiple: true },
  'attest-human-written': { type: 'boolean' },
  'attest-incident': { type: 'boolean' },
  'attest-claims': { type: 'boolean' },
  'attest-privacy': { type: 'boolean' },
  'verification-notes': { type: 'string' },
  reason: { type: 'string' },
  message: { type: 'string' },
  question: { type: 'string' },
  day: { type: 'string' },
  into: { type: 'string' },
  days: { type: 'string' },
  start: { type: 'string' },
  'dry-run': { type: 'boolean' },
  labels: { type: 'string' },
  record: { type: 'boolean' },
  json: { type: 'boolean' },
};

const HELP = `Admin commands (talk to the Worker's protected API):
  stats
  candidates:list   [--kind FLORIDA_NEWS|GTA_CANON] [--state candidate|approved|rejected|retired] [--decision auto_approve|review|reject] [--limit 30]
  candidates:show   --id <question|incident id|incident key>
  questions:approve --id <q> --play-title "…" --explanation "…" [--game GTA_III] [--location-verified --published-at YYYY-MM-DD --publisher "…"]
                    [--category weird] [--difficulty 2] [--not-duplicate] [--link-verified-manually]
                    Independent Factual Summary (your own words about verified facts; no reuse of the source's wording):
                    --factual-summary --verified-date YYYY-MM-DD --verified-location "Pace, Florida" --evidence-url <https> [--evidence-url …]
                    --attest-human-written --attest-incident --attest-claims --attest-privacy [--verification-notes "…"]
  questions:edit    --id <q> [--play-title "…"] [--explanation "…"]
  questions:reject  --id <q> --reason "…"
  questions:revoke  --id <q> --reason "…"   approved but never scheduled → back to candidate; then questions:approve again
                    with new text (+ fresh --factual-summary attestations). Scheduled questions: use withdraw.
  withdraw          (--question <q> | --day YYYY-MM-DD) --reason "…" [--message "public text"]
  incidents:merge   --id <incident> --into <incident> --reason "…"
  incidents:unmerge --id <incident> --reason "…"
  schedule          [--days 30] [--start YYYY-MM-DD] [--dry-run]
  sources:sync      copy packages/config/sources.policy.json (as deployed) into D1
  benchmark         --labels labels.json [--record]   (labels: [{"questionId":"…","label":"approve"|"reject"}])`;

function print(value: unknown, asJson: boolean) {
  if (asJson || typeof value !== 'object' || value === null) return console.log(JSON.stringify(value, null, 2));
  console.log(JSON.stringify(value, null, 2));
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return 0;
  }
  const { values: v } = parseArgs({ args: rest, options: OPTIONS, strict: true });
  const vals = v as Record<string, string | boolean | undefined>;
  const str = (k: string) => vals[k] as string | undefined;
  const flag = (k: string) => vals[k] === true;
  const url = process.env.ADMIN_API_URL ?? process.env.INGESTION_API_URL;
  const token = process.env.ADMIN_TOKEN;
  if (!url || !token) throw new Error('Set ADMIN_API_URL (or INGESTION_API_URL) and ADMIN_TOKEN.');
  const actor = (process.env.REVIEWER || userInfo().username).replace(/[^A-Za-z0-9 ._@-]/g, '').slice(0, 64) || 'admin';
  const api = createWorkerClient({ baseUrl: url, token, actor });
  const need = (k: string) => {
    const val = str(k);
    if (!val) throw new Error(`--${k} is required`);
    return val;
  };
  const json = flag('json');

  switch (command) {
    case 'stats':
      print(await api.stats(), json);
      return 0;
    case 'candidates:list': {
      const r = await api.candidates({ kind: str('kind'), state: str('state'), decision: str('decision'), limit: Number(str('limit') ?? 30), offset: Number(str('offset') ?? 0) });
      if (json) print(r, true);
      else
        for (const c of r.items) {
          console.log(`${c.question_id}  ${c.kind}  [${c.quality_state}${c.gate_decision ? ` / gate:${c.gate_decision}` : ''}]  source:${c.source_id} (${c.license_status})`);
          console.log(`    original: ${c.original_title}`);
          console.log(`    draft:    ${c.play_title}`);
          console.log(`    ${c.original_url}`);
        }
      return 0;
    }
    case 'candidates:show':
      print(await api.candidate(need('id')), true);
      return 0;
    case 'questions:approve': {
      const id = need('id');
      let linkCheck;
      if (!flag('link-verified-manually')) {
        const c = (await api.candidate(id)) as { original_url: string };
        console.log(`Checking ${c.original_url} …`);
        linkCheck = toLinkCheck(await checkLink(c.original_url));
        console.log(`  → ${linkCheck.status}${linkCheck.httpStatus ? ` (HTTP ${linkCheck.httpStatus})` : ''}${linkCheck.note ? ` ${linkCheck.note}` : ''}`);
      }
      try {
        const r = await api.review({
          questionId: id,
          action: 'approve',
          ...(str('play-title') !== undefined ? { playTitle: str('play-title') } : {}),
          ...(str('explanation') !== undefined ? { explanation: str('explanation') } : {}),
          ...(str('category') ? { category: str('category') as never } : {}),
          ...(str('difficulty') ? { difficulty: Number(str('difficulty')) } : {}),
          ...(str('game') ? { game: str('game') as never } : {}),
          ...(flag('location-verified') ? { locationVerified: true } : {}),
          ...(str('published-at') ? { publishedAt: str('published-at') } : {}),
          ...(str('publisher') ? { publisher: str('publisher') } : {}),
          ...(flag('not-duplicate') ? { notDuplicate: true } : {}),
          ...(flag('link-verified-manually') ? { linkVerifiedManually: true } : {}),
          ...(linkCheck ? { linkCheck } : {}),
          ...(flag('factual-summary')
            ? {
                mode: 'factual_summary' as const,
                factual: {
                  humanWritten: flag('attest-human-written'),
                  incidentVerified: flag('attest-incident'),
                  claimsVerified: flag('attest-claims'),
                  privacyChecked: flag('attest-privacy'),
                  verifiedDate: need('verified-date'),
                  verifiedLocation: need('verified-location'),
                  evidenceUrls: (vals['evidence-url'] as unknown as string[] | undefined) ?? [],
                  ...(str('verification-notes') ? { notes: str('verification-notes') } : {}),
                },
              }
            : {}),
        });
        console.log(`Approved ${r.questionId}.`);
        return 0;
      } catch (error) {
        if (error instanceof WorkerApiError && Array.isArray(error.details)) {
          console.error('Approval refused:');
          for (const e of error.details as string[]) console.error(`  - ${e}`);
          return 2;
        }
        throw error;
      }
    }
    case 'questions:edit':
      print(await api.review({ questionId: need('id'), action: 'edit', playTitle: str('play-title'), explanation: str('explanation') }), json);
      return 0;
    case 'questions:reject':
      print(await api.review({ questionId: need('id'), action: 'reject', reason: need('reason') }), json);
      return 0;
    case 'questions:revoke': {
      try {
        const r = await api.review({ questionId: need('id'), action: 'revoke', reason: need('reason') });
        console.log(`Approval of ${r.questionId} revoked; it is a candidate again. Re-approve it with new text and fresh attestations.`);
        return 0;
      } catch (error) {
        if (error instanceof WorkerApiError && Array.isArray(error.details)) {
          console.error('Revoke refused:');
          for (const e of error.details as string[]) console.error(`  - ${e}`);
          return 2;
        }
        throw error;
      }
    }
    case 'withdraw': {
      const target = str('question') ? 'question' : str('day') ? 'day' : null;
      if (!target) throw new Error('--question <id> or --day YYYY-MM-DD is required');
      print(await api.withdraw({ target, id: (str('question') ?? str('day'))!, reason: need('reason'), ...(str('message') ? { publicMessage: str('message') } : {}) }), json);
      return 0;
    }
    case 'incidents:merge':
      print(await api.merge({ action: 'merge', incidentId: need('id'), intoIncidentId: need('into'), reason: need('reason') }), json);
      return 0;
    case 'incidents:unmerge':
      print(await api.merge({ action: 'unmerge', incidentId: need('id'), reason: need('reason') }), json);
      return 0;
    case 'schedule': {
      const r = await api.schedule(Number(str('days') ?? 30), { ...(str('start') ? { startDate: str('start') } : {}), ...(flag('dry-run') ? { dryRun: true } : {}) });
      print(r, json);
      return r.shortageDate || r.warnings.length ? 2 : 0;
    }
    case 'sources:sync':
      print(await api.syncSources(), json);
      return 0;
    case 'benchmark': {
      const labels = JSON.parse(readFileSync(need('labels'), 'utf8')) as { questionId: string; label: 'approve' | 'reject' }[];
      if (!Array.isArray(labels) || labels.length === 0) throw new Error('labels file must be a non-empty JSON array');
      let wouldApprove = 0;
      let falseApprovals = 0;
      for (const l of labels) {
        const c = (await api.candidate(l.questionId)) as { gate_decision: string | null };
        if (c.gate_decision === 'auto_approve') {
          wouldApprove++;
          if (l.label === 'reject') falseApprovals++;
        }
      }
      const falseApprovalRate = wouldApprove === 0 ? 1 : falseApprovals / wouldApprove;
      const result = { policyVersion: POLICY_VERSION, sampleSize: labels.length, wouldApprove, falseApprovals, falseApprovalRate, measuredAt: new Date().toISOString() };
      print(result, true);
      if (flag('record')) {
        print(await api.recordBenchmark({ policyVersion: POLICY_VERSION, sampleSize: labels.length, falseApprovalRate, measuredAt: result.measuredAt, notes: `${falseApprovals}/${wouldApprove} false approvals` }), true);
      }
      return 0;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

// pathToFileURL: a plain `file://${argv[1]}` never matches on Windows (backslashes, drive letter).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof WorkerApiError ? `${error.code}: ${error.message}` : (error as Error).message);
      process.exit(1);
    },
  );
}
