import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, type ImportItem, type ImportResponse } from '@gof/core';
import { importBatch } from '../src/services/importer.ts';
import {
  ADMIN_TOKEN,
  APPROVED_PUBLISHER,
  APPROVED_WIKI,
  createHarness,
  floridaItem,
  postJson,
  seedMany,
  seedSource,
  SERVICE_TOKEN,
  TEST_REGISTRY,
  type Harness,
} from './harness.ts';

let h: Harness;
const TODAY = '2026-11-22';
const now = new Date(`${TODAY}T12:00:00Z`);

beforeAll(async () => {
  h = await createHarness({ APP_ENV: 'staging' });
});
afterAll(() => h.dispose());
beforeEach(() => h.reset());

const call = (path: string, init: RequestInit & { env?: Record<string, string> } = {}) => h.fetch(path, { ...init, now });
const importReq = (items: unknown[], key = `key-${Math.random().toString(36).slice(2)}`, token = SERVICE_TOKEN) =>
  call('/api/v1/admin/import', postJson({ items }, token, { 'idempotency-key': key }));

const BENCHMARK = { policyVersion: 'test-1', sampleSize: 400, falseApprovalRate: 0.005, measuredAt: '2026-11-20T00:00:00Z', measuredBy: 'owner' };
async function storeBenchmark() {
  await h.db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('benchmark', ?)`).bind(JSON.stringify(BENCHMARK)).run();
}
const trustedEnv = { ...{} as Record<string, never>, APP_ENV: 'staging', AUTO_PUBLISH_MODE: 'trusted_sources', AUTO_PUBLISH_MAX_FALSE_APPROVAL_RATE: '0.01', HUMAN_SAMPLE_RATE: '0.05' };
const runImport = (items: ImportItem[], env: Record<string, string> = trustedEnv, draw = 0.99) =>
  importBatch({ items }, { env: { ...h.env, ...env }, actorId: 'test', now, draw: () => draw, registry: TEST_REGISTRY });

describe('authentication', () => {
  it('rejects missing/invalid tokens and keeps service tokens off admin routes', async () => {
    expect((await call('/api/v1/admin/stats')).status).toBe(401);
    expect((await call('/api/v1/admin/stats', { headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token' } })).status).toBe(401);
    const svc = await call('/api/v1/admin/stats', { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
    expect(svc.status).toBe(403);
    expect((await call('/api/v1/admin/stats', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status).toBe(200);
    // A configured-but-too-short secret disables the role instead of accepting weak tokens.
    const weak = await h.fetch('/api/v1/admin/stats', { headers: { authorization: 'Bearer short' }, env: { ADMIN_TOKEN: 'short' }, now });
    expect(weak.status).toBe(401);
  });
});

describe('import', () => {
  it('requires an Idempotency-Key, validates schema and limits batch/body size', async () => {
    const noKey = await call('/api/v1/admin/import', postJson({ items: [] }, SERVICE_TOKEN));
    expect(noKey.status).toBe(400);
    const bad = await importReq([{ kind: 'FLORIDA_NEWS', incidentKey: 'x' }]);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('VALIDATION_FAILED');
    const tooMany = await importReq(Array.from({ length: 21 }, (_, i) => floridaItem(i)));
    expect(tooMany.status).toBe(400);
    const huge = await call('/api/v1/admin/import', {
      method: 'POST',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': 'huge-body-1' },
      body: JSON.stringify({ items: [], pad: 'x'.repeat(300_000) }),
    });
    expect(huge.status).toBe(413);
    const malformed = await call('/api/v1/admin/import', { method: 'POST', headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': 'malformed-1' }, body: '{"items": [' });
    expect(malformed.status).toBe(400);
  });

  it('records the run report and checkpoints even when a run imports nothing', async () => {
    const run = { id: 'run_empty_1', provider: 'all', startedAt: '2026-11-22T05:17:00Z', finishedAt: '2026-11-22T05:20:00Z', status: 'partial', fetched: 54, newCount: 0, duplicates: 54, rejected: 0, errors: ['wiki: timeout'], aiRequests: 0, tokensIn: 0, tokensOut: 0, neuronsEstimate: 0, models: [] };
    const res = await call('/api/v1/admin/import', postJson({ items: [], run, checkpoints: [{ provider: 'grandtheftwiki', key: 'cmcontinue:Cat', value: 'page|5' }] }, SERVICE_TOKEN, { 'idempotency-key': 'empty-run-1' }));
    expect(res.status).toBe(200);
    expect(await h.db.prepare('SELECT status, duplicate_count FROM ingestion_runs WHERE id = ?').bind('run_empty_1').first()).toEqual({ status: 'partial', duplicate_count: 54 });
    const cp = await (await call('/api/v1/admin/checkpoints?provider=grandtheftwiki', { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } })).json();
    expect(cp.checkpoints[0]).toMatchObject({ key: 'cmcontinue:Cat', value: 'page|5' });
  });

  it('replays the same Idempotency-Key and refuses it for a different body', async () => {
    const first = await importReq([floridaItem(1)], 'same-key-123');
    const a = (await first.json()) as ImportResponse;
    expect(a.results[0]!.outcome).toBe('inserted');
    const again = (await (await importReq([floridaItem(1)], 'same-key-123')).json()) as ImportResponse;
    expect(again.replayed).toBe(true);
    expect(again.results).toEqual(a.results);
    expect((await importReq([floridaItem(2)], 'same-key-123')).status).toBe(409);
    const count = await h.db.prepare('SELECT COUNT(*) AS n FROM questions').first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('dedupes by canonical URL and provider key, and attaches other outlets to one incident', async () => {
    const r1 = (await (await importReq([floridaItem(1), floridaItem(1)])).json()) as ImportResponse;
    expect(r1.results.map((r) => r.outcome)).toEqual(['inserted', 'duplicate']);
    const other = floridaItem(2);
    other.attachToIncidentKey = 'fl:test1';
    const r2 = (await (await importReq([other, floridaItem(1)])).json()) as ImportResponse;
    expect(r2.results.map((r) => r.outcome)).toEqual(['attached', 'duplicate']);
    const refs = await h.db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT incident_id) AS inc FROM source_references').first<{ n: number; inc: number }>();
    expect(refs).toEqual({ n: 2, inc: 1 });
    expect((await h.db.prepare('SELECT COUNT(*) AS n FROM questions').first<{ n: number }>())!.n).toBe(1);
  });

  it('rejects unsafe URLs, fixtures outside local, and player events', async () => {
    const ip = floridaItem(3);
    ip.reference.originalUrl = 'https://127.0.0.1/admin';
    const creds = floridaItem(4);
    creds.reference.canonicalUrl = 'https://user:pw@news.example.org/x';
    const fixture = { ...floridaItem(5), fixture: true };
    const player = { ...floridaItem(6), kind: 'GTA_PLAYER_EVENT' as const };
    const res = (await (await importReq([ip, creds, fixture, player])).json()) as ImportResponse;
    expect(res.results.map((r) => r.outcome)).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
    expect(res.results[0]!.errors![0]).toMatch(/URL_IP_LITERAL/);
    expect(res.results[1]!.errors![0]).toMatch(/URL_CREDENTIALS/);
    expect(res.results[2]!.errors![0]).toMatch(/FIXTURE_NOT_ALLOWED/);
    expect(res.results[3]!.errors![0]).toMatch(/PLAYER_EVENTS_DISABLED/);
  });

  it('bundled registry: every real source is unreviewed, so nothing is ever auto-approved', async () => {
    await storeBenchmark();
    const res = (await (await call('/api/v1/admin/import', { ...postJson({ items: [floridaItem(7)] }, SERVICE_TOKEN, { 'idempotency-key': 'k-bundled-1' }), env: trustedEnv })).json()) as ImportResponse;
    expect(res.results[0]!.questionState).toBe('candidate');
    expect(res.results[0]!.gate!.reasons).toEqual(expect.arrayContaining(['SOURCE_UNREVIEWED', 'SOURCE_NOT_AUTO_TRUSTED']));
  });
});

describe('auto-publish gate (policy state machine)', () => {
  it('shadow mode records an auto_approve decision but leaves a candidate', async () => {
    await storeBenchmark();
    const [r] = await runImport([floridaItem(10)], { ...trustedEnv, AUTO_PUBLISH_MODE: 'shadow' });
    expect(r!.gate).toMatchObject({ decision: 'auto_approve', effective: 'candidate' });
    expect(r!.questionState).toBe('candidate');
  });

  it('trusted_sources approves only when every gate passes', async () => {
    await storeBenchmark();
    const [r] = await runImport([floridaItem(11)]);
    expect(r!.questionState).toBe('approved');
    const q = await h.db.prepare(`SELECT approval_actor_type, approved_by FROM questions`).first<{ approval_actor_type: string; approved_by: string }>();
    expect(q).toEqual({ approval_actor_type: 'policy', approved_by: expect.stringMatching(/^policy:/) });
  });

  it('manual submissions (ingest:url) are never auto-approved, even from a fully trusted source', async () => {
    await storeBenchmark();
    const manual = floridaItem(16);
    manual.reference.provider = 'manual';
    const [r] = await runImport([manual]);
    expect(r!.questionState).toBe('candidate');
    expect(r!.gate).toMatchObject({ decision: 'review', effective: 'candidate' });
    expect(r!.gate!.reasons).toContain('MANUAL_SUBMISSION');
  });

  it('refuses the staging-only Florida Man dataset in production, accepts it as a candidate in staging', async () => {
    const item = floridaItem(18);
    item.reference.provider = 'floridaman_dataset';
    const [prod] = await runImport([item], { APP_ENV: 'production', AUTO_PUBLISH_MODE: 'shadow' });
    expect(prod).toMatchObject({ outcome: 'invalid', errors: [expect.stringMatching(/^PROVIDER_NOT_ALLOWED/)] });
    const [staging] = await runImport([item], { APP_ENV: 'staging', AUTO_PUBLISH_MODE: 'shadow' });
    expect(staging).toMatchObject({ outcome: 'inserted', questionState: 'candidate' });
  });

  it('registers an unknown publisher as unreviewed on import', async () => {
    const unknown = floridaItem(17);
    unknown.reference.provider = 'manual';
    unknown.reference.originalUrl = unknown.reference.canonicalUrl = 'https://www.new-outlet.example.net/story';
    unknown.reference.linkCheck!.finalUrl = unknown.reference.canonicalUrl;
    const [r] = await runImport([unknown]);
    expect(r!.questionState).toBe('candidate');
    const src = await h.db
      .prepare(`SELECT license_status, can_display_original_title, can_use_editorial_summary, auto_publish_allowed FROM sources WHERE id = 'publisher:new-outlet.example.net'`)
      .first();
    expect(src).toEqual({ license_status: 'unreviewed', can_display_original_title: 0, can_use_editorial_summary: 0, auto_publish_allowed: 0 });
  });

  it('a perfect model verdict cannot approve a giveaway title, missing date, unknown source or missing benchmark', async () => {
    await storeBenchmark();
    const giveaway = floridaItem(12, { playTitle: 'Florida man rides a lawnmower through a Miami drive-thru' });
    const noDate = floridaItem(13);
    noDate.reference.publishedAt = null;
    const unknown = floridaItem(14);
    unknown.reference.originalUrl = unknown.reference.canonicalUrl = 'https://unknown-outlet.example.net/story';
    unknown.reference.linkCheck!.finalUrl = unknown.reference.canonicalUrl;
    const res = await runImport([giveaway, noDate, unknown]);
    expect(res.map((r) => r.questionState)).toEqual(['candidate', 'candidate', 'candidate']);
    expect(res[0]!.gate!.reasons).toContain('PLAY_TITLE_GIVEAWAY');
    expect(res[1]!.gate!.reasons).toContain('MISSING_PUBLISHED_DATE');
    expect(res[2]!.gate!.reasons).toContain('SOURCE_UNREVIEWED');

    await h.reset();
    const [noBench] = await runImport([floridaItem(15)]);
    expect(noBench!.questionState).toBe('candidate');
    expect(noBench!.gate!.reasons).toContain('NO_BENCHMARK_FOR_POLICY');
    const [noThreshold] = await runImport([floridaItem(16)], { ...trustedEnv, AUTO_PUBLISH_MAX_FALSE_APPROVAL_RATE: '' });
    expect(noThreshold!.gate!.reasons).toEqual(expect.arrayContaining(['NO_BENCHMARK_FOR_POLICY']));
  });

  it('routes a random human sample to review, and sensitive items to rejection', async () => {
    await storeBenchmark();
    const [sampled] = await runImport([floridaItem(17)], trustedEnv, 0.01);
    expect(sampled!.questionState).toBe('candidate');
    expect(sampled!.gate!.reasons).toContain('HUMAN_SAMPLE');
    const sensitive = floridaItem(18);
    sensitive.ai = { ...sensitive.ai!, sensitive: true };
    const [r] = await runImport([sensitive]);
    expect(r!.questionState).toBe('rejected');
  });

  it('deterministic prefilter rejections apply in every mode, and can never approve', async () => {
    await storeBenchmark();
    const item = { ...floridaItem(20), prefilter: { decision: 'reject' as const, reasonCodes: ['SENSITIVE_TERMS'] } };
    for (const mode of ['shadow', 'trusted_sources']) {
      await h.reset();
      await storeBenchmark();
      const [r] = await runImport([item], { ...trustedEnv, AUTO_PUBLISH_MODE: mode });
      expect(r!.questionState).toBe('rejected');
    }
  });

  it('unknown AUTO_PUBLISH_MODE fails closed to off (no gate at all)', async () => {
    const [r] = await runImport([floridaItem(19)], { ...trustedEnv, AUTO_PUBLISH_MODE: 'yolo' });
    expect(r!.gate).toBeUndefined();
    expect(r!.questionState).toBe('candidate');
  });
});

describe('review, withdraw, merge', () => {
  async function importAndApproveSource(item: ImportItem) {
    const res = (await (await importReq([item])).json()) as ImportResponse;
    expect(res.results[0]!.outcome).toBe('inserted');
    // Stand-in for the owner editing sources.policy.json + `admin sources:sync`.
    await seedSource(h.db, APPROVED_PUBLISHER);
    return (await h.db.prepare('SELECT id FROM questions ORDER BY created_at DESC LIMIT 1').first<{ id: string }>())!.id;
  }
  const reviewReq = (body: unknown) => call('/api/v1/admin/review', postJson(body, ADMIN_TOKEN, { 'x-actor': 'owner' }));
  const freshLink = { status: 'ok', httpStatus: 200, finalUrl: 'https://news.example.org/news/odd-story-30', checkedAt: '2026-11-22T11:00:00.000Z' };

  it('approval fails with every missing requirement listed, then succeeds', async () => {
    const item = floridaItem(30);
    item.reference.originalUrl = item.reference.canonicalUrl = 'https://news.example.org/news/odd-story-30';
    item.reference.linkCheck = null;
    const res = (await (await importReq([item])).json()) as ImportResponse;
    expect(res.results[0]!.outcome).toBe('inserted');
    const id = (await h.db.prepare('SELECT id FROM questions').first<{ id: string }>())!.id;

    const fail = await reviewReq({ questionId: id, action: 'approve' });
    expect(fail.status).toBe(422);
    const errs = (await fail.json()).errors.join('\n');
    expect(errs).toMatch(/SOURCE_UNREVIEWED/);
    expect(errs).toMatch(/playTitle is required/);
    expect(errs).toMatch(/locationVerified/);
    expect(errs).toMatch(/fresh link check/);

    await seedSource(h.db, APPROVED_PUBLISHER);
    const verbatim = await reviewReq({ questionId: id, action: 'approve', playTitle: 'Florida man found riding a lawnmower', locationVerified: true, linkCheck: freshLink });
    expect((await verbatim.json()).errors.join()).toMatch(/GIVEAWAY/);

    const ok = await reviewReq({ questionId: id, action: 'approve', playTitle: 'A man steers a ride-on mower through a burger drive-thru', locationVerified: true, linkCheck: freshLink });
    expect(ok.status).toBe(200);
    const log = await h.db.prepare(`SELECT actor_type, actor_id, decision FROM review_log WHERE entity_id = ? AND decision = 'approved'`).bind(id).first();
    expect(log).toEqual({ actor_type: 'human', actor_id: 'owner', decision: 'approved' });
  });

  it('GTA approval requires an explicit, matching game', async () => {
    await seedSource(h.db, APPROVED_WIKI);
    const url = 'https://www.grandtheftwiki.com/index.php?curid=101';
    const gta: ImportItem = {
      ...floridaItem(31),
      kind: 'GTA_CANON',
      incidentKey: 'gta:grandtheftwiki:101#Story',
      reference: { ...floridaItem(31).reference, provider: 'grandtheftwiki', providerKey: '101#Story', originalUrl: url, canonicalUrl: url, publisher: 'Grand Theft Wiki', wikiPageId: 101, wikiSection: 'Story', originalTitle: 'Test wiki story heading', linkCheck: null },
      incident: { ...floridaItem(31).incident, gameDetected: 'GTA_III', floridaSignal: 'none', floridaEvidence: null },
    };
    await importReq([gta]);
    await seedSource(h.db, APPROVED_WIKI);
    const id = (await h.db.prepare('SELECT id FROM questions').first<{ id: string }>())!.id;
    const base = { questionId: id, action: 'approve', playTitle: 'A newspaper reports a strange event downtown', explanation: 'Documented in the game’s fictional newspaper, per the linked wiki section.', linkVerifiedManually: true };
    expect((await (await reviewReq(base)).json()).errors.join()).toMatch(/game is required/);
    expect((await (await reviewReq({ ...base, game: 'GTA_V' })).json()).errors.join()).toMatch(/differs/);
    expect((await reviewReq({ ...base, game: 'GTA_III' })).status).toBe(200);
  });

  it('mirrors the staging wiki candidates: AI_NOT_RUN / NO_BENCHMARK_FOR_POLICY are advisory; source rights and an on-source link check are not', async () => {
    const url = 'https://www.grandtheftwiki.com/Van_Heist';
    const gta: ImportItem = {
      ...floridaItem(32),
      kind: 'GTA_CANON',
      incidentKey: 'gta:grandtheftwiki:1874',
      reference: { ...floridaItem(32).reference, provider: 'grandtheftwiki', providerKey: '1874', originalUrl: url, canonicalUrl: 'https://www.grandtheftwiki.com/index.php?curid=1874', publisher: 'Grand Theft Wiki', wikiPageId: 1874, wikiSection: null, originalTitle: 'Van Heist', publishedAt: null, linkCheck: null },
      incident: { ...floridaItem(32).incident, gameDetected: 'GTA_III', floridaSignal: 'none', floridaEvidence: null },
      question: { playTitleDraft: 'Van Heist', explanationDraft: '', difficulty: 2 },
      ai: null,
    };
    // Bundled registry: Grand Theft Wiki is unreviewed, exactly like staging.
    const [imported] = ((await (await importReq([gta])).json()) as ImportResponse).results;
    expect(imported!.questionState).toBe('candidate');
    expect(imported!.gate!.reasons).toEqual(expect.arrayContaining(['SOURCE_UNREVIEWED', 'LINK_NOT_VERIFIED', 'AI_NOT_RUN', 'NO_BENCHMARK_FOR_POLICY', 'PLAY_TITLE_VERBATIM']));
    expect(imported!.gate!.reasons).not.toContain('LINK_REDIRECT_OFF_SOURCE');

    const id = (await h.db.prepare('SELECT id FROM questions').first<{ id: string }>())!.id;
    const wikiLink = { status: 'ok', httpStatus: 200, finalUrl: url, checkedAt: '2026-11-22T11:00:00.000Z' };
    const human = {
      questionId: id,
      action: 'approve',
      game: 'GTA_III',
      playTitle: 'Crew ambushes an armored security van to grab the cash inside',
      explanation: 'A mission in GTA III: the player helps rob a security van. Summary written by our editor; see the linked wiki page.',
      linkCheck: wikiLink,
    };
    const blocked = (await (await reviewReq(human)).json()).errors.join('\n');
    expect(blocked).toMatch(/SOURCE_UNREVIEWED: .*\(grandtheftwiki\)/);
    expect(blocked).not.toMatch(/AI|BENCHMARK/);

    await seedSource(h.db, APPROVED_WIKI); // stand-in for the owner's registry review + deploy + sources:sync
    expect((await (await reviewReq({ ...human, playTitle: 'Van Heist' })).json()).errors.join()).toMatch(/PLAY_TITLE_VERBATIM|PLAY_TITLE_LENGTH/);
    const offSite = await (await reviewReq({ ...human, linkCheck: { ...wikiLink, finalUrl: 'https://mirror.example.net/Van_Heist' } })).json();
    expect(offSite.errors.join()).toMatch(/outside source grandtheftwiki/);
    const ok = await reviewReq(human);
    expect(ok.status).toBe(200);
    const q = await h.db.prepare('SELECT quality_state, play_title, play_title_reviewed, approval_actor_type FROM questions WHERE id = ?').bind(id).first();
    expect(q).toEqual({ quality_state: 'approved', play_title: human.playTitle, play_title_reviewed: 1, approval_actor_type: 'human' });
  });

  it('withdrawing a question withdraws today for everyone and refills future days', async () => {
    await seedMany(h.db, 20, 20);
    const sched = await call('/api/v1/admin/schedule', postJson({ days: 3 }, SERVICE_TOKEN));
    expect(sched.status).toBe(200);
    const todayQ = (await h.db.prepare('SELECT question_id FROM daily_round_items WHERE day = ? AND position = 1').bind(TODAY).first<{ question_id: string }>())!.question_id;
    const futureQ = (await h.db.prepare('SELECT question_id FROM daily_round_items WHERE day = ? AND position = 1').bind(addDays(TODAY, 2)).first<{ question_id: string }>())!.question_id;

    const w1 = await (await call('/api/v1/admin/withdraw', postJson({ target: 'question', id: todayQ, reason: 'source retracted the story' }, ADMIN_TOKEN))).json();
    expect(w1.withdrawnDays).toEqual([TODAY]);
    const w2 = await (await call('/api/v1/admin/withdraw', postJson({ target: 'question', id: futureQ, reason: 'duplicate discovered' }, ADMIN_TOKEN))).json();
    expect(w2.droppedFutureDays).toEqual([addDays(TODAY, 2)]);
    expect((await call('/api/challenge/today')).status).toBe(410);

    const again = await (await call('/api/v1/admin/schedule', postJson({ days: 3 }, SERVICE_TOKEN))).json();
    expect(again.added.map((d: { date: string }) => d.date)).toEqual([addDays(TODAY, 2)]);
    const reused = await h.db.prepare('SELECT COUNT(*) AS n FROM daily_round_items WHERE question_id IN (?, ?)').bind(todayQ, futureQ).first<{ n: number }>();
    expect(reused!.n).toBe(1); // the withdrawn round keeps its items for the audit trail; the dropped one is gone
  });

  it('merge is reversible and audited', async () => {
    await importReq([floridaItem(40), floridaItem(41)]);
    const [a, b] = (await h.db.prepare('SELECT id FROM incidents ORDER BY incident_key').all<{ id: string }>()).results;
    const m = await call('/api/v1/admin/merge', postJson({ action: 'merge', incidentId: b!.id, intoIncidentId: a!.id, reason: 'same event' }, ADMIN_TOKEN));
    expect(m.status).toBe(200);
    expect((await h.db.prepare(`SELECT quality_state FROM questions WHERE incident_id = ?`).bind(b!.id).first<{ quality_state: string }>())!.quality_state).toBe('rejected');
    await call('/api/v1/admin/merge', postJson({ action: 'unmerge', incidentId: b!.id, reason: 'actually different' }, ADMIN_TOKEN));
    expect((await h.db.prepare(`SELECT quality_state FROM questions WHERE incident_id = ?`).bind(b!.id).first<{ quality_state: string }>())!.quality_state).toBe('candidate');
    const log = await h.db.prepare(`SELECT decision FROM review_log WHERE entity_id = ? ORDER BY id`).bind(b!.id).all<{ decision: string }>();
    expect(log.results.map((r) => r.decision)).toEqual(['merged', 'unmerged']);
  });

  it('known-key lookup and stats', async () => {
    await importReq([floridaItem(50)]);
    const known = await (await call('/api/v1/admin/known', postJson({ canonicalUrls: ['https://news.example.org/news/odd-story-50', 'https://news.example.org/none'], providerKeys: [] }, SERVICE_TOKEN))).json();
    expect(known.canonicalUrls).toEqual(['https://news.example.org/news/odd-story-50']);
    const stats = await (await call('/api/v1/admin/stats', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
    expect(stats.questions).toEqual([{ kind: 'FLORIDA_NEWS', state: 'candidate', n: 1 }]);
    expect(stats.warnings.join()).toMatch(/No playable round/);
    void importAndApproveSource;
  });
});

describe('end-to-end: import → review → schedule → play → withdraw', () => {
  it('runs one complete 5-question round through the HTTP API', async () => {
    await seedSource(h.db, APPROVED_PUBLISHER);
    await seedSource(h.db, APPROVED_WIKI);
    const items: ImportItem[] = [];
    for (let i = 0; i < 3; i++) items.push(floridaItem(60 + i));
    for (let i = 0; i < 3; i++) {
      const url = `https://www.grandtheftwiki.com/index.php?curid=${700 + i}`;
      const base = floridaItem(70 + i);
      items.push({
        ...base,
        kind: 'GTA_CANON',
        incidentKey: `gta:grandtheftwiki:${700 + i}#S`,
        reference: { ...base.reference, provider: 'grandtheftwiki', providerKey: `${700 + i}#S`, originalUrl: url, canonicalUrl: url, wikiPageId: 700 + i, wikiSection: 'S', originalTitle: `Wiki heading ${i}` },
        incident: { ...base.incident, gameDetected: 'GTA_III', floridaSignal: 'none', floridaEvidence: null },
        question: { ...base.question, playTitleDraft: ['A newspaper reports a parade of runaway hot dog carts', 'A columnist complains about a statue that keeps moving', 'A paper announces a mayor elected by a dog show'][i]! },
      });
    }
    const imp = (await (await importReq(items)).json()) as ImportResponse;
    expect(imp.results.every((r) => r.outcome === 'inserted' && r.questionState === 'candidate')).toBe(true);
    // Import re-synced the bundled (unreviewed) registry rows; the owner's approved policy is re-applied here.
    await seedSource(h.db, APPROVED_PUBLISHER);
    await seedSource(h.db, APPROVED_WIKI);

    const { results } = await h.db.prepare(`SELECT q.id, q.answer_kind, q.play_title FROM questions q`).all<{ id: string; answer_kind: string; play_title: string }>();
    for (const q of results) {
      const r = await call(
        '/api/v1/admin/review',
        postJson(
          {
            questionId: q.id,
            action: 'approve',
            playTitle: q.play_title,
            explanation: 'Verified against the linked source by the reviewer during the test.',
            ...(q.answer_kind === 'FLORIDA' ? { locationVerified: true } : { game: 'GTA_III' }),
            linkVerifiedManually: true,
          },
          ADMIN_TOKEN,
        ),
      );
      expect(r.status, await r.clone().text()).toBe(200);
    }
    const sched = await (await call('/api/v1/admin/schedule', postJson({ days: 1 }, SERVICE_TOKEN))).json();
    expect(sched.added).toHaveLength(1);

    const today = await (await call('/api/challenge/today')).json();
    expect(today.questions).toHaveLength(5);
    const ans = await (await call(`/api/challenge/${TODAY}/answer`, postJson({ questionId: 'h1', choice: 'GTA' }))).json();
    expect(typeof ans.correct).toBe('boolean');
    expect(ans.question.sourceUrl).toMatch(/^https:\/\//);

    await call('/api/v1/admin/withdraw', postJson({ target: 'day', id: TODAY, reason: 'end-to-end test' }, ADMIN_TOKEN));
    const gone = await call('/api/challenge/today');
    expect(gone.status).toBe(410);
    expect((await gone.json()).error.code).toBe('ROUND_WITHDRAWN');
  });
});

