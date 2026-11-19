import { buildSchedule, type Question } from '@gof/core';
import { describe, expect, it } from 'vitest';
import { buildStaticSite } from '../lib/static-site.ts';

const HEADLINES = [
  'Pelican steals a fisherman’s phone mid-call', 'Mango truck spills onto the causeway at rush hour', 'Airboat tour interrupted by karaoke',
  'Flamingo statue elected honorary mayor', 'Hurricane party held in a bowling alley', 'Boardwalk magician vanishes with tip jar',
  'Manatee befriends a submarine replica', 'Pawnshop buys a haunted saxophone', 'Jetski parade blocks the drawbridge',
  'Iguana rescued from a bakery ceiling fan', 'Rob a citrus baron during his grove party', 'Steal a lighthouse lens for a collector',
  'Motel heist fails when the ice machine jams', 'Smuggle a parrot witness out of town', 'Swamp racer needs a getaway driver',
  'Repaint a rival yacht pink for the marina boss', 'Scare off a food critic for a tiki bar', 'Keep lookout for a neon sign forger',
  'Causeway chase ends inside a car wash', 'Sinkhole swallows a van of fake watches',
];

const bank: Question[] = HEADLINES.map((headline, i) => {
  const florida = i < 10;
  return {
    id: `${florida ? 'fl' : 'gta'}-${i}`,
    headline,
    answer: florida ? 'florida' : 'gta',
    explanation: 'Explanation text for this item.',
    status: 'verified',
    category: (['wildlife', 'crime', 'vehicles', 'weird', 'other'] as const)[i % 5]!,
    difficulty: ((i % 3) + 1) as 1 | 2 | 3,
    canonicalEventId: `evt-${i}`,
    reviewedAt: '2026-11-01',
    ...(florida ? { sourceUrl: `https://news.example/${i}`, sourceName: 'Example', publishedAt: '2026-10-01' } : {}),
  };
});
const { schedule } = buildSchedule({ questions: bank, startDate: '2026-11-17', days: 4 });
const base = { questions: bank, schedule, archiveDays: 7, timeLimitSeconds: 60, allowPlaceholders: false };

describe('buildStaticSite', () => {
  it('publishes only days up to today', () => {
    const site = buildStaticSite({ ...base, today: '2026-11-18', leadDays: 0 });
    expect(site.published).toEqual(['2026-11-17', '2026-11-18']);
    expect(site.files.has('data/challenge/2026-11-19.json')).toBe(false);
    expect([...site.files.keys()].some((k) => k.includes('2026-11-19'))).toBe(false);
  });

  it('can publish ahead when explicitly asked', () => {
    expect(buildStaticSite({ ...base, today: '2026-11-18', leadDays: 1 }).published).toContain('2026-11-19');
  });

  it('respects the archive window', () => {
    expect(buildStaticSite({ ...base, today: '2026-11-20', leadDays: 0, archiveDays: 1 }).published).toEqual(['2026-11-19', '2026-11-20']);
  });

  it('challenge files contain no answers, explanations, sources or internal ids', () => {
    const site = buildStaticSite({ ...base, today: '2026-11-18', leadDays: 0 });
    const text = JSON.stringify(site.files.get('data/challenge/2026-11-18.json'));
    expect(text).not.toMatch(/"answer"|explanation|sourceUrl|"florida"|"gta"|fl-\d|gta-\d|evt-/);
    expect(JSON.parse(text).questions.map((q: { id: string }) => q.id)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
  });

  it('writes one reveal file per question', () => {
    const site = buildStaticSite({ ...base, today: '2026-11-18', leadDays: 0 });
    const reveal = site.files.get('data/reveal/2026-11-18/h3.json') as { id: string; answer: string };
    expect(reveal.id).toBe('h3');
    const internalId = schedule.days.find((d) => d.date === '2026-11-18')!.questionIds[2]!;
    expect(reveal.answer).toBe(bank.find((q) => q.id === internalId)!.answer);
  });

  it('lists published days in the archive, newest first', () => {
    const site = buildStaticSite({ ...base, today: '2026-11-18', leadDays: 0 });
    const archive = site.files.get('data/archive.json') as { days: { date: string; isToday: boolean }[] };
    expect(archive.days.map((d) => d.date)).toEqual(['2026-11-18', '2026-11-17']);
    expect(archive.days[0]!.isToday).toBe(true);
  });

  it('skips placeholder days unless allowed', () => {
    const withPlaceholders = bank.map((q) => ({ ...q, placeholder: q.answer === 'gta' ? true : undefined }));
    const blocked = buildStaticSite({ ...base, questions: withPlaceholders, today: '2026-11-18', leadDays: 0 });
    expect(blocked.published).toEqual([]);
    expect(blocked.skippedPlaceholderDays).toEqual(['2026-11-17', '2026-11-18']);
    const allowed = buildStaticSite({ ...base, questions: withPlaceholders, allowPlaceholders: true, today: '2026-11-18', leadDays: 0 });
    expect(allowed.published).toHaveLength(2);
  });
});
