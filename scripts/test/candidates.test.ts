import { describe, expect, it } from 'vitest';
import type { CandidateFile, Question } from '@gof/core';
import { createFloridaSignal, mergeCandidates, selectBatches, type SourcesConfig } from '../lib/candidates.ts';

const config: SourcesConfig = {
  version: 1,
  gdelt: {
    endpoint: 'https://api.gdeltproject.org/api/v2/doc/doc',
    minDelaySeconds: 5,
    maxRecords: 100,
    timespan: '2w',
    sort: 'DateDesc',
    queriesPerRun: 2,
    batches: [
      { id: 'a', query: 'A' },
      { id: 'b', query: 'B' },
      { id: 'c', query: 'C' },
    ],
  },
  domains: { blocked: { list: ['theonion.com'] }, floridaHints: { list: ['tampabay.com'] } },
  floridaPlaceNames: ['florida', 'tampa', 'key west'],
};

const approved: Question[] = [
  {
    id: 'q1',
    headline: 'Man rides a manatee-shaped pool float down a flooded street',
    answer: 'florida',
    explanation: 'Reported by a local outlet.',
    status: 'verified',
    category: 'weird',
    difficulty: 2,
    canonicalEventId: 'evt-float',
    sourceUrl: 'https://tampabay.com/news/float-story',
    sourceName: 'Example',
    publishedAt: '2026-10-01',
    reviewedAt: '2026-10-02',
  },
];

const empty: CandidateFile = { version: 1, candidates: [] };
const now = new Date('2026-11-19T10:00:00Z');
const art = (title: string, url: string, domain = new URL(url).hostname) => ({ article: { title, url, domain }, query: 'Q' });

describe('mergeCandidates', () => {
  it('adds new articles as candidates, never as approved questions', () => {
    const { file, stats } = mergeCandidates({
      file: empty,
      approved,
      articles: [art('Tampa deputies chase escaped emu through car wash', 'https://news.example/emu?utm_source=x')],
      config,
      now,
    });
    expect(stats.added).toBe(1);
    expect(file.candidates[0]).toMatchObject({
      status: 'candidate',
      canonicalUrl: 'https://news.example/emu',
      floridaSignal: 'title',
      discoveredAt: now.toISOString(),
      provider: 'gdelt',
    });
  });

  it('drops articles already approved (same canonical URL) and within-batch duplicates', () => {
    const { stats, file } = mergeCandidates({
      file: empty,
      approved,
      articles: [
        art('Different wording entirely', 'https://www.tampabay.com/news/float-story/?fbclid=1'),
        art('Key West rooster elected to neighborhood board', 'https://a.example/rooster'),
        art('Key West Rooster Elected To Neighborhood Board - Example News', 'https://b.example/rooster-syndicated'),
      ],
      config,
      now,
    });
    expect(stats.duplicates).toBe(2);
    expect(stats.added).toBe(1);
    expect(file.candidates).toHaveLength(1);
  });

  it('flags looser matches for human review instead of dropping them', () => {
    const first = mergeCandidates({ file: empty, approved: [], articles: [art('Florida man arrested after alligator found in pool', 'https://a.example/1')], config, now });
    const second = mergeCandidates({
      file: first.file,
      approved: [],
      articles: [art('Florida man charged after alligator turns up in his pool', 'https://b.example/2')],
      config,
      now,
    });
    expect(second.stats.flaggedForReview).toBe(1);
    expect(second.file.candidates[1]).toMatchObject({ possibleDuplicateOf: first.file.candidates[0]!.id });
  });

  it('skips previously rejected stories on later runs', () => {
    const first = mergeCandidates({ file: empty, approved: [], articles: [art('Tampa iguana rescued from ceiling fan', 'https://a.example/fan')], config, now });
    const rejected: CandidateFile = { ...first.file, candidates: first.file.candidates.map((c) => ({ ...c, status: 'rejected' as const })) };
    const again = mergeCandidates({ file: rejected, approved: [], articles: [art('Tampa iguana rescued from ceiling fan', 'https://a.example/fan')], config, now });
    expect(again.stats.added).toBe(0);
    expect(again.stats.duplicates).toBe(1);
  });

  it('blocks satire domains and invalid URLs', () => {
    const { stats } = mergeCandidates({
      file: empty,
      approved: [],
      articles: [art('Area man florida things', 'https://www.theonion.com/x'), { article: { title: 'Bad', url: 'nope', domain: 'x' }, query: 'Q' }],
      config,
      now,
    });
    expect(stats.blocked).toBe(1);
    expect(stats.invalid).toBe(1);
    expect(stats.added).toBe(0);
  });

  it('is deterministic for the same input', () => {
    const input = { file: empty, approved, articles: [art('Tampa emu', 'https://n.example/e'), art('Key West goat', 'https://n.example/g')], config, now };
    expect(mergeCandidates(input)).toEqual(mergeCandidates(input));
  });
});

describe('createFloridaSignal', () => {
  const signal = createFloridaSignal(config);
  it('detects place names in titles, then Florida outlets by domain', () => {
    expect(signal({ title: 'Key West chickens win again', domain: 'x.com' })).toBe('title');
    expect(signal({ title: 'Local man does a thing', domain: 'www.tampabay.com' })).toBe('domain');
    expect(signal({ title: 'Man in Ohio does a thing', domain: 'x.com' })).toBe('none');
    expect(signal({ title: 'Floridaville parade', domain: 'x.com' })).toBe('none');
  });
});

describe('selectBatches', () => {
  it('rotates through batches across runs', () => {
    const list = ['a', 'b', 'c'];
    expect(selectBatches(list, 0, 2)).toEqual({ selected: ['a', 'b'], next: 2 });
    expect(selectBatches(list, 2, 2)).toEqual({ selected: ['c', 'a'], next: 1 });
    expect(selectBatches(list, 0, 10)).toEqual({ selected: ['a', 'b', 'c'], next: 0 });
    expect(selectBatches([], 4, 2)).toEqual({ selected: [], next: 0 });
  });
});
