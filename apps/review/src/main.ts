/**
 * `npm run review` — local editorial review dashboard for the curated question bank.
 *
 * Env (all optional):
 *   REVIEW_MASTER     master batch (default ~/Desktop/personal/gta_or_florida/question-bank-master.json); read only
 *   REVIEW_AUDIT      editorial audit suggestions (default: editorial-audit.json next to the master)
 *   REVIEW_STATE_DIR  persisted local D1 + review state (default: review-state/ next to the master)
 *   REVIEW_PORT       default 4317 (always bound to 127.0.0.1)
 *   REVIEWER          name recorded in the audit trail (default: your OS user name)
 *
 * Never connects to staging or production: the Worker runs in-process on a local D1 emulator.
 */
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { ReviewError, ReviewService } from './service.ts';
import { startServer } from './server.ts';

export function resolvePaths(env: Record<string, string | undefined> = process.env) {
  const master = resolve(env.REVIEW_MASTER ?? resolve(homedir(), 'Desktop/personal/gta_or_florida/question-bank-master.json'));
  const dir = dirname(master);
  return {
    master,
    audit: resolve(env.REVIEW_AUDIT ?? resolve(dir, 'editorial-audit.json')),
    state: resolve(env.REVIEW_STATE_DIR ?? resolve(dir, 'review-state')),
    port: Number(env.REVIEW_PORT ?? 4317),
  };
}

async function main() {
  const p = resolvePaths();
  if (!existsSync(p.master)) throw new Error(`Master file not found: ${p.master} (set REVIEW_MASTER).`);
  if (!Number.isInteger(p.port) || p.port < 1024 || p.port > 65535) throw new Error('REVIEW_PORT must be 1024-65535.');
  const reviewer = process.env.REVIEWER || userInfo().username;
  console.log(`Master (read only): ${p.master}`);
  console.log(`Review state:       ${p.state}`);
  console.log(`Audit suggestions:  ${existsSync(p.audit) ? p.audit : '(none found)'}`);
  const service = await ReviewService.open({ masterPath: p.master, auditPath: existsSync(p.audit) ? p.audit : undefined, persistDir: p.state, reviewer });
  const s = await service.summary();
  if (s.master.changedSinceImport) console.warn(`WARNING: ${s.master.changedEntries.length} question(s) changed in the master after they were imported for review (${s.master.changedEntries.slice(0, 5).join(', ')}${s.master.changedEntries.length > 5 ? ', …' : ''}). The dashboard keeps reviewing the imported version of those.`);
  const srv = await startServer(service, { port: p.port, log: (m) => console.error(m) });
  console.log(`\nEditorial review dashboard for ${s.total} questions (${s.approved} approved, ${s.unreviewed} unreviewed). Reviewer: ${service.reviewer}`);
  console.log(`Open ${srv.url}  (local only; Ctrl+C to stop)`);
  const stop = async () => {
    await srv.close();
    await service.dispose();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error instanceof ReviewError ? `${error.message}${error.details.length ? `\n  - ${error.details.slice(0, 20).join('\n  - ')}` : ''}` : (error as Error).message);
  process.exit(1);
});