describe('Independent Factual Summary approval (mode factual_summary)', () => {
  const ORIGINAL = 'Pace Man Pleads Guilty to Theft of National Park Signs';
  const URL_ = 'https://news.example.org/news/park-signs';
  const link = (u = URL_) => ({ status: 'ok', httpStatus: 200, finalUrl: u, checkedAt: '2026-11-22T11:00:00.000Z' });
  const attest = (o: Record<string, unknown> = {}) => ({
    humanWritten: true,
    incidentVerified: true,
    claimsVerified: true,
    privacyChecked: true,
    verifiedDate: '2026-11-20',
    verifiedLocation: 'Pace, Florida',
    evidenceUrls: [URL_],
    ...o,
  });
  const human = {
    playTitle: 'A collector quietly carted off dozens of federal signs from a protected seashore',
    explanation: 'He admitted in federal court that he removed the signs from protected federal land. Prosecutors handled it as theft of government property.',
  };
  const approve = (body: Record<string, unknown>, env?: Record<string, string>) =>
    call('/api/v1/admin/review', { ...postJson({ action: 'approve', ...body }, ADMIN_TOKEN, { 'x-actor': 'owner' }), ...(env ? { env } : {}) });
  async function importOne(o: { host?: string; provider?: string; url?: string } = {}) {
    const item = floridaItem(50);
    const url = o.url ?? (o.host ? `https://${o.host}/news/park-signs` : URL_);
    item.reference.originalUrl = item.reference.canonicalUrl = url;
    item.reference.linkCheck = null;
    item.reference.originalTitle = ORIGINAL;
    // Default: discovered through an index (GDELT), not by fetching the publisher's feed.
    item.reference.provider = o.provider ?? 'gdelt';
    const res = (await (await importReq([item])).json()) as ImportResponse;
    expect(res.results[0]!.outcome).toBe('inserted');
    return (await h.db.prepare('SELECT id FROM questions').first<{ id: string }>())!.id;
  }
  const errorsOf = async (r: Response | { json(): Promise<unknown> }) => ((await r.json()) as { errors?: string[] }).errors ?? [];

  it('publishes verified facts in original wording from an unreviewed source; the licensed path still refuses it', async () => {
    const id = await importOne();
    const licensed = await errorsOf(await approve({ questionId: id, ...human, linkCheck: link() }));
    expect(licensed.join('\n')).toMatch(/SOURCE_UNREVIEWED[\s\S]*use mode factual_summary/);

    const ok = await approve({ questionId: id, ...human, linkCheck: link(), mode: 'factual_summary', factual: attest() });
    expect(ok.status).toBe(200);
    const q = await h.db.prepare('SELECT quality_state, play_title, approval_actor_type FROM questions WHERE id = ?').bind(id).first();
    expect(q).toEqual({ quality_state: 'approved', play_title: human.playTitle, approval_actor_type: 'human' });
    const ref = await h.db.prepare('SELECT published_at FROM source_references').first<{ published_at: string }>();
    expect(ref!.published_at).toBe('2026-11-20');
    const log = await h.db.prepare(`SELECT decision, details FROM review_log WHERE entity_id = ? AND decision LIKE 'approved%'`).bind(id).first<{ decision: string; details: string }>();
    expect(log!.decision).toBe('approved:factual_summary');
    expect(JSON.parse(log!.details)).toMatchObject({ mode: 'factual_summary', sourceLicense: 'unreviewed', factual: { evidenceUrls: [URL_], verifiedLocation: 'Pace, Florida', humanWritten: true } });
    // The publisher's headline is never served for an unlicensed source.
    const src = await h.db.prepare('SELECT can_display_original_title FROM sources WHERE id = ?').bind('publisher:news.example.org').first<{ can_display_original_title: number }>();
    expect(src!.can_display_original_title).toBe(0);
  });

  it('requires every human verification, explicit wording, a Florida location, a real date and on-source evidence', async () => {
    const id = await importOne();
    const missing = await errorsOf(await approve({ questionId: id, ...human, linkCheck: link(), mode: 'factual_summary' }));
    expect(missing).toContain("FACTUAL_ATTESTATION_MISSING: factual_summary mode needs the reviewer's verification (factual)");
    const flags = await errorsOf(
      await approve({ questionId: id, linkCheck: link(), mode: 'factual_summary', factual: attest({ humanWritten: false, incidentVerified: false, claimsVerified: false, privacyChecked: false, verifiedDate: '2031-01-01', verifiedLocation: 'Mobile, Alabama', evidenceUrls: ['https://elsewhere.example/a'] }) }),
    );
    const codes = flags.map((e) => e.split(':')[0]);
    expect(codes).toEqual(
      expect.arrayContaining([
        'FACTUAL_TITLE_MISSING',
        'FACTUAL_EXPLANATION_MISSING',
        'FACTUAL_NOT_HUMAN_WRITTEN',
        'FACTUAL_INCIDENT_UNVERIFIED',
        'FACTUAL_CLAIMS_UNVERIFIED',
        'FACTUAL_PRIVACY_UNCHECKED',
        'FACTUAL_DATE_INVALID',
        'FACTUAL_LOCATION_NOT_FLORIDA',
        'FACTUAL_PROVENANCE',
      ]),
    );
    expect((await h.db.prepare('SELECT quality_state FROM questions').first<{ quality_state: string }>())!.quality_state).toBe('candidate');
  });

  it('catches near-copies of the source headline (title similarity, shared phrases)', async () => {
    const id = await importOne();
    const near = await errorsOf(await approve({ questionId: id, playTitle: 'Pace man pleads guilty in theft of national park signage', explanation: human.explanation, linkCheck: link(), mode: 'factual_summary', factual: attest() }));
    expect(near.join('\n')).toMatch(/PLAY_TITLE_NEAR_COPY/);
    const phrase = await errorsOf(await approve({ questionId: id, playTitle: human.playTitle, explanation: 'Records show he pleads guilty to theft of national park signs and paid restitution.', linkCheck: link(), mode: 'factual_summary', factual: attest() }));
    expect(phrase.join('\n')).toMatch(/EXPLANATION_SHARED_PHRASE: repeats \d+ consecutive words/);
  });

  it('keeps every existing safety/editorial check (giveaways, duplicates, link) in factual mode', async () => {
    const id = await importOne();
    const r = await errorsOf(await approve({ questionId: id, playTitle: 'A Florida collector carted off dozens of federal signs', explanation: human.explanation, mode: 'factual_summary', factual: attest() }));
    expect(r.join('\n')).toMatch(/PLAY_TITLE_GIVEAWAY/);
    expect(r.join('\n')).toMatch(/fresh link check is required/);
  });

  it('cannot be used to bypass blocked sources, unauthorized feeds or the dataset production restriction', async () => {
    const blocked = await importOne({ host: 'www.theonion.com' });
    expect((await errorsOf(await approve({ questionId: blocked, ...human, linkCheck: link('https://www.theonion.com/news/park-signs'), mode: 'factual_summary', factual: attest({ evidenceUrls: ['https://www.theonion.com/news/park-signs'] }) }))).join('\n')).toMatch(/SOURCE_BLOCKED/);

    await h.reset();
    const rss = await importOne({ provider: 'rss' });
    expect((await errorsOf(await approve({ questionId: rss, ...human, linkCheck: link(), mode: 'factual_summary', factual: attest() }))).join('\n')).toMatch(/UNAUTHORIZED_COLLECTION/);

    await h.reset();
    const ds = await importOne({ provider: 'floridaman_dataset' });
    const prod = await errorsOf(await approve({ questionId: ds, ...human, linkCheck: link(), mode: 'factual_summary', factual: attest() }, { APP_ENV: 'production' }));
    expect(prod.join('\n')).toMatch(/PROVIDER_NOT_ALLOWED/);
    expect((await h.db.prepare('SELECT quality_state FROM questions').first<{ quality_state: string }>())!.quality_state).toBe('candidate');
  });

  it('never auto-approves: the gate still routes imports to candidates', async () => {
    const id = await importOne();
    expect((await h.db.prepare('SELECT quality_state FROM questions WHERE id = ?').bind(id).first<{ quality_state: string }>())!.quality_state).toBe('candidate');
  });
});

