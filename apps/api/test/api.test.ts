import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchedule, type Question } from '@gof/core';
import { createApp } from '../src/app.ts';
import { createChallengeService } from '../src/services/challenge.ts';
import { createContentStore, createStaticStore } from '../src/services/questions.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TODAY = '2026-11-19';

// Distinct wording so the bank passes near-duplicate validation.
const HEADLINES = [
  'Pelican steals a fisherman\'s phone mid-call', 'Mango truck spills onto the causeway at rush hour', 'Airboat tour interrupted by a karaoke contest',
  'Flamingo statue elected honorary mayor', 'Hurricane party goes ahead in a bowling alley', 'Boardwalk magician vanishes with the tip jar',
  'Manatee befriends a submarine replica', 'Pawnshop buys a haunted saxophone', 'Jetski parade blocks drawbridge for an hour',
  'Iguana rescued from a ceiling fan at a bakery', 'Rob a citrus baron during his grove party', 'Steal a lighthouse lens for a museum collector',
  'Motel heist goes wrong when the ice machine jams', 'Parrot witness must be smuggled out of town', 'Swamp racer needs a getaway driver tonight',
  'Marina boss wants a rival yacht repainted pink', 'Tiki bar owner pays you to scare off a food critic', 'Neon sign forger hires a lookout',
  'Causeway chase ends inside a car wash', 'Sinkhole swallows a getaway van full of fake watches',
];

function q(i: number, answer: 'florida' | 'gta', extra: Partial<Question> = {}): Question {
  return {
    id: `${answer}-${i}`,
    headline: HEADLINES[answer === 'florida' ? i : i - 90]!,
    answer,
    explanation: answer === 'florida' ? 'SECRET-EXPLANATION real report.' : 'SECRET-EXPLANATION fiction.',
    status: 'verified',
    category: (['wildlife', 'crime', 'vehicles', 'weird', 'other'] as const)[i % 5]!,
    difficulty: ((i % 3) + 1) as 1 | 2 | 3,
    canonicalEventId: `evt-${answer}-${i}`,
    reviewedAt: '2026-11-01',
    ...(answer === 'florida'
      ? { sourceUrl: `https://news.example/secret-source-${i}`, sourceName: 'Example News', publishedAt: '2026-10-01' }
      : { gtaSubtype: 'fiction' as const }),
    ...extra,
  };
}

const bank: Question[] = [...Array.from({ length: 10 }, (_, i) => q(i, 'florida')), ...Array.from({ length: 10 }, (_, i) => q(i + 100, 'gta'))];
const { schedule } = buildSchedule({ questions: bank, startDate: '2026-11-18', days: 2 });

let server: Server;
let base: string;
let close: () => void;

beforeAll(async () => {
  const service = createChallengeService({
    store: createStaticStore(bank, schedule),
    allowPlaceholders: false,
    archiveDays: 7,
    timeLimitSeconds: 60,
    now: () => new Date(`${TODAY}T12:00:00Z`),
  });
  const app = createApp({
    config: { webDistDir: null, rateLimit: { windowMs: 60_000, max: 1000 }, trustProxy: false, maxBodyBytes: 4096, logRequests: false },
    service,
  });
  close = app.close;
  server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  close();
  server.close();
});

const j = async (res: Response): Promise<any> => res.json();

