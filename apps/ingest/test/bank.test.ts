import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImportItem, ImportItemResult } from '@gof/core';
import { entryKey, parseBankFile, toImportItem, validateBank, type BankEntry, type BankFile } from '../src/bank.ts';
import { main } from '../src/bank-import.ts';
import { loadSourcesConfig } from '../src/config-file.ts';
import type { WorkerClient } from '../src/import.ts';
import { REPO_ROOT } from '../src/paths.ts';

const cfg = loadSourcesConfig(resolve(REPO_ROOT, 'data'));
const now = new Date('2026-11-25T10:00:00Z');

/** Fictional, original-wording drafts on registered hosts. */
const florida = (o: Partial<BankEntry> = {}): BankEntry => ({
  eventId: 'test-fl-pier',
  origin: 'FLORIDA',
  headline: 'A heron keeps stealing bait from the same pier every morning at sunrise',
  explanation: 'Test entry: the linked report says anglers documented a heron taking bait from one pier for weeks.',
  sourceUrl: 'https://www.clickorlando.com/news/local/2026/10/02/test-heron-pier/',
  sourceTitle: 'Anglers say bird is a regular at local pier',
  publisher: 'News 6',
  publishedAt: '2026-10-02',
  location: 'Example Beach, Florida',
  category: 'wildlife',
  ...o,
});
const gta = (o: Partial<BankEntry> = {}): BankEntry => ({
  eventId: 'test-gta-van',
  origin: 'GTA',
  headline: 'A crew rams an armoured van until its guards abandon it',
  explanation: 'Test entry: a documented mission where the player rams a security van until the guards flee.',
  sourceUrl: 'https://www.grandtheftwiki.com/Test_Mission',
  sourceTitle: 'Test Mission',
  game: 'GTA_III',
  category: 'crime',
  ...o,
});
const file = (questions: BankEntry[], o: Partial<BankFile> = {}): BankFile => ({ batch: '2027-Q1-test', questions, ...o });
const problems = (f: BankFile) => validateBank(f, cfg).map((r) => r.problems.map((p) => p.split(':')[0]));

describe('bank batch validation', () => {
  it('accepts original-wording drafts from registered sources (Rockstar and GTA Base count as GTA references)', () => {
    const f = file([florida(), gta(), gta({ eventId: 'test-gta-trailer', headline: 'Two leads plan a heist in a newly released trailer scene', sourceUrl: 'https://www.rockstargames.com/newswire/article/test', sourceTitle: 'Test newswire post', game: 'GTA_VI', spoiler: true }), gta({ eventId: 'test-gta-base', headline: 'A driver must deliver a stolen ice cream van before it melts', sourceUrl: 'https://www.gtabase.com/test-mission', sourceTitle: 'Test mission page' })]);
    expect(problems(f)).toEqual([[], [], [], []]);
  });

  it('refuses copied or answer-revealing headlines, the wrong kind of source, and inconsistent events', () => {
    const f = file([
      florida({ headline: 'Anglers say bird is a regular at local pier' }), // verbatim source headline
      florida({ eventId: 'e2', headline: 'Florida man keeps feeding a heron at the pier every day' }), // gives the answer away
      gta({ eventId: 'e3', sourceUrl: 'https://www.clickorlando.com/news/test' }), // GTA from a news site
      florida({ eventId: 'e4', sourceUrl: 'https://www.theonion.com/test', headline: 'A neighbourhood votes to make a pelican its honorary mayor' }), // blocked satire domain
      gta({ eventId: 'test-fl-pier', headline: 'A courier dodges rival gangs while delivering a mystery package' }), // event already Florida
      florida({ eventId: 'e6', headline: 'A neighbourhood votes to make a pelican its honorary mayor!' }), // same wording as #4
      florida({ eventId: 'e7', headline: 'YOUR OWN REVIEWED TITLE goes here for this one', explanation: 'Placeholder explanation text, to be written later.' }),
    ]);
    const p = problems(f);
    expect(p[0]).toEqual(expect.arrayContaining(['PLAY_TITLE_VERBATIM']));
    expect(p[1]).toContain('PLAY_TITLE_GIVEAWAY');
    expect(p[2]).toContain('SOURCE_KIND');
    expect(p[3]).toContain('SOURCE_REFUSED');
    expect(p[4]).toContain('EVENT_ORIGIN_CONFLICT');
    expect(p[5]).toContain('DUPLICATE_HEADLINE');
    expect(p[6]).toEqual(expect.arrayContaining(['PLAY_TITLE_PLACEHOLDER']));
  });

  it('rejects malformed batches before validation', () => {
    expect(parseBankFile({ batch: 'x', questions: [{ ...florida(), eventId: 'Has Spaces' }] }).ok).toBe(false);
    expect(parseBankFile({ batch: 'x', questions: [] }).ok).toBe(false);
  });

  it('turns a draft into a manual candidate: own incident, shared event id, real source URL, stable key', () => {
    const a = toImportItem(florida(), file([]), now);
    const b = toImportItem(florida({ headline: 'Fishermen notice one wading bird helping itself to their bait' }), file([]), now);
    expect(a.reference.provider).toBe('manual');
    expect(a.reference.originalUrl).toBe(florida().sourceUrl);
    expect(a.question).toMatchObject({ eventId: 'test-fl-pier', playTitleDraft: florida().headline });
    expect(a.incidentKey).not.toBe(b.incidentKey); // one incident per question
    expect(a.reference.canonicalUrl).not.toBe(b.reference.canonicalUrl); // same article, two questions
    expect(a.incidentKey).toBe(`bank:${entryKey(florida())}`); // re-import → duplicate
    expect(a.ai).toBeNull();
    expect(a.prefilter).toEqual({ decision: 'candidate', reasonCodes: [] });
  });

  it('the committed dev fixtures validate and are clearly labelled', () => {
    const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'data/bank/dev-fixtures.json'), 'utf8'));
    const parsed = parseBankFile(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.fixture).toBe(true);
    expect(problems(parsed.file).flat()).toEqual([]);
    expect(parsed.file.questions.every((q) => q.sourceUrl.startsWith('https://fixture.invalid/') && /fixture/i.test(q.explanation))).toBe(true);
    expect(new Set(parsed.file.questions.map((q) => q.eventId)).size).toBeLessThan(parsed.file.questions.length); // has shared events
    expect(parsed.file.questions.some((q) => q.spoiler)).toBe(true);
  });
});

