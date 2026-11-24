import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerResponse, ChallengeResponse, FinishResponse } from '@gof/core';
import { scheduleRounds } from '../src/services/scheduling.ts';
import { ADMIN_TOKEN, APPROVED_PUBLISHER, APPROVED_WIKI, createHarness, postJson, seedApproved, seedMany, seedSource, type Harness } from './harness.ts';

let h: Harness;
const TODAY = '2026-11-22';
const now = new Date(`${TODAY}T12:00:00Z`);

beforeAll(async () => {
  h = await createHarness({ APP_ENV: 'production', FRONTEND_ORIGIN: 'https://gta-or-florida.pages.dev', PAGES_PREVIEW_PROJECT: 'gta-or-florida' });
});
afterAll(() => h.dispose());
beforeEach(() => h.reset());

const get = (path: string, init: RequestInit = {}) => h.fetch(path, { ...init, now });

describe('health', () => {
  it('reports db + readiness without internals', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok', db: 'ok', runtime: 'cloudflare-workers', todayReady: false });
    expect(JSON.stringify(body)).not.toMatch(/token|database_id|DB/);
  });
});

describe('daily round', () => {
  it('returns DAILY_NOT_READY (503) when nothing is scheduled', async () => {
    const res = await get('/api/challenge/today');
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('DAILY_NOT_READY');
  });

  it('serves 5 questions without leaking answers, sources, kinds or games, same order every time', async () => {
    await seedMany(h.db, 6, 6);
    await scheduleRounds(h.db, { startDate: TODAY, days: 1 });
    const a = await get('/api/challenge/today');
    expect(a.status).toBe(200);
    expect(a.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);
    const raw = await a.text();
    const body = JSON.parse(raw) as ChallengeResponse;
    expect(body.questions).toHaveLength(5);
    expect(body.questions.map((q) => q.id)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
    for (const q of body.questions) expect(Object.keys(q).sort()).toEqual(['headline', 'id']);
    expect(raw).not.toMatch(/SECRET|ORIGINAL HEADLINE|https?:\/\/|FLORIDA|GTA_|florida"|"gta"|answer|source|game|kind/i);
    const b = (await (await get('/api/challenge/today')).json()) as ChallengeResponse;
    expect(b.questions).toEqual(body.questions);
  });

  it('reveals one question after a guess with CTA, game and rights-gated original title', async () => {
    await seedMany(h.db, 6, 6);
    await scheduleRounds(h.db, { startDate: TODAY, days: 1 });
    const seen = new Set<string>();
    for (const id of ['h1', 'h2', 'h3', 'h4', 'h5']) {
      const res = await h.fetch(`/api/challenge/${TODAY}/answer`, { ...postJson({ questionId: id, choice: 'FLORIDA' }), now });
      expect(res.status).toBe(200);
      const r = (await res.json()) as AnswerResponse;
      expect(r.correct).toBe(r.question.answer === 'florida');
      expect(r.question.explanation).toMatch(/SECRET-EXPLANATION/);
      if (r.question.answer === 'florida') {
        expect(r.question.sourceCta).toBe('Read full article');
        expect(r.question.originalTitle).toMatch(/TEST ORIGINAL HEADLINE/); // publisher policy allows it
      } else {
        expect(r.question.sourceCta).toBe('View GTA source');
        expect(r.question.originalTitle).toBeUndefined(); // wiki policy does not
        expect(r.question.game).toMatch(/GTA/);
        expect(r.question.gtaSubtype).toBe('gta_lore');
      }
      seen.add(r.question.answer);
    }
    expect(seen.size).toBe(2);
  });

  it('validates choice, question id, date, JSON and content type', async () => {
    await seedMany(h.db, 6, 6);
    await scheduleRounds(h.db, { startDate: TODAY, days: 1 });
    const post = (path: string, init: RequestInit) => h.fetch(path, { ...init, now });
    expect((await post(`/api/challenge/${TODAY}/answer`, postJson({ questionId: 'h1', choice: 'maybe' }))).status).toBe(400);
    const nf = await post(`/api/challenge/${TODAY}/answer`, postJson({ questionId: 'h9', choice: 'GTA' }));
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe('QUESTION_NOT_FOUND');
    expect((await post(`/api/challenge/2026-13-40/answer`, postJson({ questionId: 'h1', choice: 'GTA' }))).status).toBe(400);
    expect((await post(`/api/challenge/${TODAY}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status).toBe(400);
    expect((await post(`/api/challenge/${TODAY}/answer`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await get('/api/challenge/not-a-date')).status).toBe(400);
    expect((await get('/api/challenge/2026-11-23')).status).toBe(404); // future
    const wrongMethod = await h.fetch(`/api/challenge/${TODAY}/answer`, { method: 'GET', now });
    expect(wrongMethod.status).toBe(405);
  });

  it('finish grades all five and reveals everything only then', async () => {
    await seedMany(h.db, 6, 6);
    await scheduleRounds(h.db, { startDate: TODAY, days: 1 });
    const answers = ['h1', 'h2', 'h3', 'h4', 'h5'].map((questionId) => ({ questionId, choice: 'gta' }));
    const res = await h.fetch(`/api/challenge/${TODAY}/finish`, { ...postJson({ answers }), now });
    const body = (await res.json()) as FinishResponse;
    expect(body.total).toBe(5);
    expect(body.questions.every((q) => q.explanation)).toBe(true);
    expect(body.score).toBe(body.questions.filter((q) => q.answer === 'gta').length);
  });

  it('serves ROUND_WITHDRAWN (410) to everyone after a withdrawal', async () => {
    await seedMany(h.db, 6, 6);
    await scheduleRounds(h.db, { startDate: TODAY, days: 1 });
    const w = await h.fetch('/api/v1/admin/withdraw', { ...postJson({ target: 'day', id: TODAY, reason: 'test withdrawal', publicMessage: 'Back soon, fixing a round.' }, ADMIN_TOKEN), now });
    expect(w.status).toBe(200);
    const res = await get('/api/challenge/today');
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: { code: 'ROUND_WITHDRAWN', message: 'Back soon, fixing a round.' } });
    const archive = await (await get('/api/archive')).json();
    expect(archive.days).toEqual([]);
  });

  it('never serves fixtures outside the local environment', async () => {
    await seedSource(h.db, APPROVED_PUBLISHER);
    await seedSource(h.db, APPROVED_WIKI);
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'FLORIDA', { fixture: true });
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'GTA', { fixture: true });
    // Even if fixtures were scheduled (allowFixtures), production refuses to serve them.
    await scheduleRounds(h.db, { startDate: TODAY, days: 1, allowFixtures: true });
    const res = await get('/api/challenge/today');
    expect(res.status).toBe(503);
    const local = await h.fetch('/api/challenge/today', { now, env: { APP_ENV: 'local' } });
    expect(local.status).toBe(200);
    expect((await local.json()).sample).toBe(true);
  });

  it('stops serving a round whose source policy is later revoked', async () => {
    await seedMany(h.db, 6, 6);
    await scheduleRounds(h.db, { startDate: TODAY, days: 1 });
    await h.db.prepare(`UPDATE sources SET license_status = 'blocked', can_use_editorial_summary = 0, can_display_original_title = 0, auto_publish_allowed = 0`).run();
    expect((await get('/api/challenge/today')).status).toBe(503);
  });
});

describe('approval modes (same rules as the scheduler)', () => {
  const WIKI = { id: 'grandtheftwiki', type: 'gta_wiki' as const, name: 'Grand Theft Wiki', hosts: ['grandtheftwiki.com'], licenseStatus: 'unreviewed' as const, canUseEditorialSummary: false, canDisplayOriginalTitle: false, autoPublishAllowed: false };
  async function factualRound() {
    await seedSource(h.db, APPROVED_PUBLISHER);
    await seedSource(h.db, WIKI);
    for (let i = 0; i < 3; i++) await seedApproved(h.db, 'FLORIDA');
    const gta = [];
    for (let i = 0; i < 2; i++) gta.push(await seedApproved(h.db, 'GTA', { sourceId: WIKI.id, provider: 'grandtheftwiki', mode: 'factual_summary' }));
    const r = await scheduleRounds(h.db, { startDate: TODAY, days: 1, appEnv: 'production' });
    expect(r.added).toEqual([{ date: TODAY, floridaCount: 3 }]);
    return gta;
  }

  it('serves a 3 + 2 round whose GTA questions are factual summaries of the unreviewed wiki', async () => {
    await factualRound();
    const res = await get('/api/challenge/today');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChallengeResponse;
    expect(body.questions).toHaveLength(5);
    expect(body.sample).toBe(false);
  });

  const mutations: [string, (q: string) => Promise<unknown>][] = [
    ['approval revoked afterwards (audit)', (q) => h.db.prepare(`INSERT INTO review_log (entity_type, entity_id, decision, actor_type, actor_id) VALUES ('question', ?, 'approval_revoked', 'human', 'owner')`).bind(q).run()],
    ['approval provenance cleared', (q) => h.db.prepare('UPDATE questions SET approval_log_id = NULL WHERE id = ?').bind(q).run()],
    ['mode switched to licensed without source rights', (q) => h.db.prepare(`UPDATE questions SET approval_mode = 'licensed' WHERE id = ?`).bind(q).run()],
    ['source blocked', () => h.db.prepare(`UPDATE sources SET license_status = 'blocked' WHERE id = 'grandtheftwiki'`).run()],
    ['stored attestation incomplete', (q) => h.db.prepare(`UPDATE review_log SET details = '{"mode":"factual_summary","factual":{"humanWritten":true}}' WHERE id = (SELECT approval_log_id FROM questions WHERE id = ?)`).bind(q).run()],
    ['dataset provider in production', (q) => h.db.prepare('UPDATE source_references SET provider = ? WHERE id = (SELECT primary_reference_id FROM questions WHERE id = ?)').bind('floridaman_dataset', q).run()],
    ['question back in review', (q) => h.db.prepare(`UPDATE questions SET quality_state = 'candidate' WHERE id = ?`).bind(q).run()],
  ];
  for (const [name, mutate] of mutations) {
    it(`stops serving the round when a factual question is no longer eligible: ${name}`, async () => {
      const [q] = await factualRound();
      expect((await get('/api/challenge/today')).status).toBe(200);
      await mutate(q!);
      expect((await get('/api/challenge/today')).status).toBe(503);
    });
  }
});

describe('CORS', () => {
  it('allows the production origin and parsed Pages previews only', async () => {
    const pre = (origin: string) => h.fetch('/api/challenge/today', { method: 'OPTIONS', headers: { origin }, now });
    expect((await pre('https://gta-or-florida.pages.dev')).status).toBe(204);
    expect((await pre('https://abc123.gta-or-florida.pages.dev')).headers.get('access-control-allow-origin')).toBe('https://abc123.gta-or-florida.pages.dev');
    expect((await pre('https://evil.com')).status).toBe(403);
    expect((await pre('https://gta-or-florida.pages.dev.evil.com')).status).toBe(403);
    expect((await pre('https://a.b.gta-or-florida.pages.dev')).status).toBe(403);
    expect((await pre('https://evilgta-or-florida.pages.dev')).status).toBe(403);
    const res = await h.fetch('/api/health', { headers: { origin: 'https://gta-or-florida.pages.dev' }, now });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://gta-or-florida.pages.dev');
    const admin = await h.fetch('/api/v1/admin/stats', { headers: { origin: 'https://gta-or-florida.pages.dev', authorization: `Bearer ${ADMIN_TOKEN}` }, now });
    expect(admin.headers.get('access-control-allow-origin')).toBeNull();
  });
});
