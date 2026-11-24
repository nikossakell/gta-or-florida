import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prefilterDoj } from '../src/adapters/doj.ts';
import { loadSourcesConfig } from '../src/config-file.ts';
import { discoverDojBackfill, type Log } from '../src/discover.ts';
import { unusualness } from '../src/filters.ts';
import { REPO_ROOT } from '../src/paths.ts';

const cfg = loadSourcesConfig(resolve(REPO_ROOT, 'data'));
const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} };
const ts = (d: string) => String(Date.parse(`${d}T12:00:00Z`) / 1000);

describe('unusualness scoring', () => {
  it('ranks bizarre-but-true above routine prosecutions and notices', () => {
    const s = (t: string) => unusualness(t).score;
    expect(s('Miami Man Sentenced For Smuggling Baby Iguanas Hidden In His Pants')).toBeGreaterThanOrEqual(4);
    expect(s('Tampa Woman Pleads Guilty To Selling Counterfeit Pokémon Cards')).toBeGreaterThanOrEqual(4);
    expect(s('Keys Man Convicted Of Posing As A Coast Guard Officer To Get Free Lobster')).toBeGreaterThanOrEqual(4);
    expect(s('Licensed Mortgage Loan Officer Pleads Guilty In Bank Fraud Conspiracy')).toBeLessThan(0);
    expect(s('U.S. Attorney Recognized With National Award')).toBeLessThan(0);
    expect(s('Orlando Man Sentenced For Wire Fraud')).toBeLessThan(2);
    expect(unusualness('Man Smuggles Turtles').cues).toEqual(['animal:turtles', 'wildlife_crime:smuggles turtles']);
  });

  it('as a DOJ threshold it can only reject (NOT_UNUSUAL), never approve, and never overrides safety rules', () => {
    const p = (title: string, minUnusual = 2) => prefilterDoj({ title, teaser: '', includeAllegations: false, minUnusual });
    expect(p('Orlando Man Sentenced For Wire Fraud Scheme').reasonCodes).toEqual(['NOT_UNUSUAL']);
    expect(p('Orlando Man Sentenced For Wire Fraud Scheme', 0).decision).toBe('candidate'); // threshold off
    expect(p('Miami Man Sentenced For Smuggling Baby Iguanas Hidden In His Pants')).toMatchObject({ decision: 'candidate', reasonCodes: [] });
    // Animals do not rescue a serious case.
    expect(p('Man Sentenced For Possessing Firearm While Selling Alligator Meat').reasonCodes).toContain('SERIOUS_CRIME_OR_VULNERABLE_VICTIM');
    // Unusual charges are still allegations.
    expect(p('Two Men Charged With Smuggling Parrots In Coolers').reasonCodes).toEqual(['ALLEGATION_ONLY']);
  });
});