describe('Independent Factual Summary for GTA wiki events', () => {
  it('approves original wording about a verified in-game event, links the wiki, and never sets a publication date', async () => {
    const url = 'https://www.grandtheftwiki.com/Van_Heist';
    const gta: ImportItem = {
      ...floridaItem(60),
      kind: 'GTA_CANON',
      incidentKey: 'gta:grandtheftwiki:1874',
      reference: { ...floridaItem(60).reference, provider: 'grandtheftwiki', providerKey: '1874', originalUrl: url, canonicalUrl: 'https://www.grandtheftwiki.com/index.php?curid=1874', publisher: 'Grand Theft Wiki', wikiPageId: 1874, wikiSection: null, originalTitle: 'Van Heist', publishedAt: null, linkCheck: null },
      incident: { ...floridaItem(60).incident, gameDetected: 'GTA_III', floridaSignal: 'none', floridaEvidence: null },
      question: { playTitleDraft: 'Van Heist', explanationDraft: '', difficulty: 2 },
      ai: null,
    };
    await importReq([gta]);
    const id = (await h.db.prepare('SELECT id FROM questions').first<{ id: string }>())!.id;
    const body = {
      questionId: id,
      action: 'approve',
      game: 'GTA_III',
      playTitle: 'A crew ambushes an armored security van to grab the cash inside',
      explanation: 'In this mission the player helps a crew stop a security van and take the money it carries. Verified on the linked wiki page.',
      linkCheck: { status: 'ok', httpStatus: 200, finalUrl: url, checkedAt: '2026-11-22T11:00:00.000Z' },
      mode: 'factual_summary',
      factual: { humanWritten: true, incidentVerified: true, claimsVerified: true, privacyChecked: true, verifiedDate: '2026-11-22', verifiedLocation: 'Liberty City (GTA III)', evidenceUrls: [url] },
    };
    const r = await call('/api/v1/admin/review', postJson(body, ADMIN_TOKEN, { 'x-actor': 'owner' }));
    expect(r.status).toBe(200);
    const ref = await h.db.prepare('SELECT published_at, original_url FROM source_references').first();
    expect(ref).toEqual({ published_at: null, original_url: url });
    const src = await h.db.prepare(`SELECT license_status FROM sources WHERE id = 'grandtheftwiki'`).first();
    expect(src).toEqual({ license_status: 'unreviewed' }); // wiki rights unchanged
  });
});

