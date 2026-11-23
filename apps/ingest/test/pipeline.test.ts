import { describe, expect, it } from 'vitest';
import { importItemSchema, parse, type ImportItem, type LinkCheck } from '@gof/core';
import { allowedFeeds, parseFeed } from '../src/adapters/rss.ts';
import { createBudget, createMockAiProvider } from '../src/classify.ts';
import { createRunDeduper } from '../src/deduplicate.ts';
import { floridaEvidence, prefilterFlorida } from '../src/filters.ts';
import { createWorkerClient, normalizeBaseUrl } from '../src/import.ts';
import { processDiscovered, type Discovered } from '../src/pipeline.ts';

const PLACES = ['Florida', 'Tampa', 'Miami'];
function fl(i: number, title: string, o: Partial<Discovered> = {}): Discovered {
  const url = `https://news.example.org/story-${i}`;
  return {
    kind: 'FLORIDA_NEWS',
    provider: 'gdelt',
    providerKey: null,
    title,
    originalUrl: url,
    canonicalUrl: url,
    publisher: 'news.example.org',
    publishedAt: null,
    seenAt: '2026-11-20T00:00:00Z',
    excerpt: '',
    gameHint: null,
    wikiPageId: null,
    wikiSection: null,
    floridaSignal: 'title',
    floridaEvidence: floridaEvidence(title, PLACES),
    notes: null,
    prefilter: prefilterFlorida({ title, domain: 'news.example.org', floridaSignal: /florida|tampa|miami/i.test(title) ? 'title' : 'none', blockedDomains: ['theonion.com'] }),
    ...o,
  };
}

describe('deterministic filters', () => {
  it('rejects tragedies, routine news, satire and items with no Florida signal', () => {
    const f = (title: string, domain = 'news.example.org', signal: 'title' | 'none' = 'title') => prefilterFlorida({ title, domain, floridaSignal: signal, blockedDomains: ['theonion.com'] }).reasonCodes;
    expect(f('Florida man killed in crash on I-4 overnight')).toContain('SENSITIVE_TERMS');
    expect(f('Florida governor signs bill on property taxes')).toContain('ROUTINE_NEWS');
    expect(f('Florida man elected king of the swamp', 'theonion.com')).toContain('SATIRE_OR_BLOCKED_DOMAIN');
    expect(f('Man rides lawnmower to the liquor store', 'news.example.org', 'none')).toContain('NO_FLORIDA_SIGNAL');
    expect(f('Florida man rides lawnmower to the liquor store again')).toEqual([]);
    expect(f('Dolphins spotted escorting a paddleboarder in Florida bay')).toEqual([]); // animals aren't the NFL team
  });
});

describe('incident dedupe', () => {
  it('attaches near-identical Florida reports within the window and flags old look-alikes instead', () => {
    const d = createRunDeduper([{ incidentKey: 'fl:a', title: 'Florida man arrested for riding alligator to school', seenAt: '2026-11-18' }]);
    expect(d.check({ kind: 'FLORIDA_NEWS', title: 'Florida man arrested for riding an alligator to school', canonicalUrl: 'https://x.example.org/1', seenAt: '2026-11-20' })).toMatchObject({ kind: 'attach', incidentKey: 'fl:a' });
    // Same stunt a year later is a different incident: a human decides.
    expect(d.check({ kind: 'FLORIDA_NEWS', title: 'Florida man arrested for riding an alligator to school', canonicalUrl: 'https://x.example.org/2', seenAt: '2027-11-20' })).toMatchObject({ kind: 'review' });
    // Distinct incidents with merely similar wording are not merged.
    expect(d.check({ kind: 'FLORIDA_NEWS', title: 'Florida woman cited for walking pet iguana through bank', canonicalUrl: 'https://x.example.org/3', seenAt: '2026-11-20' }).kind).toBe('new');
  });
});

describe('RSS', () => {
  it('parses RSS and Atom metadata only, stripping markup and refusing DTDs', () => {
    const rss = `<rss><channel><item><title><![CDATA[Florida man <b>does</b> thing &amp; more]]></title><link>https://news.example.org/a</link><pubDate>Fri, 20 Nov 2026 10:00:00 GMT</pubDate><guid>g1</guid><description>body we never keep</description></item></channel></rss>`;
    expect(parseFeed(rss)).toEqual([{ title: 'Florida man does thing & more', link: 'https://news.example.org/a', publishedAt: '2026-11-20', guid: 'g1' }]);
    const atom = `<feed><entry><title>Tampa oddity</title><link href="https://news.example.org/b"/><updated>2026-11-21T00:00:00Z</updated><id>tag:b</id></entry></feed>`;
    expect(parseFeed(atom)[0]).toMatchObject({ link: 'https://news.example.org/b', publishedAt: '2026-11-21' });
    expect(parseFeed('<!DOCTYPE x [<!ENTITY a "b">]><rss><item><title>x</title><link>https://a.example.org</link></item></rss>')).toEqual([]);
  });

  it('only fetches feeds of approved sources on their own host', () => {
    const approved = { id: 'publisher:news.example.org', type: 'publisher' as const, name: 'n', hosts: ['news.example.org'], licenseStatus: 'approved' as const, canUseEditorialSummary: true, canDisplayOriginalTitle: false, autoPublishAllowed: false, reviewedBy: 'o', reviewedAt: '2026-11-01' };
    const lookup = (id: string) => (id === approved.id ? approved : id === 'publisher:other.example.org' ? { ...approved, id, licenseStatus: 'unreviewed' as const } : undefined);
    const r = allowedFeeds(
      [
        { id: 'ok', url: 'https://news.example.org/feed', sourceId: approved.id },
        { id: 'unreviewed', url: 'https://other.example.org/feed', sourceId: 'publisher:other.example.org' },
        { id: 'offhost', url: 'https://evil.example.net/feed', sourceId: approved.id },
        { id: 'unknown', url: 'https://x.example.org/feed', sourceId: 'nope' },
      ],
      lookup,
    );
    expect(r.allowed.map((f) => f.id)).toEqual(['ok']);
    expect(r.refused.map((f) => f.id)).toEqual(['unreviewed', 'offhost', 'unknown']);
  });
});

