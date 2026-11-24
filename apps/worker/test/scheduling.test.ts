import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, createRng } from '@gof/core';
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

describe('scheduleRounds', () => {
  it('alternates 3/2 and 2/3, five unique questions per day, never reused', async () => {
    await seedMany(h.db, 30, 30);
    const r = await scheduleRounds(h.db, { startDate: START, days: 10, rng: createRng('alt') });
    expect(r.added).toHaveLength(10);
    expect(r.shortageDate).toBeNull();
    const days = await rounds();
    const counts = [...days.values()].map((d) => d.filter((x) => x.answer_kind === 'FLORIDA').length);
    counts.forEach((c, i) => {
      expect([2, 3]).toContain(c);
      if (i > 0) expect(c).not.toBe(counts[i - 1]);
    });
    const ids = [...days.values()].flat().map((x) => x.question_id);
    expect(new Set(ids).size).toBe(50);
    expect([...days.values()].map((d) => d[0]!.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('is idempotent: re-running keeps existing days and their order', async () => {
    await seedMany(h.db, 20, 20);
    await scheduleRounds(h.db, { startDate: START, days: 3, rng: createRng('a') });
    const before = await rounds();
    const again = await scheduleRounds(h.db, { startDate: START, days: 3, rng: createRng('b') });
    expect(again.added).toEqual([]);
    expect(again.kept).toEqual([START, addDays(START, 1), addDays(START, 2)]);
    expect(await rounds()).toEqual(before);
  });

  it('stops at a shortage without writing a partial day or inventing anything', async () => {
    await seedMany(h.db, 6, 4);
    const r = await scheduleRounds(h.db, { startDate: START, days: 5, rng: createRng('short') });
    expect(r.added).toHaveLength(2);
    expect(r.shortageDate).toBe(addDays(START, 2));
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['shortage', 'low_inventory']));
    const days = await rounds();
    expect(days.size).toBe(2);
    for (const d of days.values()) expect(d).toHaveLength(5);
  });

  it('first day can run with 3 + 3 approved', async () => {
    await seedMany(h.db, 3, 3);
    const r = await scheduleRounds(h.db, { startDate: START, days: 1 });
    expect(r.added).toHaveLength(1);
  });

  it('two concurrent runs never duplicate or reorder a date', async () => {
    await seedMany(h.db, 20, 20);
    const results = await Promise.allSettled([
      scheduleRounds(h.db, { startDate: START, days: 4, rng: createRng('x') }),
      scheduleRounds(h.db, { startDate: START, days: 4, rng: createRng('y') }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const days = await rounds();
    expect(days.size).toBe(4);
    const ids = [...days.values()].flat().map((x) => x.question_id);
    expect(new Set(ids).size).toBe(20);
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
  });

  it('ensureSchedule publishes due days and keeps a forward window', async () => {
    await seedMany(h.db, 40, 40);
    const r = await ensureSchedule(h.db, { now: new Date(`${START}T00:05:00Z`), aheadDays: 30 });
    expect(r.added.length).toBe(16); // 80 approved / 5 per day
    expect(r.shortageDate).toBe(addDays(START, 16));
    const st = await h.db.prepare(`SELECT status, COUNT(*) AS n FROM daily_rounds GROUP BY status`).all<{ status: string; n: number }>();
    expect(Object.fromEntries(st.results.map((x) => [x.status, x.n]))).toEqual({ published: 1, scheduled: 15 });
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
  it('schedules factual-summary GTA questions from the unreviewed wiki in the usual 3 + 2 split; licensed ones still need source rights', async () => {
    await seedSources();
    const fl = await licensedFlorida(3);
    const gta = [await factualGta(), await factualGta()];
    const licensedOnUnreviewedWiki = await seedApproved(h.db, 'GTA', { sourceId: WIKI.id, provider: 'grandtheftwiki', mode: 'licensed' });
    expect(await poolIds()).toEqual(new Set([...fl, ...gta]));

    const r = await scheduleRounds(h.db, { startDate: START, days: 2, rng: createRng('modes'), appEnv: 'staging' });
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
    expect(new Set(ids).size).toBe(25);
    for (const d of days.values()) expect([2, 3]).toContain(d.filter((x) => x.answer_kind === 'FLORIDA').length);
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
