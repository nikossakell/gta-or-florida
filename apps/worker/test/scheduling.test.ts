import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, createRng, daysBetween } from '@gof/core';
import { eligiblePool, ensureSchedule, scheduleRounds } from '../src/services/scheduling.ts';
import { ADMIN_TOKEN, APPROVED_PUBLISHER, createHarness, migrationStatements, postJson, seedApproved, seedMany, seedSource, type Harness } from './harness.ts';
import type { SourcePolicy } from '@gof/core';

let h: Harness;
const START = '2026-11-22';

beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.dispose());
beforeEach(() => h.reset());

async function rounds() {
  const { results } = await h.db
    .prepare(
      `SELECT r.day, r.florida_count, r.number, i.position, i.question_id, q.answer_kind
         FROM daily_rounds r JOIN daily_round_items i ON i.day = r.day JOIN questions q ON q.id = i.question_id ORDER BY r.day, i.position`,
    )
    .all<{ day: string; florida_count: number; number: number; position: number; question_id: string; answer_kind: string }>();
  const byDay = new Map<string, typeof results>();
  for (const r of results) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  return byDay;
}

const floridaPerDay = (days: Awaited<ReturnType<typeof rounds>>) => [...days.values()].map((d) => d.filter((x) => x.answer_kind === 'FLORIDA').length);
const eventOf = async () =>
  new Map(
    (await h.db.prepare('SELECT id, COALESCE(event_id, incident_id) AS ev FROM questions').all<{ id: string; ev: string }>()).results.map((r) => [r.id, r.ev]),
  );

/** Hard constraints on what is persisted: 5 per day, no duplicate question/event in a day, cooldown between uses of an event. */
async function expectValidSchedule(cooldown: number) {
  const days = await rounds();
  const ev = await eventOf();
  const lastUse = new Map<string, string>();
  for (const [day, items] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    expect(items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(items.map((i) => i.question_id)).size).toBe(5);
    expect(new Set(items.map((i) => ev.get(i.question_id))).size).toBe(5);
    expect(items[0]!.florida_count).toBe(items.filter((i) => i.answer_kind === 'FLORIDA').length);
    for (const i of items) {
      const e = ev.get(i.question_id)!;
      const prev = lastUse.get(e);
      if (prev) expect(daysBetween(prev, day), `${e} on ${prev} and ${day}`).toBeGreaterThanOrEqual(cooldown);
      lastUse.set(e, day);
    }
  }
  return days;
}