describe('revoking an approval that should not stand (placeholder text), then a fresh approval', () => {
  const url = 'https://www.grandtheftwiki.com/Van_Heist';
  const PLACEHOLDER = { playTitle: 'YOUR OWN REVIEWED TITLE', explanation: 'YOUR OWN VERIFIED EXPLANATION' };
  const REAL = {
    playTitle: 'A crew ambushes an armored security van to grab the cash inside',
    explanation: 'In this mission the player helps a crew stop a security van and take the money it carries. Verified on the linked wiki page.',
  };
  const factual = { humanWritten: true, incidentVerified: true, claimsVerified: true, privacyChecked: true, verifiedDate: '2026-11-22', verifiedLocation: 'Liberty City (GTA III)', evidenceUrls: [url] };
  const linkCheck = { status: 'ok', httpStatus: 200, finalUrl: url, checkedAt: '2026-11-22T11:00:00.000Z' };
  const review = (body: Record<string, unknown>, token = ADMIN_TOKEN) => call('/api/v1/admin/review', postJson(body, token, { 'x-actor': 'owner' }));
  const errorsOf = async (r: Response) => ((await r.json()) as { errors?: string[] }).errors ?? [];
  const approveBody = (id: string, o: Record<string, unknown> = {}) => ({ questionId: id, action: 'approve', game: 'GTA_III', linkCheck, mode: 'factual_summary', factual, ...REAL, ...o });

  async function importGta(): Promise<string> {
    const gta: ImportItem = {
      ...floridaItem(60),
      kind: 'GTA_CANON',
      incidentKey: 'gta:grandtheftwiki:1874',
      reference: { ...floridaItem(60).reference, provider: 'grandtheftwiki', providerKey: '1874', originalUrl: url, canonicalUrl: 'https://www.grandtheftwiki.com/index.php?curid=1874', publisher: 'Grand Theft Wiki', wikiPageId: 1874, wikiSection: null, originalTitle: 'Van Heist', publishedAt: null, linkCheck: null },
      incident: { ...floridaItem(60).incident, gameDetected: 'GTA_III', floridaSignal: 'none', floridaEvidence: null },
      question: { playTitleDraft: 'Van Heist', explanationDraft: '', difficulty: 2 },
      ai: null,
    };
    await importReq([gta]);
    return (await h.db.prepare('SELECT id FROM questions').first<{ id: string }>())!.id;
  }
  /** Reproduces the incident: an approval made before placeholder text was refused (simulated in the test DB only). */
  async function legacyPlaceholderApproval(): Promise<string> {
    const id = await importGta();
    expect((await review(approveBody(id))).status).toBe(200);
    await h.db.prepare('UPDATE questions SET play_title = ?, explanation = ? WHERE id = ?').bind(PLACEHOLDER.playTitle, PLACEHOLDER.explanation, id).run();
    return id;
  }
  const provenance = () =>
    h.db.prepare('SELECT sr.id, sr.provider, sr.source_id, sr.original_url, sr.original_title, sr.canonical_url, sr.publisher, sr.published_at, q.primary_reference_id, q.incident_id FROM questions q JOIN source_references sr ON sr.id = q.primary_reference_id').first();

  it('refuses placeholder and generic editorial text at approval, in every mode', async () => {
    const id = await importGta();
    const errs = await errorsOf(await review(approveBody(id, PLACEHOLDER)));
    const codes = errs.map((e) => e.split(':')[0]);
    expect(codes).toEqual(expect.arrayContaining(['PLAY_TITLE_PLACEHOLDER', 'PLAY_TITLE_ALL_CAPS', 'EXPLANATION_PLACEHOLDER', 'EXPLANATION_ALL_CAPS']));
    const generic = await errorsOf(await review(approveBody(id, { playTitle: 'Title title title title', explanation: 'See the source for the details of this one, see the source' })));
    expect(generic.map((e) => e.split(':')[0])).toEqual(expect.arrayContaining(['PLAY_TITLE_GENERIC']));
    const licensed = await errorsOf(await review({ questionId: id, action: 'approve', game: 'GTA_III', linkCheck, ...PLACEHOLDER }));
    expect(licensed.join('\n')).toMatch(/PLAY_TITLE_PLACEHOLDER[\s\S]*EXPLANATION_PLACEHOLDER/);
    expect((await h.db.prepare('SELECT quality_state FROM questions WHERE id = ?').bind(id).first())).toEqual({ quality_state: 'candidate' });
  });

  it('only admins can revoke, with a reason, and only approved questions', async () => {
    const id = await legacyPlaceholderApproval();
    expect((await review({ questionId: id, action: 'revoke', reason: 'placeholder text' }, SERVICE_TOKEN)).status).toBe(403);
    expect((await call('/api/v1/admin/review', postJson({ questionId: id, action: 'revoke', reason: 'placeholder text' }, 'wrong-token'))).status).toBe(401);
    expect(await errorsOf(await review({ questionId: id, action: 'revoke' }))).toEqual([expect.stringMatching(/reason is required/)]);
    expect((await h.db.prepare('SELECT quality_state FROM questions WHERE id = ?').bind(id).first())).toEqual({ quality_state: 'approved' });

    expect((await review({ questionId: id, action: 'revoke', reason: 'placeholder text' })).status).toBe(200);
    // A second revoke (now a candidate) and revoking a rejected question are refused.
    expect(await errorsOf(await review({ questionId: id, action: 'revoke', reason: 'placeholder text' }))).toEqual([expect.stringMatching(/Question is candidate/)]);
    await review({ questionId: id, action: 'reject', reason: 'not fun' });
    expect(await errorsOf(await review({ questionId: id, action: 'revoke', reason: 'placeholder text' }))).toEqual([expect.stringMatching(/Question is rejected/)]);
  });

  it('refuses scheduled questions (withdraw is the path for those) and changes nothing', async () => {
    const id = await legacyPlaceholderApproval();
    await h.db.batch([
      h.db.prepare(`INSERT INTO daily_rounds (day, number, florida_count) VALUES ('2026-11-30', 9, 3)`),
      h.db.prepare(`INSERT INTO daily_round_items (day, position, question_id) VALUES ('2026-11-30', 1, ?)`).bind(id),
    ]);
    const errs = await errorsOf(await review({ questionId: id, action: 'revoke', reason: 'placeholder text' }));
    expect(errs).toEqual([expect.stringMatching(/scheduled on 2026-11-30; withdraw it instead/)]);
    expect((await h.db.prepare('SELECT quality_state, approved_by FROM questions WHERE id = ?').bind(id).first())).toEqual({ quality_state: 'approved', approved_by: 'owner' });
    expect((await h.db.prepare(`SELECT COUNT(*) AS n FROM review_log WHERE decision = 'approval_revoked'`).first())).toEqual({ n: 0 });
  });

  it('returns the question to review, keeps source/provenance/audit, and requires new text plus fresh attestations', async () => {
    const id = await legacyPlaceholderApproval();
    const before = await provenance();

    const r = await review({ questionId: id, action: 'revoke', reason: 'Approved by mistake with placeholder text' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, questionId: id, state: 'candidate' });
    const q = await h.db
      .prepare('SELECT quality_state, play_title_reviewed, explanation, approved_by, approved_at, approval_actor_type FROM questions WHERE id = ?')
      .bind(id)
      .first();
    expect(q).toEqual({ quality_state: 'candidate', play_title_reviewed: 0, explanation: '', approved_by: null, approved_at: null, approval_actor_type: null });
    expect((await h.db.prepare('SELECT verification_status FROM incidents').first())).toEqual({ verification_status: 'unverified' });
    expect(await provenance()).toEqual(before);
    const revoked = await h.db.prepare(`SELECT actor_type, actor_id, reason, details FROM review_log WHERE decision = 'approval_revoked'`).first<{ actor_type: string; actor_id: string; reason: string; details: string }>();
    expect(revoked).toMatchObject({ actor_type: 'human', actor_id: 'owner', reason: 'Approved by mistake with placeholder text' });
    expect(JSON.parse(revoked!.details).revoked).toMatchObject({ ...PLACEHOLDER, approvedBy: 'owner', approvalActorType: 'human' });

    // A fresh approval runs the full factual-summary validation again.
    const noAttest = await errorsOf(await review(approveBody(id, { factual: undefined })));
    expect(noAttest.join('\n')).toMatch(/FACTUAL_ATTESTATION_MISSING/);
    const notAttested = await errorsOf(await review(approveBody(id, { factual: { ...factual, claimsVerified: false, privacyChecked: false } })));
    expect(notAttested.map((e) => e.split(':')[0])).toEqual(expect.arrayContaining(['FACTUAL_CLAIMS_UNVERIFIED', 'FACTUAL_PRIVACY_UNCHECKED']));
    const noText = await errorsOf(await review(approveBody(id, { playTitle: undefined, explanation: undefined })));
    expect(noText.join('\n')).toMatch(/FACTUAL_TITLE_MISSING[\s\S]*FACTUAL_EXPLANATION_MISSING/);
    const samePlaceholder = await errorsOf(await review(approveBody(id, PLACEHOLDER)));
    expect(samePlaceholder.join('\n')).toMatch(/PLAY_TITLE_PLACEHOLDER[\s\S]*EXPLANATION_PLACEHOLDER/);
    // The licensed path cannot quietly reuse the stored draft either (and the wiki is not licensed).
    const licensed = await errorsOf(await review({ questionId: id, action: 'approve', game: 'GTA_III', linkCheck }));
    expect(licensed.join('\n')).toMatch(/SOURCE_UNREVIEWED[\s\S]*playTitle is required[\s\S]*explanation is required/);
    expect((await h.db.prepare('SELECT quality_state FROM questions WHERE id = ?').bind(id).first())).toEqual({ quality_state: 'candidate' });

    expect((await review(approveBody(id))).status).toBe(200);
    const after = await h.db.prepare('SELECT quality_state, play_title, explanation, approved_by FROM questions WHERE id = ?').bind(id).first();
    expect(after).toEqual({ quality_state: 'approved', play_title: REAL.playTitle, explanation: REAL.explanation, approved_by: 'owner' });
    expect((await h.db.prepare('SELECT verification_status FROM incidents').first())).toEqual({ verification_status: 'verified' });
    const trail = await h.db.prepare(`SELECT decision FROM review_log WHERE entity_id = ? AND entity_type = 'question' ORDER BY id`).bind(id).all<{ decision: string }>();
    expect(trail.results.map((t) => t.decision)).toEqual(['import:candidate', 'approved:factual_summary', 'approval_revoked', 'approved:factual_summary']);
  });
});

