import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImportItem, SourcePolicy } from '@gof/core';
import { createMockAiProvider } from '@gof/ingest/classify.ts';
import { loadSourcesConfig } from '@gof/ingest/config-file.ts';
import { createWorkerClient } from '@gof/ingest/import.ts';
import { REPO_ROOT } from '@gof/ingest/paths.ts';
import { runIngestion, type IngestDeps, type IngestParams, type StepConfig, type StepLike } from '../src/ingest.ts';
import { parseLimits } from '../src/limits.ts';
import { CATEGORIES, COST, isSubrequestLimitError, meteredFetch, SubrequestBudgetError, SubrequestMeter, SubrequestPlan, tailCost } from '../src/subrequests.ts';

const base = loadSourcesConfig(resolve(REPO_ROOT, 'data'));
const TOKEN = 't'.repeat(40);
const NOW = '2026-11-24T05:17:00.000Z';
const ts = (daysAgo: number) => String(Math.floor((Date.parse(NOW) - daysAgo * 86_400_000) / 1000));

// ------------------------------------------------------------------ API Worker stand-in (metered like the Service Binding)
function api(meter: SubrequestMeter, o: { checkpoints?: Record<string, Record<string, string>>; incidentsPerKind?: number; failImport?: boolean } = {}) {
  const store: Record<string, Record<string, string>> = JSON.parse(JSON.stringify(o.checkpoints ?? {}));
  const imports: { items: ImportItem[]; checkpoints?: { provider: string; key: string; value: string }[]; run?: unknown }[] = [];
  const n = o.incidentsPerKind ?? 0;
  const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const raw = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname.replace('/api/v1/admin', '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === '/checkpoints') return reply({ checkpoints: Object.entries(store[u.searchParams.get('provider')!] ?? {}).map(([key, value]) => ({ key, value })) });
    if (path === '/known') return reply({ canonicalUrls: [], providerKeys: [] });
    if (path === '/titles') {
      const kind = u.searchParams.get('kind')!;
      const limit = Number(u.searchParams.get('limit'));
      const start = Number(u.searchParams.get('cursor')?.split(':').pop() ?? -1) + 1;
      const rows = Array.from({ length: Math.max(0, Math.min(limit, n - start)) }, (_, i) => ({ incidentKey: `${kind === 'GTA_CANON' ? 'gta' : 'fl'}:${start + i}`, title: `Existing ${kind} incident number ${start + i} about boats`, kind, seenAt: null }));
      return reply({ items: rows, nextCursor: start + rows.length < n ? rows.at(-1)!.incidentKey : null });
    }
    if (path === '/import') {
      if (o.failImport) return reply({ error: { code: 'INTERNAL' } }, 500);
      imports.push(body);
      for (const c of body.checkpoints ?? []) (store[c.provider] ??= {})[c.key] = c.value;
      return reply({ replayed: false, results: body.items.map((i: ImportItem) => ({ incidentKey: i.incidentKey, outcome: 'inserted', questionState: 'candidate' })) });
    }
    if (path === '/schedule') return reply({ added: [], kept: [], shortageDate: null, warnings: [], inventory: { unusedFlorida: 0, unusedGta: 0, runwayDays: 0, scheduledAhead: 0 } });
    return reply({}, 404);
  }) as typeof fetch;
  const client = createWorkerClient({ baseUrl: 'https://api.internal', token: TOKEN, fetchImpl: meteredFetch(raw, meter, 'api'), sleep: async () => {}, maxRetries: 0 });
  return { client, store, imports };
}

// ------------------------------------------------------------------ the worst possible outside world
const FEEDS = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, sourceId: `publisher:feed${i}.example`, url: `https://feed${i}.example/feed/` }));
const policy = (host: string): SourcePolicy => ({
  id: `publisher:${host}`, type: 'publisher', name: host, hosts: [host], licenseStatus: 'unreviewed', canUseEditorialSummary: false, canDisplayOriginalTitle: false, autoPublishAllowed: false,
  feedAccess: { status: 'allowed', basis: [`https://${host}/rss/`], reviewedBy: 'owner', reviewedAt: '2026-11-23', aiClassification: true },
});
const lookup = (id: string) => (id.startsWith('publisher:feed') ? policy(id.slice('publisher:'.length)) : undefined);
const cfg = { ...base, rss: FEEDS, grandTheftWiki: { categories: [{ name: 'Missions in GTA III', mode: 'pages' as const }] } };