describe('scheduleRounds (verified bank, pseudo-random days)', () => {
  it('writes exactly five questions a day with no duplicate question or event, numbered from the epoch', async () => {
    await seedMany(h.db, 40, 40);
    const r = await scheduleRounds(h.db, { startDate: START, days: 10, rng: createRng('basic') });
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.added).toHaveLength(10);
    const days = await expectValidSchedule(30);
    expect([...days.values()].map((d) => d[0]!.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.added.map((a) => a.floridaCount)).toEqual(floridaPerDay(days));
    expect(r.settings).toMatchObject({ startDate: START, days: 10, cooldownDays: 30, includeSpoilers: false });
  });

  it('persists any split, including 0 Florida / 5 GTA and 5 Florida / 0 GTA (no fixed ratio)', async () => {
    await seedMany(h.db, 12, 12);
    // Every slot draw below 0.5 is Florida: a constant source forces the extremes.
    await scheduleRounds(h.db, { startDate: START, days: 2, cooldownDays: 2, rng: () => 0.9 });
    await scheduleRounds(h.db, { startDate: addDays(START, 2), days: 2, cooldownDays: 2, rng: () => 0.1 });
    expect(floridaPerDay(await expectValidSchedule(2))).toEqual([0, 0, 5, 5]);
  });

  it('is idempotent: re-running keeps existing days, their questions and their order', async () => {
    await seedMany(h.db, 20, 20);
    await scheduleRounds(h.db, { startDate: START, days: 3, rng: createRng('a') });
    const before = await rounds();
    const again = await scheduleRounds(h.db, { startDate: START, days: 3, rng: createRng('b') });
    expect(again.added).toEqual([]);
    expect(again.kept).toEqual([START, addDays(START, 1), addDays(START, 2)]);
    expect(await rounds()).toEqual(before);
  });

  it('never changes published or withdrawn days when a later run overlaps them', async () => {
    await seedMany(h.db, 30, 30);
    await scheduleRounds(h.db, { startDate: START, days: 2, rng: createRng('pub') });
    await h.db.batch([
      h.db.prepare(`UPDATE daily_rounds SET status = 'published' WHERE day = ?`).bind(START),
      h.db.prepare(`UPDATE daily_rounds SET status = 'withdrawn' WHERE day = ?`).bind(addDays(START, 1)),
    ]);
    const before = await rounds();
    const r = await scheduleRounds(h.db, { startDate: START, days: 4, rng: createRng('later') });
    expect(r.kept).toEqual([START, addDays(START, 1)]);
    expect(r.added.map((a) => a.date)).toEqual([addDays(START, 2), addDays(START, 3)]);
    const after = await rounds();
    expect(after.get(START)).toEqual(before.get(START));
    expect(after.get(addDays(START, 1))).toEqual(before.get(addDays(START, 1)));
    await expectValidSchedule(30); // withdrawn days still count for the cooldown
  });

  it('reuses a question only after its event cooldown, preferring the least-used ones', async () => {
    await seedMany(h.db, 5, 5);
    const r = await scheduleRounds(h.db, { startDate: START, days: 6, cooldownDays: 2, rng: createRng('reuse') });
    expect(r.ok).toBe(true);
    await expectValidSchedule(2);
    const uses = await h.db.prepare('SELECT question_id, COUNT(*) AS n FROM daily_round_items GROUP BY question_id').all<{ n: number }>();
    expect(uses.results).toHaveLength(10);
    expect(uses.results.every((u) => u.n === 3)).toBe(true); // 30 slots over 10 questions, evenly
  });

  it('keeps the cooldown against persisted days and reports the blocking inventory instead of writing a bad day', async () => {
    await seedMany(h.db, 10, 10);
    expect((await scheduleRounds(h.db, { startDate: START, days: 3, rng: createRng('c1') })).ok).toBe(true);
    // 20 events, 15 shown in the last 3 days: a 30-day cooldown leaves 5, enough for one more day only.
    const r = await scheduleRounds(h.db, { startDate: addDays(START, 10), days: 2, rng: createRng('c2') });
    expect(r.ok).toBe(false);
    expect(r.added).toEqual([]);
    expect(r.error).toMatchObject({ code: 'SCHEDULE_INFEASIBLE', date: addDays(START, 11) });
    expect(r.error!.details).toMatchObject({ plannedDays: 1, requestedDays: 2, floridaEvents: 10, gtaEvents: 10, cooldownDays: 30 });
    expect(r.error!.message).toMatch(/Cannot fill .* 30-day event cooldown.*Nothing was written/);
    expect(r.warnings.map((w) => w.code)).toContain('shortage');
    expect((await rounds()).size).toBe(3);
    await expectValidSchedule(30);
  });

  it('plans the whole period first: all days or none (unless allowPartial, which writes the valid prefix)', async () => {
    await seedMany(h.db, 6, 4);
    const none = await scheduleRounds(h.db, { startDate: START, days: 5, rng: createRng('short') });
    expect(none).toMatchObject({ ok: false, added: [], shortageDate: addDays(START, 2) });
    expect((await rounds()).size).toBe(0);
    const partial = await scheduleRounds(h.db, { startDate: START, days: 5, allowPartial: true, rng: createRng('short') });
    expect(partial.ok).toBe(false);
    expect(partial.added).toHaveLength(2);
    expect(partial.error!.message).toMatch(/Wrote the 2 day\(s\) before/);
    expect(partial.inventory.runwayDays).toBe(2);
    await expectValidSchedule(30);
  });

  it('handles a missing category by drawing from what exists, and warns about the thin side', async () => {
    await seedMany(h.db, 0, 12);
    const r = await scheduleRounds(h.db, { startDate: START, days: 2, rng: createRng('gta-only') });
    expect(r.ok).toBe(true);
    expect(floridaPerDay(await expectValidSchedule(30))).toEqual([0, 0]);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['thin_inventory', 'split_resampled']));
    const none = await scheduleRounds(h.db, { startDate: addDays(START, 2), days: 1, rng: createRng('x') });
    expect(none.error!.message).toMatch(/0 Florida and 12 GTA event\(s\)/);
  });

  it('never puts two questions about the same event in a day, and applies the cooldown to the shared event', async () => {
    // Three Florida questions describe one event, so the six Florida questions are four events.
    for (let seed = 0; seed < 4; seed++) {
      await h.reset();
      await seedMany(h.db, 6, 6);
      const fresh = (await h.db.prepare(`SELECT id FROM questions WHERE answer_kind = 'FLORIDA' ORDER BY id`).all<{ id: string }>()).results.map((r) => r.id);
      await h.db.prepare(`UPDATE questions SET event_id = 'ev-shared' WHERE id IN (?, ?, ?)`).bind(fresh[0], fresh[1], fresh[2]).run();
      const r = await scheduleRounds(h.db, { startDate: START, days: 2, rng: createRng(`ev${seed}`) });
      expect(r.inventory.floridaEvents).toBe(4);
      if (r.ok) await expectValidSchedule(30);
    }
  });

  it('leaves spoilers out unless they are explicitly included', async () => {
    await seedMany(h.db, 5, 5);
    const spoiler = (await h.db.prepare(`SELECT id FROM questions WHERE answer_kind = 'GTA' ORDER BY id LIMIT 1`).first<{ id: string }>())!.id;
    await h.db.prepare('UPDATE questions SET spoiler = 1 WHERE id = ?').bind(spoiler).run();
    const r = await scheduleRounds(h.db, { startDate: START, days: 1, rng: createRng('sp') });
    expect(r).toMatchObject({ ok: true, inventory: { excludedSpoilers: 1, eligibleGta: 4 } });
    expect([...(await rounds()).values()].flat().map((x) => x.question_id)).not.toContain(spoiler);
    await h.reset();
    await seedMany(h.db, 0, 5);
    const only = (await h.db.prepare(`SELECT id FROM questions ORDER BY id LIMIT 1`).first<{ id: string }>())!.id;
    await h.db.prepare('UPDATE questions SET spoiler = 1 WHERE id = ?').bind(only).run();
    expect((await scheduleRounds(h.db, { startDate: START, days: 1, rng: createRng('sp2') })).ok).toBe(false);
    expect((await scheduleRounds(h.db, { startDate: START, days: 1, includeSpoilers: true, rng: createRng('sp2') })).ok).toBe(true);
  });

  it('generates a 90-day horizon in one run; longer periods are refused', async () => {
    await seedMany(h.db, 20, 20);
    const r = await scheduleRounds(h.db, { startDate: START, days: 90, cooldownDays: 7, rng: createRng('ninety') });
    expect(r.ok).toBe(true);
    expect(r.added).toHaveLength(90);
    expect(r.inventory.runwayDays).toBe(90);
    const days = await expectValidSchedule(7);
    expect(days.size).toBe(90);
    expect(new Set(floridaPerDay(days)).size).toBeGreaterThanOrEqual(4); // the split varies
    await expect(scheduleRounds(h.db, { startDate: START, days: 91 })).rejects.toThrow(/days must be 1-90/);
  });

  it('a dry run plans and reports but writes nothing', async () => {
    await seedMany(h.db, 20, 20);
    const r = await scheduleRounds(h.db, { startDate: START, days: 5, dryRun: true, rng: createRng('dry') });
    expect(r).toMatchObject({ ok: true, settings: { dryRun: true } });
    expect(r.added).toHaveLength(5);
    expect(r.inventory.runwayDays).toBe(5);
    expect((await rounds()).size).toBe(0);
  });

  it('two concurrent runs never duplicate or reorder a date', async () => {
    await seedMany(h.db, 20, 20);
    const results = await Promise.allSettled([
      scheduleRounds(h.db, { startDate: START, days: 4, rng: createRng('x') }),
      scheduleRounds(h.db, { startDate: START, days: 4, rng: createRng('y') }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const days = await expectValidSchedule(30);
    expect(days.size).toBe(4);
  });

  it('excludes unreviewed sources, broken links, fixtures and unapproved questions', async () => {
    await seedSource(h.db, APPROVED_PUBLISHER);
    await seedSource(h.db, { ...APPROVED_PUBLISHER, id: 'publisher:unreviewed.example.org', licenseStatus: 'unreviewed', canUseEditorialSummary: false, canDisplayOriginalTitle: false, autoPublishAllowed: false });
    await seedSource(h.db, { ...APPROVED_PUBLISHER, id: 'grandtheftwiki', type: 'gta_wiki' });
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'FLORIDA', { sourceId: 'publisher:unreviewed.example.org' });
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'FLORIDA', { link: 'broken' });
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'FLORIDA', { fixture: true });
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'GTA');
    const r = await scheduleRounds(h.db, { startDate: START, days: 1 });
    expect(r.added).toEqual([]);
    expect(r.shortageDate).toBe(START);
    expect(r.inventory).toMatchObject({ eligibleFlorida: 0, eligibleGta: 3 });
  });

  it('ensureSchedule (cron) writes what it can, publishes due days and keeps a forward window', async () => {
    await seedMany(h.db, 40, 40);
    const r = await ensureSchedule(h.db, { now: new Date(`${START}T00:05:00Z`), aheadDays: 30, rng: createRng('cron') });
    expect(r.added.length).toBe(16); // 80 events / 5 per day under a 30-day cooldown
    expect(r.shortageDate).toBe(addDays(START, 16));
    const st = await h.db.prepare(`SELECT status, COUNT(*) AS n FROM daily_rounds GROUP BY status`).all<{ status: string; n: number }>();
    expect(Object.fromEntries(st.results.map((x) => [x.status, x.n]))).toEqual({ published: 1, scheduled: 15 });
    await expectValidSchedule(30);
  });
});


