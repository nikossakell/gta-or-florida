import { describe, expect, it } from 'vitest';
import {
  accessOperationProblems,
  canonicalSimilarity,
  draftProblems,
  operationStatus,
  urlBelongsToSource,
  type DraftContext,
  type SourcePolicy,
} from '../src/index.ts';

const EVIDENCE =
  'Monroe County Officer Example stopped a vehicle and conducted a resource inspection. Officer Example checked a white bucket with cleaning supplies and rags inside and found a live juvenile alligator underneath the rags. The individual was arrested for illegal take of an American alligator.';
const ctx = (o: Partial<DraftContext> = {}): DraftContext => ({
  headline: 'Florida Man Arrested After Hiding Baby Alligator in Bucket',
  evidenceText: EVIDENCE,
  legalStage: 'arrested',
  forbiddenTerms: ['Example'],
  placeTerms: ['Monroe', 'Monroe County'],
  extraNeutral: ['documented'],
  ...o,
});
const GOOD = {
  playTitle: 'Wildlife Officers Check a Bucket of Rags and Find a Live Juvenile Alligator',
  explanation: 'Wildlife officers checking a bucket found a live juvenile alligator under the rags. The person was arrested on a charge of illegal take of an American alligator; an arrest is an accusation, not proof of guilt.',
};
const codes = (problems: string[]) => problems.map((p) => p.split(':')[0]);

describe('facts-first draft validation', () => {
  it('accepts a title and explanation built from the facts', () => {
    expect(draftProblems(GOOD, ctx())).toEqual([]);
  });

  it('rejects a synonym-swapped headline as cosmetic paraphrase', () => {
    const swapped = 'Man Taken Into Custody After Concealing Young Alligator Inside Container';
    expect(canonicalSimilarity(swapped, ctx().headline)).toBeGreaterThanOrEqual(0.5);
    expect(codes(draftProblems({ ...GOOD, playTitle: swapped }, ctx()))).toContain('PLAY_TITLE_HEADLINE_PARAPHRASE');
  });

  it('rejects words, numbers and places the evidence does not support', () => {
    const p = draftProblems(
      { playTitle: 'Officers Find Five Alligators Hidden in a Cooler Near the Interstate', explanation: 'Officers found five alligators in a cooler on Tuesday; the driver was arrested on a charge of smuggling.' },
      ctx(),
    );
    const text = p.join('\n');
    expect(text).toMatch(/PLAY_TITLE_UNSUPPORTED: .*(five|cooler|interstate)/);
    expect(text).toMatch(/EXPLANATION_UNSUPPORTED: .*(tuesday|smuggling|cooler)/);
  });

  it('refuses answer leakage: Florida, GTA terms, local places and the agency in the title', () => {
    expect(codes(draftProblems({ ...GOOD, playTitle: 'Florida Officers Find a Live Juvenile Alligator in a Bucket' }, ctx()))).toContain('PLAY_TITLE_GIVEAWAY');
    expect(codes(draftProblems({ ...GOOD, playTitle: 'Officers in Vice City Find a Live Juvenile Alligator in a Bucket' }, ctx()))).toContain('PLAY_TITLE_GIVEAWAY');
    expect(codes(draftProblems({ ...GOOD, playTitle: 'Monroe County Officers Find a Live Juvenile Alligator in a Bucket' }, ctx()))).toEqual(
      expect.arrayContaining(['PLAY_TITLE_LOCATION', 'PLAY_TITLE_AGENCY']),
    );
  });

  it('never states guilt for an allegation and requires attribution in the explanation', () => {
    const guilty = draftProblems({ playTitle: 'Alligator Thief Caught With a Live Juvenile Alligator in a Bucket', explanation: 'The thief had a live juvenile alligator under the rags in a bucket and is guilty.' }, ctx());
    expect(codes(guilty)).toEqual(expect.arrayContaining(['PLAY_TITLE_GUILT_ASSERTED', 'EXPLANATION_GUILT_ASSERTED', 'EXPLANATION_ALLEGATION_UNHEDGED']));
    // Convictions may be stated as such.
    expect(codes(draftProblems(GOOD, ctx({ legalStage: 'convicted' })))).not.toContain('EXPLANATION_ALLEGATION_UNHEDGED');
  });

  it('refuses quotes, copied source phrases and personal data', () => {
    const p = codes(
      draftProblems(
        {
          playTitle: GOOD.playTitle,
          explanation: 'Officer Example checked a white bucket with cleaning supplies and rags inside, saying "look here". The person was arrested; an arrest is an accusation, not proof of guilt.',
        },
        ctx(),
      ),
    );
    expect(p).toEqual(expect.arrayContaining(['EXPLANATION_SOURCE_PHRASE', 'EXPLANATION_QUOTE', 'EXPLANATION_PERSONAL_DATA']));
  });

  it('keeps every existing editorial check: placeholders, near-copies, length', () => {
    expect(codes(draftProblems({ ...GOOD, playTitle: 'YOUR OWN REVIEWED TITLE' }, ctx()))).toEqual(expect.arrayContaining(['PLAY_TITLE_PLACEHOLDER']));
    expect(codes(draftProblems({ ...GOOD, playTitle: 'Florida Man Arrested After Hiding Baby Alligator in Bucket' }, ctx()))).toEqual(
      expect.arrayContaining(['PLAY_TITLE_VERBATIM', 'PLAY_TITLE_NEAR_COPY']),
    );
    expect(codes(draftProblems({ ...GOOD, explanation: 'Too short.' }, ctx()))).toContain('EXPLANATION_LENGTH');
  });
});

describe('per-operation source access', () => {
  const base: SourcePolicy = {
    id: 'publisher:agency.example.gov',
    type: 'publisher',
    name: 'Agency',
    hosts: ['agency.example.gov', 'content.govdelivery.com'],
    pathScopes: ['content.govdelivery.com/accounts/AGENCY/'],
    licenseStatus: 'unreviewed',
    canUseEditorialSummary: false,
    canDisplayOriginalTitle: false,
    autoPublishAllowed: false,
    access: { officialGovernment: true, operations: { fetch: 'allowed', extractFacts: 'unknown', publishSummary: 'denied' }, acquisition: 'explicit_urls', minIntervalMs: 5000 },
  };

  it('reports unresolved and denied operations separately; missing review fails closed', () => {
    expect(accessOperationProblems(base, ['fetch', 'extractFacts', 'publishSummary']).map((p) => p.split(':')[0])).toEqual(['SOURCE_OPERATION_UNRESOLVED', 'SOURCE_OPERATION_DENIED']);
    expect(accessOperationProblems({ ...base, access: undefined }, ['fetch'])[0]).toMatch(/^SOURCE_ACCESS_UNREVIEWED/);
    expect(operationStatus(base, 'useMedia')).toBe('unknown');
  });

  it('a blocked source denies every operation whatever the access block says', () => {
    expect(operationStatus({ ...base, licenseStatus: 'blocked' }, 'fetch')).toBe('denied');
  });

  it('scopes shared platforms by path', () => {
    expect(urlBelongsToSource(new URL('https://content.govdelivery.com/accounts/AGENCY/bulletins/1'), base)).toBe(true);
    expect(urlBelongsToSource(new URL('https://content.govdelivery.com/accounts/OTHER/bulletins/1'), base)).toBe(false);
    expect(urlBelongsToSource(new URL('https://agency.example.gov/news/1'), base)).toBe(true);
  });
});
