/**
 * CLI entry guards must work on Windows. `import.meta.url === \`file://${process.argv[1]}\``
 * never matches there (file:///C:/… vs file://C:\…), so `npm run admin`, `ingest:batch`,
 * `legacy:*` and `dev:seed` silently did nothing and exited 0.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLIS = ['apps/ingest/src/admin.ts', 'apps/ingest/src/run.ts', 'apps/ingest/src/legacy.ts', 'scripts/seed-local.ts'];

describe('CLI entry guards', () => {
  it.each(CLIS)('%s compares against pathToFileURL(argv[1])', (file) => {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    expect(src).not.toMatch(/import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/);
    expect(src).toContain('import.meta.url === pathToFileURL(process.argv[1]).href');
  });

  it('pathToFileURL matches the module URL form for Windows and POSIX paths', () => {
    if (process.platform === 'win32') expect(pathToFileURL('C:\\code\\x\\admin.ts').href).toBe('file:///C:/code/x/admin.ts');
    else expect(pathToFileURL('/home/runner/work/apps/ingest/src/admin.ts').href).toBe('file:///home/runner/work/apps/ingest/src/admin.ts');
  });
});
