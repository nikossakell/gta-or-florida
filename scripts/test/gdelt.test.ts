import { describe, expect, it, vi } from 'vitest';
import {
  buildGdeltUrl,
  createPacer,
  fetchGdeltArticles,
  GdeltError,
  parseGdeltBody,
  parseSeenDate,
  type FetchLike,
} from '../lib/gdelt.ts';

function response(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => body,
  };
}

const sample = JSON.stringify({
  articles: [
    {
      url: 'https://www.example.com/a?utm_source=x',
      url_mobile: '',
      title: 'Florida man and the gator',
      seendate: '20261118T120000Z',
      socialimage: '',
      domain: 'example.com',
      language: 'English',
      sourcecountry: 'United States',
    },
    { url: 'https://example.org/no-title' },
    'garbage',
  ],
});

describe('buildGdeltUrl', () => {
  it('uses only documented DOC 2.0 parameters', () => {
    const url = buildGdeltUrl({ query: '"Florida man" (alligator OR gator)', maxRecords: 100, timespan: '2w' });
    expect(url.origin + url.pathname).toBe('https://api.gdeltproject.org/api/v2/doc/doc');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: '"Florida man" (alligator OR gator)',
      mode: 'ArtList',
      format: 'json',
      maxrecords: '100',
      timespan: '2w',
      sort: 'DateDesc',
    });
  });

  it('rejects out-of-range maxrecords and bad timespans', () => {
    expect(() => buildGdeltUrl({ query: 'x', maxRecords: 251 })).toThrow(/maxRecords/);
    expect(() => buildGdeltUrl({ query: 'x', timespan: 'forever' })).toThrow(/timespan/);
    expect(() => buildGdeltUrl({ query: '  ' })).toThrow(/empty/);
  });
});

describe('parseGdeltBody', () => {
  it('extracts valid articles and skips malformed ones', () => {
    const articles = parseGdeltBody(sample);
    expect(articles).toEqual([
      {
        url: 'https://www.example.com/a?utm_source=x',
        title: 'Florida man and the gator',
        domain: 'example.com',
        seenAt: '2026-11-18T12:00:00.000Z',
        language: 'English',
        sourceCountry: 'United States',
      },
    ]);
  });

  it('treats an empty result as no articles', () => {
    expect(parseGdeltBody('{}')).toEqual([]);
    expect(parseGdeltBody('')).toEqual([]);
  });

  it('surfaces plain-text API messages as explicit errors', () => {
    expect(() => parseGdeltBody('Your search contained a phrase that was too short.')).toThrow(GdeltError);
    try {
      parseGdeltBody('Please limit requests to one every 5 seconds');
    } catch (e) {
      expect((e as GdeltError).kind).toBe('rate_limited');
      expect((e as GdeltError).retryable).toBe(true);
    }
  });

  it('rejects unexpected shapes', () => {
    expect(() => parseGdeltBody('{"articles": 5}')).toThrow(/not an array/);
  });

  it('parses seendate', () => {
    expect(parseSeenDate('20261118T235959Z')).toBe('2026-11-18T23:59:59.000Z');
    expect(parseSeenDate('2026-11-18')).toBeUndefined();
  });
});

describe('fetchGdeltArticles', () => {
  const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc?query=x');

  it('retries 429 and 5xx with backoff, honoring Retry-After', async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn<FetchLike>()
      .mockResolvedValueOnce(response(429, '', { 'retry-after': '20' }))
      .mockResolvedValueOnce(response(503, 'oops'))
      .mockResolvedValueOnce(response(200, sample));
    const sleep = vi.fn(async (ms: number) => {
      calls.push(ms);
    });
    const articles = await fetchGdeltArticles(url, { fetchImpl, sleep, baseBackoffMs: 5000 });
    expect(articles).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([20_000, 10_000]);
  });

  it('backs off longer when rate limited without Retry-After', async () => {
    const waits: number[] = [];
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValueOnce(response(429, '')).mockResolvedValueOnce(response(200, '{}'));
    await fetchGdeltArticles(url, { fetchImpl, sleep: async (ms) => void waits.push(ms), baseBackoffMs: 5000 });
    expect(waits).toEqual([15_000]);
  });

  it('gives up after maxRetries', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response(502, ''));
    await expect(fetchGdeltArticles(url, { fetchImpl, sleep: async () => {}, maxRetries: 2 })).rejects.toMatchObject({ kind: 'http', status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response(400, 'bad'));
    await expect(fetchGdeltArticles(url, { fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ kind: 'http', status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps network failures and timeouts', async () => {
    const network = vi.fn<FetchLike>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchGdeltArticles(url, { fetchImpl: network, sleep: async () => {}, maxRetries: 0 })).rejects.toMatchObject({ kind: 'network' });
    const timeout = vi.fn<FetchLike>().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(fetchGdeltArticles(url, { fetchImpl: timeout, sleep: async () => {}, maxRetries: 0 })).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('createPacer', () => {
  it('enforces at least 5 seconds between calls even if configured lower', async () => {
    let clock = 0;
    const waits: number[] = [];
    const pace = createPacer(1000, async (ms) => {
      waits.push(ms);
      clock += ms;
    }, () => clock);
    await pace();
    clock += 1000;
    await pace();
    expect(waits).toEqual([4000]);
  });
});