describe('DOJ historical backfill', () => {
  function api(pages: { date: string; slug: string; title?: string; office?: string }[][]) {
    const calls: number[] = [];
    const fetchImpl = async (input: string) => {
      const page = Number(new URL(input).searchParams.get('page'));
      calls.push(page);
      if (page === 99) return new Response('busy', { status: 503 });
      const rows = (pages[page] ?? []).map((r) => ({
        uuid: r.slug,
        title: r.title ?? `Tampa Man Sentenced For Selling Fake Moon Rocks Number ${r.slug}`,
        teaser: 'Tampa, Florida – Synthetic.',
        url: `https://www.justice.gov/${r.office ?? 'usao-mdfl'}/pr/${r.slug}`,
        date: ts(r.date),
      }));
      return new Response(JSON.stringify({ results: rows }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { calls, fetchImpl };
  }
  const base = { userAgent: 'test', includeAllegations: false, minUnusual: 2, sleep: async () => {}, log: quiet, now: new Date('2026-11-24T00:00:00Z') };
  const pages = [
    [{ date: '2026-11-23', slug: 'a' }],
    [{ date: '2026-06-01', slug: 'b' }, { date: '2026-05-30', slug: 'x', office: 'usao-ca' }],
    [{ date: '2026-01-10', slug: 'c' }],
    [{ date: '2025-12-01', slug: 'd' }, { date: '2025-11-01', slug: 'too-old' }],
    [{ date: '2025-10-01', slug: 'never' }],
  ];

  it('walks older pages from the cursor in bounded chunks and stops at the date floor', async () => {
    const w = api(pages);
    const first = await discoverDojBackfill(cfg, { ...base, fetchImpl: w.fetchImpl, days: 365, pages: 2 });
    expect(w.calls).toEqual([0, 1]);
    expect(first.checkpoints).toEqual([{ provider: 'doj', key: 'backfillPage', value: '2' }]);
    expect(first.items.map((i) => i.canonicalUrl)).toEqual(['https://justice.gov/usao-mdfl/pr/a', 'https://justice.gov/usao-mdfl/pr/b']);

    const second = await discoverDojBackfill(cfg, { ...base, fetchImpl: w.fetchImpl, days: 365, pages: 5, checkpoint: new Map([['backfillPage', '2']]) });
    expect(w.calls).toEqual([0, 1, 2, 3]); // page 3 crosses the floor → done, page 4 never requested
    expect(second.done).toBe(true);
    expect(second.checkpoints).toEqual([{ provider: 'doj', key: 'backfillPage', value: 'done' }]);
    expect(second.items.map((i) => i.canonicalUrl)).toEqual(['https://justice.gov/usao-mdfl/pr/c', 'https://justice.gov/usao-mdfl/pr/d']);

    const third = await discoverDojBackfill(cfg, { ...base, fetchImpl: w.fetchImpl, days: 365, pages: 5, checkpoint: new Map([['backfillPage', 'done']]) });
    expect(third).toMatchObject({ done: true, skipped: 'DOJ backfill complete', items: [] });
    expect(w.calls).toHaveLength(4);
  });

  it('a failed page is retried next run (cursor not advanced past it)', async () => {
    const w = api(pages);
    const r = await discoverDojBackfill(cfg, { ...base, fetchImpl: w.fetchImpl, days: 365, pages: 3, checkpoint: new Map([['backfillPage', '99']]) });
    expect(r.errors[0]).toMatch(/doj:page:99: HTTP 503/);
    expect(r.checkpoints).toEqual([]);
  });

  it('records routine releases as NOT_UNUSUAL and annotates every release for the reviewer', async () => {
    const w = api([[{ date: '2026-11-20', slug: 'r', title: 'Orlando Man Sentenced For Wire Fraud Scheme' }, { date: '2026-11-20', slug: 'u' }]]);
    const r = await discoverDojBackfill(cfg, { ...base, fetchImpl: w.fetchImpl, days: 365, pages: 1 });
    expect(r.items.map((i) => [i.prefilter.decision, i.prefilter.reasonCodes])).toEqual([
      ['reject', ['NOT_UNUSUAL']],
      ['candidate', []],
    ]);
    expect(r.items[1]!.notes).toMatch(/Unusualness: \d+ \(.*deception:fake.*\)/);
  });
});

describe('calibration regressions found in the 12-month DOJ sample', () => {
  const p = (title: string, teaser = '') => prefilterDoj({ title, teaser, includeAllegations: false, minUnusual: 2 });
  it('excludes immigration and election prosecutions instead of ranking "alien" as strange', () => {
    expect(p('Twice-Deported Mexican National Sentenced For Illegal Reentry').reasonCodes).toContain('IMMIGRATION_OR_ELECTION_CASE');
    expect(p('Jamaican National Pleads Guilty To Illegally Voting In Presidential Primary Election').reasonCodes).toContain('IMMIGRATION_OR_ELECTION_CASE');
    expect(unusualness('Criminal Illegal Alien Sentenced').cues.some((c) => c.startsWith('strange'))).toBe(false);
  });
  it('does not mistake place or personal names for cues', () => {
    expect(unusualness('Coral Gables Woman Sentenced For Bank Fraud').cues).toEqual(['routine_fraud']);
    expect(unusualness('Coconut Creek Man Pleads Guilty').score).toBe(0);
    expect(unusualness('Elvis Rodriguez Sentenced For Identity Theft').cues).toEqual(['routine_fraud']);
  });
  it('takes the case stage from the headline, not from earlier convictions in the teaser', () => {
    expect(p('Repeat Offender Charged With Selling Fake Moon Rocks', 'Tampa, Florida – A man previously convicted of fraud was charged').status).toBe('charged');
  });
  it('excludes deaths, animal cruelty and patient harm the first lexicon missed', () => {
    for (const t of ['Palmetto Man Pleads Guilty To Illegal Disposal Of A Deceased Body', 'Gainesville Man Pleads Guilty To Dog Fighting Conspiracy', 'Eustis Man Who Shot At Law Enforcement Drone Sentenced', 'Orlando Doctor Sentenced For Injecting Silicone Oil Into Patients'])
      expect(p(t).reasonCodes, t).toContain('SERIOUS_CRIME_OR_VULNERABLE_VICTIM');
  });
  it('keeps the genuinely odd ones', () => {
    for (const t of ['Pace Man Pleads Guilty To Theft Of National Park Signs', 'Miami Art Dealer Sentenced For Selling Forged Andy Warhol Artwork', 'Jacksonville Man Pleads Guilty To Conspiracy To Influence Major International Sports Competition By Doping'])
      expect(p(t).decision, t).toBe('candidate');
  });
});
