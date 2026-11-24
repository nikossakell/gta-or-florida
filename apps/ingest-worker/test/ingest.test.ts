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

function fakeWorld(o: { pages?: { id: number; title: string }[]; gdelt?: 'ok' | '429'; next?: string | null; feeds?: Record<string, string> } = {}) {
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
    if (o.feeds?.[u.toString()]) return new Response(o.feeds[u.toString()], { status: 200, headers: { 'content-type': 'application/rss+xml', etag: '"e1"' } });
    if (u.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /private/\n', { status: 200 });
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
    // Official-report sources were not fetched, and the run says so (status "ok" ≠ "official content ingested").
    expect(summary.official.map((o) => [o.sourceId, o.status])).toEqual([
      ['publisher:myfwc.com', 'skipped'],
      ['publisher:flaglersheriff.com', 'skipped'],
    ]);
    expect(events.filter((e) => e.name === 'ingest.official_skipped')).toHaveLength(2);
    expect(world.calls.some((c) => /govdelivery|flaglersheriff/.test(c))).toBe(false);
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
    // Fuzzy dedupe: the title index is read ONCE per 500 incidents (one API call), then scanned in CPU-bounded slices.
    expect(api.paths.filter((p) => p.includes('/titles?kind=GTA_CANON')).map((p) => p.replace(/^GET \/titles/, ''))).toEqual(['?kind=GTA_CANON&limit=500']);
    expect(s.names.filter((n) => n.startsWith('dedupe:scan:GTA_CANON')).length).toBe(2); // 61 incidents → slices of 50 entries
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
    // Identical except the per-invocation ACTUAL call counts (a replay served from cache makes none).
    expect({ ...out2, subrequests: { ...out2.subrequests, actual: null } }).toEqual({ ...out1, subrequests: { ...out1.subrequests, actual: null } });
    expect(out2.subrequests.reserved).toEqual(out1.subrequests.reserved);
    expect(Object.values(out2.subrequests.actual).every((n) => n === 0)).toBe(true);
    expect(api2.imports).toEqual([]); // every step came from the cache: nothing re-sent
  });

  it('produces the same import items as the CLI pipeline (processDiscovered) on the same inputs', async () => {
    const s = fakeStep();
    const api = fakeApi({ incidents: EXISTING });
    // Unconstrained subrequest budget: this test compares pipeline logic, not Free-plan rationing.
    const d = deps({ api, world: fakeWorld({ pages: PAGES }), vars: { SUBREQUEST_BUDGET: '10000' } });
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
    const gdeltCps = api.imports[0]!.body.checkpoints!.filter((c) => c.provider === 'gdelt');
    expect(gdeltCps.some((c) => c.key === 'nextBatchIndex')).toBe(false); // query cursor not advanced
    expect(Object.fromEntries(gdeltCps.map((c) => [c.key, c.value]))).toEqual({ strikes: '1', cooldownUntil: '2026-11-23T11:17:00.000Z' }); // 6 h cooldown
    expect(api.imports[0]!.body.items.length).toBe(5); // wiki items still imported
  });

  it('GDELT stays off unless enabled', async () => {
    const world = fakeWorld({ pages: PAGES });
    await runIngestion({ ...RUN, params: { sources: 'florida' } }, fakeStep().step, deps({ api: fakeApi(), world, vars: { GDELT_ENABLED: 'false' } }));
    expect(world.calls.some((c) => c.includes('gdeltproject'))).toBe(false);
  });

  it('defers discovery instead of exceeding the step budget (the hard guard stays as a last resort)', async () => {
    const s = fakeStep();
    const out = await runIngestion({ ...RUN, params: {} }, s.step, deps({ api: fakeApi({ incidents: EXISTING }), world: fakeWorld({ pages: PAGES }), vars: { MAX_STEPS: '50', SCAN_PAGE_SIZE: '1', SCAN_CANDIDATES: '1' } }));
    expect(s.names.length).toBeLessThanOrEqual(50);
    expect(out.subrequests.deferred.length).toBeGreaterThan(0);
    expect(out.status).not.toBe('failed');
  });

  it('flags an import that comes back approved (manual review gate must hold)', async () => {
    const events: { name: string; data: Record<string, unknown> }[] = [];
    await runIngestion({ ...RUN, params: { sources: 'florida' } }, fakeStep().step, deps({ api: fakeApi({ approve: true }), world: fakeWorld(), events }));
    expect(events.filter((e) => e.name === 'ingest.unexpected_approval').length).toBeGreaterThan(0);
  });

});

