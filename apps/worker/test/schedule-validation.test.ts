/**
 * Pre-deployment validation of the question-bank scheduler against a real local D1:
 *  1. exact cooldown boundary through the persisted-history query (no off-by-one)
 *  3. repeated generation never alters existing rounds; a failed write leaves nothing behind
 *  5. the daily cron with too little approved content: no silent gaps, loud signals instead
 * (2 = simulation: scripts/simulate-schedule.ts; 4 = migration: migration-0004.test.ts)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, createRng, daysBetween } from '@gof/core';
import { ensureSchedule, scheduleRounds } from '../src/services/scheduling.ts';
import { ADMIN_TOKEN, createHarness, postJson, seedMany, type Harness } from './harness.ts';

let h: Harness;
const START = '2026-12-01';

beforeAll(async () => {
  h = await createHarness({ APP_ENV: 'staging' });
});
afterAll(() => h.dispose());
beforeEach(() => h.reset());

const roundRows = async () => (await h.db.prepare('SELECT * FROM daily_rounds ORDER BY day').all()).results;
const itemRows = async () => (await h.db.prepare('SELECT * FROM daily_round_items ORDER BY day, position').all()).results;
const days = async () => (await h.db.prepare('SELECT day FROM daily_rounds ORDER BY day').all<{ day: string }>()).results.map((r) => r.day);

/** Every persisted day: 5 distinct events, and no event twice within `cooldown` days. */
async function expectCooldownRespected(cooldown: number) {
  const { results } = await h.db
    .prepare(`SELECT i.day, COALESCE(q.event_id, q.incident_id) AS ev FROM daily_round_items i JOIN questions q ON q.id = i.question_id ORDER BY i.day`)
    .all<{ day: string; ev: string }>();
  const last = new Map<string, string>();
  for (const r of results) {
    const prev = last.get(r.ev);
    if (prev && prev !== r.day) expect(daysBetween(prev, r.day), `${r.ev}: ${prev} → ${r.day}`).toBeGreaterThanOrEqual(cooldown);
    last.set(r.ev, r.day);
  }
}

describe('1. cooldown boundary through persisted rounds', () => {
  it('an event shown on D is refused on D+29 and accepted on D+30 (history query window)', async () => {
    await seedMany(h.db, 3, 2); // exactly five events
    expect((await scheduleRounds(h.db, { startDate: START, days: 1, rng: createRng('d0') })).ok).toBe(true);
    const d29 = await scheduleRounds(h.db, { startDate: addDays(START, 29), days: 1, rng: createRng('d29') });
    expect(d29).toMatchObject({ ok: false, added: [] });
    expect(d29.error!.details).toMatchObject({ floridaAvailable: 0, gtaAvailable: 0, cooldownDays: 30 });
    expect((await scheduleRounds(h.db, { startDate: addDays(START, 30), days: 1, rng: createRng('d30') })).ok).toBe(true);
    expect(await days()).toEqual([START, addDays(START, 30)]);
  });

  it('the same boundary holds against an already scheduled LATER day', async () => {
    // Round numbers count from the schedule epoch, so a test that writes a later day first sets the epoch earlier.
    const epoch = () => h.db.prepare(`INSERT INTO app_meta (key, value) VALUES ('schedule_epoch', ?)`).bind(START).run();
    await seedMany(h.db, 3, 2);
    await epoch();
    await scheduleRounds(h.db, { startDate: addDays(START, 30), days: 1, rng: createRng('later') });
    expect((await scheduleRounds(h.db, { startDate: START, days: 1, rng: createRng('before') })).ok).toBe(true);
    await h.reset();
    await seedMany(h.db, 3, 2);
    await epoch();
    await scheduleRounds(h.db, { startDate: addDays(START, 29), days: 1, rng: createRng('later') });
    expect((await scheduleRounds(h.db, { startDate: START, days: 1, rng: createRng('before') })).ok).toBe(false);
  });

  it('a custom cooldown uses the same rule (7 days: D+6 refused, D+7 accepted)', async () => {
    await seedMany(h.db, 3, 2);
    await scheduleRounds(h.db, { startDate: START, days: 1, cooldownDays: 7, rng: createRng('c') });
    expect((await scheduleRounds(h.db, { startDate: addDays(START, 6), days: 1, cooldownDays: 7 })).ok).toBe(false);
    expect((await scheduleRounds(h.db, { startDate: addDays(START, 7), days: 1, cooldownDays: 7 })).ok).toBe(true);
  });
});

