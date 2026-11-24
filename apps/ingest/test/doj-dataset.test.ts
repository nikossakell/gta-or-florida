import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceForHost } from '@gof/config';
import { dojDateline, legalStatus, parseDojPage, prefilterDoj } from '../src/adapters/doj.ts';
import { DATASET_DAYS, datasetDayUrl, parseDatasetDay } from '../src/adapters/floridaman-dataset.ts';
import { createBudget, createMockAiProvider } from '../src/classify.ts';
import { loadSourcesConfig } from '../src/config-file.ts';
import { discoverDoj, discoverFloridaManDataset, type Log } from '../src/discover.ts';
import { REPO_ROOT } from '../src/paths.ts';
import { processDiscovered } from '../src/pipeline.ts';

const cfg = loadSourcesConfig(resolve(REPO_ROOT, 'data'));
const UA = 'gta-or-florida-ingest/0.4 (test)';
const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} };
const ts = (d: string) => String(Date.parse(`${d}T12:00:00Z`) / 1000);

// Synthetic DOJ-shaped rows (no real names).
const row = (o: { office?: string; slug: string; title: string; teaser?: string; date: string; uuid?: string }) => ({
  uuid: o.uuid ?? `u-${o.slug}`,
  title: o.title,
  teaser: o.teaser ?? '<strong>Tampa, Florida</strong> – A synthetic summary sentence.',
  url: `https://www.justice.gov/${o.office ?? 'usao-mdfl'}/pr/${o.slug}`,
  date: ts(o.date),
  component: [{ name: 'USAO - Florida, Middle' }],
});

