import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImportItem } from '@gof/core';
import type { ArticleResponse } from '../src/adapters/article.ts';
import { createWorkerClient } from '../src/import.ts';
import { main } from '../src/ingest-official.ts';
import { FLAGLER_RELEASE, FLAGLER_URL, FWC_BULLETIN, FWC_URL } from './official-fixtures.ts';

const STAGING = 'https://gta-florida-api-staging.example.workers.dev';
const TOKEN = 'test-service-token-0123456789abcdef01234567';
const html = (body: string): ArticleResponse => ({ status: 200, contentType: 'text/html; charset=utf-8', body });

function fakeWorker(o: { checkpoints?: Record<string, string>; knownKeys?: string[]; failImport?: boolean } = {}) {
  const imports: { items: ImportItem[]; run?: { provider: string; status: string }; checkpoints?: { key: string }[] }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/api/v1/admin/titles') return reply(200, { items: [], nextCursor: null });
    if (u.pathname === '/api/v1/admin/checkpoints') return reply(200, { provider: u.searchParams.get('provider'), checkpoints: Object.entries(o.checkpoints ?? {}).map(([key, value]) => ({ key, value })) });
    if (u.pathname === '/api/v1/admin/known') return reply(200, { canonicalUrls: [], providerKeys: (o.knownKeys ?? []).filter((k) => body.providerKeys.includes(k)) });
    if (u.pathname === '/api/v1/admin/import') {
      if (o.failImport) return reply(400, { error: { code: 'VALIDATION_FAILED', message: 'nope' } });
      imports.push(body);
      return reply(200, { replayed: false, results: body.items.map((i: ImportItem) => ({ incidentKey: i.incidentKey, outcome: 'inserted', questionState: 'candidate' })) });
    }
    return reply(404, { error: { code: 'NOT_FOUND', message: u.pathname } });
  }) as typeof fetch;
  return { imports, createClient: (opts: { baseUrl: string; token: string; actor: string }) => createWorkerClient({ ...opts, fetchImpl, sleep: async () => {} }) };
}