const post = (path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('GET /api/challenge/today', () => {
  it('returns today’s questions without answers, explanations or sources', async () => {
    const res = await fetch(`${base}/api/challenge/today`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toMatch(/"answer"|SECRET|secret-source|explanation|"florida"|"gta"/);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ challengeId: TODAY, date: TODAY, number: 2, today: TODAY, timeLimitSeconds: 60, sample: false });
    expect(body.questions).toHaveLength(5);
    expect(Object.keys(body.questions[0]).sort()).toEqual(['headline', 'id']);
    // Ids are positional, so they can't hint at the answer ("florida-3", "gta-101"...).
    expect(body.questions.map((x: { id: string }) => x.id)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
    for (const internal of schedule.days[1]!.questionIds) expect(text).not.toContain(internal);
  });

  it('is identical for every caller on the same UTC date', async () => {
    const [a, b] = await Promise.all([fetch(`${base}/api/challenge/today`).then(j), fetch(`${base}/api/challenge/today`).then(j)]);
    expect(a).toEqual(b);
  });

  it('sends security headers', async () => {
    const res = await fetch(`${base}/api/challenge/today`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

describe('GET /api/challenge/:date', () => {
  it('serves archive days', async () => {
    const res = await fetch(`${base}/api/challenge/2026-11-18`);
    expect(res.status).toBe(200);
    expect((await j(res)).number).toBe(1);
  });

  it('refuses future days', async () => {
    const res = await fetch(`${base}/api/challenge/2026-11-20`);
    expect(res.status).toBe(404);
    expect((await j(res)).error.code).toBe('FUTURE_CHALLENGE');
  });

  it('reports unscheduled past days as not found', async () => {
    const res = await fetch(`${base}/api/challenge/2026-11-15`);
    expect(res.status).toBe(404);
    expect((await j(res)).error.code).toBe('NOT_FOUND');
  });

  it('rejects impossible dates', async () => {
    const res = await fetch(`${base}/api/challenge/2026-02-30`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/challenge/:id/answer', () => {
  it('reveals a single answer only after it is submitted', async () => {
    const challenge = await j(await fetch(`${base}/api/challenge/today`));
    const qid = challenge.questions[0].id as string;
    const truth = bank.find((x) => x.id === schedule.days[1]!.questionIds[0])!;
    const res = await post(`/api/challenge/${TODAY}/answer`, { questionId: qid, choice: 'florida' });
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.correct).toBe(truth.answer === 'florida');
    expect(body.question.answer).toBe(truth.answer);
    expect(body.question.explanation).toBe(truth.explanation);
    if (truth.answer === 'florida') expect(body.question.sourceUrl).toBe(truth.sourceUrl);
    else expect(body.question.sourceUrl).toBeUndefined();
  });

  it('validates input', async () => {
    expect((await post(`/api/challenge/${TODAY}/answer`, { questionId: 'nope', choice: 'gta' })).status).toBe(400);
    expect((await post(`/api/challenge/${TODAY}/answer`, { questionId: 'h1', choice: 'maybe' })).status).toBe(400);
    expect((await post(`/api/challenge/${TODAY}/answer`, { questionId: 'florida-0', choice: 'gta' })).status).toBe(400);
    expect((await post(`/api/challenge/${TODAY}/answer`, '{not json')).status).toBe(400);
    expect((await post(`/api/challenge/${TODAY}/answer`, { a: 1 }, { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('rejects oversized bodies', async () => {
    const res = await post(`/api/challenge/${TODAY}/answer`, { questionId: 'x', choice: 'gta', pad: 'x'.repeat(10_000) });
    expect(res.status).toBe(413);
  });

  it('does not allow answering future challenges', async () => {
    const res = await post('/api/challenge/2026-11-25/answer', { questionId: 'x', choice: 'gta' });
    expect(res.status).toBe(404);
  });

  it('requires POST', async () => {
    const res = await fetch(`${base}/api/challenge/${TODAY}/answer`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('POST /api/challenge/:id/finish', () => {
  it('scores all answers server-side and returns explanations', async () => {
    const challenge = await j(await fetch(`${base}/api/challenge/today`));
    const ids: string[] = challenge.questions.map((x: { id: string }) => x.id);
    const internal = schedule.days[1]!.questionIds;
    const answers = ids.map((id, i) => ({ questionId: id, choice: i === 4 ? null : bank.find((x) => x.id === internal[i])!.answer }));
    const res = await post(`/api/challenge/${TODAY}/finish`, { answers });
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body).toMatchObject({ score: 4, total: 5, cells: [true, true, true, true, null] });
    expect(body.questions.map((x: { id: string }) => x.id)).toEqual(ids);
  });

  it('rejects incomplete or mismatched answer sets', async () => {
    expect((await post(`/api/challenge/${TODAY}/finish`, { answers: [] })).status).toBe(400);
    const five = Array.from({ length: 5 }, (_, i) => ({ questionId: `bogus-${i}`, choice: 'gta' }));
    expect((await post(`/api/challenge/${TODAY}/finish`, { answers: five })).status).toBe(400);
    const dupes = Array.from({ length: 5 }, () => ({ questionId: 'h1', choice: 'gta' }));
    expect((await post(`/api/challenge/${TODAY}/finish`, { answers: dupes })).status).toBe(400);
  });
});

describe('other routes', () => {
  it('health reports ok', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await j(res)).toMatchObject({ status: 'ok', questions: 20, scheduledDays: 2, todayScheduled: true });
  });

  it('archive lists past and today’s challenges, newest first, no future', async () => {
    const body = await j(await fetch(`${base}/api/archive`));
    expect(body.days.map((d: { date: string }) => d.date)).toEqual([TODAY, '2026-11-18']);
    expect(body.days[0].isToday).toBe(true);
  });

  it('unknown API routes are JSON 404s', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect((await j(res)).error.code).toBe('NOT_FOUND');
  });
});

describe('fallbacks', () => {
  it('returns NO_CHALLENGE when today is not scheduled', () => {
    const service = createChallengeService({
      store: createStaticStore(bank, schedule),
      allowPlaceholders: false,
      archiveDays: 7,
      timeLimitSeconds: 60,
      now: () => new Date('2026-11-21T00:00:00Z'),
    });
    expect(() => service.getChallenge('today')).toThrow(expect.objectContaining({ code: 'NO_CHALLENGE', status: 404 }));
  });

  it('refuses placeholder content unless allowed', () => {
    const withPlaceholder = bank.map((x) => (x.answer === 'gta' ? { ...x, placeholder: true } : x));
    const opts = { store: createStaticStore(withPlaceholder, schedule), archiveDays: 7, timeLimitSeconds: 60, now: () => new Date(`${TODAY}T01:00:00Z`) };
    expect(() => createChallengeService({ ...opts, allowPlaceholders: false }).getChallenge('today')).toThrow(
      expect.objectContaining({ code: 'CONTENT_UNAVAILABLE' }),
    );
    expect(createChallengeService({ ...opts, allowPlaceholders: true }).getChallenge('today').sample).toBe(true);
  });

  it('returns CONTENT_UNAVAILABLE when no data is loaded', () => {
    const service = createChallengeService({ store: createStaticStore([], null), allowPlaceholders: true, archiveDays: 7, timeLimitSeconds: 60 });
    expect(() => service.getChallenge('today')).toThrow(expect.objectContaining({ status: 503 }));
    expect(service.health().status).toBe('degraded');
  });

  it('keeps serving the last good content when files become invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gof-'));
    writeFileSync(resolve(dir, 'questions.approved.json'), JSON.stringify({ version: 1, questions: bank }));
    writeFileSync(resolve(dir, 'daily-schedule.json'), JSON.stringify(schedule));
    const errors: string[] = [];
    const store = createContentStore(dir, (m) => errors.push(m), 0);
    expect(store.get().questions.size).toBe(20);
    expect(store.get().error).toBeUndefined();

    // A bad manual edit: duplicate ids make the bank invalid.
    writeFileSync(resolve(dir, 'questions.approved.json'), JSON.stringify({ version: 1, questions: [...bank, bank[0], { junk: true }] }));
    const after = store.get();
    expect(after.error).toMatch(/Question bank invalid/);
    expect(after.questions.size).toBe(20);
    expect(after.schedule).not.toBeNull();
    expect(errors.some((e) => e.includes('keeping previously loaded content'))).toBe(true);
  });
});

describe('shipped sample data', () => {
  it('loads and validates the repository data files', () => {
    const errors: string[] = [];
    const store = createContentStore(resolve(__dirname, '../../../data'), (m) => errors.push(m));
    expect(errors).toEqual([]);
    expect(store.get().schedule?.days.length).toBeGreaterThan(0);
  });
});
