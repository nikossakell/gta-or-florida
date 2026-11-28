/**
 * `npm run check:secrets` — refuses to build/deploy when the repository contains secrets or answer-bearing
 * content. Runs inside the Cloudflare builds (Workers Builds and Pages) and locally.
 *
 * Files: `git ls-files` when a Git checkout is available (so local, git-ignored files such as
 * apps/worker/.dev.vars are never scanned); otherwise a walk of the checked-out tree, because Cloudflare's
 * build environment does not guarantee a .git directory.
 *
 * Fails on:
 *  - assignments of our secret names to long values (the check the GitHub Actions CI used to run);
 *  - well-known credential shapes (private keys, GitHub / Cloudflare-style tokens, AWS keys);
 *  - committed local secret files (.env, .dev.vars);
 *  - committed question-bank content that exposes the answers (exports and research batches stay outside Git).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Finding = { file: string; line?: number; rule: string };

const SECRET_NAMES = 'INGESTION_IMPORT_TOKEN|ADMIN_TOKEN|CF_AI_API_TOKEN|CLOUDFLARE_API_TOKEN';
const CONTENT_RULES: { rule: string; re: RegExp; skipDocs?: boolean }[] = [
  // Same rule as the retired GitHub Actions CI (examples and docs may show the variable names).
  { rule: 'secret-assignment', re: new RegExp(`(${SECRET_NAMES})\\s*=\\s*[A-Za-z0-9_-]{24,}`), skipDocs: true },
  { rule: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { rule: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { rule: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'bearer-token-literal', re: /Authorization['"]?\s*[:=]\s*['"]Bearer [A-Za-z0-9._~+/-]{32,}['"]/ },
];

/** Local secret files that must never be committed (examples are fine). */
const SECRET_FILE = /(^|\/)(\.env(\.[^/]*)?|\.dev\.vars(\.[^/]*)?)$/;
const SECRET_FILE_ALLOWED = /\.example$/;
/** Answer-bearing question-bank content (exports, research batches, review state). Dev fixtures are allowed. */
const CONTENT_FILE = /(^|\/)(question-bank-(master|final)[^/]*\.json|pilot-\d{3}\.(bank|pending)\.json|review-(approved|investigate|rejected|history)[^/]*\.json|editorial-audit\.json)$|(^|\/)data\/bank\/(?!dev-fixtures\.json$)[^/]+\.json$|(^|\/)review-state\//;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-pages', '.wrangler', 'coverage', 'reports', 'backups']);
const DOC = /\.(md|example)$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|pdf|mp3|mp4|wasm)$/i;

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, join(dir, e.name), out);
    } else if (e.isFile()) out.push(relative(root, join(dir, e.name)).split(sep).join('/'));
  }
  return out;
}

/** Tracked files when Git is available, else the checked-out tree. */
export function listFiles(root: string): { files: string[]; source: 'git' | 'walk' } {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const files = out.split('\0').filter(Boolean);
    if (files.length) return { files, source: 'git' };
  } catch {
    /* no git or not a checkout: walk instead */
  }
  // Without Git we cannot read .gitignore: skip the local secret files that are always git-ignored here.
  return { files: walk(root).filter((f) => !SECRET_FILE.test(f) || SECRET_FILE_ALLOWED.test(f)), source: 'walk' };
}

export function scan(root: string, files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (SECRET_FILE.test(file) && !SECRET_FILE_ALLOWED.test(file)) findings.push({ file, rule: 'secret-file' });
    if (CONTENT_FILE.test(file)) findings.push({ file, rule: 'answer-bearing-content' });
    if (BINARY.test(file)) continue;
    let text: string;
    try {
      const p = resolve(root, file);
      if (statSync(p).size > 5 * 1024 * 1024) continue;
      text = readFileSync(p, 'utf8');
    } catch {
      continue; // deleted in the working tree, or unreadable
    }
    const lines = text.split('\n');
    for (const r of CONTENT_RULES) {
      if (r.skipDocs && DOC.test(file)) continue;
      const i = lines.findIndex((l) => r.re.test(l));
      if (i >= 0) findings.push({ file, line: i + 1, rule: r.rule });
    }
  }
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  const { files, source } = listFiles(root);
  const findings = scan(root, files);
  if (findings.length) {
    // Never print the matching text: only where and which rule.
    for (const f of findings) console.error(`error: ${f.file}${f.line ? `:${f.line}` : ''} — ${f.rule}`);
    console.error(`check:secrets failed: ${findings.length} finding(s). Remove the secret/content from the repository (and rotate any exposed secret).`);
    process.exit(1);
  }
  console.log(`check:secrets ok: ${files.length} files scanned (${source})`);
}
