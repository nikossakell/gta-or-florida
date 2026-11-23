import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importItemSchema, parse, type ImportItem } from '@gof/core';
import { articleUrlProblem, chooseCanonical, extractArticleMeta, fetchArticle, type ArticleResponse } from '../src/adapters/article.ts';
import { createMockAiProvider } from '../src/classify.ts';
import { createWorkerClient } from '../src/import.ts';
import { main, targetProblem } from '../src/ingest-url.ts';
import { loadSourcesConfig } from '../src/config-file.ts';
import { REPO_ROOT } from '../src/paths.ts';
import { safeLookup } from '../src/verify.ts';

const cfg = loadSourcesConfig(resolve(REPO_ROOT, 'data'));
const UA = 'test-agent';
const STAGING = 'https://gta-florida-api-staging.example.workers.dev';
const TOKEN = 'x'.repeat(40);
const ARTICLE = 'https://www.sunshine-gazette.example/news/lawnmower-123';

const page = (o: { title?: string; canonical?: string; published?: string; extra?: string } = {}) => `<!doctype html><html><head>
<title>Ignored &mdash; Sunshine Gazette</title>
<meta property="og:title" content="${o.title ?? 'Florida man rides lawnmower to the liquor store &amp; back'}">
<meta property="og:site_name" content='Sunshine Gazette'>
${o.published === undefined ? '<meta property="article:published_time" content="2026-11-20T14:00:00Z">' : o.published}
<link rel="canonical" href="${o.canonical ?? 'https://www.sunshine-gazette.example/news/lawnmower-123?utm_source=feed'}">
${o.extra ?? ''}
</head><body><p>Article body that is never kept.</p></body></html>`;

const html = (body: string): ArticleResponse => ({ status: 200, contentType: 'text/html; charset=utf-8', body });
const routes = (map: Record<string, ArticleResponse>) => async (u: URL) => map[u.href] ?? { status: 404 };

describe('article URL policy (before any network access)', () => {
  it('refuses unsafe, aggregator, blocked and non-publisher URLs; accepts unknown publishers', () => {
    const cases: [string, RegExp][] = [
      ['http://www.sunshine-gazette.example/a', /https/],
      ['https://127.0.0.1/a', /private/],
      ['https://169.254.169.254/latest/meta-data', /private/],
      ['https://[::1]/a', /private/],
      ['https://93.184.216.34/a', /bare IP/],
      ['https://localhost/a', /local/],
      ['https://intranet/a', /single-label/],
      ['https://wiki.corp/a', /local/],
      ['https://metadata.google.internal/a', /local/],
      ['https://user:pw@www.sunshine-gazette.example/a', /credentials/],
      ['https://www.sunshine-gazette.example:8443/a', /port/],
      ['https://news.google.com/articles/abc', /aggregator/],
      ['https://www.theonion.com/florida-man', /blocked/],
      ['https://www.grandtheftwiki.com/Liberty_Tree', /gta_wiki/],
      ['not a url', /valid URL/],
    ];
    for (const [url, reason] of cases) expect(articleUrlProblem(url, cfg), url).toMatch(reason);
    expect(articleUrlProblem(ARTICLE, cfg)).toBeNull();
    expect(articleUrlProblem('https://www.tampabay.com/news/florida/2026/11/20/story/', cfg)).toBeNull();
  });

  it('the socket DNS guard refuses names that resolve to non-public addresses', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((done) => safeLookup('localhost', {}, (e) => done(e)));
    expect(err?.code).toBe('EBLOCKED');
  });
});