describe('DOJ press releases', () => {
  it('keeps only Florida U.S. Attorney releases (SD/MD/ND), with decoded text and ISO dates', () => {
    const page = parseDojPage({
      results: [
        row({ slug: 'a', title: 'Tampa Man Pleads Guilty To Selling Counterfeit Manatee Plush Toys &amp; More', date: '2026-11-23' }),
        row({ office: 'usao-sdfl', slug: 'b', title: 'Miami Woman Sentenced For Fake Pet Insurance Scheme', date: '2026-11-22' }),
        row({ office: 'usao-ndfl', slug: 'c', title: 'Pensacola Man Convicted Of Selling Fake Fishing Licenses', date: '2026-11-22' }),
        row({ office: 'usao-md', slug: 'd', title: 'Baltimore Man Sentenced For Something Else Entirely', date: '2026-11-23' }),
        { ...row({ slug: 'e', title: 'Not a press release path at all here', date: '2026-11-23' }), url: 'https://www.justice.gov/usao-mdfl/speech/e' },
        { ...row({ slug: 'f', title: 'Plain http is never accepted as a source', date: '2026-11-23' }), url: 'http://www.justice.gov/usao-mdfl/pr/f' },
      ],
    });
    expect(page.dates).toEqual(['2026-11-23', '2026-11-22', '2026-11-22', '2026-11-23', '2026-11-23', '2026-11-23']);
    expect(page.releases.map((r) => [r.district, r.date, r.title])).toEqual([
      ['usao-mdfl', '2026-11-23', 'Tampa Man Pleads Guilty To Selling Counterfeit Manatee Plush Toys & More'],
      ['usao-sdfl', '2026-11-22', 'Miami Woman Sentenced For Fake Pet Insurance Scheme'],
      ['usao-ndfl', '2026-11-22', 'Pensacola Man Convicted Of Selling Fake Fishing Licenses'],
    ]);
    expect(page.releases[0]!.teaser).toBe('Tampa, Florida – A synthetic summary sentence.');
    expect(() => parseDojPage({ nope: true })).toThrow(/results/);
  });

  it('distinguishes allegations from convictions', () => {
    expect(legalStatus('Orlando Man Sentenced To Prison For Fake Lottery')).toBe('sentenced');
    expect(legalStatus('Ocala Woman Pleads Guilty To Bank Fraud')).toBe('pleaded_guilty');
    expect(legalStatus('Federal Jury Convicts Tampa Man')).toBe('convicted');
    expect(legalStatus('Miami Company Agrees To Pay $2 Million To Settle Claims')).toBe('civil');
    expect(legalStatus('Two Men Charged In Airboat Ticket Scheme')).toBe('charged');
    expect(legalStatus('Jacksonville Man Indicted For Fake Moon Rocks')).toBe('charged');
    expect(legalStatus('Keys Man Arrested For Smuggling Cigars')).toBe('arrested');
    expect(legalStatus('Update On The Courthouse Schedule')).toBe('other');
  });

  it('rejects serious crimes and vulnerable victims, routine notices, and (by default) unproven charges', () => {
    const p = (title: string, includeAllegations = false) => prefilterDoj({ title, teaser: '', includeAllegations });
    for (const t of [
      'Tampa Man Sentenced For Possessing Child Sexual Abuse Material',
      'Felon Sentenced For Possessing A Firearm And Ammunition',
      'Miami Man Pleads Guilty To Fentanyl Distribution Conspiracy',
      'Man Convicted In Murder-For-Hire Plot',
      'Federal Jury Convicts Defendant In Scheme To Assassinate Foreign President',
      'Man Sentenced For Elder Fraud Targeting Retirees As Victims',
    ]) expect(p(t).reasonCodes, t).toContain('SERIOUS_CRIME_OR_VULNERABLE_VICTIM');
    expect(p('U.S. Attorney Announces New Elder Justice Coordinator').decision).toBe('reject');
    expect(p('Two Men Charged In Fake Alligator Wrestling License Scheme').reasonCodes).toEqual(['ALLEGATION_ONLY']);
    expect(p('Two Men Charged In Fake Alligator Wrestling License Scheme', true)).toMatchObject({ decision: 'candidate', status: 'charged' });
    expect(p('Bradenton Man Pleads Guilty To Home Improvement Refund Scheme')).toMatchObject({ decision: 'candidate', reasonCodes: [], status: 'pleaded_guilty' });
  });

  it('extracts the verbatim dateline as Florida location evidence', () => {
    expect(dojDateline('Fort Walton Beach, Florida – A man was sentenced')).toBe('Fort Walton Beach, Florida');
    expect(dojDateline('Washington – The Department announced')).toBeNull();
  });

  function dojApi(pages: object[][]) {
    const calls: string[] = [];
    const fetchImpl = async (input: string) => {
      calls.push(input);
      const page = Number(new URL(input).searchParams.get('page'));
      return new Response(JSON.stringify({ results: pages[page] ?? [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { calls, fetchImpl };
  }

  it('pages newest-first within the lookback window, ≥ 1 s apart, and builds review-only candidates', async () => {
    const api = dojApi([
      [row({ slug: 'p1', title: 'Bradenton Man Pleads Guilty To Home Improvement Refund Scheme', date: '2026-11-23' }), row({ office: 'usao-ca', slug: 'x', title: 'Elsewhere', date: '2026-11-23' })],
      [row({ office: 'usao-ndfl', slug: 'p2', title: 'Tallahassee Man Charged With Selling Fake Fishing Licenses', teaser: 'Tallahassee, Florida – Synthetic.', date: '2026-11-22' }), row({ slug: 'p1', title: 'Bradenton Man Pleads Guilty To Home Improvement Refund Scheme', date: '2026-11-23' })],
      [row({ slug: 'old', title: 'Old Release Outside The Window Of Two Days', date: '2026-11-10' })],
      [row({ slug: 'never', title: 'Never Requested Because Paging Stopped Already', date: '2026-11-09' })],
    ]);
    const waits: number[] = [];
    const r = await discoverDoj(cfg, { userAgent: UA, fetchImpl: api.fetchImpl, now: new Date('2026-11-23T17:00:00Z'), lookbackDays: 2, maxPages: 6, includeAllegations: false, sleep: async (ms) => void waits.push(ms), log: quiet });
    expect(api.calls).toHaveLength(3); // stopped at the page that crossed the window
    expect(waits).toEqual([1000, 1000]);
    expect(new URL(api.calls[0]!).searchParams.get('fields')).toBe('uuid,title,teaser,url,date,component');
    expect(r.items.map((i) => [i.provider, i.canonicalUrl, i.prefilter.decision, i.prefilter.reasonCodes])).toEqual([
      ['doj', 'https://justice.gov/usao-mdfl/pr/p1', 'candidate', []],
      ['doj', 'https://justice.gov/usao-ndfl/pr/p2', 'reject', ['ALLEGATION_ONLY']],
    ]);
    const [convicted, charged] = r.items;
    expect(convicted).toMatchObject({
      publisher: "U.S. Attorney's Office, Middle District of Florida",
      providerKey: 'doj:u-p1',
      floridaSignal: 'domain',
      floridaEvidence: 'Tampa, Florida',
      excerpt: 'Tampa, Florida – A synthetic summary sentence.',
      publishedAt: '2026-11-23',
    });
    expect(convicted!.aiAllowed).not.toBe(false); // absent = AI allowed (public domain)
    expect(convicted!.notes).toMatch(/public domain[\s\S]*Case status: pleaded guilty \(a conviction\)/);
    expect(charged!.notes).toMatch(/CHARGED ONLY: an allegation; the defendant is presumed innocent[\s\S]*never imply guilt/);
    expect(charged!.floridaSignal).toBe('title'); // "Tallahassee" in the title
  });

  it('feeds the shared pipeline: exact dedupe against D1, prefilter, and the justice.gov source policy (unreviewed)', async () => {
    const api = dojApi([[row({ slug: 'p1', title: 'Bradenton Man Pleads Guilty To Home Improvement Refund Scheme', date: '2026-11-23' }), row({ slug: 'p3', title: 'Lakeland Woman Sentenced For Fake Parking Ticket Scheme', date: '2026-11-23' })], []]);
    const r = await discoverDoj(cfg, { userAgent: UA, fetchImpl: api.fetchImpl, now: new Date('2026-11-23T17:00:00Z'), lookbackDays: 2, maxPages: 2, includeAllegations: false, sleep: async () => {}, log: quiet });
    const client = { known: async () => ({ canonicalUrls: ['https://justice.gov/usao-mdfl/pr/p1'], providerKeys: [] }) } as never;
    const { items, stats } = await processDiscovered(r.items, { client, ai: createMockAiProvider(), budget: createBudget(), checkLink: null, maxLinkChecks: 0, aiConcurrency: 1 });
    expect(stats.duplicates).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'FLORIDA_NEWS', reference: { provider: 'doj', publisher: "U.S. Attorney's Office, Middle District of Florida" }, incident: { floridaEvidence: 'Tampa, Florida' } });
    expect(items[0]!.ai).not.toBeNull(); // public domain: AI classification allowed
    expect(sourceForHost('www.justice.gov')).toMatchObject({ id: 'publisher:justice.gov', licenseStatus: 'approved', canUseEditorialSummary: true, autoPublishAllowed: false });
  });

  it('stops and records an error on 429 or bad JSON (no hammering)', async () => {
    const calls: string[] = [];
    const r = await discoverDoj(cfg, {
      userAgent: UA,
      fetchImpl: async (u) => (calls.push(u), new Response('slow down', { status: 429 })),
      lookbackDays: 2,
      maxPages: 6,
      includeAllegations: false,
      sleep: async () => {},
      log: quiet,
    });
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ rateLimited: true, items: [] });
    expect(r.errors[0]).toMatch(/doj:page:0: HTTP 429/);
  });
});

describe('Florida Man API dataset (staging/dev only)', () => {
  it('walks all 366 calendar day files', () => {
    expect(DATASET_DAYS).toHaveLength(366);
    expect(DATASET_DAYS.slice(58, 61)).toEqual(['02/28', '02/29', '03/01']);
    expect(datasetDayUrl('11/23')).toBe('https://juliayxhuang.github.io/florida-man-api/api/11/23.json');
  });

  it('validates untrusted rows (https URL, ISO date, bounded text)', () => {
    expect(
      parseDatasetDay([
        { title: 'Florida man rides a lawnmower to the bank', url: 'https://www.wfla.com/news/x/', source: 'wfla.com', date: '2023-11-23', keywords: [] },
        { title: 'missing url', source: 'x', date: '2023-11-23' },
        { title: 'http only', url: 'http://x.example/a', date: '2023-11-23' },
        { title: 'bad date', url: 'https://x.example/a', date: 'yesterday' },
        null,
      ]),
    ).toEqual([{ title: 'Florida man rides a lawnmower to the bank', url: 'https://www.wfla.com/news/x/', source: 'wfla.com', date: '2023-11-23' }]);
    expect(() => parseDatasetDay({ not: 'an array' })).toThrow(/not an array/);
  });

  function dataset(files: Record<string, unknown[] | number>) {
    const calls: string[] = [];
    const fetchImpl = async (u: string) => {
      calls.push(u);
      const day = u.replace(/^.*\/api\//, '').replace(/\.json$/, '');
      const f = files[day];
      if (typeof f === 'number') return new Response('', { status: f });
      return new Response(JSON.stringify(f ?? []), { status: f ? 200 : 404, headers: { 'content-type': 'application/json' } });
    };
    return { calls, fetchImpl };
  }

  it('keeps original publisher URLs + provenance, resolves rights to that publisher, and advances a day cursor', async () => {
    const ds = dataset({
      '01/01': [
        { title: 'Florida man tries to pay for tacos with a live baby alligator', url: 'https://www.wfla.com/news/florida/alligator-tacos/', source: 'wfla.com', date: '2022-01-01' },
        { title: 'Florida woman found living in a store’s attic', url: 'https://www.msn.com/en-us/news/x', source: 'msn.com', date: '2022-01-01' },
      ],
    });
    const r = await discoverFloridaManDataset(cfg, { userAgent: UA, fetchImpl: ds.fetchImpl, daysPerRun: 2, log: quiet });
    expect(ds.calls).toEqual([datasetDayUrl('01/01'), datasetDayUrl('01/02')]);
    expect(r.items).toHaveLength(1); // aggregator (msn) links are not publisher links
    expect(r.items[0]).toMatchObject({ provider: 'floridaman_dataset', canonicalUrl: 'https://wfla.com/news/florida/alligator-tacos', originalUrl: 'https://www.wfla.com/news/florida/alligator-tacos/', publisher: 'wfla.com', publishedAt: '2022-01-01', aiAllowed: false });
    expect(r.items[0]!.notes).toMatch(/florida-man-api; MIT repo, dataset intended for personal\/educational\/non-commercial use\)[\s\S]*Original publisher: wfla\.com/);
    expect(sourceForHost('wfla.com')).toMatchObject({ licenseStatus: 'unreviewed', canUseEditorialSummary: false });
    expect(r.checkpoints).toEqual([{ provider: 'floridaman_dataset', key: 'nextDay', value: '2' }]);
  });

  it('wraps around the calendar and retries a failing day next run', async () => {
    const wrap = await discoverFloridaManDataset(cfg, { userAgent: UA, fetchImpl: dataset({}).fetchImpl, daysPerRun: 2, checkpoint: new Map([['nextDay', '365']]), log: quiet });
    expect(wrap.checkpoints).toEqual([{ provider: 'floridaman_dataset', key: 'nextDay', value: '1' }]);
    const failing = await discoverFloridaManDataset(cfg, { userAgent: UA, fetchImpl: dataset({ '01/02': 503 }).fetchImpl, daysPerRun: 3, log: quiet });
    expect(failing.errors).toEqual(['floridaman_dataset:01/02: HTTP 503']);
    expect(failing.checkpoints).toEqual([{ provider: 'floridaman_dataset', key: 'nextDay', value: '1' }]);
  });
});
