import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourcePolicy } from '@gof/core';
import { sourceById } from '@gof/config';
import { allowedFeeds, checkRobots, fetchFeedConditional, parseFeed, type FeedConfig } from '../src/adapters/rss.ts';
import { createBudget, createMockAiProvider } from '../src/classify.ts';
import { loadSourcesConfig } from '../src/config-file.ts';
import { discoverGdelt, discoverRss, gdeltCooldownMs, type Log } from '../src/discover.ts';
import { REPO_ROOT } from '../src/paths.ts';
import { processDiscovered } from '../src/pipeline.ts';
import { productToken, robotsAllows, robotsVerdictFor } from '../src/robots.ts';

// All fixtures are synthetic (no publisher text).
const cfg = loadSourcesConfig(resolve(REPO_ROOT, 'data'));
const UA = 'gta-or-florida-ingest/0.4 (test)';
const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} };

const src = (id: string, host: string, o: Partial<SourcePolicy> = {}): SourcePolicy => ({
  id,
  type: 'publisher',
  name: host,
  hosts: [host],
  licenseStatus: 'unreviewed',
  canUseEditorialSummary: false,
  canDisplayOriginalTitle: false,
  autoPublishAllowed: false,
  ...o,
});
const ALLOWED = { status: 'allowed' as const, basis: ['https://news-a.example/rss/'], reviewedBy: 'owner', reviewedAt: '2026-11-23' };

function item(i: number, o: { title?: string; host?: string; date?: string; heavy?: boolean } = {}) {
  const host = o.host ?? 'news-a.example';
  return `<item><title><![CDATA[${o.title ?? `Florida man ${i} rides a lawnmower to the liquor store`} &amp; more]]></title>
<link>https://${host}/story/${i}/</link><pubDate>${o.date ?? 'Mon, 23 Nov 2026 10:00:00 GMT'}</pubDate><guid isPermaLink="false">g-${i}</guid>
<media:title>not the title</media:title>
${o.heavy ? `<content:encoded><![CDATA[${'<p>Synthetic paragraph with a <title>fake</title> tag and &amp; entity.</p>'.repeat(400)}]]></content:encoded>` : '<description>synthetic summary never kept</description>'}
</item>`;
}
const rss = (items: string[]) => `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Synthetic</title>${items.join('')}</channel></rss>`;

describe('parseFeed', () => {
  it('reads RSS metadata only (title, link, date, guid), decoding CDATA/entities and ignoring <media:title>', () => {
    expect(parseFeed(rss([item(1)]))).toEqual([{ title: 'Florida man 1 rides a lawnmower to the liquor store & more', link: 'https://news-a.example/story/1/', publishedAt: '2026-11-23', guid: 'g-1' }]);
  });

  it('reads Atom entries with <link href> and <updated>', () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Tampa iguana &lt;b&gt;escapes&lt;/b&gt;</title><link rel="alternate" href="https://news-a.example/a/2"/><id>tag:x,2026:2</id><updated>2026-11-22T08:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom)).toEqual([{ title: 'Tampa iguana escapes', link: 'https://news-a.example/a/2', publishedAt: '2026-11-22', guid: 'tag:x,2026:2' }]);
  });

  it('is not confused by embedded article bodies and stays fast on large feeds', () => {
    const big = rss(Array.from({ length: 50 }, (_, i) => item(i, { heavy: true })));
    expect(big.length).toBeGreaterThan(1_000_000);
    const t = performance.now();
    const items = parseFeed(big);
    expect(performance.now() - t).toBeLessThan(100); // warm/cold in CI; a few ms on a dev machine
    expect(items).toHaveLength(50);
    expect(items[7]!.title).toBe('Florida man 7 rides a lawnmower to the liquor store & more');
  });

  it('skips malformed items, drops a truncated last item, caps the count and refuses inline DTDs', () => {
    const doc = rss([item(1), '<item><title>no link here</title></item>', item(3)]);
    expect(parseFeed(doc).map((i) => i.guid)).toEqual(['g-1', 'g-3']);
    expect(parseFeed(doc.slice(0, doc.lastIndexOf('</item>'))).map((i) => i.guid)).toEqual(['g-1']);
    expect(parseFeed(rss(Array.from({ length: 30 }, (_, i) => item(i))), 5)).toHaveLength(5);
    expect(parseFeed(`<!DOCTYPE rss [<!ENTITY x "boom">]>${rss([item(1)])}`)).toEqual([]);
  });
});