/** Sources as the staging registry has them: the wiki and Florida publishers unreviewed, The Onion blocked. */
const unreviewed = (id: string, host: string, type: SourcePolicy['type'] = 'publisher'): SourcePolicy => ({
  id, type, name: id, hosts: [host], licenseStatus: 'unreviewed', canUseEditorialSummary: false, canDisplayOriginalTitle: false, autoPublishAllowed: false,
});
const WIKI = unreviewed('grandtheftwiki', 'grandtheftwiki.com', 'gta_wiki');
const FEED_SOURCE = unreviewed('publisher:wsvn.com', 'wsvn.com'); // feedAccess "unreviewed" in the registry
const BLOCKED: SourcePolicy = { ...unreviewed('publisher:theonion.com', 'theonion.com'), licenseStatus: 'blocked' };
const DATASET_SOURCE = unreviewed('publisher:wfla.com', 'wfla.com');

async function seedSources() {
  for (const src of [APPROVED_PUBLISHER, WIKI, FEED_SOURCE, BLOCKED, DATASET_SOURCE]) await seedSource(h.db, src);
}
const licensedFlorida = async (n: number) => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await seedApproved(h.db, 'FLORIDA'));
  return ids;
};
const factualGta = (o: Parameters<typeof seedApproved>[2] = {}) => seedApproved(h.db, 'GTA', { sourceId: WIKI.id, provider: 'grandtheftwiki', mode: 'factual_summary', ...o });
const poolIds = async (appEnv = 'staging') => new Set((await eligiblePool(h.db, false, appEnv)).map((q) => q.id));