describe('end-to-end with both approval modes: 3 licensed Florida + 2 factual-summary GTA', () => {
  it('imports, approves (human), schedules and serves one playable round; a revoked GTA question never reaches it', async () => {
    await seedSource(h.db, APPROVED_PUBLISHER);
    const items: ImportItem[] = [];
    for (let i = 0; i < 3; i++) items.push(floridaItem(80 + i));
    const gtaTitles = [
      'A crew ambushes an armored security van to grab the cash inside',
      'A getaway driver loses the police by repainting the car mid-chase',
      'A courier races across the city to deliver a briefcase before midnight',
    ];
    for (let i = 0; i < 3; i++) {
      const url = `https://www.grandtheftwiki.com/Mission_${900 + i}`;
      const base = floridaItem(90 + i);
      items.push({
        ...base,
        kind: 'GTA_CANON',
        incidentKey: `gta:grandtheftwiki:${900 + i}`,
        reference: { ...base.reference, provider: 'grandtheftwiki', providerKey: `${900 + i}`, originalUrl: url, canonicalUrl: url, publisher: 'Grand Theft Wiki', wikiPageId: 900 + i, wikiSection: null, originalTitle: `Mission ${i}`, publishedAt: null, linkCheck: null },
        incident: { ...base.incident, gameDetected: 'GTA_III', floridaSignal: 'none', floridaEvidence: null },
        question: { playTitleDraft: `Mission ${i}`, explanationDraft: '', difficulty: 2 },
        ai: null,
      });
    }
    await importReq(items);
    await seedSource(h.db, APPROVED_PUBLISHER); // owner's licensed policy for the Florida publisher; the wiki stays unreviewed
    expect(await h.db.prepare(`SELECT license_status FROM sources WHERE id = 'grandtheftwiki'`).first()).toEqual({ license_status: 'unreviewed' });

    const { results } = await h.db.prepare(`SELECT q.id, q.answer_kind, q.play_title, sr.original_url FROM questions q JOIN source_references sr ON sr.id = q.primary_reference_id ORDER BY sr.original_url`).all<{ id: string; answer_kind: string; play_title: string; original_url: string }>();
    const gtaIds: string[] = [];
    for (const q of results) {
      const body =
        q.answer_kind === 'FLORIDA'
          ? { questionId: q.id, action: 'approve', playTitle: q.play_title, explanation: 'Verified against the linked source by the reviewer during the test.', locationVerified: true, linkVerifiedManually: true }
          : {
              questionId: q.id,
              action: 'approve',
              game: 'GTA_III',
              playTitle: gtaTitles[gtaIds.length],
              explanation: 'In this mission the player does exactly what the prompt says. Verified on the linked wiki page by the reviewer.',
              linkCheck: { status: 'ok', httpStatus: 200, finalUrl: q.original_url, checkedAt: '2026-11-22T11:00:00.000Z' },
              mode: 'factual_summary',
              factual: { humanWritten: true, incidentVerified: true, claimsVerified: true, privacyChecked: true, verifiedDate: '2026-11-22', verifiedLocation: 'Liberty City (GTA III)', evidenceUrls: [q.original_url] },
            };
      const r = await call('/api/v1/admin/review', postJson(body, ADMIN_TOKEN, { 'x-actor': 'owner' }));
      expect(r.status, await r.clone().text()).toBe(200);
      if (q.answer_kind === 'GTA') gtaIds.push(q.id);
    }
    const modes = await h.db.prepare(`SELECT approval_mode, COUNT(*) AS n FROM questions WHERE approval_log_id IS NOT NULL GROUP BY approval_mode ORDER BY approval_mode`).all();
    expect(modes.results).toEqual([{ approval_mode: 'factual_summary', n: 3 }, { approval_mode: 'licensed', n: 3 }]);

    // One GTA approval is revoked before scheduling: only the other two may be used.
    const revoked = gtaIds[0]!;
    expect((await call('/api/v1/admin/review', postJson({ questionId: revoked, action: 'revoke', reason: 'wrong game checked' }, ADMIN_TOKEN, { 'x-actor': 'owner' }))).status).toBe(200);

    const sched = await (await call('/api/v1/admin/schedule', postJson({ days: 1 }, SERVICE_TOKEN))).json();
    expect(sched.added).toEqual([{ date: TODAY, floridaCount: 3 }]);
    const items5 = await h.db.prepare('SELECT question_id FROM daily_round_items ORDER BY position').all<{ question_id: string }>();
    expect(items5.results.map((x) => x.question_id)).not.toContain(revoked);

    const today = await (await call('/api/challenge/today')).json();
    expect(today.questions).toHaveLength(5);
    const fin = await (await call(`/api/challenge/${TODAY}/finish`, postJson({ answers: today.questions.map((q: { id: string }) => ({ questionId: q.id, choice: 'GTA' })) }))).json();
    expect(fin.questions.filter((q: { answer: string }) => q.answer === 'gta')).toHaveLength(2);
    expect(fin.questions.filter((q: { answer: string }) => q.answer === 'florida')).toHaveLength(3);
  });
});
