import type { ChallengeResponse } from '@gof/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultGrid } from '../src/components/ResultGrid.tsx';
import { GameSession } from '../src/features/game/GameSession.tsx';
import { QuestionView } from '../src/features/game/QuestionView.tsx';
import { getProgress, getResult, type StoredResult } from '../src/lib/storage.ts';

function withProviders(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const challenge: ChallengeResponse = {
  challengeId: '2026-11-19',
  date: '2026-11-19',
  number: 3,
  today: '2026-11-19',
  timeLimitSeconds: 60,
  sample: false,
  questions: [
    { id: 'q1', headline: 'Iguana files a noise complaint' },
    { id: 'q2', headline: 'Steal a blimp for a mob boss' },
  ],
};

const truth: Record<string, 'florida' | 'gta'> = { q1: 'florida', q2: 'gta' };

function mockApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/answer')) {
      const answer = truth[body.questionId]!;
      return json({
        questionId: body.questionId,
        choice: body.choice,
        correct: body.choice === answer,
        question: {
          id: body.questionId,
          headline: challenge.questions.find((q) => q.id === body.questionId)!.headline,
          answer,
          explanation: answer === 'florida' ? 'Reported by Example News.' : 'Original scenario written for this game.',
          placeholder: false,
          ...(answer === 'florida' ? { sourceUrl: 'https://news.example/iguana', sourceName: 'Example News', publishedAt: '2026-10-01' } : { gtaSubtype: 'fiction' }),
        },
      });
    }
    if (url.endsWith('/finish')) {
      const cells = body.answers.map((a: { questionId: string; choice: string | null }) => (a.choice === null ? null : a.choice === truth[a.questionId]));
      return json({
        challengeId: challenge.challengeId,
        date: challenge.date,
        number: challenge.number,
        score: cells.filter((c: boolean | null) => c === true).length,
        total: 2,
        cells,
        questions: [],
      });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('QuestionView', () => {
  it('exposes two large, labeled answer buttons and keyboard shortcuts', async () => {
    const onChoose = vi.fn();
    render(<QuestionView question={{ id: 'x', headline: 'Something odd happened' }} onChoose={onChoose} busy={false} error={null} timed />);
    const gta = screen.getByRole('button', { name: /GTA.*Fictional scenario/i });
    const florida = screen.getByRole('button', { name: /FLORIDA.*Real report/i });
    expect(screen.getByRole('heading', { name: 'Something odd happened' })).toHaveFocus();
    await userEvent.click(gta);
    expect(onChoose).toHaveBeenLastCalledWith('gta');
    await userEvent.click(florida);
    expect(onChoose).toHaveBeenLastCalledWith('florida');
    await userEvent.keyboard('f');
    expect(onChoose).toHaveBeenLastCalledWith('florida');
  });

  it('locks the buttons while an answer is being checked', () => {
    render(<QuestionView question={{ id: 'x', headline: 'Something odd happened' }} onChoose={() => {}} busy error={null} timed />);
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });
});

describe('ResultGrid', () => {
  it('describes each tile in text, not just color', () => {
    render(<ResultGrid cells={[true, false, null]} />);
    expect(screen.getByRole('list', { name: '1 right, 1 wrong, 1 unanswered' })).toBeInTheDocument();
    expect(screen.getByText('Headline 2: wrong')).toBeInTheDocument();
  });
});

describe('GameSession', () => {
  it('plays a full round: reveal, source link, scoring and local completion', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    let completed: StoredResult | null = null;
    withProviders(<GameSession challenge={challenge} practice={false} onComplete={(r) => (completed = r)} />);

    await user.click(await screen.findByRole('button', { name: /FLORIDA/ }));
    expect(await screen.findByRole('heading', { name: 'Correct!' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Read original report/ })).toHaveAttribute('href', 'https://news.example/iguana');
    expect(screen.getByRole('timer')).toHaveAccessibleName(/paused/);
    expect(getProgress('2026-11-19')).toMatchObject({ index: 0, phase: 'reveal' });

    await user.click(screen.getByRole('button', { name: /Next headline/ }));
    await user.click(await screen.findByRole('button', { name: /FLORIDA/ }));
    expect(await screen.findByRole('heading', { name: 'Not quite.' })).toBeInTheDocument();
    expect(screen.getByText('Fictional GTA-style scenario.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /See my results/ }));
    await waitFor(() => expect(completed).not.toBeNull());
    expect(completed!).toMatchObject({ score: 1, total: 2, cells: [true, false], mode: 'daily' });
    expect(getResult('2026-11-19')?.score).toBe(1);
    expect(getProgress('2026-11-19')).toBeNull();

    // The initial challenge never included answers; they only came from /answer after each choice.
    const answerCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/answer'));
    expect(answerCalls).toHaveLength(2);
  });

  it('does not save practice replays', async () => {
    mockApi();
    const user = userEvent.setup();
    let completed: StoredResult | null = null;
    withProviders(<GameSession challenge={challenge} practice onComplete={(r) => (completed = r)} />);
    await user.click(await screen.findByRole('button', { name: /GTA/ }));
    await user.click(await screen.findByRole('button', { name: /Next headline/ }));
    await user.click(await screen.findByRole('button', { name: /GTA/ }));
    await user.click(await screen.findByRole('button', { name: /See my results/ }));
    await waitFor(() => expect(completed).not.toBeNull());
    expect(getResult('2026-11-19')).toBeNull();
    expect(getProgress('2026-11-19')).toBeNull();
  });

  it('shows a retryable error when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const user = userEvent.setup();
    withProviders(<GameSession challenge={challenge} practice={false} onComplete={() => {}} />);
    await user.click(await screen.findByRole('button', { name: /GTA/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Connection hiccup/);
    expect(screen.getByRole('button', { name: /GTA/ })).toBeEnabled();
  });
});