describe('robots.txt (RFC 9309)', () => {
  const txt = `User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nAllow: /private/feed$\nDisallow: /*?amp=1\n\nUser-agent: gta-or-florida\nDisallow: /feed/\nAllow: /feed/ok\n`;
  it('uses the most specific matching group, longest rule, allow on ties', () => {
    expect(robotsAllows(txt, 'gptbot', '/feed/')).toMatchObject({ allowed: false });
    expect(robotsAllows(txt, 'other-bot', '/feed/')).toMatchObject({ allowed: true });
    expect(robotsAllows(txt, 'other-bot', '/private/x')).toMatchObject({ allowed: false });
    expect(robotsAllows(txt, 'other-bot', '/private/feed')).toMatchObject({ allowed: true });
    expect(robotsAllows(txt, 'other-bot', '/private/feed/x')).toMatchObject({ allowed: false }); // $ anchor
    expect(robotsAllows(txt, 'other-bot', '/news?amp=1')).toMatchObject({ allowed: false }); // * wildcard
    expect(robotsAllows(txt, 'gta-or-florida-ingest', '/feed/')).toMatchObject({ allowed: false }); // prefix group
    expect(robotsAllows(txt, 'gta-or-florida-ingest', '/feed/ok')).toMatchObject({ allowed: true });
    expect(robotsAllows('User-agent: *\nDisallow:\n', 'x', '/anything')).toMatchObject({ allowed: true });
    expect(productToken(UA)).toBe('gta-or-florida-ingest');
  });
  it('maps fetch outcomes: 4xx = no restrictions, 5xx / network = fail closed', () => {
    expect(robotsVerdictFor({ status: 404 }, 'x', '/feed/').allowed).toBe(true);
    expect(robotsVerdictFor({ status: 503 }, 'x', '/feed/').allowed).toBe(false);
    expect(robotsVerdictFor({ error: 'ECONNRESET' }, 'x', '/feed/').allowed).toBe(false);
  });
});

describe('feed allowlist (owner policy)', () => {
  const feed = (id: string, sourceId: string, url = `https://news-a.example/feed/`): FeedConfig => ({ id, sourceId, url });
  it('fetches only owner-allowed or rights-approved feeds, on the source host', () => {
    const sources: Record<string, SourcePolicy> = {
      unreviewed: src('unreviewed', 'news-a.example'),
      allowed: src('allowed', 'news-a.example', { feedAccess: ALLOWED }),
      denied: src('denied', 'news-a.example', { feedAccess: { status: 'denied', reviewedBy: 'owner', reviewedAt: '2026-11-23' } }),
      approved: src('approved', 'news-a.example', { licenseStatus: 'approved', canUseEditorialSummary: true, reviewedBy: 'owner', reviewedAt: '2026-11-01' }),
      blocked: src('blocked', 'news-a.example', { licenseStatus: 'blocked', feedAccess: ALLOWED }),
    };
    const { allowed, refused } = allowedFeeds(
      [feed('u', 'unreviewed'), feed('a', 'allowed'), feed('d', 'denied'), feed('p', 'approved'), feed('b', 'blocked'), feed('x', 'missing'), feed('h', 'allowed', 'https://elsewhere.example/feed/'), feed('s', 'allowed', 'http://news-a.example/feed/')],
      (id) => sources[id],
    );
    expect(allowed.map((f) => f.id)).toEqual(['a', 'p']);
    expect(Object.fromEntries(refused.map((r) => [r.id, r.reason]))).toEqual({
      u: 'unreviewed: feed access not reviewed',
      d: 'denied: feed access denied by the owner',
      b: 'blocked: source is blocked',
      x: 'unknown source missing',
      h: 'feed URL is not https on the source host',
      s: 'feed URL is not https on the source host',
    });
  });

  it('ships with every configured Florida feed inert until the owner reviews feed access', () => {
    expect(cfg.rss!.length).toBeGreaterThanOrEqual(5);
    const { allowed, refused } = allowedFeeds(cfg.rss!, (id) => sourceById(id));
    expect(allowed).toEqual([]);
    expect(refused.every((r) => /feed access not reviewed/.test(r.reason))).toBe(true);
  });
});

