import { describe, expect, it } from 'vitest';
import { draftPlayTitle, findGiveaways, gtaGameLabel, isGtaGame, SOURCE_CTA } from '../src/content.ts';
import { toRevealedQuestion } from '../src/game.ts';
import type { Question } from '../src/types.ts';

describe('giveaway detection', () => {
  it('finds Florida and GTA giveaway terms as whole words', () => {
    expect(findGiveaways('Florida man rides a gator')).toEqual(['florida']);
    expect(findGiveaways('Weazel News reports chaos in Los Santos')).toEqual(expect.arrayContaining(['weazel', 'los santos']));
    expect(findGiveaways('A man in Key West, near the Everglades')).toEqual(expect.arrayContaining(['key west', 'everglades']));
    expect(findGiveaways('A flamingo statue is elected mayor')).toEqual([]);
    expect(findGiveaways('Inflatable flags')).toEqual([]); // "fla" only as a word
  });
});

describe('draftPlayTitle', () => {
  it('neutralises common giveaways without inventing facts', () => {
    expect(draftPlayTitle('Florida man arrested after riding alligator - WFLA')).toBe('A man arrested after riding alligator');
    expect(draftPlayTitle('Car Jacking Back in Vogue in Liberty City')).toBe('Car Jacking Back in Vogue in the city');
    expect(draftPlayTitle('Liberty Tree Wins Award. No New Information')).toBe('The local paper Wins Award. No New Information');
  });
});

describe('games and CTAs', () => {
  it('labels verified game ids only', () => {
    expect(isGtaGame('GTA_III')).toBe(true);
    expect(isGtaGame('toString')).toBe(false);
    expect(gtaGameLabel('GTA_SA')).toBe('GTA: San Andreas');
    expect(gtaGameLabel('nope')).toBeUndefined();
    expect(SOURCE_CTA).toMatchObject({ FLORIDA_NEWS: 'Read full article', GTA_CANON: 'View GTA source' });
  });

  it('reveal carries CTA, game label and the exact title only when provided', () => {
    const base: Question = { id: 'q1', headline: 'A paper praises car thieves', answer: 'gta', explanation: 'In-game newspaper.', status: 'verified', category: 'crime', difficulty: 2, canonicalEventId: 'e', gtaSubtype: 'gta_lore', game: 'GTA_III', sourceUrl: 'https://wiki.example.test/x', sourceName: 'Grand Theft Wiki', sourceCta: 'View GTA source' };
    expect(toRevealedQuestion(base, 0)).toMatchObject({ game: 'GTA III', sourceCta: 'View GTA source', sourceName: 'Grand Theft Wiki' });
    expect(toRevealedQuestion(base, 0).originalTitle).toBeUndefined();
    expect(toRevealedQuestion({ ...base, originalTitle: 'Exact' }, 0).originalTitle).toBe('Exact');
    const placeholder = toRevealedQuestion({ ...base, placeholder: true, originalTitle: 'Exact' }, 0);
    expect(placeholder.sourceUrl).toBeUndefined();
    expect(placeholder.originalTitle).toBeUndefined();
    expect(placeholder.game).toBeUndefined();
  });
});