describe('npm run bank:import', () => {
  function harness(batch: unknown, outcome: ImportItemResult['outcome'] = 'inserted') {
    const lines: string[] = [];
    const sent: ImportItem[] = [];
    const client = {
      importItems: async (_run: string, items: ImportItem[]) => {
        sent.push(...items);
        return items.map((i) => ({ incidentKey: i.incidentKey, outcome }));
      },
    } as unknown as WorkerClient;
    return {
      lines,
      sent,
      deps: {
        log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`), error: (m: string) => lines.push(`ERROR ${m}`) },
        env: { INGESTION_API_URL: 'https://gta-florida-api-staging.example.workers.dev', INGESTION_IMPORT_TOKEN: 'test-token-0123456789abcdef0123456789ab' },
        now: () => now,
        cfg,
        readFile: () => JSON.stringify(batch),
        createClient: () => client,
      },
    };
  }

  it('imports valid drafts as candidates and explains the review step', async () => {
    const h = harness(file([florida(), gta()]));
    expect(await main(['--file', 'batch.json'], h.deps)).toBe(0);
    expect(h.sent).toHaveLength(2);
    expect(h.lines.join('\n')).toMatch(/2 new candidate\(s\)[\s\S]*questions:approve/);
  });

  it('stops on problems (nothing sent) unless --skip-invalid', async () => {
    const batch = file([florida(), florida({ eventId: 'bad', headline: 'Anglers say bird is a regular at local pier' })]);
    const strict = harness(batch);
    expect(await main(['--file', 'batch.json'], strict.deps)).toBe(2);
    expect(strict.sent).toEqual([]);
    expect(strict.lines.join('\n')).toMatch(/PLAY_TITLE_VERBATIM[\s\S]*Nothing was imported/);
    const lenient = harness(batch);
    expect(await main(['--file', 'batch.json', '--skip-invalid'], lenient.deps)).toBe(0);
    expect(lenient.sent).toHaveLength(1);
  });

  it('dry run sends nothing; fixture batches only go to the local Worker; production needs the explicit flag', async () => {
    const dry = harness(file([florida()]));
    expect(await main(['--file', 'b.json', '--dry-run'], dry.deps)).toBe(0);
    expect(dry.sent).toEqual([]);
    const fx = harness(file([florida()], { fixture: true }));
    expect(await main(['--file', 'b.json'], fx.deps)).toBe(2);
    expect(fx.lines.join('\n')).toMatch(/only be imported into the local Worker/);
    const prod = harness(file([florida()]));
    expect(await main(['--file', 'b.json', '--env', 'production'], prod.deps)).toBe(2);
    expect(prod.sent).toEqual([]);
  });

  it('reports drafts the Worker already has as duplicates (re-running a batch is safe)', async () => {
    const h = harness(file([florida()]), 'duplicate');
    expect(await main(['--file', 'b.json'], h.deps)).toBe(0);
    expect(h.lines.join('\n')).toMatch(/0 new candidate\(s\), 1 already known/);
  });
});