// ------------------------------------------------------------------ simulated publishers
type Route = { status: number; body?: string; headers?: Record<string, string> };
function web(routes: Record<string, Route | ((init: RequestInit) => Route)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (input: string, init: RequestInit) => {
    calls.push({ url: input, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const r = routes[input];
    const route = typeof r === 'function' ? r(init) : (r ?? { status: 404 });
    return new Response(route.status === 304 ? null : (route.body ?? ''), { status: route.status, headers: route.headers });
  };
  return { calls, fetchImpl };
}
const XML = { 'content-type': 'application/rss+xml; charset=UTF-8' };

describe('fetchFeedConditional', () => {
  const feed: FeedConfig = { id: 'a', sourceId: 'allowed', url: 'https://news-a.example/feed/' };
  it('returns items + validators, sends them back, and handles 304', async () => {
    const w = web({
      'https://news-a.example/feed/': (init) =>
        new Headers(init.headers).get('if-none-match') === '"v1"' ? { status: 304 } : { status: 200, body: rss([item(1)]), headers: { ...XML, etag: '"v1"', 'last-modified': 'Mon, 23 Nov 2026 10:00:00 GMT' } },
    });
    const first = await fetchFeedConditional(feed, ['news-a.example'], { fetchImpl: w.fetchImpl, userAgent: UA });
    expect(first).toMatchObject({ status: 'ok', etag: '"v1"', lastModified: 'Mon, 23 Nov 2026 10:00:00 GMT', truncated: false });
    const second = await fetchFeedConditional(feed, ['news-a.example'], { fetchImpl: w.fetchImpl, userAgent: UA, etag: '"v1"', lastModified: 'Mon, 23 Nov 2026 10:00:00 GMT' });
    expect(second).toEqual({ status: 'not_modified' });
    expect(w.calls[1]!.headers).toMatchObject({ 'if-none-match': '"v1"', 'if-modified-since': 'Mon, 23 Nov 2026 10:00:00 GMT', 'user-agent': UA });
  });

  it('fails clearly on 429, 5xx, HTML pages and redirects off the source; follows same-source redirects', async () => {
    const go = (r: Route, extra: Record<string, Route> = {}) =>
      fetchFeedConditional(feed, ['news-a.example'], { fetchImpl: web({ 'https://news-a.example/feed/': r, ...extra }).fetchImpl, userAgent: UA });
    await expect(go({ status: 429 })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(go({ status: 503 })).rejects.toMatchObject({ kind: 'http', status: 503 });
    await expect(go({ status: 200, body: '<html></html>', headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'not_feed' });
    await expect(go({ status: 301, headers: { location: 'https://tracker.example/feed' } })).rejects.toMatchObject({ kind: 'redirect' });
    await expect(go({ status: 302, headers: { location: 'http://news-a.example/feed/' } })).rejects.toMatchObject({ kind: 'redirect' });
    const ok = await go({ status: 301, headers: { location: 'https://www.news-a.example/feed/' } }, { 'https://www.news-a.example/feed/': { status: 200, body: rss([item(1)]), headers: XML } });
    expect(ok).toMatchObject({ status: 'ok' });
  });

  it('truncates oversized feeds to whole items', async () => {
    const body = rss(Array.from({ length: 20 }, (_, i) => item(i)));
    const r = await fetchFeedConditional(feed, ['news-a.example'], { fetchImpl: web({ 'https://news-a.example/feed/': { status: 200, body, headers: XML } }).fetchImpl, userAgent: UA, maxChars: Math.floor(body.length / 2) });
    expect(r).toMatchObject({ status: 'ok', truncated: true });
    expect((r as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect((r as { items: unknown[] }).items.length).toBeLessThan(20);
  });

  it('checks robots.txt for our product token', async () => {
    const w = web({ 'https://news-a.example/robots.txt': { status: 200, body: 'User-agent: gta-or-florida-ingest\nDisallow: /feed/\n' } });
    expect(await checkRobots('https://news-a.example/feed/', ['news-a.example'], { fetchImpl: w.fetchImpl, userAgent: UA })).toMatchObject({ allowed: false });
  });
});

describe('discoverRss', () => {
  const sources: Record<string, SourcePolicy> = {
    a: src('a', 'news-a.example', { feedAccess: ALLOWED }),
    b: src('b', 'news-b.example', { feedAccess: { ...ALLOWED, aiClassification: true } }),
    c: src('c', 'news-c.example', { feedAccess: ALLOWED }),
  };
  const feeds: FeedConfig[] = [
    { id: 'fa', sourceId: 'a', url: 'https://news-a.example/feed/', region: 'Tampa Bay' },
    { id: 'fb', sourceId: 'b', url: 'https://news-b.example/feed/' },
    { id: 'fc', sourceId: 'c', url: 'https://news-c.example/feed/' },
  ];
  const routes = (o: { robotsA?: Route; feedB?: Route } = {}) => ({
    'https://news-a.example/robots.txt': o.robotsA ?? { status: 200, body: 'User-agent: *\nDisallow: /private/\n' },
    'https://news-b.example/robots.txt': { status: 404 },
    'https://news-c.example/robots.txt': { status: 404 },
    'https://news-a.example/feed/': {
      status: 200,
      headers: { ...XML, etag: '"a1"' },
      // One off-source link (syndication / redirector) must be dropped.
      body: rss([item(1), item(2, { host: 'aggregator.example', title: 'Florida man 2 at another outlet entirely' })]),
    },
    'https://news-b.example/feed/': o.feedB ?? { status: 200, headers: { ...XML, 'last-modified': 'Mon, 23 Nov 2026 09:00:00 GMT' }, body: rss([item(3, { host: 'news-b.example' })]) },
    'https://news-c.example/feed/': { status: 200, headers: XML, body: rss([item(4, { host: 'news-c.example', title: 'Miami deputies rescue iguana from frozen palm tree' })]) },
  });

  it('collects metadata from allowed feeds, maps items to their own publisher, and stores one cache checkpoint per feed', async () => {
    const w = web(routes());
    const r = await discoverRss(cfg, { userAgent: UA, fetchImpl: w.fetchImpl, lookup: (id) => sources[id], feeds, log: quiet });
    expect(r.errors).toEqual([]);
    expect(r.items.map((i) => [i.provider, i.canonicalUrl, i.providerKey, i.aiAllowed])).toEqual([
      ['rss', 'https://news-a.example/story/1', 'news-a.example:g-1', false],
      ['rss', 'https://news-b.example/story/3', 'news-b.example:g-3', undefined],
      ['rss', 'https://news-c.example/story/4', 'news-c.example:g-4', false],
    ]);
    expect(r.items[0]!.notes).toMatch(/Feed: fa \(Tampa Bay\)[\s\S]*AI not run/);
    expect(r.items[0]!.floridaSignal).toBe('title');
    expect(r.checkpoints).toEqual([
      { provider: 'rss', key: 'cache:fa', value: JSON.stringify({ etag: '"a1"', lastModified: null }) },
      { provider: 'rss', key: 'cache:fb', value: JSON.stringify({ etag: null, lastModified: 'Mon, 23 Nov 2026 09:00:00 GMT' }) },
    ]);
    // robots first, then the feed; never any article page.
    expect(w.calls.map((c) => c.url)).toEqual(feeds.flatMap((f) => [`${new URL(f.url).origin}/robots.txt`, f.url]));
  });

  it('isolates failures: robots disallow or 5xx on one feed does not stop the others', async () => {
    const w = web(routes({ robotsA: { status: 503 }, feedB: { status: 500 } }));
    const r = await discoverRss(cfg, { userAgent: UA, fetchImpl: w.fetchImpl, lookup: (id) => sources[id], feeds, log: quiet });
    expect(r.errors).toEqual([expect.stringMatching(/^rss:fa: robots\.txt disallows .*fail closed/), 'rss:fb: fb: HTTP 500']);
    expect(w.calls.some((c) => c.url === 'https://news-a.example/feed/')).toBe(false); // never fetched after robots refused
    expect(r.items.map((i) => i.providerKey)).toEqual(['news-c.example:g-4']);
  });

  it('sends saved validators and yields nothing on 304', async () => {
    const w = web({ ...routes(), 'https://news-a.example/feed/': { status: 304 } });
    const r = await discoverRss(cfg, { userAgent: UA, fetchImpl: w.fetchImpl, lookup: (id) => sources[id], feeds: [feeds[0]!], checkpoint: new Map([['cache:fa', JSON.stringify({ etag: '"a1"', lastModified: null })]]), log: quiet });
    expect(r.items).toEqual([]);
    expect(r.checkpoints).toEqual([]);
    expect(w.calls[1]!.headers['if-none-match']).toBe('"a1"');
  });

  it('dedupes across feeds and against D1, and attaches another outlet’s report of the same incident', async () => {
    const same = 'Florida man rides a lawnmower to the liquor store again';
    const two = web({
      'https://news-a.example/robots.txt': { status: 404 },
      'https://news-b.example/robots.txt': { status: 404 },
      'https://news-a.example/feed/': { status: 200, headers: XML, body: rss([item(1, { title: same }), item(9, { title: 'Key West rooster crows at the county commission meeting' })]) },
      'https://news-b.example/feed/': { status: 200, headers: XML, body: rss([item(5, { host: 'news-b.example', title: `Again: ${same}` })]) },
    });
    const r = await discoverRss(cfg, { userAgent: UA, fetchImpl: two.fetchImpl, lookup: (id) => sources[id], feeds: feeds.slice(0, 2), log: quiet });
    const known = { canonicalUrls: ['https://news-a.example/story/9'], providerKeys: [] as string[] };
    const client = { known: async () => known } as never;
    const { items, stats } = await processDiscovered([...r.items, ...r.items], { client, ai: createMockAiProvider(), budget: createBudget(), checkLink: null, maxLinkChecks: 0, aiConcurrency: 1 });
    expect(stats.duplicates).toBe(3 + 1); // 3 in-run repeats + the story already in D1
    expect(items.map((i) => [i.reference.canonicalUrl, i.attachToIncidentKey ?? null])).toEqual([
      ['https://news-a.example/story/1', null],
      ['https://news-b.example/story/5', items[0]!.incidentKey],
    ]);
    // Source "a" has no AI permission; "b" does but the item attaches (no AI for attachments).
    expect(items.every((i) => i.ai === null)).toBe(true);
  });
});

describe('GDELT fallback cooldown', () => {
  const gdeltUrl = (u: URL) => u.hostname === 'api.gdeltproject.org';
  function gdelt(status: number) {
    const calls: string[] = [];
    const fetchImpl = async (u: URL) => {
      calls.push(u.toString());
      if (!gdeltUrl(u)) throw new Error('unexpected');
      return status === 200
        ? new Response(JSON.stringify({ articles: [{ url: 'https://news-a.example/x', title: 'Florida man and the very large pizza delivery', domain: 'news-a.example', seendate: '20261123T100000Z' }] }), { status })
        : new Response('', { status });
    };
    return { calls, fetchImpl: fetchImpl as never };
  }
  const now = new Date('2026-11-23T05:17:00.000Z');
  const opts = (cp: Record<string, string>, f: ReturnType<typeof gdelt>, at = now) => ({ checkpoint: new Map(Object.entries(cp)), queries: 3, userAgent: UA, fetchImpl: f.fetchImpl, sleep: async () => {}, log: quiet, now: at });

  it('stops at the first 429 (no retry, no further queries) and sets an escalating cooldown', async () => {
    const f = gdelt(429);
    const r = await discoverGdelt(cfg, opts({}, f));
    expect(f.calls).toHaveLength(1);
    expect(r.rateLimited).toBe(true);
    expect(r.checkpoints).toEqual([]); // query cursor not advanced
    expect(r.guards).toEqual([
      { provider: 'gdelt', key: 'strikes', value: '1' },
      { provider: 'gdelt', key: 'cooldownUntil', value: '2026-11-23T11:17:00.000Z' },
    ]);
    const again = await discoverGdelt(cfg, opts({ strikes: '1' }, gdelt(429), new Date('2026-11-23T12:00:00Z')));
    expect(again.guards![1]!.value).toBe('2026-11-24T00:00:00.000Z'); // 12 h
    expect([1, 2, 3, 4, 5, 9].map((s) => gdeltCooldownMs(s) / 3600_000)).toEqual([6, 12, 24, 48, 48, 48]);
  });

  it('makes no request at all during the cooldown', async () => {
    const f = gdelt(200);
    const r = await discoverGdelt(cfg, opts({ strikes: '1', cooldownUntil: '2026-11-23T11:17:00.000Z' }, f, new Date('2026-11-23T11:00:00Z')));
    expect(f.calls).toEqual([]);
    expect(r.skipped).toMatch(/cooldown until 2026-11-23T11:17:00.000Z/);
  });

  it('resets the cooldown after a successful query', async () => {
    const f = gdelt(200);
    const r = await discoverGdelt(cfg, opts({ strikes: '2', cooldownUntil: '2026-11-23T01:00:00.000Z' }, f));
    expect(r.items).toHaveLength(3);
    expect(r.guards).toEqual([
      { provider: 'gdelt', key: 'strikes', value: '0' },
      { provider: 'gdelt', key: 'cooldownUntil', value: '' },
    ]);
  });
});

describe('AI permission follows the publisher, not the discovery channel', () => {
  it('skips AI for GDELT items from publishers whose researched terms restrict AI (aiClassification: false)', async () => {
    const rec = (url: string, title: string) => ({
      kind: 'FLORIDA_NEWS' as const, provider: 'gdelt' as const, providerKey: null, title, originalUrl: url, canonicalUrl: url, publisher: null,
      publishedAt: null, seenAt: '2026-11-20T00:00:00Z', excerpt: '', gameHint: null, wikiPageId: null, wikiSection: null,
      floridaSignal: 'title' as const, floridaEvidence: 'Florida', notes: null, prefilter: { decision: 'candidate' as const, reasonCodes: [] },
    });
    const { items } = await processDiscovered(
      [rec('https://www.tampabay.com/news/a/1', 'Florida man rides a lawnmower to the liquor store'), rec('https://unknown-outlet.example.net/b/2', 'Florida woman walks a pet iguana through the bank lobby')],
      { client: null, ai: createMockAiProvider(), budget: createBudget(), checkLink: null, maxLinkChecks: 0, aiConcurrency: 1 },
    );
    expect(items.map((i) => [i.reference.canonicalUrl, i.ai === null])).toEqual([
      ['https://www.tampabay.com/news/a/1', true], // registry: feedAccess.aiClassification false (terms restrict AI)
      ['https://unknown-outlet.example.net/b/2', false],
    ]);
  });
});
