import type { ChallengeResponse, RevealedQuestion } from '@gof/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaticApi } from '../src/api/static.ts';

const challenge: ChallengeResponse = {
  challengeId: '2026-11-19',
  date: '2026-11-19',
  number: 8,
  today: '2026-11-19',
  timeLimitSeconds: 60,
  sample: false,
  questions: [
    { id: 'h1', headline: 'One headline here' },
    { id: 'h2', headline: 'Two headline here' },
  ],
};
const reveals: Record<string, RevealedQuestion> = {
  h1: { id: 'h1', headline: 'One headline here', answer: 'florida', explanation: 'x', placeholder: false, sourceUrl: 'https://n.example/1' },
  h2: { id: 'h2', headline: 'Two headline here', answer: 'gta', gtaSubtype: 'fiction', explanation: 'y', placeholder: false },
};

function serve(files: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const hit = Object.entries(files).find(([k]) => path === `/gta-or-florida/data/${k}`);
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response('<html>404</html>', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const files = {
  'challenge/2026-11-19.json': challenge,
  'challenge/2026-11-18.json': { ...challenge, challengeId: '2026-11-18', date: '2026-11-18', number: 7 },
  'reveal/2026-11-19/h1.json': reveals.h1,
  'reveal/2026-11-19/h2.json': reveals.h2,
  'archive.json': {
    today: '2026-11-19',
    archiveDays: 7,
    days: [
      { date: '2026-11-19', number: 8, challengeId: '2026-11-19', isToday: true },
      { date: '2026-11-18', number: 7, challengeId: '2026-11-18', isToday: false },
      { date: '2026-11-01', number: 1, challengeId: '2026-11-01', isToday: false },
    ],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('static data source (GitHub Pages)', () => {
  const at = (iso: string) => createStaticApi('/gta-or-florida/', () => new Date(iso));

  it('loads today’s challenge by the client’s UTC date, under the base path', async () => {
    const fetchMock = serve(files);
    const c = await at('2026-11-19T08:00:00Z').challenge('today');
    expect(c).toMatchObject({ date: '2026-11-19', today: '2026-11-19', number: 8 });
    expect(fetchMock).toHaveBeenCalledWith('/gta-or-florida/data/challenge/2026-11-19.json', expect.anything());
  });

  it('reports DAILY_NOT_READY when today’s file is not deployed yet', async () => {
    serve(files);
    await expect(at('2026-11-20T00:01:00Z').challenge('today')).rejects.toMatchObject({ code: 'DAILY_NOT_READY' });
  });

  it('refuses future dates without fetching', async () => {
    const fetchMock = serve(files);
    await expect(at('2026-11-19T08:00:00Z').challenge('2026-11-20')).rejects.toMatchObject({ code: 'FUTURE_CHALLENGE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reveals only the answered question', async () => {
    const fetchMock = serve(files);
    const res = await at('2026-11-19T08:00:00Z').answer('2026-11-19', { questionId: 'h2', choice: 'florida' });
    expect(res).toMatchObject({ correct: false, question: { answer: 'gta' } });
    const revealCalls = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/reveal/'));
    expect(revealCalls).toEqual(['/gta-or-florida/data/reveal/2026-11-19/h2.json']);
  });

  it('rejects unknown question ids', async () => {
    serve(files);
    await expect(at('2026-11-19T08:00:00Z').answer('2026-11-19', { questionId: 'h9', choice: 'gta' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('scores a finished round locally', async () => {
    serve(files);
    const res = await at('2026-11-19T08:00:00Z').finish('2026-11-19', { answers: [{ questionId: 'h1', choice: 'florida' }, { questionId: 'h2', choice: null }] });
    expect(res).toMatchObject({ score: 1, total: 2, cells: [true, null], number: 8 });
    expect(res.questions.map((q) => q.answer)).toEqual(['florida', 'gta']);
  });

  it('filters the archive to the window and recomputes "today" on the client', async () => {
    serve(files);
    const a = await at('2026-11-20T08:00:00Z').archive();
    expect(a.today).toBe('2026-11-20');
    expect(a.days.map((d) => [d.date, d.isToday])).toEqual([
      ['2026-11-19', false],
      ['2026-11-18', false],
    ]);
  });

  it('maps network failures to retryable errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(at('2026-11-19T08:00:00Z').archive()).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
