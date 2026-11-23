/**
 * `npm run dev:seed` — LOCAL ONLY. Imports the development placeholder bank
 * (data/questions.approved.json, clearly-labelled sample content) into the local
 * D1 emulator through the running `wrangler dev` Worker, then schedules a week.
 *
 * The Worker refuses fixture imports in any environment except APP_ENV=local,
 * and never serves fixtures elsewhere. Fixture URLs use the reserved .invalid TLD.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ImportItem, QuestionBankFile } from '@gof/core';
import { createWorkerClient } from '../apps/ingest/src/import.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DEV_VARS = resolve(ROOT, 'apps/worker/.dev.vars');

/** Create apps/worker/.dev.vars with random local-only tokens if it doesn't exist. */
export function ensureDevVars(): Record<string, string> {
  if (!existsSync(DEV_VARS)) {
    const t = () => randomBytes(32).toString('hex');
    writeFileSync(DEV_VARS, `# Local-only secrets for \`wrangler dev\` (git-ignored). Never reuse in staging/production.\nINGESTION_IMPORT_TOKEN=${t()}\nADMIN_TOKEN=${t()}\n`, { mode: 0o600 });
    console.log(`Created ${DEV_VARS} (local-only tokens).`);
  }
  return Object.fromEntries(
    readFileSync(DEV_VARS, 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

export function fixtureItems(bank: QuestionBankFile): ImportItem[] {
  return bank.questions
    .filter((q) => q.status === 'verified')
    .map((q) => {
      const url = `https://fixture.invalid/${encodeURIComponent(q.id)}`;
      return {
        kind: q.answer === 'florida' ? 'FLORIDA_NEWS' : 'GTA_CANON',
        incidentKey: `fixture:${q.id}`,
        reference: {
          provider: 'fixture',
          providerKey: q.id,
          originalUrl: url,
          canonicalUrl: url,
          originalTitle: q.headline,
          publisher: null,
          publishedAt: null,
          providerSeenAt: null,
          wikiPageId: null,
          wikiSection: null,
          contentDigest: createHash('sha256').update(q.id + q.headline).digest('hex').slice(0, 32),
          linkCheck: null,
        },
        incident: { category: q.category, gameDetected: null, floridaSignal: 'none', floridaEvidence: null, possibleDuplicateOfKey: null, similarity: null, notes: 'Development placeholder (not a real event).' },
        question: { playTitleDraft: q.headline.slice(0, 240), explanationDraft: q.explanation.slice(0, 800), difficulty: q.difficulty },
        ai: null,
        prefilter: { decision: 'candidate', reasonCodes: [] },
        fixture: true,
      } satisfies ImportItem;
    });
}

async function main() {
  const vars = ensureDevVars();
  if (process.argv.includes('--vars-only')) return;
  const base = process.env.LOCAL_WORKER_URL ?? 'http://127.0.0.1:8787';
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('dev:seed only targets a local wrangler dev Worker');
  const bank = JSON.parse(readFileSync(resolve(ROOT, 'data/questions.approved.json'), 'utf8')) as QuestionBankFile;
  const items = fixtureItems(bank);
  const client = createWorkerClient({ baseUrl: base, token: vars.INGESTION_IMPORT_TOKEN!, maxRetries: 1 });
  const results = await client.importItems('dev-seed', items);
  const tally: Record<string, number> = {};
  for (const r of results) tally[`${r.outcome}${r.questionState ? `:${r.questionState}` : ''}`] = (tally[`${r.outcome}${r.questionState ? `:${r.questionState}` : ''}`] ?? 0) + 1;
  console.log(`Imported ${items.length} placeholder items: ${JSON.stringify(tally)}`);
  const s = await client.schedule(7);
  console.log(`Scheduled ${s.added.length} new day(s); kept ${s.kept.length}. Open http://localhost:5173`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
