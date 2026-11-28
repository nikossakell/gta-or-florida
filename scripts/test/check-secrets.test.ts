/** check:secrets — the secret/content gate that runs inside the Cloudflare builds. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listFiles, scan } from '../check-secrets.ts';

// Fake credentials are assembled at runtime so this file itself never matches the rules.
const fake = {
  assignment: ['ADMIN', '_TOKEN', '=', 'a'.repeat(40)].join(''),
  github: ['gh', 'p_', 'A'.repeat(36)].join(''),
  key: ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
};

let dir = '';
const tree = (files: Record<string, string>) => {
  dir = mkdtempSync(join(tmpdir(), 'gof-secrets-'));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return dir;
};
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('check:secrets', () => {
  it('passes a clean tree', () => {
    const root = tree({ 'src/a.ts': 'export const ADMIN_TOKEN_NAME = "ADMIN_TOKEN";\n', 'README.md': `example: ${fake.assignment}\n`, '.env.example': `${fake.assignment}\n` });
    expect(scan(root, listFiles(root).files)).toEqual([]);
  });

  it('flags secret assignments, credential shapes and the line they are on', () => {
    const root = tree({ 'src/config.ts': `const x = 1;\n${fake.assignment}\n`, 'scripts/key.txt': `${fake.key}\n`, 'apps/x.ts': `const t = "${fake.github}";\n` });
    expect(scan(root, listFiles(root).files).map((f) => `${f.file}:${f.line}:${f.rule}`).sort()).toEqual(['apps/x.ts:1:github-token', 'scripts/key.txt:1:private-key', 'src/config.ts:2:secret-assignment']);
  });

  it('flags committed local secret files and answer-bearing question-bank content, but not dev fixtures', () => {
    const files = ['apps/worker/.dev.vars', '.env', '.env.example', 'data/bank/2027-q1.json', 'data/bank/dev-fixtures.json', 'question-bank-final-2026-11-28.json', 'exports/review-approved.json', 'pilot-010.bank.json'];
    const root = tree(Object.fromEntries(files.map((f) => [f, '{}'])));
    expect(scan(root, files).map((f) => `${f.file}:${f.rule}`).sort()).toEqual([
      '.env:secret-file',
      'apps/worker/.dev.vars:secret-file',
      'data/bank/2027-q1.json:answer-bearing-content',
      'exports/review-approved.json:answer-bearing-content',
      'pilot-010.bank.json:answer-bearing-content',
      'question-bank-final-2026-11-28.json:answer-bearing-content',
    ]);
  });

  it('without Git, walks the tree and skips node_modules and git-ignored local secret files', () => {
    const root = tree({ 'node_modules/pkg/index.js': `${fake.github}\n`, 'apps/worker/.dev.vars': `${fake.assignment}\n`, 'src/ok.ts': 'export {};\n' });
    const { files, source } = listFiles(root);
    expect(source).toBe('walk');
    expect(files).toEqual(['src/ok.ts']);
  });
});
