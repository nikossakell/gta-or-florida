import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importItemSchema, parse, type ImportItem } from '@gof/core';
import { createMockAiProvider } from '@gof/ingest/classify.ts';
import { loadSourcesConfig } from '@gof/ingest/config-file.ts';
import { createWorkerClient } from '@gof/ingest/import.ts';
import { REPO_ROOT } from '@gof/ingest/paths.ts';
import { processDiscovered, type Discovered } from '@gof/ingest/pipeline.ts';
import { runIngestion, StepBudgetError, type IngestDeps, type StepConfig, type StepLike } from '../src/ingest.ts';
import { parseLimits } from '../src/limits.ts';

const base = loadSourcesConfig(resolve(REPO_ROOT, 'data'));
const MISSIONS = { name: 'Missions in GTA III', mode: 'pages' as const };
const cfg = { ...base, grandTheftWiki: { categories: [MISSIONS] }, rss: [] };
const TOKEN = 't'.repeat(40);

// ---------------------------------------------------------------- simulated API Worker (in-memory D1 view)
type Incident = { incidentKey: string; kind: 'FLORIDA_NEWS' | 'GTA_CANON'; title: string; seenAt: string | null; url?: string; providerKey?: string | null };

function fakeApi(o: { incidents?: Incident[]; checkpoints?: Record<string, Record<string, string>>; runwayDays?: number; approve?: boolean } = {}) {
  const incidents = [...(o.incidents ?? [])];
  const urls = new Set(incidents.map((i) => i.url).filter(Boolean) as string[]);
  const keys = new Set(incidents.map((i) => i.providerKey).filter(Boolean) as string[]);
  const imports: { key: string; body: { items: ImportItem[]; run?: Record<string, unknown>; checkpoints?: { provider: string; key: string; value: string }[] } }[] = [];
  const paths: string[] = [];
  const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname.replace('/api/v1/admin', '');
    paths.push(`${init?.method ?? 'GET'} ${path}${u.search}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === '/checkpoints') {
      const cp = o.checkpoints?.[u.searchParams.get('provider')!] ?? {};
      return reply({ checkpoints: Object.entries(cp).map(([key, value]) => ({ key, value })) });
    }
    if (path === '/known') return reply({ canonicalUrls: body.canonicalUrls.filter((x: string) => urls.has(x)), providerKeys: body.providerKeys.filter((x: string) => keys.has(x)) });
    if (path === '/titles') {
      const kind = u.searchParams.get('kind');
      const limit = Number(u.searchParams.get('limit') ?? 500);
      const cursor = u.searchParams.get('cursor') ?? '';
      const rows = incidents.filter((i) => i.kind === kind && i.incidentKey > cursor).sort((a, b) => (a.incidentKey < b.incidentKey ? -1 : 1)).slice(0, limit);
      return reply({ items: rows.map((r) => ({ incidentKey: r.incidentKey, title: r.title, kind: r.kind, seenAt: r.seenAt })), nextCursor: rows.length === limit ? rows.at(-1)!.incidentKey : null });
    }
    if (path === '/import') {
      imports.push({ key: new Headers(init?.headers).get('idempotency-key')!, body });
      for (const it of body.items as ImportItem[]) {
        urls.add(it.reference.canonicalUrl);
        if (it.reference.providerKey) keys.add(it.reference.providerKey);
      }
      return reply({ replayed: false, results: body.items.map((i: ImportItem) => ({ incidentKey: i.incidentKey, outcome: 'inserted', questionState: o.approve ? 'approved' : 'candidate' })) });
    }
    if (path === '/schedule') return reply({ added: [], kept: [], shortageDate: null, warnings: [], inventory: { unusedFlorida: 3, unusedGta: 40, runwayDays: o.runwayDays ?? 30, scheduledAhead: 30 } });
    return reply({ error: { code: 'NOT_FOUND' } }, 404);
  }) as typeof fetch;
  return { imports, paths, client: createWorkerClient({ baseUrl: 'https://api.internal', token: TOKEN, fetchImpl, sleep: async () => {}, maxRetries: 0 }) };
}

// ---------------------------------------------------------------- simulated outside world (wiki, GDELT, publishers)
const missionText = (t: string) => `'''${t}''' is a mission in [[Grand Theft Auto III]] where the player chases an odd armored van across the harbor at night.`;

function fakeWorld(o: { pages?: { id: number; title: string }[]; gdelt?: 'ok' | '429'; next?: string | null } = {}) {
  const pages = o.pages ?? [];
  const calls: string[] = [];
  const reply = (v: unknown, status = 200) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${u.hostname}${u.pathname}`);
    if (u.hostname === 'www.grandtheftwiki.com' && u.pathname === '/api.php') {
      const p = u.searchParams;
      if (p.get('list') === 'categorymembers') return reply({ query: { categorymembers: pages.map((x) => ({ pageid: x.id, title: x.title, ns: 0 })) }, ...(o.next ? { continue: { cmcontinue: o.next } } : {}) });
      if (p.get('titles')) return reply({ query: { pages: p.get('titles')!.split('|').map((t) => ({ pageid: pages.find((x) => x.title === t)!.id, title: t })) } });
      if (p.get('action') === 'parse') {
        const pg = pages.find((x) => x.id === Number(p.get('pageid')))!;
        return reply({ parse: { pageid: pg.id, title: pg.title, revid: 1, wikitext: missionText(pg.title), sections: [], categories: [] } });
      }
    }
    if (u.hostname === 'api.gdeltproject.org') {
      if (o.gdelt === '429') return reply('', 429);
      return reply({
        articles: [
          { url: 'https://www.tampa-news.example/a/1', title: 'Florida man rides a lawnmower to the liquor store', domain: 'tampa-news.example', seendate: '20261122T100000Z' },
          { url: 'https://www.keys-news.example/b/2', title: 'Key West iguana steals tourist sandwich at the pier', domain: 'keys-news.example', seendate: '20261122T110000Z' },
          { url: 'https://www.tampa-news.example/c/3', title: 'Florida man killed in crash on I-4 overnight', domain: 'tampa-news.example', seendate: '20261122T120000Z' },
        ],
      });
    }
    // Publisher link checks (HEAD): everything is up.
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

// ---------------------------------------------------------------- Workflow step simulator
/** Executes steps like Workflows: results persisted as plain data, unique names, optional cache for replay. */
function fakeStep(cache?: Map<string, unknown>) {
  const names: string[] = [];
  const results = new Map<string, unknown>();
  const configs = new Map<string, StepConfig>();
  const step: StepLike = {
    async do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T> {
      if (names.includes(name)) throw new Error(`duplicate step name ${name}`);
      names.push(name);
      configs.set(name, config);
      if (cache?.has(name)) return cache.get(name) as T;
      const value = JSON.parse(JSON.stringify(await fn())) as T; // Sets/Maps/functions would not survive
      results.set(name, value);
      return value;
    },
  };
  return { step, names, results, configs };
}

function deps(o: { api: ReturnType<typeof fakeApi>; world: ReturnType<typeof fakeWorld>; vars?: Record<string, string>; events?: { name: string; data: Record<string, unknown> }[] }): IngestDeps {
  return {
    cfg,
    limits: parseLimits({ GDELT_ENABLED: 'true', ...o.vars }),
    client: o.api.client,
    ai: createMockAiProvider(),
    fetchImpl: o.world.fetchImpl,
    userAgent: 'test',
    wikiApi: 'https://www.grandtheftwiki.com/api.php',
    event: (name, data) => o.events?.push({ name, data }),
    sleep: async () => {},
    wikiPaceMs: 0,
  };
}

const PAGES = Array.from({ length: 6 }, (_, i) => ({ id: 1000 + i, title: `Test Mission ${['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'][i]}` }));
const EXISTING: Incident[] = [
  // Another outlet's report of the lawnmower story, seen 2 days earlier → attach.
  { incidentKey: 'fl:aaa', kind: 'FLORIDA_NEWS', title: 'Liquor store: Florida man rides lawnmower', seenAt: '2026-11-20T00:00:00Z' },
  // Loosely similar older story → flagged for a human (possible duplicate), not attached.
  { incidentKey: 'fl:bbb', kind: 'FLORIDA_NEWS', title: 'Key West iguana steals sandwich from tourist', seenAt: '2025-01-01T00:00:00Z' },
  // Page 1003 already imported → skipped before fetching.
  { incidentKey: 'gta:grandtheftwiki:1003', kind: 'GTA_CANON', title: 'Test Mission Delta', seenAt: null, providerKey: '1003', url: 'https://www.grandtheftwiki.com/index.php?curid=1003' },
  ...Array.from({ length: 60 }, (_, i) => ({ incidentKey: `gta:grandtheftwiki:${5000 + i}`, kind: 'GTA_CANON' as const, title: `Unrelated wiki thing number ${i} about boats`, seenAt: null })),
];
const RUN = { runId: 'cron-staging-2026112305', startedAt: '2026-11-23T05:17:00.000Z' };

describe('ingestion workflow', () => {
  it('runs end to end in bounded steps and imports review candidates only', async () => {
    const api = fakeApi({ incidents: EXISTING });
    const world = fakeWorld({ pages: PAGES });
    const events: { name: string; data: Record<string, unknown> }[] = [];
    const s = fakeStep();
    const summary = await runIngestion({ ...RUN, params: {} }, s.step, deps({ api, world, events }));

    expect(summary.status).toBe('ok');
    // 5 new mission pages + 2 Florida (the tragedy is prefilter-rejected but still recorded).
    expect(summary.discovered).toBe(8);
    expect(world.calls.filter((c) => c.includes('/api.php')).length).toBe(2 + 5); // members + resolve + 5 pages (1003 skipped)
    expect(api.imports).toHaveLength(1);
    const { items, run, checkpoints } = api.imports[0]!.body;
    expect(items.every((i) => parse(importItemSchema, i).ok)).toBe(true);
    expect(items.map((i) => i.reference.provider).sort()).toEqual(['gdelt', 'gdelt', 'gdelt', 'grandtheftwiki', 'grandtheftwiki', 'grandtheftwiki', 'grandtheftwiki', 'grandtheftwiki']);
    expect(items.find((i) => i.reference.originalTitle.includes('lawnmower'))!.attachToIncidentKey).toBe('fl:aaa');
    expect(items.find((i) => i.reference.originalTitle.includes('iguana'))!.incident.possibleDuplicateOfKey).toBe('fl:bbb');
    expect(items.find((i) => i.reference.originalTitle.includes('killed'))!.prefilter.decision).toBe('reject');
    expect(items.filter((i) => i.fixture)).toEqual([]);
    expect(run).toMatchObject({ id: RUN.runId, provider: 'all', status: 'ok', fetched: 8 });
    expect(checkpoints).toEqual(
      expect.arrayContaining([
        { provider: 'gdelt', key: 'nextBatchIndex', value: '1' },
        { provider: 'grandtheftwiki', key: `cmcontinue:${MISSIONS.name}`, value: '' },
        { provider: 'grandtheftwiki', key: `offset:${MISSIONS.name}`, value: '0' },
        { provider: 'grandtheftwiki', key: 'nextCategory', value: '0' },
      ]),
    );
    // Fuzzy dedupe paged through the title index in small pages.
    expect(api.paths.some((p) => p.includes('/titles?kind=GTA_CANON&limit=25'))).toBe(true);
    expect(s.names.filter((n) => n.startsWith('dedupe:scan:GTA_CANON')).length).toBe(3); // 61 incidents / 25 per page
    expect(summary.outcomes).toEqual({ 'inserted:candidate': 8 });
    expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(['ingest.discovered', 'ingest.planned', 'ingest.imported', 'ingest.inventory', 'ingest.run']));
    expect(summary.steps).toBe(s.names.length);
  });

  it('a full replay from cached step results is identical (Workflows determinism)', async () => {
    const first = fakeStep();
    const api1 = fakeApi({ incidents: EXISTING });
    const out1 = await runIngestion({ ...RUN, params: {} }, first.step, deps({ api: api1, world: fakeWorld({ pages: PAGES }) }));
    const replay = fakeStep(first.results);
    const api2 = fakeApi({ incidents: EXISTING });
    const out2 = await runIngestion({ ...RUN, params: {} }, replay.step, deps({ api: api2, world: fakeWorld({ pages: PAGES }) }));
    expect(replay.names).toEqual(first.names);
    expect(out2).toEqual(out1);
    expect(api2.imports).toEqual([]); // every step came from the cache: nothing re-sent
  });

  it('produces the same import items as the CLI pipeline (processDiscovered) on the same inputs', async () => {
    const s = fakeStep();
    const api = fakeApi({ incidents: EXISTING });
    const d = deps({ api, world: fakeWorld({ pages: PAGES }) });
    await runIngestion({ ...RUN, params: {} }, s.step, d);
    const found: Discovered[] = [...s.names]
      .filter((n) => n === 'gdelt' || /^wiki:\d+:page:/.test(n))
      .flatMap((n) => {
        const r = s.results.get(n) as Discovered[] | { items: Discovered[] };
        return Array.isArray(r) ? r : r.items;
      });
    const cliApi = fakeApi({ incidents: EXISTING });
    const cli = await processDiscovered(found, {
      client: cliApi.client,
      ai: createMockAiProvider(),
      budget: (await import('@gof/ingest/classify.ts')).createBudget(d.limits.maxAiRequests, d.limits.maxNeurons),
      checkLink: async (url) => ({ status: 'ok', httpStatus: 200, finalUrl: url, checkedAt: 'X' }),
      maxLinkChecks: d.limits.maxLinkChecks,
      aiConcurrency: 1,
      existingTitles: (await cliApi.client.titles('FLORIDA_NEWS')).concat(await cliApi.client.titles('GTA_CANON')),
    });
    const norm = (items: ImportItem[]) => items.map((i) => ({ ...i, reference: { ...i.reference, linkCheck: i.reference.linkCheck ? { ...i.reference.linkCheck, checkedAt: 'X' } : null } }));
    expect(norm(api.imports[0]!.body.items)).toEqual(norm(cli.items));
  });

  it('dry run imports nothing and still reports inventory', async () => {
    const api = fakeApi({ incidents: EXISTING, runwayDays: 5 });
    const events: { name: string; data: Record<string, unknown> }[] = [];
    const out = await runIngestion({ ...RUN, params: { dryRun: true } }, fakeStep().step, deps({ api, world: fakeWorld({ pages: PAGES }), events }));
    expect(api.imports).toEqual([]);
    expect(out.toImport).toBe(8);
    expect(out.lowInventory).toBe(true);
    expect(events.find((e) => e.name === 'ingest.inventory_low')!.data).toMatchObject({ runwayDays: 5, thresholdDays: 14 });
  });

  it('caps wiki pages per run and resumes from the saved offset', async () => {
    const pages = PAGES.slice(0, 5);
    const api = fakeApi();
    const s1 = fakeStep();
    await runIngestion({ ...RUN, params: { sources: 'gta' } }, s1.step, deps({ api, world: fakeWorld({ pages, next: 'NEXT' }), vars: { MAX_WIKI_PAGES: '2' } }));
    const cp1 = Object.fromEntries(api.imports[0]!.body.checkpoints!.map((c) => [c.key, c.value]));
    expect(cp1).toMatchObject({ [`cmcontinue:${MISSIONS.name}`]: '', [`offset:${MISSIONS.name}`]: '2', nextCategory: '0' });
    expect(api.imports[0]!.body.items.map((i) => i.reference.providerKey)).toEqual(['1000', '1001']);

    const api2 = fakeApi({ checkpoints: { grandtheftwiki: cp1 } });
    await runIngestion({ ...RUN, runId: 'run-2', params: { sources: 'gta' } }, fakeStep().step, deps({ api: api2, world: fakeWorld({ pages, next: 'NEXT' }), vars: { MAX_WIKI_PAGES: '10' } }));
    const cp2 = Object.fromEntries(api2.imports[0]!.body.checkpoints!.map((c) => [c.key, c.value]));
    expect(api2.imports[0]!.body.items.map((i) => i.reference.providerKey)).toEqual(['1002', '1003', '1004']);
    // Member page finished → advance to the next member page, offset reset.
    expect(cp2).toMatchObject({ [`cmcontinue:${MISSIONS.name}`]: 'NEXT', [`offset:${MISSIONS.name}`]: '0' });
  });

  it('GDELT 429 is recorded, the run continues, and its cursor does not advance', async () => {
    const api = fakeApi({ incidents: EXISTING });
    const out = await runIngestion({ ...RUN, params: {} }, fakeStep().step, deps({ api, world: fakeWorld({ pages: PAGES, gdelt: '429' }) }));
    expect(out.status).toBe('partial');
    expect(out.errors.join()).toMatch(/gdelt.*429|rate/i);
    expect(api.imports[0]!.body.checkpoints!.some((c) => c.provider === 'gdelt')).toBe(false);
    expect(api.imports[0]!.body.items.length).toBe(5); // wiki items still imported
  });

  it('GDELT stays off unless enabled', async () => {
    const world = fakeWorld({ pages: PAGES });
    await runIngestion({ ...RUN, params: { sources: 'florida' } }, fakeStep().step, deps({ api: fakeApi(), world, vars: { GDELT_ENABLED: 'false' } }));
    expect(world.calls.some((c) => c.includes('gdeltproject'))).toBe(false);
  });

  it('refuses to start a run that would exceed the step budget', async () => {
    await expect(runIngestion({ ...RUN, params: {} }, fakeStep().step, deps({ api: fakeApi({ incidents: EXISTING }), world: fakeWorld({ pages: PAGES }), vars: { MAX_STEPS: '50', SCAN_PAGE_SIZE: '1' } }))).rejects.toBeInstanceOf(StepBudgetError);
  });

  it('flags an import that comes back approved (manual review gate must hold)', async () => {
    const events: { name: string; data: Record<string, unknown> }[] = [];
    await runIngestion({ ...RUN, params: { sources: 'florida' } }, fakeStep().step, deps({ api: fakeApi({ approve: true }), world: fakeWorld(), events }));
    expect(events.filter((e) => e.name === 'ingest.unexpected_approval').length).toBeGreaterThan(0);
  });

  it('keeps every step within the Free-plan subrequest budget', async () => {
    // Worst-case outbound calls in one step: process batch = 4 × (≤ 6 HTTP hops + 2 AI calls) = 32 < 50.
    const s = fakeStep();
    await runIngestion({ ...RUN, params: {} }, s.step, deps({ api: fakeApi({ incidents: EXISTING }), world: fakeWorld({ pages: PAGES }) }));
    expect(parseLimits({}).processBatch * (6 + 2)).toBeLessThan(50);
    // AI steps barely retry (neurons); imports retry (idempotent keys).
    expect(s.configs.get('process:0')!.retries!.limit).toBe(1);
    expect(s.configs.get('import:0')!.retries!.limit).toBeGreaterThan(1);
  });
});