describe('processDiscovered', () => {
  const okLink = async (u: string): Promise<LinkCheck> => ({ status: 'ok', httpStatus: 200, finalUrl: u, checkedAt: '2026-11-22T00:00:00.000Z' });

  it('produces schema-valid import items: dedupes, keeps prefilter rejections (as rejections), classifies the rest', async () => {
    const found = [
      fl(1, 'Florida man rides lawnmower through Tampa drive-thru'),
      fl(1, 'Florida man rides lawnmower through Tampa drive-thru'), // same URL
      fl(2, 'Florida man killed in crash on the interstate'),
      fl(3, 'Miami woman walks pet iguana through a bank lobby'),
    ];
    const { items, stats } = await processDiscovered(found, { client: null, ai: createMockAiProvider(), budget: createBudget(), checkLink: okLink, maxLinkChecks: 10, aiConcurrency: 2 });
    expect(stats).toMatchObject({ discovered: 4, duplicates: 1, prefilterRejected: 1, linkChecked: 2, aiClassified: 2 });
    expect(items).toHaveLength(3);
    for (const it of items) expect(parse(importItemSchema, it).ok).toBe(true);
    const rejected = items.find((i) => i.prefilter.decision === 'reject')!;
    expect(rejected.ai).toBeNull();
    expect(rejected.reference.linkCheck).toBeNull();
    // GDELT seendate is discovery time, never a publication date.
    expect(items.every((i) => i.reference.publishedAt === null)).toBe(true);
  });

  it('asks the Worker which items it already has and skips them', async () => {
    const calls: string[] = [];
    const client = { known: async (urls: string[]) => (calls.push('known'), { canonicalUrls: urls.slice(0, 1), providerKeys: [] }) } as never;
    const { items, stats } = await processDiscovered([fl(1, 'Florida man rides lawnmower through Tampa drive-thru'), fl(2, 'Miami woman walks pet iguana through a bank lobby')], {
      client,
      ai: null,
      budget: createBudget(),
      checkLink: null,
      maxLinkChecks: 0,
      aiConcurrency: 1,
    });
    expect(calls).toEqual(['known']);
    expect(stats.duplicates).toBe(1);
    expect(items.map((i) => i.reference.canonicalUrl)).toEqual(['https://news.example.org/story-2']);
  });
});

describe('Worker client', () => {
  it('requires https (http only on localhost) and a long token', () => {
    expect(normalizeBaseUrl('https://api.example.org/api/v1/admin/import')).toBe('https://api.example.org');
    expect(normalizeBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => normalizeBaseUrl('http://api.example.org')).toThrow(/https/);
    expect(() => createWorkerClient({ baseUrl: 'https://api.example.org', token: 'short' })).toThrow(/token/);
  });

  it('chunks imports with deterministic idempotency keys, retries 5xx, sends checkpoints only on the last chunk', async () => {
    const sent: { key: string; body: { items: unknown[]; checkpoints?: unknown } }[] = [];
    let fail = 1;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (fail-- > 0) return new Response('{}', { status: 503 });
      const body = JSON.parse(String(init.body));
      sent.push({ key: (init.headers as Record<string, string>)['idempotency-key']!, body });
      return new Response(JSON.stringify({ results: body.items.map(() => ({ incidentKey: 'k', outcome: 'inserted' })), replayed: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createWorkerClient({ baseUrl: 'https://api.example.org', token: 'x'.repeat(40), fetchImpl, sleep: async () => {} });
    const items = Array.from({ length: 45 }, () => ({}) as ImportItem);
    const results = await client.importItems('run_1', items, undefined, [{ provider: 'gdelt', key: 'nextBatchIndex', value: '3' }]);
    expect(results).toHaveLength(45);
    expect(sent.map((s) => s.body.items.length)).toEqual([20, 20, 5]);
    expect(sent.map((s) => s.body.checkpoints === undefined)).toEqual([true, true, false]);
    expect(sent[0]!.key).toMatch(/^run_1:0:[a-f0-9]{16}$/);
    // The retried first request reused the same key (deterministic from content).
    expect(new Set(sent.map((s) => s.key)).size).toBe(3);
  });

  it('does not retry 4xx', async () => {
    let n = 0;
    const fetchImpl = (async () => (n++, new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no' } }), { status: 401 }))) as unknown as typeof fetch;
    const client = createWorkerClient({ baseUrl: 'https://api.example.org', token: 'x'.repeat(40), fetchImpl, sleep: async () => {} });
    await expect(client.stats()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(n).toBe(1);
  });
});
