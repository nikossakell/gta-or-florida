/**
 * Review service end to end on a real local D1 (workerd via getPlatformProxy) with fictional fixtures:
 * loading, one-click decisions, changing a decision, history, edits + validation, exports,
 * persistence after restart, and isolation (no network, no Worker approvals).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseBankFile, validateBank } from '../../ingest/src/bank.ts';
import { loadSourcesConfig } from '../../ingest/src/config-file.ts';
import { REPO_ROOT } from '../../ingest/src/paths.ts';
import { ReviewService } from '../src/service.ts';
import { BANK, tempDir, writeBank } from './fixtures.ts';

const NOW = new Date('2026-11-25T12:00:00Z');
let dir: string;
let svc: ReviewService;
const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeAll(async () => {
  dir = tempDir('svc');
  svc = await ReviewService.open({ masterPath: writeBank(dir), persistDir: `${dir}/state`, reviewer: 'Test Reviewer', now: () => NOW });
});
afterAll(async () => {
  await svc.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const db = () => (svc as unknown as { w: { db: D1Database } }).w.db;
const workerState = (eventId: string) =>
  db()
    .prepare(`SELECT q.quality_state, q.play_title FROM questions q JOIN editorial_items e ON e.question_id = q.id WHERE e.event_id = ?`)
    .bind(eventId)
    .first<{ quality_state: string; play_title: string }>();

describe('loading', () => {
  it('imports every master question as a local candidate, unreviewed', async () => {
    const s = await svc.summary();
    expect(s).toMatchObject({ total: 4, approved: 0, investigate: 0, rejected: 0, unreviewed: 4, progressPercent: 0, florida: { total: 2 }, gta: { total: 2 } });
    expect(s.master.changedSinceImport).toBe(false);
    expect((await svc.list()).map((i) => i.eventId)).toEqual(BANK.questions.map((q) => q.eventId));
    for (const q of BANK.questions) expect((await workerState(q.eventId))?.quality_state).toBe('candidate');
  });

  it('shows the question and its source', async () => {
    const d = await svc.detail('test-fl-heron-pier');
    expect(d.working.headline).toBe(BANK.questions[0]!.headline);
    expect(d.original.sourceUrl).toBe('https://news.example.org/heron-pier');
    expect(d.history.map((h) => h.action)).toEqual(['imported']);
  });

  it('rejects unknown and malformed ids', async () => {
    await expect(svc.detail('no-such-question')).rejects.toMatchObject({ status: 404 });
    await expect(svc.detail('../etc/passwd')).rejects.toMatchObject({ status: 400 });
  });
});

describe('one-click decisions', () => {
  it('approve, investigate and reject need nothing but the click', async () => {
    expect(await svc.decide('test-fl-heron-pier', 'approved', {})).toMatchObject({ ok: true, changed: true });
    expect(await svc.decide('test-gta-ice-rink-zamboni', 'investigate', undefined)).toMatchObject({ ok: true });
    expect(await svc.decide('test-fl-wheelbarrow-parade', 'rejected', {})).toMatchObject({ ok: true });
    expect(await svc.summary()).toMatchObject({ approved: 1, investigate: 1, rejected: 1, unreviewed: 1, progressPercent: 75, florida: { approved: 1, rejected: 1 }, gta: { investigate: 1, unreviewed: 1 } });
  });

  it('an optional note is kept; bad input is refused', async () => {
    await svc.decide('test-gta-ice-rink-zamboni', 'investigate', { note: 'Need a second wiki source' });
    expect((await svc.detail('test-gta-ice-rink-zamboni')).statusNote).toBe('Need a second wiki source');
    await expect(svc.decide('test-gta-ice-rink-zamboni', 'investigate', { note: 'x'.repeat(501) })).rejects.toMatchObject({ status: 400 });
    await expect(svc.decide('test-gta-ice-rink-zamboni', 'investigate', { attest: true })).rejects.toMatchObject({ status: 400 });
  });

  it('clicking the current decision again changes nothing', async () => {
    const before = (await svc.detail('test-fl-heron-pier')).history.length;
    expect(await svc.decide('test-fl-heron-pier', 'approved', {})).toMatchObject({ changed: false });
    expect((await svc.detail('test-fl-heron-pier')).history).toHaveLength(before);
  });

  it('a decision can be changed by clicking another button; the history keeps every step', async () => {
    await svc.decide('test-fl-wheelbarrow-parade', 'approved', {});
    const d = await svc.detail('test-fl-wheelbarrow-parade');
    expect(d.status).toBe('approved');
    expect(d.history.map((h) => [h.action, h.from_status, h.to_status])).toEqual([
      ['imported', null, 'unreviewed'],
      ['rejected', 'unreviewed', 'rejected'],
      ['approved', 'rejected', 'approved'],
    ]);
    expect(d.history.every((h) => h.reviewer === 'Test Reviewer' || h.action === 'imported')).toBe(true);
  });

  it('never creates a Worker approval or attestation (decisions are editorial only)', async () => {
    for (const q of BANK.questions) expect((await workerState(q.eventId))?.quality_state).toBe('candidate');
    const n = await db().prepare(`SELECT COUNT(*) AS n FROM review_log WHERE decision LIKE 'approved%'`).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('history is append-only', async () => {
    await expect(db().prepare('UPDATE editorial_events SET note = ? WHERE id = 1').bind('x').run()).rejects.toThrow(/append-only/);
    await expect(db().prepare('DELETE FROM editorial_events').run()).rejects.toThrow(/append-only/);
  });
});

describe('editing (API)', () => {
  it('runs the existing content validators and keeps both versions', async () => {
    const bad = await svc.edit('test-gta-crane-car', { headline: 'Florida man parade' });
    expect(bad.validation.problems.join(' ')).toMatch(/PLAY_TITLE/);
    const next = 'A man used a construction crane to hoist a parked sports car onto a rooftop';
    expect((await svc.edit('test-gta-crane-car', { headline: next })).validation.problems).toEqual([]);
    const edits = (await svc.detail('test-gta-crane-car')).history.filter((h) => h.action === 'edited');
    expect(edits[0]?.before).toMatchObject({ headline: BANK.questions[2]!.headline });
    expect(edits.at(-1)?.after).toMatchObject({ headline: next });
    expect((await workerState('test-gta-crane-car'))?.play_title).toBe(next);
  });

  it('cannot change source evidence or identity', async () => {
    await expect(svc.edit('test-gta-crane-car', { sourceUrl: 'https://evil.example.org/' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.edit('test-gta-crane-car', { eventId: 'other-event' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('exports', () => {
  it('approved export uses the question-bank schema and passes the bank validators', async () => {
    const f = (await svc.exportFile('approved')) as { questions: { eventId: string; headline: string; notes?: string }[] };
    expect(f.questions.map((q) => q.eventId)).toEqual(['test-fl-heron-pier', 'test-fl-wheelbarrow-parade']);
    expect(f.questions[0]!.notes).toMatch(/^Editorially approved in the local review dashboard by Test Reviewer .* Not a Worker approval\./);
    const parsed = parseBankFile(f);
    expect(parsed.ok).toBe(true);
    const reports = validateBank((parsed as unknown as { file: never }).file, loadSourcesConfig(`${REPO_ROOT}/data`));
    expect(reports.every((r) => r.problems.length === 0)).toBe(true);
  });

  it('investigate and rejected exports carry the decision', async () => {
    const inv = (await svc.exportFile('investigate')) as { questions: { eventId: string; notes?: string }[] };
    expect(inv.questions.map((q) => q.eventId)).toEqual(['test-gta-ice-rink-zamboni']);
    expect(inv.questions[0]!.notes).toMatch(/Need a second wiki source/);
    await svc.decide('test-gta-crane-car', 'rejected', {});
    expect(((await svc.exportFile('rejected')) as { questions: { eventId: string }[] }).questions.map((q) => q.eventId)).toEqual(['test-gta-crane-car']);
  });

  it('history export lists every item and event', async () => {
    const h = (await svc.exportFile('history')) as unknown as { items: { status: string }[]; editorialEvents: { action: string }[] };
    expect(h.items).toHaveLength(4);
    expect(h.editorialEvents.map((e) => e.action)).toEqual(expect.arrayContaining(['imported', 'approved', 'investigate', 'rejected', 'edited']));
  });
});

describe('persistence and failure handling', () => {
  it('survives a restart; a changed master is detected and never re-imported', async () => {
    const d2 = tempDir('restart');
    const master = writeBank(d2);
    const state = `${d2}/state`;
    const a = await ReviewService.open({ masterPath: master, persistDir: state, reviewer: 'R1', now: () => NOW });
    await a.decide('test-gta-crane-car', 'approved', {});
    await a.decide('test-fl-wheelbarrow-parade', 'investigate', {});
    await a.dispose();
    writeFileSync(master, readFileSync(master, 'utf8').replace('A heron kept', 'An egret kept'));
    const b = await ReviewService.open({ masterPath: master, persistDir: state, reviewer: 'R2', now: () => NOW });
    const s = await b.summary();
    expect(s).toMatchObject({ total: 4, approved: 1, investigate: 1, unreviewed: 2 });
    expect(s.master.changedSinceImport).toBe(true);
    expect((await b.detail('test-fl-heron-pier')).working.headline).toMatch(/heron/);
    await b.dispose();
    rmSync(d2, { recursive: true, force: true });
  });

  it('an updated master adds its new questions as unreviewed and keeps every existing decision', async () => {
    const d4 = tempDir('append');
    const master = writeBank(d4);
    const state = `${d4}/state`;
    const a = await ReviewService.open({ masterPath: master, persistDir: state, reviewer: 'R1', now: () => NOW });
    await a.decide('test-gta-crane-car', 'rejected', {});
    await a.decide('test-fl-heron-pier', 'approved', {});
    await a.dispose();
    const extra = {
      eventId: 'test-fl-kayak-drive-thru',
      origin: 'FLORIDA' as const,
      headline: 'A man paddled a kayak through a flooded fast-food drive-thru lane to place his order',
      explanation: 'Test entry: the linked report says staff served the kayaker at the window after heavy rain flooded the lot.',
      sourceUrl: 'https://news.example.org/kayak-drive-thru',
      sourceTitle: 'Customer arrives by boat after storm',
      publisher: 'Example News',
      publishedAt: '2026-08-30',
      location: 'Sampletown, Example County, Florida',
      category: 'weird' as const,
      difficulty: 1,
    };
    // The rejected question leaves the master; a new one arrives.
    writeBank(d4, { ...BANK, questions: [...BANK.questions.filter((q) => q.eventId !== 'test-gta-crane-car'), extra] });
    const b = await ReviewService.open({ masterPath: master, persistDir: state, reviewer: 'R2', now: () => NOW });
    const s = await b.summary();
    expect(s).toMatchObject({ total: 5, approved: 1, rejected: 1, unreviewed: 3 });
    expect(s.master.changedSinceImport).toBe(false);
    const list = await b.list();
    expect(list.at(-1)).toMatchObject({ eventId: 'test-fl-kayak-drive-thru', status: 'unreviewed', position: 5 });
    expect((await b.detail('test-gta-crane-car')).status).toBe('rejected');
    expect((await b.detail('test-fl-kayak-drive-thru')).history[0]?.note).toMatch(/^Added from an updated master/);
    await b.dispose();
    rmSync(d4, { recursive: true, force: true });
  });

  it('refuses an invalid master instead of importing part of it', async () => {
    const d3 = tempDir('invalid');
    const bad = { ...BANK, questions: [{ ...BANK.questions[0]!, headline: 'Florida Florida Florida Florida' }] };
    await expect(ReviewService.open({ masterPath: writeBank(d3, bad), persistDir: false, reviewer: 'R', now: () => NOW })).rejects.toMatchObject({ status: 400 });
    rmSync(d3, { recursive: true, force: true });
  });

  it('only targets the local environment and makes no network requests', () => {
    expect((svc as unknown as { w: { env: { APP_ENV: string } } }).w.env.APP_ENV).toBe('local');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
