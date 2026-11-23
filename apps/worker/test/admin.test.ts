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
