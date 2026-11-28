/** `bank:approve`: approves dashboard-approved bank questions through the Worker's normal review route. */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LinkCheck, ReviewRequest } from '@gof/core';
import { entryKey, type BankEntry, type BankFile } from '../src/bank.ts';
import { main } from '../src/bank-approve.ts';
import { loadSourcesConfig } from '../src/config-file.ts';
import { WorkerApiError, type WorkerClient } from '../src/import.ts';
import { REPO_ROOT } from '../src/paths.ts';

const cfg = loadSourcesConfig(resolve(REPO_ROOT, 'data'));
const RECORD = 'Editorially approved in the local review dashboard by owner at 2026-11-27T20:00:00.000Z. Not a Worker approval.';

const fl = (o: Partial<BankEntry> = {}): BankEntry => ({
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
  notes: `${RECORD} Batch 001. Verified 2026-11-25 against the source.`,
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
  spoiler: true,
  notes: `${RECORD} Batch 007. Verified 2026-11-24 against two reference sites.`,
  ...o,
});
const file = (questions: BankEntry[]): BankFile => ({ batch: 'editorial-review-approved-2026-11-27', questions });

type Cand = { question_id: string; quality_state: string; play_title: string; explanation: string };
function harness(batch: unknown, candidates: Record<string, Cand | null>, opts: { link?: LinkCheck['status']; reviewErrors?: string[] } = {}) {
  const lines: string[] = [];
  const sent: ReviewRequest[] = [];
  const checked: string[] = [];
  const client = {
    candidate: async (id: string) => {
      const c = candidates[id];
      if (!c) throw new WorkerApiError(404, 'NOT_FOUND', 'Unknown question/incident');
      return c;
    },
    review: async (body: ReviewRequest) => {
      if (opts.reviewErrors) throw new WorkerApiError(422, 'VALIDATION_FAILED', 'refused', opts.reviewErrors);
      sent.push(body);
      return { ok: true, questionId: body.questionId, state: 'approved' };
    },
  } as unknown as WorkerClient;
  return {
    lines,
    sent,
    checked,
    deps: {
      log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`), error: (m: string) => lines.push(`ERROR ${m}`) },
      env: { ADMIN_API_URL: 'https://gta-florida-api-staging.example.workers.dev', ADMIN_TOKEN: 'test-admin-token-0123456789abcdef0123', REVIEWER: 'owner' },
      cfg,
      readFile: () => JSON.stringify(batch),
      createClient: () => client,
      linkCheck: async (u: string): Promise<LinkCheck> => {
        checked.push(u);
        return { status: opts.link ?? 'ok', httpStatus: 200, finalUrl: u, checkedAt: '2026-11-28T10:00:00.000Z' };
      },
      sleep: async () => {},
    },
  };
}
const cand = (e: BankEntry, state = 'candidate', text: Partial<Cand> = {}): Cand => ({ question_id: `q_${e.eventId}`, quality_state: state, play_title: e.headline, explanation: e.explanation, ...text });
const key = (e: BankEntry) => `bank:${entryKey(e)}`;

describe('bank:approve', () => {
  it('approves each reviewed question as an unchanged, reviewed AI-assisted draft after a live link check', async () => {
    const a = fl();
    const b = gta();
    const h = harness(file([a, b]), { [key(a)]: cand(a), [key(b)]: cand(b) });
    expect(await main(['--file', 'approved.json'], h.deps)).toBe(0);
    expect(h.checked).toEqual([a.sourceUrl, b.sourceUrl]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toMatchObject({
      questionId: 'q_test-fl-pier',
      action: 'approve',
      mode: 'factual_summary',
      playTitle: a.headline,
      explanation: a.explanation,
      publishedAt: '2026-10-02',
      publisher: 'News 6',
      eventId: 'test-fl-pier',
      linkCheck: { status: 'ok' },
      factual: { humanWritten: false, textOrigin: 'machine_draft_reviewed', verifiedDate: '2026-10-02', verifiedLocation: 'Example Beach, Florida', evidenceUrls: [a.sourceUrl] },
    });
    expect(h.sent[0]!.factual!.notes).toMatch(/AI-assisted draft.*\(2026-11-25\).*approved unchanged by owner .* at 2026-11-27T20:00:00.000Z/);
    expect(h.sent[1]).toMatchObject({ game: 'GTA_III', spoiler: true, factual: { verifiedDate: '2026-11-24', verifiedLocation: 'GTA III', textOrigin: 'machine_draft_reviewed' } });
    expect(h.lines.at(-2)).toMatch(/Approved 2, already approved 0, not imported 0, refused 0/);
  });

  it('never sends a verification date later than the dashboard decision (local note date vs UTC decision)', async () => {
    const b = gta({ notes: 'Editorially approved in the local review dashboard by owner at 2026-11-27T22:30:00.000Z. Batch 011. Verified 2026-11-28 against two reference sites.' });
    const h = harness(file([b]), { [key(b)]: cand(b) });
    expect(await main(['--file', 'approved.json'], h.deps)).toBe(0);
    expect(h.sent[0]!.factual!.verifiedDate).toBe('2026-11-27');
    expect(h.sent[0]!.factual!.notes).toMatch(/during research \(2026-11-27\)/);
  });

  it('refuses the whole file when a question has no dashboard approval record (nothing is sent)', async () => {
    const a = fl({ notes: 'Batch 001. Verified 2026-11-25.' });
    const h = harness(file([a, gta()]), {});
    expect(await main(['--file', 'approved.json'], h.deps)).toBe(2);
    expect(h.sent).toEqual([]);
    expect(h.lines.join('\n')).toMatch(/no approval record from the review dashboard[\s\S]*Nothing was approved/);
  });

  it('skips approved questions, reports missing ones, and refuses changed text or a broken link', async () => {
    const a = fl();
    const b = gta();
    const c = fl({ eventId: 'test-fl-other', headline: 'A pelican rode the hood of a delivery van through three intersections', sourceUrl: 'https://www.clickorlando.com/news/local/2026/10/03/test-pelican/' });
    const d = gta({ eventId: 'test-gta-other', headline: 'A man towed a parked bus across town with a pickup truck', sourceUrl: 'https://www.grandtheftwiki.com/Other_Mission' });
    const h = harness(file([a, b, c, d]), { [key(a)]: cand(a, 'approved'), [key(b)]: null, [key(c)]: cand(c, 'candidate', { play_title: 'Something else entirely about a pelican' }), [key(d)]: cand(d) }, { link: 'broken' });
    expect(await main(['--file', 'approved.json'], h.deps)).toBe(2);
    expect(h.sent).toEqual([]);
    const out = h.lines.join('\n');
    expect(out).toMatch(/test-gta-van: not in the Worker; run bank:import/);
    expect(out).toMatch(/test-fl-other: the Worker's stored text differs/);
    expect(out).toMatch(/test-gta-other: link check broken/);
    expect(out).toMatch(/Approved 0, already approved 1, not imported 1, refused 2/);
  });

  it('reports the Worker refusal reasons; --link-verified-manually skips the live check', async () => {
    const a = fl();
    const h = harness(file([a]), { [key(a)]: cand(a) }, { reviewErrors: ['FACTUAL_PROVENANCE: example'] });
    expect(await main(['--file', 'approved.json', '--link-verified-manually'], h.deps)).toBe(2);
    expect(h.checked).toEqual([]);
    expect(h.lines.join('\n')).toMatch(/refused by the Worker:\s+- FACTUAL_PROVENANCE/);
  });

  it('dry run is offline; production needs --allow-production', async () => {
    const a = fl();
    const dry = harness(file([a]), {});
    expect(await main(['--file', 'approved.json', '--dry-run'], dry.deps)).toBe(0);
    expect(dry.sent).toEqual([]);
    const prod = harness(file([a]), { [key(a)]: cand(a) });
    expect(await main(['--file', 'approved.json', '--env', 'production'], prod.deps)).toBe(2);
    expect(prod.sent).toEqual([]);
    expect(prod.lines.join('\n')).toMatch(/--allow-production/);
  });
});
