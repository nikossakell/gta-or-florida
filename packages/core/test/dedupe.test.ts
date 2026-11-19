import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  createDeduper,
  findSimilarPairs,
  normalizeTitle,
  stripPublisherSuffix,
  titleFingerprint,
  titleSimilarity,
} from '../src/index.ts';

describe('canonicalizeUrl', () => {
  it('removes tracking parameters, fragments, www and trailing slashes', () => {
    expect(
      canonicalizeUrl('http://WWW.Example.com/news/story-123/?utm_source=x&utm_medium=y&fbclid=abc#comments'),
    ).toBe('https://example.com/news/story-123');
  });

  it('keeps meaningful query params and sorts them', () => {
    expect(canonicalizeUrl('https://example.com/article?page=2&id=7&gclid=zzz')).toBe('https://example.com/article?id=7&page=2');
  });

  it('collapses AMP and mobile variants of the same page', () => {
    const a = canonicalizeUrl('https://m.example.com/2026/11/gator-pool/amp/');
    const b = canonicalizeUrl('https://www.example.com/2026/11/gator-pool');
    expect(a).toBe(b);
  });

  it('rejects non-http URLs and garbage', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
    expect(canonicalizeUrl('ftp://example.com/x')).toBeNull();
  });
});

describe('title normalization', () => {
  it('strips short publisher suffixes but not real headline content', () => {
    expect(stripPublisherSuffix('Man rides lawnmower to bar - WFLA')).toBe('Man rides lawnmower to bar');
    expect(stripPublisherSuffix('Gator found in pool | Example Herald')).toBe('Gator found in pool');
    expect(stripPublisherSuffix('Self-driving cart - the story nobody expected to read about this year at all')).toBe(
      'Self-driving cart - the story nobody expected to read about this year at all',
    );
  });

  it('normalizes case, accents, quotes and punctuation', () => {
    expect(normalizeTitle('  “Florida Man’s” CAFÉ   Heist!!! ')).toBe('florida mans cafe heist');
  });

  it('fingerprints are order- and stopword-insensitive', () => {
    expect(titleFingerprint('Florida man arrested after alligator found in pool')).toBe(
      titleFingerprint('Alligator found in pool; Florida man arrested'),
    );
    expect(titleFingerprint('Florida man arrested after alligator found in pool')).not.toBe(
      titleFingerprint('Florida woman arrested after python found in car'),
    );
  });
});

describe('titleSimilarity', () => {
  it('scores syndicated rewrites as near-identical', () => {
    const s = titleSimilarity(
      'Florida Man Arrested After Alligator Found In His Pool - WFLA',
      'Florida man arrested after alligator found in pool',
    );
    expect(s).toBeGreaterThan(0.85);
  });

  it('scores unrelated headlines low', () => {
    expect(titleSimilarity('Iguana falls from tree onto parked car', 'Mayor unveils new bike lanes downtown')).toBeLessThan(0.2);
  });
});

describe('createDeduper', () => {
  const existing = [
    { id: 'c1', title: 'Florida man arrested after alligator found in pool', url: 'https://news.example/gator-pool?utm_source=rss' },
    { id: 'c2', title: 'Woman drives golf cart through drive-thru window', url: 'https://other.example/golf-cart' },
  ];

  it('flags the same article reached through a tracking URL', () => {
    const d = createDeduper(existing);
    expect(d.check({ title: 'Totally different title', url: 'https://www.news.example/gator-pool/' })).toEqual({
      kind: 'duplicate',
      reason: 'url',
      of: 'c1',
      similarity: 1,
    });
  });

  it('flags the same story from another publisher via fingerprint', () => {
    const d = createDeduper(existing);
    const v = d.check({ title: 'Alligator found in pool; Florida man arrested', url: 'https://third.example/a' });
    expect(v).toMatchObject({ kind: 'duplicate', reason: 'fingerprint', of: 'c1' });
  });

  it('flags close paraphrases as duplicates and looser matches for human review', () => {
    const d = createDeduper(existing);
    expect(d.check({ title: 'Florida man arrested after alligator is found in backyard pool' }).kind).toBe('duplicate');
    const review = d.check({ title: 'Florida man charged after alligator turns up in his pool' });
    expect(review.kind).toBe('review');
  });

  it('treats genuinely new stories as new', () => {
    const d = createDeduper(existing);
    expect(d.check({ title: 'Python hitches a ride on airport shuttle bus', url: 'https://x.example/p' })).toEqual({ kind: 'new' });
  });

  it('catches duplicates inside the same incoming batch once added', () => {
    const d = createDeduper([]);
    const first = { id: 'n1', title: 'Manatee mailbox mystery solved', url: 'https://a.example/m' };
    expect(d.check(first).kind).toBe('new');
    d.add(first);
    expect(d.check({ title: 'Manatee mailbox mystery solved - Example News', url: 'https://b.example/m' }).kind).toBe('duplicate');
  });
});

describe('findSimilarPairs', () => {
  it('returns only pairs above the threshold', () => {
    const pairs = findSimilarPairs(
      [
        { id: 'a', title: 'Crime boss hires you to steal a parade float' },
        { id: 'b', title: 'Crime boss hires you to steal the parade float' },
        { id: 'c', title: 'Raccoon elected honorary fire chief' },
      ],
      0.8,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: 'a', b: 'b' });
  });
});