describe('fetchArticle', () => {
  it('follows same-source redirects and returns the HTML', async () => {
    const r = await fetchArticle('https://sunshine-gazette.example/s/1', {
      cfg,
      userAgent: UA,
      requestImpl: routes({ 'https://sunshine-gazette.example/s/1': { status: 301, location: ARTICLE }, [ARTICLE]: html(page()) }),
    });
    expect(r).toMatchObject({ finalUrl: ARTICLE, httpStatus: 200, redirects: 1 });
  });

  it('re-validates every redirect hop (private IPs, http downgrade, other sources)', async () => {
    const go = (location: string) =>
      fetchArticle(ARTICLE, { cfg, userAgent: UA, requestImpl: routes({ [ARTICLE]: { status: 302, location } }) });
    await expect(go('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/redirect target rejected.*private/);
    await expect(go('http://www.sunshine-gazette.example/x')).rejects.toThrow(/redirect target rejected.*https/);
    await expect(go('https://localhost/admin')).rejects.toThrow(/redirect target rejected.*local/);
    await expect(go('https://other-site.example/x')).rejects.toThrow(/redirect leaves publisher:sunshine-gazette.example/);
  });

  it('refuses non-HTML, HTTP errors and redirect loops', async () => {
    const one = (res: ArticleResponse) => fetchArticle(ARTICLE, { cfg, userAgent: UA, requestImpl: async () => res });
    await expect(one({ status: 200, contentType: 'application/pdf', body: '%PDF' })).rejects.toThrow(/did not return an HTML page/);
    await expect(one({ status: 404 })).rejects.toThrow(/HTTP 404/);
    await expect(one({ status: 429 })).rejects.toThrow(/rate limited/);
    await expect(one({ status: 301, location: ARTICLE })).rejects.toThrow(/more than 5 redirects/);
  });

  it('never sends a request for a refused URL', async () => {
    let calls = 0;
    await expect(fetchArticle('https://10.0.0.5/a', { cfg, userAgent: UA, requestImpl: async () => (calls++, { status: 200 }) })).rejects.toThrow(/private/);
    expect(calls).toBe(0);
  });
});

describe('extractArticleMeta', () => {
  const now = new Date('2026-11-23T00:00:00Z');
  it('extracts title, canonical, date and site name from the head only', () => {
    expect(extractArticleMeta(page(), ARTICLE, now)).toEqual({
      title: 'Florida man rides lawnmower to the liquor store & back',
      canonicalUrl: 'https://www.sunshine-gazette.example/news/lawnmower-123?utm_source=feed',
      publishedAt: '2026-11-20T14:00:00.000Z',
      siteName: 'Sunshine Gazette',
    });
  });

  it('falls back to <title> and JSON-LD datePublished; drops implausible dates', () => {
    const m = extractArticleMeta('<html><head><title>Tampa iguana &amp; the drive-thru</title><script type="application/ld+json">{"datePublished":"2026-11-19T08:00:00-05:00"}</script></head></html>', ARTICLE, now);
    expect(m).toMatchObject({ title: 'Tampa iguana & the drive-thru', publishedAt: '2026-11-19T13:00:00.000Z', canonicalUrl: null });
    expect(extractArticleMeta(page({ published: '<meta property="article:published_time" content="2031-01-01T00:00:00Z">' }), ARTICLE, now).publishedAt).toBeNull();
    expect(extractArticleMeta('<p>no head</p>', ARTICLE, now).title).toBeNull();
  });

  it('ignores a canonical link that points to another source or an unsafe URL', () => {
    const meta = (canonicalUrl: string) => ({ title: 't', canonicalUrl, publishedAt: null, siteName: null });
    expect(chooseCanonical(meta('https://syndicator.example/copy'), ARTICLE, cfg)).toBe(ARTICLE);
    expect(chooseCanonical(meta('http://www.sunshine-gazette.example/x'), ARTICLE, cfg)).toBe(ARTICLE);
    expect(chooseCanonical(meta('https://sunshine-gazette.example/clean'), ARTICLE, cfg)).toBe('https://sunshine-gazette.example/clean');
  });
});

describe('targetProblem (environment guard)', () => {
  it('only writes to the environment that was named', () => {
    expect(targetProblem('staging', STAGING, false)).toBeNull();
    expect(targetProblem('staging', 'https://gta-florida-api-production.example.workers.dev', false)).toMatch(/staging/);
    expect(targetProblem('local', 'http://127.0.0.1:8787', false)).toBeNull();
    expect(targetProblem('local', STAGING, false)).toMatch(/localhost/);
    expect(targetProblem('production', 'https://gta-florida-api-production.example.workers.dev', false)).toMatch(/--allow-production/);
    expect(targetProblem('production', STAGING, true)).toMatch(/must not target/);
    expect(targetProblem('production', 'https://gta-florida-api-production.example.workers.dev', true)).toBeNull();
  });
});

describe('ingest:url command', () => {
  function fakeWorker(o: { knownUrls?: string[]; titles?: { incidentKey: string; title: string; seenAt: string | null }[] } = {}) {
    const imports: { items: ImportItem[]; run?: { provider: string } }[] = [];
    const paths: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      paths.push(`${init?.method ?? 'GET'} ${path}`);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
      if (path.startsWith('/api/v1/admin/titles')) return reply(200, { items: o.titles ?? [], nextCursor: null });
      if (path === '/api/v1/admin/known') return reply(200, { canonicalUrls: (o.knownUrls ?? []).filter((u) => body.canonicalUrls.includes(u)), providerKeys: [] });
      if (path === '/api/v1/admin/import') {
        imports.push(body);
        return reply(200, { replayed: false, results: body.items.map((i: ImportItem) => ({ incidentKey: i.incidentKey, outcome: 'inserted', questionState: 'candidate', gate: { decision: 'review', effective: 'candidate', reasons: ['MANUAL_SUBMISSION'] } })) });
      }
      return reply(404, { error: { code: 'NOT_FOUND', message: path } });
    }) as typeof fetch;
    return { imports, paths, createClient: (opts: { baseUrl: string; token: string; actor: string }) => createWorkerClient({ ...opts, fetchImpl, sleep: async () => {} }) };
  }

  function harness(o: { env?: Record<string, string>; pages?: Record<string, ArticleResponse>; worker?: ReturnType<typeof fakeWorker> } = {}) {
    const lines: string[] = [];
    const worker = o.worker ?? fakeWorker();
    const deps = {
      log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`), error: (m: string) => lines.push(`ERROR ${m}`) },
      env: o.env ?? { INGESTION_API_URL: STAGING, INGESTION_IMPORT_TOKEN: TOKEN, REVIEWER: 'owner' },
      now: () => new Date('2026-11-23T10:00:00Z'),
      cfg,
      requestImpl: routes(o.pages ?? { [ARTICLE]: html(page()) }),
      createClient: worker.createClient,
      ai: createMockAiProvider(),
    };
    return { lines, worker, run: (...argv: string[]) => main(argv, deps) };
  }

  it('imports one article to staging as a manual, unreviewed review candidate', async () => {
    const h = harness();
    expect(await h.run('--env', 'staging', ARTICLE)).toBe(0);
    expect(h.worker.imports).toHaveLength(1);
    const { items, run } = h.worker.imports[0]!;
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(parse(importItemSchema, item).ok).toBe(true);
    expect(item).toMatchObject({
      kind: 'FLORIDA_NEWS',
      reference: {
        provider: 'manual',
        originalUrl: ARTICLE,
        canonicalUrl: 'https://sunshine-gazette.example/news/lawnmower-123', // tracking param + www removed
        originalTitle: 'Florida man rides lawnmower to the liquor store & back',
        publisher: 'sunshine-gazette.example',
        publishedAt: '2026-11-20T14:00:00.000Z',
        linkCheck: { status: 'ok', httpStatus: 200, finalUrl: ARTICLE },
      },
      incident: { floridaSignal: 'title', floridaEvidence: 'Florida' },
      prefilter: { decision: 'candidate' },
    });
    expect(item.fixture).toBeUndefined();
    expect(item.ai).not.toBeNull();
    expect(item.incident.notes).toMatch(/Manual submission \(ingest:url\) by owner[\s\S]*Site name: Sunshine Gazette/);
    expect(run?.provider).toBe('manual');
    expect(h.lines.join('\n')).toMatch(/publisher:sunshine-gazette.example — unreviewed \(not in the registry; the Worker registers it as unreviewed\)/);
    expect(h.lines.join('\n')).toMatch(/inserted → candidate/);
    // Dedupe ran against D1 before importing.
    expect(h.worker.paths).toEqual(expect.arrayContaining(['GET /api/v1/admin/titles?kind=FLORIDA_NEWS', 'POST /api/v1/admin/known']));
  });

  it('--dry-run never imports (with or without Worker credentials)', async () => {
    const withCreds = harness();
    expect(await withCreds.run('--dry-run', ARTICLE)).toBe(0);
    expect(withCreds.worker.imports).toHaveLength(0);
    expect(withCreds.worker.paths.every((p) => !p.includes('/import'))).toBe(true);

    const offline = harness({ env: {} });
    expect(await offline.run('--dry-run', ARTICLE)).toBe(0);
    expect(offline.worker.paths).toEqual([]);
    expect(offline.lines.join('\n')).toMatch(/Dry run: nothing imported/);
  });

  it('skips URLs already stored in D1 (any state)', async () => {
    const h = harness({ worker: fakeWorker({ knownUrls: ['https://sunshine-gazette.example/news/lawnmower-123'] }) });
    expect(await h.run(ARTICLE)).toBe(0);
    expect(h.worker.imports).toHaveLength(0);
    expect(h.lines.join('\n')).toMatch(/Already known/);
  });

  it('refuses before fetching when the URL or the target environment is not allowed', async () => {
    const blocked = harness();
    expect(await blocked.run('https://www.theonion.com/florida-man-1')).toBe(2);
    expect(await blocked.run('https://192.168.1.10/story')).toBe(2);
    expect(blocked.worker.paths).toEqual([]);

    const prod = harness({ env: { INGESTION_API_URL: 'https://gta-florida-api-production.example.workers.dev', INGESTION_IMPORT_TOKEN: TOKEN } });
    expect(await prod.run(ARTICLE)).toBe(2);
    expect(await prod.run('--env', 'production', ARTICLE)).toBe(2);
    expect(prod.worker.paths).toEqual([]);
    expect(prod.lines.join('\n')).toMatch(/--allow-production/);

    const noCreds = harness({ env: {} });
    expect(await noCreds.run(ARTICLE)).toBe(1);
    expect(await harness().run()).toBe(2);
    expect(await harness().run(ARTICLE, 'https://www.sunshine-gazette.example/other')).toBe(2);
  });

  it('does not import items the deterministic prefilter rejects', async () => {
    const h = harness({ pages: { [ARTICLE]: html(page({ title: 'Florida man killed in crash on I-4 overnight' })) } });
    expect(await h.run(ARTICLE)).toBe(2);
    expect(h.worker.imports).toHaveLength(0);
    expect(h.lines.join('\n')).toMatch(/SENSITIVE_TERMS/);
  });

  it('reports fetch failures and pages without a title', async () => {
    const down = harness({ pages: {} });
    expect(await down.run(ARTICLE)).toBe(1);
    const noTitle = harness({ pages: { [ARTICLE]: html('<html><head></head><body>x</body></html>') } });
    expect(await noTitle.run(ARTICLE)).toBe(2);
    expect(down.worker.imports.length + noTitle.worker.imports.length).toBe(0);
  });
});