// ---------------------------------------------------------------- RSS-first Florida discovery
describe('RSS-first Florida discovery', () => {
  const FEEDS = [
    { id: 'fa', sourceId: 'publisher:feed-a.example', url: 'https://feed-a.example/feed/', region: 'Tampa Bay' },
    { id: 'fb', sourceId: 'publisher:feed-b.example', url: 'https://feed-b.example/feed/', region: 'Miami' },
  ];
  const policy = (host: string, ai: boolean) => ({
    id: `publisher:${host}`,
    type: 'publisher' as const,
    name: host,
    hosts: [host],
    licenseStatus: 'unreviewed' as const,
    canUseEditorialSummary: false,
    canDisplayOriginalTitle: false,
    autoPublishAllowed: false,
    feedAccess: { status: 'allowed' as const, basis: [`https://${host}/rss/`], reviewedBy: 'owner', reviewedAt: '2026-11-23', aiClassification: ai },
  });
  const lookup = (id: string) => ({ 'publisher:feed-a.example': policy('feed-a.example', false), 'publisher:feed-b.example': policy('feed-b.example', true) })[id];
  const feedXml = (host: string, titles: string[]) =>
    `<rss><channel>${titles.map((t, i) => `<item><title>${t}</title><link>https://${host}/s/${i}</link><guid>${host}-${i}</guid><pubDate>Mon, 23 Nov 2026 10:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
  const feeds = {
    'https://feed-a.example/feed/': feedXml('feed-a.example', ['Florida man rides a lawnmower to a Tampa drive-thru', 'Tampa iguana stuck in a vending machine overnight']),
    'https://feed-b.example/feed/': feedXml('feed-b.example', ['Miami deputies find an alligator in a backyard pool', 'Florida man killed in crash on I-95 overnight']),
  };
  const rssCfg = { ...cfg, rss: FEEDS };
  function countingAi() {
    const calls: string[] = [];
    const base = createMockAiProvider();
    return { calls, ai: { name: 'mock', run: (model: string, messages: Parameters<typeof base.run>[1], max: number) => (calls.push(model), base.run(model, messages, max)) } };
  }

  it('uses allowed feeds, leaves GDELT alone when they yield enough, and runs AI only where the owner allowed it', async () => {
    const api = fakeApi();
    const world = fakeWorld({ feeds });
    const counted = countingAi();
    const s = fakeStep();
    const out = await runIngestion({ ...RUN, params: { sources: 'florida' } }, s.step, { ...deps({ api, world, vars: { GDELT_MIN_RSS_ITEMS: '3' } }), cfg: rssCfg, lookup, ai: counted.ai });
    expect(out.gdelt).toBe('not_needed');
    expect(world.calls.some((c) => c.includes('gdeltproject'))).toBe(false);
    expect(s.names.filter((n) => n.startsWith('rss:'))).toEqual(['rss:fa', 'rss:fb']);
    const items = api.imports[0]!.body.items;
    expect(items.map((i) => [i.reference.provider, i.reference.canonicalUrl, i.prefilter.decision])).toEqual([
      ['rss', 'https://feed-a.example/s/0', 'candidate'],
      ['rss', 'https://feed-a.example/s/1', 'candidate'],
      ['rss', 'https://feed-b.example/s/0', 'candidate'],
      ['rss', 'https://feed-b.example/s/1', 'reject'],
    ]);
    // feed-a: metadata only (no AI); feed-b: AI allowed, but only for the prefilter-passing item.
    expect(items.map((i) => i.ai !== null)).toEqual([false, false, true, false]);
    expect(counted.calls.length).toBeGreaterThan(0);
    expect(items.every((i) => !('fixture' in i))).toBe(true);
    expect(api.imports[0]!.body.checkpoints).toEqual(
      expect.arrayContaining([{ provider: 'rss', key: 'cache:fa', value: JSON.stringify({ etag: '"e1"', lastModified: null }) }]),
    );
  });

  it('never contacts GDELT during its cooldown', async () => {
    const world = fakeWorld({ feeds: {} });
    const api = fakeApi({ checkpoints: { gdelt: { strikes: '1', cooldownUntil: '2026-11-23T11:17:00.000Z' } } });
    const s = fakeStep();
    const out = await runIngestion({ ...RUN, params: { sources: 'florida' } }, s.step, { ...deps({ api, world }), cfg: rssCfg, lookup: () => undefined });
    expect(out.gdelt).toBe('cooldown');
    expect(s.names).not.toContain('gdelt');
    expect(world.calls.some((c) => c.includes('gdeltproject'))).toBe(false);
  });

  it('persists the GDELT cooldown even on a dry run and on a failed run (cursors stay put)', async () => {
    const dry = fakeApi();
    await runIngestion({ ...RUN, params: { sources: 'florida', dryRun: true } }, fakeStep().step, { ...deps({ api: dry, world: fakeWorld({ gdelt: '429' }) }), cfg: rssCfg, lookup: () => undefined });
    expect(dry.imports).toHaveLength(1);
    expect(dry.imports[0]!.body).toEqual({ items: [], checkpoints: [{ provider: 'gdelt', key: 'strikes', value: '1' }, { provider: 'gdelt', key: 'cooldownUntil', value: '2026-11-23T11:17:00.000Z' }] });

    const failed = fakeApi();
    const out = await runIngestion({ ...RUN, params: { sources: 'florida' } }, fakeStep().step, { ...deps({ api: failed, world: fakeWorld({ gdelt: '429' }) }), cfg: rssCfg, lookup: () => undefined });
    expect(out.status).toBe('failed');
    expect(failed.imports[0]!.body.checkpoints).toEqual([{ provider: 'gdelt', key: 'strikes', value: '1' }, { provider: 'gdelt', key: 'cooldownUntil', value: '2026-11-23T11:17:00.000Z' }]);
  });
});

