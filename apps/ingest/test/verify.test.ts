import { describe, expect, it } from 'vitest';
import { checkLink, isBlockedAddress, unsafeUrlReason } from '../src/verify.ts';
import { cleanText, createFloridaSignal, normalizePublisherUrl, selectBatches } from '../src/normalize.ts';

describe('SSRF guard', () => {
  it('blocks loopback, private, link-local, CGNAT, metadata and IPv6 local ranges', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '2606:4700:4700::1111']) expect(isBlockedAddress(a), a).toBe(false);
  });

  it('rejects unsafe URL shapes before any network access', () => {
    expect(unsafeUrlReason('http://news.example.test/a')).toMatch(/https/);
    expect(unsafeUrlReason('https://127.0.0.1/a')).toMatch(/private/);
    expect(unsafeUrlReason('https://8.8.8.8/a')).toMatch(/bare IP/);
    expect(unsafeUrlReason('https://localhost/a')).toMatch(/local/);
    expect(unsafeUrlReason('https://user:pw@news.example.test/')).toMatch(/credentials/);
    expect(unsafeUrlReason('https://news.example.test:8443/')).toMatch(/port/);
    expect(unsafeUrlReason('https://news.example.test/a')).toBeNull();
  });

  it('re-validates every redirect hop', async () => {
    const hops: Record<string, { status: number; location?: string }> = {
      'https://news.example.test/a': { status: 301, location: '/b' },
      'https://news.example.test/b': { status: 302, location: 'https://169.254.169.254/latest/meta-data' },
    };
    const r = await checkLink('https://news.example.test/a', { requestImpl: async (u) => hops[u.toString()]! });
    expect(r).toMatchObject({ status: 'broken' });
    expect((r as { reason: string }).reason).toMatch(/redirect target rejected: private/);
  });

  it('follows safe redirects, falls back from HEAD to GET, and reports HTTP errors', async () => {
    const seen: string[] = [];
    const ok = await checkLink('https://news.example.test/a', {
      requestImpl: async (u, m) => {
        seen.push(`${m} ${u.pathname}`);
        if (u.pathname === '/a') return { status: 301, location: '/final' };
        return m === 'HEAD' ? { status: 405 } : { status: 200 };
      },
    });
    expect(ok).toEqual({ status: 'ok', finalUrl: 'https://news.example.test/final', httpStatus: 200, redirects: 1 });
    expect(seen).toEqual(['HEAD /a', 'HEAD /final', 'GET /final']);
    expect(await checkLink('https://news.example.test/gone', { requestImpl: async () => ({ status: 404 }) })).toMatchObject({ status: 'broken', reason: 'HTTP 404' });
    const loop = await checkLink('https://news.example.test/x', { maxRedirects: 2, requestImpl: async () => ({ status: 302, location: '/x' }) });
    expect(loop).toMatchObject({ status: 'broken' });
  });
});

describe('normalization', () => {
  it('canonicalizes publisher URLs and refuses aggregator links', () => {
    expect(normalizePublisherUrl('https://WWW.News.example.test/story/?utm_source=a&id=4&fbclid=z')).toBe('https://news.example.test/story?id=4');
    expect(normalizePublisherUrl('https://news.example.test/story/amp/')).toBe('https://news.example.test/story');
    expect(normalizePublisherUrl('https://news.google.com/rss/articles/abc')).toBeNull();
    expect(normalizePublisherUrl('javascript:alert(1)')).toBeNull();
  });

  it('cleans untrusted text', () => {
    expect(cleanText('a\u0000b‮c\n  d', 100)).toBe('a b c d');
    expect(cleanText('x'.repeat(50), 10)).toHaveLength(10);
    expect(cleanText(42, 10)).toBe('');
  });

  it('florida signal is a heuristic from title or domain', () => {
    const signal = createFloridaSignal({ floridaPlaceNames: ['florida', 'key west'], domains: { blocked: { list: [] }, floridaHints: { list: ['tampabay.example.test'] } } });
    expect(signal({ title: 'Man in Key West does X', domain: 'a.test' })).toBe('title');
    expect(signal({ title: 'Man does X', domain: 'www.tampabay.example.test' })).toBe('domain');
    expect(signal({ title: 'Man does X', domain: 'a.test' })).toBe('none');
  });

  it('rotates batches', () => {
    expect(selectBatches(['a', 'b', 'c'], 2, 2)).toEqual({ selected: ['c', 'a'], next: 1 });
    expect(selectBatches([], 0, 2)).toEqual({ selected: [], next: 0 });
  });
});