function hostileWorld(o: { dojFailAt?: number; platformLimitAt?: number } = {}) {
  let calls = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls++;
    if (o.platformLimitAt && calls >= o.platformLimitAt) throw new Error('Too many subrequests by single Worker invocation.');
    const u = new URL(String(input));
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'www.justice.gov' && u.pathname === '/api/v1/press_releases.json') {
      const page = Number(u.searchParams.get('page'));
      if (o.dojFailAt !== undefined && page === o.dojFailAt) return new Response('busy', { status: 503 });
      // 50 distinct Florida releases on every page, one day older per page (never reaches the floor quickly).
      return json({ results: Array.from({ length: 50 }, (_, i) => ({ uuid: `p${page}-${i}`, title: `Tampa Man Sentenced For Selling Fake Moon Rocks Lot ${page}-${i}`, teaser: 'Tampa, Florida – Synthetic.', url: `https://www.justice.gov/usao-mdfl/pr/p${page}-${i}`, date: ts(page * 0.2) })) });
    }
    if (u.hostname === 'juliayxhuang.github.io') return json(Array.from({ length: 200 }, (_, i) => ({ title: `Florida man rides a lawnmower to the store number ${u.pathname}-${i}`, url: `https://news${i}.example/a/${u.pathname.replace(/\W/g, '')}-${i}`, source: 'x', date: '2023-01-01' })));
    if (u.hostname === 'api.gdeltproject.org') return new Response('', { status: 503 }); // every retry is spent
    if (u.hostname === 'www.grandtheftwiki.com') {
      const p = u.searchParams;
      if ((p.get('attempt') ?? '') === '' && Math.random() < 0) return json({});
      if (p.get('list') === 'categorymembers') return json({ query: { categorymembers: Array.from({ length: 50 }, (_, i) => ({ pageid: 1000 + i, title: `Mission ${i}`, ns: 0 })) }, continue: { cmcontinue: 'NEXT' } });
      if (p.get('titles')) return json({ query: { pages: p.get('titles')!.split('|').map((t) => ({ pageid: 1000 + Number(t.split(' ')[1]), title: t })) } });
      if (p.get('action') === 'parse') {
        const id = Number(p.get('pageid'));
        return json({ parse: { pageid: id, title: `Mission ${id}`, revid: 1, wikitext: `'''Mission ${id}''' is a mission in [[Grand Theft Auto III]] where the player chases an odd armored van across the harbor at night.`, sections: [], categories: [] } });
      }
    }
    // robots.txt and feeds: the maximum same-host redirect chain (3 hops) before answering.
    const hop = Number(u.searchParams.get('hop') ?? 0);
    if (u.pathname === '/robots.txt' || u.pathname === '/feed/') {
      if (hop < 3) return new Response(null, { status: 301, headers: { location: `${u.origin}${u.pathname}?hop=${hop + 1}` } });
      if (u.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      const items = Array.from({ length: 100 }, (_, i) => `<item><title>Florida man feeds a gator number ${u.hostname}-${i} at the pier</title><link>https://${u.hostname}/s/${i}</link><guid>${i}</guid></item>`).join('');
      return new Response(`<rss><channel>${items}</channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    }
    // Link checks: HEAD always refused (→ GET), two redirects, then OK: the most expensive path.
    if (init?.method === 'HEAD') return new Response(null, { status: 405 });
    if (hop < 2) return new Response(null, { status: 302, headers: { location: `${u.origin}${u.pathname}?hop=${hop + 1}` } });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function fakeStep() {
  const names: string[] = [];
  const configs: Record<string, StepConfig> = {};
  const step: StepLike = {
    async do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T> {
      if (names.includes(name)) throw new Error(`duplicate step ${name}`);
      names.push(name);
      configs[name] = config;
      return JSON.parse(JSON.stringify(await fn())) as T;
    },
  };
  return { step, names, configs };
}

function setup(vars: Record<string, string>, o: { checkpoints?: Record<string, Record<string, string>>; incidentsPerKind?: number; world?: ReturnType<typeof hostileWorld>; failImport?: boolean } = {}) {
  const limits = parseLimits({ GDELT_ENABLED: 'true', GDELT_MIN_RSS_ITEMS: '1000000', DOJ_ENABLED: 'true', FM_DATASET_ENABLED: 'true', DOJ_MIN_UNUSUAL: '0', ...vars });
  const meter = new SubrequestMeter(limits.subrequestBudget);
  const a = api(meter, { checkpoints: o.checkpoints, incidentsPerKind: o.incidentsPerKind, failImport: o.failImport });
  const world = o.world ?? hostileWorld();
  const spawned: { id: string; params: IngestParams }[] = [];
  const deps: IngestDeps = {
    cfg,
    limits,
    client: a.client,
    ai: createMockAiProvider(),
    fetchImpl: world.fetchImpl,
    userAgent: 'gta-or-florida-ingest/0.4 (test)',
    wikiApi: 'https://www.grandtheftwiki.com/api.php',
    event: () => {},
    sleep: async () => {},
    wikiPaceMs: 0,
    lookup,
    appEnv: 'staging',
    meter,
    spawn: async (id, params) => void spawned.push({ id, params }),
    nonRetryable: (e) => Object.assign(new Error(`NonRetryable: ${e.message}`), { name: 'NonRetryableError' }),
  };
  return { deps, meter, api: a, world, spawned, limits };
}

const assertWithinBudget = (meter: SubrequestMeter, summary: { subrequests: { limit: number; reserved: Record<string, number>; actual: Record<string, number> } }) => {
  const reserved = Object.values(summary.subrequests.reserved).reduce((a, b) => a + b, 0);
  expect(meter.total).toBeLessThanOrEqual(summary.subrequests.limit);
  expect(reserved).toBeLessThanOrEqual(summary.subrequests.limit);
  for (const c of CATEGORIES) expect(summary.subrequests.actual[c], c).toBeLessThanOrEqual(summary.subrequests.reserved[c]!);
};

describe('per-instance subrequest budget (worst case)', () => {
  it('never exceeds the plan, in total or per category, across budgets and source mixes', async () => {
    const cases: Record<string, string>[] = [];
    for (const budget of ['20', '30', '45', '50']) {
      for (const sources of ['all', 'florida', 'gta']) {
        cases.push({ SUBREQUEST_BUDGET: budget, MAX_LINK_CHECKS: '15', MAX_AI_REQUESTS: '30', MAX_WIKI_PAGES: '15', DOJ_MAX_PAGES: '6', FM_DATASET_DAYS_PER_RUN: '3', __sources: sources });
      }
    }
    for (const c of cases) {
      const { __sources, ...vars } = c;
      const { deps, meter } = setup(vars, { incidentsPerKind: 700 });
      const out = await runIngestion({ runId: `r-${c.SUBREQUEST_BUDGET}-${__sources}`, startedAt: NOW, params: { sources: __sources as 'all' } }, fakeStep().step, deps);
      assertWithinBudget(meter, out);
      expect(out.subrequests.reserved.api, JSON.stringify(c)).toBeGreaterThan(0);
    }
  }, 120_000);

  it('keeps the tail (dedupe, import, checkpoints, inventory) even when discovery could eat everything', async () => {
    const { deps, meter, api: a } = setup({ SUBREQUEST_BUDGET: '20', MAX_LINK_CHECKS: '15' }, { incidentsPerKind: 10 });
    const out = await runIngestion({ runId: 'tight', startedAt: NOW, params: {} }, fakeStep().step, deps);
    assertWithinBudget(meter, out);
    expect(a.imports.length).toBeGreaterThan(0); // the run still imported and saved its cursors
    expect(out.subrequests.deferred.length).toBeGreaterThan(0); // and deferred the rest deterministically
    expect(out.inventory).not.toBeNull();
  });

  it('accounts redirects, retries, link checks, AI and API calls in separate categories', async () => {
    // One DOJ page only (no feeds, dataset or GDELT), so link checks and AI have room in the plan.
    const { deps, meter } = setup({ SUBREQUEST_BUDGET: '50', MAX_LINK_CHECKS: '2', MAX_AI_REQUESTS: '4', DOJ_MAX_PAGES: '1', MAX_FEEDS: '0', FM_DATASET_ENABLED: 'false', GDELT_ENABLED: 'false' }, { incidentsPerKind: 5 });
    const out = await runIngestion({ runId: 'cats', startedAt: NOW, params: { sources: 'florida' } }, fakeStep().step, deps);
    assertWithinBudget(meter, out);
    expect(out.subrequests.actual.link_check).toBe(2 * COST.linkCheck); // 3 hops × (HEAD 405 → GET), twice
    expect(out.subrequests.actual.ai).toBeGreaterThan(0);
    expect(out.subrequests.actual.api).toBeGreaterThan(0);
  });

  it('no request-making step is ever retried (a retry would spend unreserved budget)', async () => {
    const s = fakeStep();
    const { deps } = setup({ SUBREQUEST_BUDGET: '45' }, { incidentsPerKind: 5 });
    await runIngestion({ runId: 'retries', startedAt: NOW, params: {} }, s.step, deps);
    for (const [name, cfg_] of Object.entries(s.configs)) if (!/^dedupe:scan|^plan$|^summary$/.test(name)) expect(cfg_.retries?.limit ?? 0, name).toBe(0);
  });

  it('the meter stops a run before the platform limit, and limit errors are non-retryable', async () => {
    const m = new SubrequestMeter(3);
    m.take('api');
    m.take('discovery');
    m.take('ai');
    expect(() => m.take('api')).toThrow(SubrequestBudgetError);
    expect(isSubrequestLimitError(new Error('Too many subrequests by single Worker invocation.'))).toBe(true);
    // Cloudflare's own error inside a step surfaces as NonRetryable.
    const { deps } = setup({ SUBREQUEST_BUDGET: '45' }, { world: hostileWorld({ platformLimitAt: 1 }) });
    await expect(runIngestion({ runId: 'plat', startedAt: NOW, params: { sources: 'florida' } }, fakeStep().step, deps)).rejects.toThrow(/^NonRetryable: .*Too many subrequests/);
  });

  it('plan arithmetic', () => {
    const p = new SubrequestPlan(10);
    expect(p.tryReserve('discovery', 6, 4)).toBe(true);
    expect(p.tryReserve('api', 1, 4)).toBe(false);
    expect(p.remaining()).toBe(4);
    expect(tailCost({ items: 0, kinds: 2, titlePagesPerKind: 2, dryRun: false })).toBe(0 + 4 + 1 + 1);
    expect(tailCost({ items: 181, kinds: 1, titlePagesPerKind: 2, dryRun: false })).toBe(3 + 2 + 10 + 1);
  });
});

describe('DOJ backfill as separate, chained instances', () => {
  it('reproduces the staging failure config (100 pages requested) and stays within 45 while saving the cursor and chaining', async () => {
    const { deps, meter, api: a, spawned } = setup({ SUBREQUEST_BUDGET: '45', DOJ_BACKFILL_PAGES_PER_RUN: '100', DOJ_BACKFILL_DAYS: '365' }, { incidentsPerKind: 5 });
    const s = fakeStep();
    const out = await runIngestion({ runId: 'bf-1', startedAt: NOW, params: { mode: 'backfill' } }, s.step, deps);
    assertWithinBudget(meter, out);
    expect(out.backfill!.pages).toBeGreaterThan(0);
    expect(out.backfill!.pages).toBeLessThan(100); // the plan, not the page setting, decides how far it goes
    expect(s.names.filter((n) => n.startsWith('doj:backfill:p'))).toEqual(Array.from({ length: out.backfill!.pages }, (_, i) => `doj:backfill:p${i}`));
    expect(a.store.doj!.backfillPage).toBe(String(out.backfill!.pages));
    expect(a.store.doj!.backfillLease).toBe(''); // released
    expect(spawned).toEqual([{ id: `backfill-staging-p${out.backfill!.pages}`, params: { mode: 'backfill' } }]);
  });

  it('a successor resumes exactly where the previous instance stopped (no skipped pages)', async () => {
    const first = setup({ SUBREQUEST_BUDGET: '30', DOJ_BACKFILL_PAGES_PER_RUN: '100' }, { incidentsPerKind: 5 });
    const a = await runIngestion({ runId: 'bf-a', startedAt: NOW, params: { mode: 'backfill' } }, fakeStep().step, first.deps);
    const second = setup({ SUBREQUEST_BUDGET: '30', DOJ_BACKFILL_PAGES_PER_RUN: '100' }, { incidentsPerKind: 5, checkpoints: first.api.store });
    const s2 = fakeStep();
    const b = await runIngestion({ runId: 'bf-b', startedAt: NOW, params: { mode: 'backfill' } }, s2.step, second.deps);
    expect(b.backfill!.from).toBe(a.backfill!.to);
    expect(s2.names.find((n) => n.startsWith('doj:backfill:p'))).toBe(`doj:backfill:p${a.backfill!.to}`);
  });

  it('a failed page is retried by the next instance: the cursor stops right before it', async () => {
    const { deps, api: a, spawned } = setup({ SUBREQUEST_BUDGET: '45', DOJ_BACKFILL_PAGES_PER_RUN: '100' }, { world: hostileWorld({ dojFailAt: 3 }), incidentsPerKind: 5 });
    const out = await runIngestion({ runId: 'bf-fail', startedAt: NOW, params: { mode: 'backfill' } }, fakeStep().step, deps);
    expect(out.backfill).toMatchObject({ from: '0', to: '3', pages: 3 });
    expect(a.store.doj!.backfillPage).toBe('3');
    expect(spawned.map((x) => x.id)).toEqual(['backfill-staging-p3']);
  });

  it('a failed import saves nothing: cursor and lease stay, no successor', async () => {
    const { deps, api: a, spawned } = setup({ SUBREQUEST_BUDGET: '45' }, { failImport: true, checkpoints: { doj: { backfillPage: '7' } } });
    await expect(runIngestion({ runId: 'bf-imp', startedAt: NOW, params: { mode: 'backfill' } }, fakeStep().step, deps)).rejects.toThrow();
    expect(a.store.doj!.backfillPage).toBe('7');
    expect(spawned).toEqual([]);
  });

  it('a dry run reads only: no lease, no import, no cursor change, no successor', async () => {
    const { deps, api: a, spawned, meter } = setup({ SUBREQUEST_BUDGET: '45' }, { checkpoints: { doj: { backfillPage: '4' } } });
    const out = await runIngestion({ runId: 'bf-dry', startedAt: NOW, params: { mode: 'backfill', dryRun: true } }, fakeStep().step, deps);
    assertWithinBudget(meter, out);
    expect(a.imports).toEqual([]);
    expect(a.store.doj).toEqual({ backfillPage: '4' });
    expect(spawned).toEqual([]);
    expect(out.backfill!.from).toBe('4');
  });

  it('only one backfill works at a time (lease), and a completed backfill does nothing', async () => {
    const held = setup({ SUBREQUEST_BUDGET: '45' }, { checkpoints: { doj: { backfillPage: '9', backfillLease: `other-run|2026-11-24T06:00:00.000Z` } } });
    const s = fakeStep();
    const out = await runIngestion({ runId: 'bf-lease', startedAt: NOW, params: { mode: 'backfill' } }, s.step, held.deps);
    expect(out.backfill!.skipped).toMatch(/holds the lease/);
    expect(s.names.some((n) => n.startsWith('doj:backfill:p'))).toBe(false);
    expect(held.spawned).toEqual([]);

    const expired = setup({ SUBREQUEST_BUDGET: '45' }, { checkpoints: { doj: { backfillPage: '9', backfillLease: `other-run|2026-11-24T04:00:00.000Z` } } });
    expect((await runIngestion({ runId: 'bf-exp', startedAt: NOW, params: { mode: 'backfill' } }, fakeStep().step, expired.deps)).backfill!.pages).toBeGreaterThan(0);

    const done = setup({ SUBREQUEST_BUDGET: '45' }, { checkpoints: { doj: { backfillPage: 'done' } } });
    const d = await runIngestion({ runId: 'bf-done', startedAt: NOW, params: { mode: 'backfill' } }, fakeStep().step, done.deps);
    expect(d.backfill).toMatchObject({ skipped: 'backfill already complete', pages: 0 });
    expect(done.spawned).toEqual([]);
  });

  it('regular runs never do backfill pages (their budget stays for daily discovery)', async () => {
    const s = fakeStep();
    const { deps } = setup({ SUBREQUEST_BUDGET: '45', DOJ_BACKFILL_ENABLED: 'true' }, { incidentsPerKind: 5 });
    await runIngestion({ runId: 'reg', startedAt: NOW, params: {} }, s.step, deps);
    expect(s.names.some((n) => n.startsWith('doj:backfill'))).toBe(false);
  });
});

describe('shipped staging configuration (wrangler.jsonc) under worst-case conditions', () => {
  it('regular and backfill instances stay within the Free-plan budget', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(resolve(REPO_ROOT, 'apps/ingest-worker/wrangler.jsonc'), 'utf8').replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, str: string | undefined) => str ?? '');
    const staging = (JSON.parse(text) as { env: { staging: { vars: Record<string, string> } } }).env.staging.vars;
    expect(Number(staging.SUBREQUEST_BUDGET)).toBeLessThan(50);
    for (const params of [{}, { mode: 'backfill' as const }, { dryRun: true }, { mode: 'backfill' as const, dryRun: true }]) {
      const { deps, meter } = setup({ ...staging, GDELT_MIN_RSS_ITEMS: '1000000' }, { incidentsPerKind: 900 });
      const out = await runIngestion({ runId: `staging-${JSON.stringify(params).replace(/\W/g, '')}`, startedAt: NOW, params }, fakeStep().step, deps);
      assertWithinBudget(meter, out);
      expect(meter.total).toBeLessThanOrEqual(Number(staging.SUBREQUEST_BUDGET));
    }
  }, 120_000);
});