// ---------------------------------------------------------------- DOJ + staging-only dataset
describe('Florida: DOJ first, dataset staging-only', () => {
  const ts = (d: string) => String(Date.parse(`${d}T12:00:00Z`) / 1000);
  const dojBody = JSON.stringify({
    results: [
      { uuid: 'u1', title: 'Bradenton Man Pleads Guilty To Home Improvement Refund Scheme', teaser: 'Tampa, Florida – Synthetic.', url: 'https://www.justice.gov/usao-mdfl/pr/u1', date: ts('2026-11-23') },
      { uuid: 'u2', title: 'Lakeland Woman Sentenced For Fake Parking Ticket Scheme', teaser: 'Tampa, Florida – Synthetic.', url: 'https://www.justice.gov/usao-mdfl/pr/u2', date: ts('2026-11-22') },
      { uuid: 'old', title: 'Outside the lookback window by a long way', teaser: '', url: 'https://www.justice.gov/usao-mdfl/pr/old', date: ts('2026-11-01') },
    ],
  });
  const dayBody = JSON.stringify([{ title: 'Florida man tries to pay for tacos with a live baby alligator', url: 'https://www.wfla.com/news/florida/alligator-tacos/', source: 'wfla.com', date: '2022-01-01' }]);
  function world() {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const u = new URL(String(input));
      calls.push(`${u.hostname}${u.pathname}`);
      if (u.hostname === 'www.justice.gov') return new Response(dojBody, { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.hostname === 'juliayxhuang.github.io') return new Response(u.pathname.endsWith('/01/01.json') ? dayBody : '[]', { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.hostname === 'api.gdeltproject.org') return new Response('', { status: 429 });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const vars = { DOJ_ENABLED: 'true', FM_DATASET_ENABLED: 'true', GDELT_MIN_RSS_ITEMS: '2', DOJ_MIN_UNUSUAL: '0' };

  it('imports DOJ convictions and dataset items as review candidates in staging, without touching GDELT', async () => {
    const api = fakeApi();
    const w = world();
    const s = fakeStep();
    const out = await runIngestion({ ...RUN, params: { sources: 'florida' } }, s.step, { ...deps({ api, world: w as never, vars }), appEnv: 'staging' });
    expect(s.names.slice(0, 3)).toEqual(['checkpoints', 'doj:p0', 'floridaman_dataset:0']);
    expect(out.gdelt).toBe('not_needed');
    expect(w.calls.some((c) => c.includes('gdeltproject'))).toBe(false);
    const items = api.imports[0]!.body.items;
    expect(items.map((i) => [i.reference.provider, i.reference.canonicalUrl])).toEqual([
      ['doj', 'https://justice.gov/usao-mdfl/pr/u1'],
      ['doj', 'https://justice.gov/usao-mdfl/pr/u2'],
      ['floridaman_dataset', 'https://wfla.com/news/florida/alligator-tacos'],
    ]);
    expect(items[2]!.ai).toBeNull(); // third-party headline: no AI
    expect(api.imports[0]!.body.checkpoints).toEqual(expect.arrayContaining([{ provider: 'floridaman_dataset', key: 'nextDay', value: '2' }]));
  });

  it('never runs the dataset in production, whatever the flag says', async () => {
    const api = fakeApi();
    const w = world();
    const s = fakeStep();
    await runIngestion({ ...RUN, params: { sources: 'florida', dryRun: true } }, s.step, { ...deps({ api, world: w as never, vars }), appEnv: 'production' });
    expect(s.names).not.toContain('floridaman_dataset');
    expect(w.calls.some((c) => c.includes('juliayxhuang'))).toBe(false);
    expect(api.paths.some((p) => p.includes('provider=floridaman_dataset'))).toBe(false);
  });
});

