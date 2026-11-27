/** Browser-side pure helpers: filters, search, navigation. */
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser ES module without type declarations
import { displayStatus, filterItems, neighbour, nextUnreviewed, sourceOptions, warningOptions } from '../public/logic.js';

const item = (eventId: string, o: Record<string, unknown> = {}) => ({
  eventId,
  origin: 'FLORIDA',
  headline: `Headline for ${eventId}`,
  difficulty: 2,
  status: 'unreviewed',
  sourceHost: 'news.example.org',
  publisher: 'Example News',
  game: null,
  recommendation: 'approve',
  warningCodes: [] as string[],
  ...o,
});
const ITEMS = [
  item('fl-a', { headline: 'A heron stole bait at the pier' }),
  item('gta-b', { origin: 'GTA', sourceHost: 'gtabase.com', game: 'GTA_V', difficulty: 3, recommendation: 'investigate', warningCodes: ['TENSE_TELL'] }),
  item('fl-c', { status: 'investigate', warningCodes: ['CLUSTER_911', 'SECONDARY_REPORTING'] }),
  item('gta-d', { origin: 'GTA', status: 'approved', sourceHost: 'gtabase.com', difficulty: 1 }),
  item('fl-e'),
  item('fl-f', { status: 'rejected', recommendation: 'reject' }),
];
const ids = (xs: { eventId: string }[]) => xs.map((x) => x.eventId);

describe('displayStatus', () => {
  it('shows the reviewer decision', () => {
    expect(displayStatus(ITEMS[3])).toBe('approved');
    expect(displayStatus(ITEMS[4])).toBe('unreviewed');
  });
});

describe('filterItems', () => {
  it('filters by origin, status, difficulty and source', () => {
    expect(ids(filterItems(ITEMS, { origin: 'GTA' }))).toEqual(['gta-b', 'gta-d']);
    expect(ids(filterItems(ITEMS, { status: 'approved' }))).toEqual(['gta-d']);
    expect(ids(filterItems(ITEMS, { status: 'unreviewed' }))).toEqual(['fl-a', 'gta-b', 'fl-e']);
    expect(ids(filterItems(ITEMS, { difficulty: '3' }))).toEqual(['gta-b']);
    expect(ids(filterItems(ITEMS, { source: 'gtabase.com', status: 'approved' }))).toEqual(['gta-d']);
  });

  it('filters by editorial warnings and recommendations', () => {
    expect(ids(filterItems(ITEMS, { warning: 'any' }))).toEqual(['gta-b', 'fl-c']);
    expect(ids(filterItems(ITEMS, { warning: 'none' }))).toEqual(['fl-a', 'gta-d', 'fl-e', 'fl-f']);
    expect(ids(filterItems(ITEMS, { warning: 'CLUSTER_911' }))).toEqual(['fl-c']);
    expect(ids(filterItems(ITEMS, { warning: 'rec:reject' }))).toEqual(['fl-f']);
  });

  it('searches headline, event id and source (all words, accent-insensitive)', () => {
    expect(ids(filterItems(ITEMS, { q: 'héron pier' }))).toEqual(['fl-a']);
    expect(ids(filterItems(ITEMS, { q: 'gta-b' }))).toEqual(['gta-b']);
    expect(ids(filterItems(ITEMS, { q: 'gtabase' }))).toEqual(['gta-b', 'gta-d']);
    expect(ids(filterItems(ITEMS, { q: 'nothing matches this' }))).toEqual([]);
  });
});

describe('navigation', () => {
  it('nextUnreviewed skips decided items and wraps', () => {
    expect(nextUnreviewed(ITEMS, 'fl-a')).toBe('gta-b');
    expect(nextUnreviewed(ITEMS, 'gta-b')).toBe('fl-e');
    expect(nextUnreviewed(ITEMS, 'fl-e')).toBe('fl-a');
    expect(nextUnreviewed(ITEMS, null)).toBe('fl-a');
    expect(nextUnreviewed([ITEMS[3]], 'gta-d')).toBeNull();
  });

  it('neighbour steps within the filtered order', () => {
    expect(neighbour(ITEMS, 'fl-a', 1)).toBe('gta-b');
    expect(neighbour(ITEMS, 'fl-a', -1)).toBeNull();
    expect(neighbour(ITEMS, 'fl-f', 1)).toBeNull();
  });
});

describe('filter menus', () => {
  it('counts sources and warnings for the filter menus', () => {
    expect(sourceOptions(ITEMS)[0]).toEqual({ host: 'news.example.org', n: 4 });
    expect(warningOptions(ITEMS).map((w: { code: string }) => w.code)).toEqual(['CLUSTER_911', 'SECONDARY_REPORTING', 'TENSE_TELL']);
  });
});