describe('3. existing rounds are preserved; failed generation leaves nothing', () => {
  it('a series of overlapping, dry, partial, infeasible and cron runs never changes an existing row', async () => {
    await seedMany(h.db, 30, 30); // 60 events → 12 days under a 30-day cooldown
    await scheduleRounds(h.db, { startDate: START, days: 5, rng: createRng('base') });
    await h.db.batch([
      h.db.prepare(`UPDATE daily_rounds SET status = 'published', published_at = '2026-12-01T00:05:00Z' WHERE day = ?`).bind(START),
      h.db.prepare(`UPDATE daily_rounds SET status = 'withdrawn', withdrawn_reason = 'test', public_message = 'Withdrawn for review.' WHERE day = ?`).bind(addDays(START, 1)),
    ]);
    const rounds0 = await roundRows();
    const items0 = await itemRows();

    await scheduleRounds(h.db, { startDate: START, days: 8, rng: createRng('r1') });
    await scheduleRounds(h.db, { startDate: addDays(START, 2), days: 10, dryRun: true, rng: createRng('r2') });
    const infeasible = await scheduleRounds(h.db, { startDate: START, days: 30, rng: createRng('r3') });
    expect(infeasible.ok).toBe(false);
    await scheduleRounds(h.db, { startDate: START, days: 30, allowPartial: true, rng: createRng('r4') });
    await ensureSchedule(h.db, { now: new Date(`${START}T12:00:00Z`), aheadDays: 30, rng: createRng('r5') });

    const rounds1 = await roundRows();
    const items1 = await itemRows();
    for (const r of rounds0) expect(rounds1.find((x) => x.day === r.day)).toEqual(r); // every column, incl. created_at and number
    for (const i of items0) expect(items1).toContainEqual(i);
    expect(items1.filter((i) => rounds0.some((r) => r.day === i.day))).toEqual(items0);
    // One 'scheduled' audit row per day: no day was written twice.
    const audit = await h.db.prepare(`SELECT entity_id, COUNT(*) AS n FROM review_log WHERE entity_type = 'day' AND decision = 'scheduled' GROUP BY entity_id`).all<{ n: number }>();
    expect(audit.results.every((a) => a.n === 1)).toBe(true);
    expect(audit.results).toHaveLength(rounds1.length);
    await expectCooldownRespected(30);
  });

  it('a write that fails on its LAST day rolls back every day of the batch (also on the automatic retry)', async () => {
    await seedMany(h.db, 20, 20);
    let injected = 0;
    // Simulates a concurrent writer that takes the last planned date right before each write.
    const beforeWrite = async () => {
      const taken = await h.db.prepare('SELECT day FROM daily_rounds').all<{ day: string }>();
      let last = addDays(START, 5);
      while (taken.results.some((r) => r.day === last)) last = addDays(last, -1);
      await h.db.prepare(`INSERT INTO daily_rounds (day, number, florida_count) VALUES (?, ?, 0)`).bind(last, 900 + ++injected).run();
    };
    await expect(scheduleRounds(h.db, { startDate: START, days: 6, rng: createRng('race'), beforeWrite })).rejects.toThrow(/UNIQUE|constraint/i);
    expect(injected).toBe(2); // first attempt + one re-plan
    expect(await h.db.prepare('SELECT COUNT(*) AS n FROM daily_round_items').first()).toEqual({ n: 0 });
    expect((await roundRows()).every((r) => (r.number as number) > 900)).toBe(true); // only the simulated rows
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM review_log WHERE decision = 'scheduled'`).first()).toEqual({ n: 0 });
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM app_meta WHERE key = 'schedule_epoch'`).first()).toEqual({ n: 0 });
  });

  it('an infeasible period writes no round, item, audit row or epoch', async () => {
    await seedMany(h.db, 4, 4);
    const r = await scheduleRounds(h.db, { startDate: START, days: 3, rng: createRng('nope') });
    expect(r.ok).toBe(false);
    for (const t of ['daily_rounds', 'daily_round_items', 'app_meta']) expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).toEqual({ n: 0 });
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM review_log WHERE entity_type = 'day'`).first()).toEqual({ n: 0 });
  });
});

describe('5. daily cron with insufficient approved content', () => {
  const cron = (day: string, seed: string) => ensureSchedule(h.db, { now: new Date(`${day}T00:05:00Z`), aheadDays: 30, rng: createRng(seed) });

  it('fills a contiguous run from today, then reports the missing today loudly; never a hole, never a cooldown breach', async () => {
    await seedMany(h.db, 15, 15); // 30 events → 6 days per 30-day window
    const log: Record<number, { day: string; added: number; todayPlayable: boolean; gaps: string[]; codes: string[] }> = {};
    // Daily runs over the first window and its edge (days 13-28 behave like 6-12; skipped to keep the test fast).
    const runDays = [...Array.from({ length: 13 }, (_, i) => i), 29, 30];
    for (const i of runDays) {
      const day = addDays(START, i);
      const r = await cron(day, `cron-${i}`);
      log[i] = { day, added: r.added.length, todayPlayable: r.todayPlayable, gaps: r.gaps, codes: r.warnings.map((w) => w.code) };
      expect(r.gaps).toEqual([]); // the cron never leaves a hole
      // Rounds from today onwards are contiguous (no day missing between two scheduled days).
      const ahead = (await days()).filter((d) => d >= day);
      ahead.forEach((d, k) => expect(d).toBe(addDays(day, k)));
      if (i === 10) {
        // A missing today is visible to players (not ready), to the owner (stats) and in the last-run record.
        const noon = new Date(`${day}T12:00:00Z`);
        expect((await h.fetch('/api/challenge/today', { now: noon })).status).toBe(503);
        const meta = JSON.parse((await h.db.prepare(`SELECT value FROM app_meta WHERE key = 'last_schedule_run'`).first<{ value: string }>())!.value);
        expect(meta).toMatchObject({ ok: false, todayPlayable: false, gaps: [], runwayDays: 0 });
        const stats = await (await h.fetch('/api/v1/admin/stats', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, now: noon })).json();
        expect(stats.warnings.join(' ')).toMatch(/No playable round for today/);
      }
    }
    expect(log[0]).toMatchObject({ added: 6, todayPlayable: true });
    for (const i of [1, 2, 3, 4, 5]) expect(log[i]!.todayPlayable).toBe(true);
    // Days 6-29: every event is inside its cooldown, so there is no round, and each run says so.
    for (const l of [6, 7, 8, 9, 10, 11, 12, 29].map((i) => log[i]!)) {
      expect(l.todayPlayable).toBe(false);
      expect(l.codes).toEqual(expect.arrayContaining(['no_round_today', 'shortage', 'low_inventory']));
    }
    // From day 30 the first events are free again and the cron resumes on its own.
    expect(log[30]).toMatchObject({ todayPlayable: true });
    await expectCooldownRespected(30);

  });

  it('a hole left by a withdrawal that cannot be refilled is reported as a gap (cron, stats), not left silent', async () => {
    await seedMany(h.db, 20, 20); // 40 events → 8 days
    await cron(START, 'fill');
    expect(await days()).toHaveLength(8);
    const hole = addDays(START, 3);
    const victim = (await h.db.prepare('SELECT question_id FROM daily_round_items WHERE day = ? LIMIT 1').bind(hole).first<{ question_id: string }>())!.question_id;
    const w = await h.fetch('/api/v1/admin/withdraw', { ...postJson({ target: 'question', id: victim, reason: 'test correction' }, ADMIN_TOKEN, { 'x-actor': 'owner' }), now: new Date(`${START}T12:00:00Z`) });
    expect((await w.json()).droppedFutureDays).toEqual([hole]);

    // Only 4 events are outside the cooldown on that date: it cannot be refilled without breaking a constraint.
    const r = await cron(START, 'refill');
    expect(r.gaps).toEqual([hole]);
    expect(r.warnings.find((x) => x.code === 'schedule_gap')!.message).toMatch(new RegExp(`No round on ${hole}`));
    expect(await days()).not.toContain(hole);
    const stats = await (await h.fetch('/api/v1/admin/stats', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, now: new Date(`${START}T12:00:00Z`) })).json();
    expect(stats.warnings.join(' ')).toMatch(new RegExp(`Missing round\\(s\\) on ${hole}`));
    await expectCooldownRespected(30);
  });
});
