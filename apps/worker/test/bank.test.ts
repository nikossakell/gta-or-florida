/**
 * Verified question bank, end to end through the Worker: curated drafts (apps/ingest bank:import format)
 * → manual candidates with event id + spoiler flag → scheduling metadata edits → /schedule API →
 * public play of a question reused on a later day, without leaking the answer.
 * All content is fictional test data on IANA-reserved example hosts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChallengeResponse, ScheduleResponse } from '@gof/core';
import { toImportItem, type BankEntry } from '../../ingest/src/bank-item.ts';
import { scheduleRounds } from '../src/services/scheduling.ts';
import { ADMIN_TOKEN, SERVICE_TOKEN, createHarness, postJson, seedMany, type Harness } from './harness.ts';

let h: Harness;
const TODAY = '2026-11-25';
const now = new Date(`${TODAY}T12:00:00Z`);

beforeAll(async () => {
  h = await createHarness({ APP_ENV: 'staging' });
});
afterAll(() => h.dispose());
beforeEach(() => h.reset());

const call = (path: string, init: RequestInit = {}) => h.fetch(path, { ...init, now });

const entries: BankEntry[] = [
  {
    eventId: 'test-fl-heron',
    origin: 'FLORIDA',
    headline: 'A heron keeps stealing bait from the same pier every morning at sunrise',
    explanation: 'Test entry: the linked report says anglers documented a heron taking bait from one pier for weeks.',
    sourceUrl: 'https://news.example.org/heron-pier',
    sourceTitle: 'Anglers say bird is a regular at local pier',
    publisher: 'Example News',
    publishedAt: '2026-10-02',
    location: 'Example Beach, Florida',
    category: 'wildlife',
  },
  {
    eventId: 'test-fl-heron',
    origin: 'FLORIDA',
    headline: 'Fishermen notice one wading bird helping itself to their bait for weeks',
    explanation: 'Test entry: a second wording of the same event, so it shares the event id and its cooldown.',
    sourceUrl: 'https://news.example.org/heron-pier',
    sourceTitle: 'Anglers say bird is a regular at local pier',
    publisher: 'Example News',
    publishedAt: '2026-10-02',
    location: 'Example Beach, Florida',
  },
  {
    eventId: 'test-gta-trailer',
    origin: 'GTA',
    headline: 'Two leads plan a heist in a newly released trailer scene',
    explanation: 'Test entry: stands in for upcoming-game story content; it stays a candidate until a human reviews it.',
    sourceUrl: 'https://www.grandtheftwiki.com/Test_Trailer',
    sourceTitle: 'Test Trailer',
    game: 'GTA_VI',
    spoiler: true,
  },
];

describe('curated bank import', () => {
  it('stores drafts as candidates with their event id and spoiler flag; re-importing is a no-op', async () => {
    const items = entries.map((e) => toImportItem(e, { batch: 'test-batch' }, now));
    const first = await (await call('/api/v1/admin/import', postJson({ items }, SERVICE_TOKEN, { 'idempotency-key': 'bank-import-1' }))).json();
    expect(first.results.map((r: { outcome: string }) => r.outcome)).toEqual(['inserted', 'inserted', 'inserted']);
    const rows = await h.db
      .prepare(`SELECT q.quality_state, q.event_id, q.spoiler, q.gate_reasons, sr.provider, sr.original_url FROM questions q JOIN source_references sr ON sr.id = q.primary_reference_id ORDER BY q.play_title`)
      .all<{ quality_state: string; event_id: string; spoiler: number; gate_reasons: string | null; provider: string; original_url: string }>();
    expect(rows.results.map((r) => [r.quality_state, r.event_id, r.spoiler, r.provider])).toEqual([
      ['candidate', 'test-fl-heron', 0, 'manual'],
      ['candidate', 'test-fl-heron', 0, 'manual'],
      ['candidate', 'test-gta-trailer', 1, 'manual'],
    ]);
    // A human always reviews curated drafts; both wordings keep the real source URL.
    expect(rows.results.every((r) => r.quality_state === 'candidate')).toBe(true);
    expect(rows.results.filter((r) => r.original_url === 'https://news.example.org/heron-pier')).toHaveLength(2);

    const again = await (await call('/api/v1/admin/import', postJson({ items }, SERVICE_TOKEN, { 'idempotency-key': 'bank-import-2' }))).json();
    expect(again.results.map((r: { outcome: string }) => r.outcome)).toEqual(['duplicate', 'duplicate', 'duplicate']);
  });

  it('lets a reviewer regroup events or flag spoilers on approved questions, but not change their wording', async () => {
    await seedMany(h.db, 1, 0);
    const id = (await h.db.prepare('SELECT id FROM questions').first<{ id: string }>())!.id;
    const edit = (body: Record<string, unknown>) => call('/api/v1/admin/review', postJson({ questionId: id, action: 'edit', ...body }, ADMIN_TOKEN, { 'x-actor': 'owner' }));
    expect((await edit({ eventId: 'shared-event-1', spoiler: true })).status).toBe(200);
    expect(await h.db.prepare('SELECT quality_state, event_id, spoiler FROM questions WHERE id = ?').bind(id).first()).toEqual({ quality_state: 'approved', event_id: 'shared-event-1', spoiler: 1 });
    const text = await edit({ playTitle: 'A completely different headline for this question' });
    expect(text.status).toBe(422);
    expect(JSON.stringify(await text.json())).toMatch(/only --event-id \/ --spoiler/);
    expect((await edit({ eventId: 'Not Valid!' })).status).toBe(400);
    const log = await h.db.prepare(`SELECT decision, details FROM review_log WHERE entity_id = ? AND decision = 'edited'`).bind(id).first<{ details: string }>();
    expect(JSON.parse(log!.details)).toEqual({ eventId: 'shared-event-1', spoiler: true });
  });
});

describe('/api/v1/admin/schedule', () => {
  const schedule = (body: Record<string, unknown>) => call('/api/v1/admin/schedule', postJson(body, SERVICE_TOKEN));

  it('accepts a 30- or 90-day horizon, a cooldown and the spoiler switch; refuses longer periods and past dates', async () => {
    await seedMany(h.db, 12, 12);
    const r = (await (await schedule({ days: 30, startDate: TODAY, dryRun: true, cooldownDays: 4 })).json()) as ScheduleResponse;
    expect(r).toMatchObject({ ok: true, settings: { days: 30, cooldownDays: 4, includeSpoilers: true, dryRun: true } });
    const optOut = (await (await schedule({ days: 30, startDate: TODAY, dryRun: true, cooldownDays: 4, includeSpoilers: false })).json()) as ScheduleResponse;
    expect(optOut.settings.includeSpoilers).toBe(false);
    expect(r.added).toHaveLength(30);
    expect((await schedule({ days: 90, startDate: TODAY, dryRun: true, cooldownDays: 4 })).status).toBe(200);
    expect((await schedule({ days: 91, startDate: TODAY })).status).toBe(400);
    expect((await schedule({ days: 5, startDate: '2026-11-24' })).status).toBe(400);
    expect(await h.db.prepare('SELECT COUNT(*) AS n FROM daily_rounds').first()).toEqual({ n: 0 });
  });

  it('returns an actionable error (200, ok: false) and writes nothing when the period cannot be filled', async () => {
    await seedMany(h.db, 3, 3);
    const r = (await (await schedule({ days: 2, startDate: TODAY })).json()) as ScheduleResponse;
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'SCHEDULE_INFEASIBLE', date: '2026-11-26' });
    expect(r.error!.message).toMatch(/3 Florida and 3 GTA event\(s\).*Nothing was written/);
    expect(await h.db.prepare('SELECT COUNT(*) AS n FROM daily_rounds').first()).toEqual({ n: 0 });
  });
});

describe('public play with a reused question', () => {
  it('serves the same question on two days (after its cooldown) without leaking answers, sources or event ids', async () => {
    await seedMany(h.db, 3, 3);
    await h.db.prepare(`UPDATE questions SET event_id = 'secret-event-' || id`).run();
    // 6 events, 1-day cooldown: day 2 must reuse questions from day 1.
    const r = await scheduleRounds(h.db, { startDate: '2026-11-24', days: 2, cooldownDays: 1 });
    expect(r.ok).toBe(true);
    const reused = await h.db.prepare('SELECT COUNT(*) AS n FROM (SELECT question_id FROM daily_round_items GROUP BY question_id HAVING COUNT(*) = 2)').first<{ n: number }>();
    expect(reused!.n).toBeGreaterThan(0);
    for (const day of ['2026-11-24', '2026-11-25']) {
      const res = await call(`/api/challenge/${day}`);
      expect(res.status).toBe(200);
      const raw = await res.text();
      const body = JSON.parse(raw) as ChallengeResponse;
      expect(body.questions.map((q) => q.id)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
      for (const q of body.questions) expect(Object.keys(q).sort()).toEqual(['headline', 'id']);
      expect(raw).not.toMatch(/SECRET|secret-event|ORIGINAL HEADLINE|https?:\/\/|FLORIDA|GTA_|"florida"|"gta"|answer|source|origin|event_id|eventId|spoiler/i);
      const finish = await (await call(`/api/challenge/${day}/finish`, postJson({ answers: body.questions.map((q) => ({ questionId: q.id, choice: 'GTA' })) }))).json();
      expect(finish.total).toBe(5);
      expect(finish.score).toBe(finish.cells.filter((c: boolean) => c).length);
    }
  });

  it('schedules spoiler-flagged questions by default and serves them without exposing the flag or the answer before a guess', async () => {
    await seedMany(h.db, 3, 2);
    await h.db.prepare(`UPDATE questions SET spoiler = 1 WHERE answer_kind = 'GTA'`).run();
    expect((await scheduleRounds(h.db, { startDate: TODAY, days: 1 })).ok).toBe(true);
    const flagged = await h.db.prepare('SELECT COUNT(*) AS n FROM daily_round_items i JOIN questions q ON q.id = i.question_id WHERE q.spoiler = 1').first<{ n: number }>();
    expect(flagged!.n).toBe(2);
    const res = await call('/api/challenge/today');
    expect(res.status).toBe(200);
    const raw = await res.text();
    for (const q of (JSON.parse(raw) as ChallengeResponse).questions) expect(Object.keys(q).sort()).toEqual(['headline', 'id']);
    expect(raw).not.toMatch(/spoiler|answer|source|origin|event_?id|FLORIDA|GTA_|"florida"|"gta"|https?:\/\//i);
  });

  it('an imported spoiler draft (e.g. unreleased-game story) stays out of every round until a human approves it', async () => {
    const items = entries.map((e) => toImportItem(e, { batch: 'test-batch' }, now));
    expect((await call('/api/v1/admin/import', postJson({ items }, SERVICE_TOKEN, { 'idempotency-key': 'bank-import-spoiler' }))).status).toBe(200);
    await seedMany(h.db, 3, 3);
    const draft = (await h.db.prepare(`SELECT id, quality_state FROM questions WHERE event_id = 'test-gta-trailer'`).first<{ id: string; quality_state: string }>())!;
    expect(draft.quality_state).toBe('candidate');
    const r = await scheduleRounds(h.db, { startDate: TODAY, days: 1 });
    expect(r.error).toBeNull();
    expect(await h.db.prepare('SELECT COUNT(*) AS n FROM daily_round_items WHERE question_id = ?').bind(draft.id).first()).toEqual({ n: 0 });
  });
});