describe('approval modes and provenance', () => {
  it('schedules factual-summary GTA questions from the unreviewed wiki; licensed ones still need source rights', async () => {
    await seedSources();
    const fl = await licensedFlorida(3);
    const gta = [await factualGta(), await factualGta()];
    const licensedOnUnreviewedWiki = await seedApproved(h.db, 'GTA', { sourceId: WIKI.id, provider: 'grandtheftwiki', mode: 'licensed' });
    expect(await poolIds()).toEqual(new Set([...fl, ...gta]));

    // Five eligible events in all: the first day must use every one (the draw is resampled to 3 + 2).
    const r = await scheduleRounds(h.db, { startDate: START, days: 2, allowPartial: true, rng: createRng('modes'), appEnv: 'staging' });
    expect(r.added).toEqual([{ date: START, floridaCount: 3 }]);
    expect(r.shortageDate).toBe(addDays(START, 1));
    const day = (await rounds()).get(START)!;
    expect(day.map((x) => x.question_id).sort()).toEqual([...fl, ...gta].sort());
    expect(day.filter((x) => x.answer_kind === 'FLORIDA')).toHaveLength(3);
    expect(day.map((x) => x.question_id)).not.toContain(licensedOnUnreviewedWiki);
  });

  it('does not rely on quality_state: the approval must be audited, in force, and match its mode', async () => {
    await seedSources();
    await licensedFlorida(3);
    const legacy = await factualGta({ mode: 'none' }); // approved, but no audit row in force
    const unattested = await factualGta({ factual: { humanWritten: true, incidentVerified: true, claimsVerified: false, privacyChecked: true, verifiedDate: '2026-11-01', verifiedLocation: 'Liberty City', evidenceUrls: ['https://grandtheftwiki.com/x'] } });
    const noFactualDetails = await factualGta({ factual: {} });
    const mismatch = await seedApproved(h.db, 'GTA', { sourceId: WIKI.id, provider: 'grandtheftwiki', mode: 'licensed' });
    await h.db.prepare(`UPDATE questions SET approval_mode = 'factual_summary' WHERE id = ?`).bind(mismatch).run(); // claims factual, audit says licensed
    const policyActor = await factualGta();
    await h.db.prepare(`UPDATE review_log SET actor_type = 'policy' WHERE entity_id = ?`).bind(policyActor).run(); // factual summaries are human-only
    const borrowed = await factualGta();
    const donor = await factualGta();
    await h.db.prepare(`UPDATE questions SET approval_log_id = (SELECT approval_log_id FROM questions WHERE id = ?) WHERE id = ?`).bind(donor, borrowed).run(); // another question's approval
    const revokedLater = await factualGta();
    await h.db.prepare(`INSERT INTO review_log (entity_type, entity_id, decision, actor_type, actor_id) VALUES ('question', ?, 'approval_revoked', 'human', 'owner')`).bind(revokedLater).run();
    const placeholder = await factualGta({ title: 'YOUR OWN REVIEWED TITLE' });

    const pool = await poolIds();
    for (const id of [legacy, unattested, noFactualDetails, mismatch, policyActor, borrowed, revokedLater, placeholder]) expect(pool.has(id), id).toBe(false);
    expect(pool.has(donor)).toBe(true);
  });

  it('keeps rejecting blocked sources, unresolved feed access and the dataset in production, in factual mode too', async () => {
    await seedSources();
    const blocked = await seedApproved(h.db, 'FLORIDA', { sourceId: BLOCKED.id, mode: 'factual_summary' });
    const feed = await seedApproved(h.db, 'FLORIDA', { sourceId: FEED_SOURCE.id, provider: 'rss', mode: 'factual_summary' });
    const unknownFeed = await seedApproved(h.db, 'FLORIDA', { sourceId: APPROVED_PUBLISHER.id, provider: 'rss', mode: 'factual_summary' }); // not in the registry
    const dataset = await seedApproved(h.db, 'FLORIDA', { sourceId: DATASET_SOURCE.id, provider: 'floridaman_dataset', mode: 'factual_summary' });
    const indexed = await seedApproved(h.db, 'FLORIDA', { sourceId: DATASET_SOURCE.id, provider: 'gdelt', mode: 'factual_summary' });
    await seedSource(h.db, { ...unreviewed('publisher:off.example.org', 'off.example.org') });
    const disabled = await seedApproved(h.db, 'FLORIDA', { sourceId: 'publisher:off.example.org', mode: 'factual_summary' });
    await h.db.prepare(`UPDATE sources SET enabled = 0 WHERE id = 'publisher:off.example.org'`).run();

    const staging = await poolIds('staging');
    expect([blocked, feed, unknownFeed, disabled].filter((id) => staging.has(id))).toEqual([]);
    expect(staging.has(dataset)).toBe(true); // staging-only provider
    expect(staging.has(indexed)).toBe(true);
    const production = await poolIds('production');
    expect(production.has(dataset)).toBe(false);
    expect(production.has(indexed)).toBe(true);
  });

  it('a revoke that lands between planning and writing aborts the batch; nothing partial is scheduled', async () => {
    await seedSources();
    await licensedFlorida(3);
    const [g1] = [await factualGta(), await factualGta()];
    const r = await scheduleRounds(h.db, {
      startDate: START,
      days: 1,
      appEnv: 'staging',
      rng: createRng('race'),
      beforeWrite: async () => {
        const res = await h.fetch('/api/v1/admin/review', { ...postJson({ questionId: g1, action: 'revoke', reason: 'concurrent correction' }, ADMIN_TOKEN, { 'x-actor': 'owner' }), now: new Date(`${START}T12:00:00Z`) });
        if (res.status !== 200 && !JSON.stringify(await res.json()).includes('Question is candidate')) throw new Error(`revoke failed: ${res.status}`);
      },
    });
    expect(r.added).toEqual([]);
    expect(r.shortageDate).toBe(START);
    expect((await rounds()).size).toBe(0);
    expect(await h.db.prepare('SELECT COUNT(*) AS n FROM daily_round_items').first()).toEqual({ n: 0 });
    expect(await h.db.prepare('SELECT quality_state, approval_log_id FROM questions WHERE id = ?').bind(g1).first()).toEqual({ quality_state: 'candidate', approval_log_id: null });
  });

  it('concurrent runs over mixed approval modes never duplicate a question or a date', async () => {
    await seedSources();
    await licensedFlorida(15);
    for (let i = 0; i < 15; i++) await factualGta();
    const results = await Promise.allSettled([
      scheduleRounds(h.db, { startDate: START, days: 5, rng: createRng('p'), appEnv: 'staging' }),
      scheduleRounds(h.db, { startDate: START, days: 5, rng: createRng('q'), appEnv: 'staging' }),
    ]);
    expect(results.every((x) => x.status === 'fulfilled')).toBe(true);
    const days = await rounds();
    expect(days.size).toBe(5);
    const ids = [...days.values()].flat().map((x) => x.question_id);
    expect(new Set(ids).size).toBe(25); // 30 events, 30-day cooldown: no reuse within 5 days
    await expectValidSchedule(30);
  });

  it('migration backfills the mode and audit row of approvals made before it', async () => {
    await seedSources();
    const fl = await seedApproved(h.db, 'FLORIDA', { mode: 'none' });
    const gta = await factualGta({ mode: 'none' });
    const never = await seedApproved(h.db, 'GTA', { mode: 'none' });
    await h.db.batch([
      h.db.prepare(`INSERT INTO review_log (entity_type, entity_id, decision, actor_type, actor_id, details) VALUES ('question', ?, 'approved', 'human', 'owner', '{"mode":"licensed"}')`).bind(fl),
      h.db.prepare(
        `INSERT INTO review_log (entity_type, entity_id, decision, actor_type, actor_id, details) VALUES ('question', ?, 'approved:factual_summary', 'human', 'owner', ?)`,
      ).bind(gta, JSON.stringify({ mode: 'factual_summary', factual: { humanWritten: true, incidentVerified: true, claimsVerified: true, privacyChecked: true, verifiedDate: '2026-11-20', verifiedLocation: 'Liberty City', evidenceUrls: ['https://grandtheftwiki.com/x'] } })),
    ]);
    const backfill = migrationStatements().filter((st) => /^UPDATE questions/.test(st) && /approval_(log_id|mode)/.test(st));
    expect(backfill).toHaveLength(2);
    await h.db.batch(backfill.map((st) => h.db.prepare(st)));
    const rows = await h.db.prepare(`SELECT id, approval_mode, approval_log_id IS NOT NULL AS linked FROM questions WHERE id IN (?, ?, ?) ORDER BY id`).bind(fl, gta, never).all();
    expect(Object.fromEntries(rows.results.map((x) => [x.id, [x.approval_mode, x.linked]]))).toEqual({ [fl]: ['licensed', 1], [gta]: ['factual_summary', 1], [never]: [null, 0] });
    const pool = await poolIds();
    expect(pool.has(fl) && pool.has(gta)).toBe(true);
    expect(pool.has(never)).toBe(false);
  });
});