function harness(o: { pages?: Record<string, ArticleResponse | ArticleResponse[]>; worker?: ReturnType<typeof fakeWorker> | null } = {}) {
  const lines: string[] = [];
  const requested: string[] = [];
  const sleeps: number[] = [];
  const queues = new Map(Object.entries(o.pages ?? { [FWC_URL]: html(FWC_BULLETIN), [FLAGLER_URL]: html(FLAGLER_RELEASE) }).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const worker = o.worker === undefined ? fakeWorker() : o.worker;
  return {
    lines,
    requested,
    sleeps,
    worker,
    deps: {
      log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`), error: (m: string) => lines.push(`ERROR ${m}`) },
      env: (worker ? { INGESTION_API_URL: STAGING, INGESTION_IMPORT_TOKEN: TOKEN, REVIEWER: 'owner' } : {}) as Record<string, string | undefined>,
      now: () => new Date('2026-11-24T10:00:00Z'),
      sleep: async (ms: number) => void sleeps.push(ms),
      requestImpl: async (url: URL) => {
        requested.push(url.href);
        const q = queues.get(url.href);
        if (!q?.length) return { status: 404 };
        return q.length > 1 ? q.shift()! : q[0]!;
      },
      ...(worker ? { createClient: worker.createClient } : {}),
    },
  };
}
const totals = (lines: string[]) => JSON.parse(lines.find((l) => l.startsWith('Totals: '))!.slice(8)) as Record<string, unknown>;

describe('ingest:official (supervised pilot)', () => {
  it('dry run: evaluates one FWC report and one Flagler release, imports nothing, reports measured totals', async () => {
    const h = harness({ worker: null });
    expect(await main(['--url', FWC_URL, '--url', FLAGLER_URL, '--dry-run'], h.deps)).toBe(0);
    expect(totals(h.lines)).toMatchObject({
      documentsProcessed: 2,
      incidentsExtracted: 6,
      rejected: 3,
      toReview: 3,
      safetyReview: 1,
      eligibleForPublication: 0,
      sourcesBlockingPublication: ['publisher:myfwc.com', 'publisher:flaglersheriff.com'],
      cost: { aiRequests: 0, neurons: 0 },
    });
    expect(h.lines.join('\n')).toMatch(/title: +Wildlife Officers Check a Cooler of Wet Towels and Find a Small Live Alligator/);
    expect(h.lines.join('\n')).toMatch(/publishSummary has not been cleared.*stay in review/);
    expect(h.lines.join('\n')).not.toMatch(/Jordan|Testcase|Daytona/);
  });

  it('imports review candidates only (rejections are counted, not stored) and check-points each document', async () => {
    const h = harness();
    expect(await main(['--url', FWC_URL, '--url', FLAGLER_URL], h.deps)).toBe(0);
    const items = h.worker!.imports.flatMap((b) => b.items);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.reference.provider === 'official_report' && i.facts && i.ai === null)).toBe(true);
    expect(items.map((i) => i.prefilter.decision)).toEqual(['candidate', 'candidate', 'candidate']);
    const cps = h.worker!.imports.flatMap((b) => b.checkpoints ?? []).map((c) => c.key);
    expect(cps).toEqual(['doc:FLFFWCC/3a1b2c3', 'doc:flaglersheriff/gorilla-masked-man-arrested-after-store-robbery']);
    expect(h.worker!.imports.at(-1)!.run).toMatchObject({ provider: 'official_report', status: 'ok' });
  });

  it('is idempotent: check-pointed documents are skipped; known incidents are not re-sent', async () => {
    const skip = harness({ worker: fakeWorker({ checkpoints: { 'doc:FLFFWCC/3a1b2c3': '{}' } }) });
    expect(await main(['--url', FWC_URL], skip.deps)).toBe(0);
    expect(skip.requested).toEqual([]);
    expect(skip.lines.join('\n')).toMatch(/SKIPPED_CHECKPOINT/);

    const first = harness();
    await main(['--url', FWC_URL, '--dry-run', '--json'], first.deps);
    const report = JSON.parse(first.lines.find((l) => l.startsWith('{'))!);
    const keys = report.documents[0].incidents.filter((i: { decision: string }) => i.decision !== 'reject').map((i: { providerKey: string }) => i.providerKey);
    const again = harness({ worker: fakeWorker({ knownKeys: keys }) });
    expect(await main(['--url', FWC_URL, '--force'], again.deps)).toBe(0);
    expect(again.worker!.imports.flatMap((b) => b.items)).toHaveLength(0);
    expect(totals(again.lines)).toMatchObject({ alreadyKnown: 2, newForImport: 0 });
  });

  it('backs off on 429/5xx (honouring Retry-After) and stops at once on 401/403 for that source', async () => {
    const retry = harness({ worker: null, pages: { [FWC_URL]: [{ status: 429, retryAfter: '7' }, { status: 503 }, html(FWC_BULLETIN)] } });
    expect(await main(['--url', FWC_URL, '--dry-run'], retry.deps)).toBe(0);
    expect(retry.requested).toHaveLength(3);
    expect(retry.sleeps).toEqual([7000, 8000]);

    const other = 'https://content.govdelivery.com/accounts/FLFFWCC/bulletins/3ffffff';
    const denied = harness({ worker: null, pages: { [FWC_URL]: { status: 403 }, [other]: html(FWC_BULLETIN) } });
    expect(await main(['--url', FWC_URL, '--url', other, '--dry-run'], denied.deps)).toBe(2);
    expect(denied.requested).toEqual([FWC_URL]); // never retried, and the same source is not tried again
    expect(denied.lines.join('\n')).toMatch(/ACCESS_DENIED: HTTP 403[\s\S]*SOURCE_REFUSED_AUTOMATION/);
  });

  it('refuses blocked, unregistered and non-adapter URLs before any request', async () => {
    const h = harness({ worker: null });
    const code = await main(
      ['--dry-run', '--url', 'https://www.theonion.com/florida-man-1', '--url', 'https://content.govdelivery.com/accounts/OTHER/bulletins/1', '--url', 'https://flaglersheriff.com/contact-us/records/'],
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.requested).toEqual([]);
    const out = h.lines.join('\n');
    expect(out).toMatch(/theonion[\s\S]*(blocked|URL_REFUSED)/);
    expect(out).toMatch(/NO_OFFICIAL_ADAPTER/);
  });

  it('a failed import is reported as a failure and leaves no checkpoint behind', async () => {
    const h = harness({ worker: fakeWorker({ failImport: true }) });
    expect(await main(['--url', FWC_URL], h.deps)).toBe(1);
    expect(h.lines.join('\n')).toMatch(/errors: FLFFWCC\/3a1b2c3: VALIDATION_FAILED/);
  });

  it('resumes an explicit URL list from a local state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gof-official-'));
    const list = join(dir, 'urls.txt');
    const state = join(dir, 'state.json');
    writeFileSync(list, `# owner-approved list\n${FWC_URL}\n${FLAGLER_URL}\n`);
    const first = harness();
    expect(await main(['--urls-file', list, '--state', state], first.deps)).toBe(0);
    expect(Object.values(JSON.parse(readFileSync(state, 'utf8')).docs).map((d) => (d as { status: string }).status)).toEqual(['imported', 'imported']);
    const second = harness();
    expect(await main(['--urls-file', list, '--state', state], second.deps)).toBe(0);
    expect(second.requested).toEqual([]);
  });

  it('refuses to write anywhere but the named environment', async () => {
    const h = harness();
    h.deps.env = { INGESTION_API_URL: 'https://gta-florida-api.example.workers.dev', INGESTION_IMPORT_TOKEN: TOKEN };
    expect(await main(['--url', FWC_URL], h.deps)).toBe(2);
    expect(h.requested).toEqual([]);
  });
});
