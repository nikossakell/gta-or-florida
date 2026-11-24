import { buildShareText, type ChallengeResponse, type ResultCell } from '@gof/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkpointStates } from '../src/daily-drive/components/CheckpointRoute.tsx';
import { DriveMap } from '../src/daily-drive/components/DriveMap.tsx';
import { provideEngine, type Engine } from '../src/daily-drive/engine.ts';
import { keyAction } from '../src/daily-drive/lib/keys.ts';
import { endingFor, endingOf } from '../src/daily-drive/lib/endings.ts';
import { trailingStreak } from '../src/daily-drive/lib/streak.ts';
import { DriveResults } from '../src/daily-drive/screens/DriveResults.tsx';
import { GameSession } from '../src/features/game/GameSession.tsx';
import { getResult, type StoredResult } from '../src/lib/storage.ts';

// The flag is a build-time constant; here it is a live binding so one file can run both UIs.
const flag = vi.hoisted(() => ({ on: true }));
vi.mock('../src/daily-drive/flag.ts', () => ({
  get DAILY_DRIVE() {
    return flag.on;
  },
}));

// ---- pixel engine mock (the real one needs <canvas>) ----
type FakeMap = {
  attract: boolean;
  drive: ReturnType<typeof vi.fn>;
  setMark: ReturnType<typeof vi.fn>;
  jump: ReturnType<typeof vi.fn>;
  setTurbo: ReturnType<typeof vi.fn>;
  layout: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
let maps: FakeMap[] = [];
function fakeEngine(): Engine {
  class FakeDriveMap {
    attract: boolean;
    drive = vi.fn((_k: number, _wrong: boolean, done?: () => void) => done?.());
    setMark = vi.fn();
    jump = vi.fn();
    setTurbo = vi.fn();
    layout = vi.fn();
    destroy = vi.fn();
    reset = vi.fn();
    marks = [];
    constructor(_el: HTMLElement, attract = false) {
      this.attract = attract;
      maps.push(this as unknown as FakeMap);
    }
  }
  const spr = (s: string) => [`data:image/png;base64,${s}0`, `data:image/png;base64,${s}1`];
  return {
    DriveMap: FakeDriveMap,
    SPR: { idle: spr('i'), correct: spr('c'), wrong: spr('w'), streak: spr('s'), nervous: spr('n'), perfect: spr('p'), low: spr('l') },
    drawArt: vi.fn(),
    setReducedMotion: vi.fn(),
  } as unknown as Engine;
}

beforeEach(() => {
  maps = [];
  flag.on = true;
  provideEngine(fakeEngine());
});
afterEach(() => {
  provideEngine(null);
  vi.unstubAllGlobals();
  document.body.classList.remove('rm');
});

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

// ---- a 5-question round against a mocked API ----
const TRUTH = ['florida', 'gta', 'florida', 'gta', 'florida'] as const;
const challenge: ChallengeResponse = {
  challengeId: '2026-11-19',
  date: '2026-11-19',
  number: 7,
  today: '2026-11-19',
  timeLimitSeconds: 60,
  sample: false,
  questions: TRUTH.map((_, i) => ({ id: `h${i + 1}`, headline: `Headline number ${i + 1}` })),
};

function mockApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const truth = (id: string) => TRUTH[Number(id.slice(1)) - 1]!;
    if (url.endsWith('/answer')) {
      const answer = truth(body.questionId);
      return json({
        questionId: body.questionId,
        choice: body.choice,
        correct: body.choice === answer,
        question: {
          id: body.questionId,
          headline: `Headline number ${body.questionId.slice(1)}`,
          answer,
          explanation: `Explanation for ${body.questionId}.`,
          placeholder: false,
          ...(answer === 'florida'
            ? { sourceUrl: 'https://news.example/a', sourceName: 'Example News', sourceCta: 'Read full article', originalTitle: 'Exact Example Headline' }
            : { gtaSubtype: 'gta_lore', game: 'GTA III', sourceUrl: 'https://wiki.example/b', sourceName: 'Grand Theft Wiki', sourceCta: 'View GTA source' }),
        },
      });
    }
    if (url.endsWith('/finish')) {
      const cells = body.answers.map((a: { questionId: string; choice: string | null }) => (a.choice === null ? null : a.choice === truth(a.questionId)));
      return json({ challengeId: challenge.challengeId, date: challenge.date, number: challenge.number, score: cells.filter((c: ResultCell) => c === true).length, total: 5, cells, questions: [] });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Daily Drive: score → ending', () => {
  it('maps every score to the README bands', () => {
    expect([5, 4, 3, 2, 1, 0].map(endingFor)).toEqual(['vice', 'veteran', 'tourist', 'glades', 'fman', 'fman']);
    expect(endingOf(5).title).toBe('VICE LEGEND');
    expect(endingOf(4).title).toBe('FLORIDA VETERAN');
    expect(endingOf(3).title).toBe('TOURIST WITH POTENTIAL');
    expect(endingOf(2).title).toBe('LOST IN THE EVERGLADES');
    expect(endingOf(0).title).toBe('CERTIFIED FLORIDA MAN');
  });

  it('derives the in-round streak and checkpoint states from the answers only', () => {
    const a = (...c: boolean[]) => c.map((correct) => ({ correct }));
    expect(trailingStreak(a())).toBe(0);
    expect(trailingStreak(a(true, false, true, true, true))).toBe(3);
    expect(trailingStreak(a(true, true, false))).toBe(0);
    expect(checkpointStates(a(true, false), 2, 5, false)).toEqual(['ok', 'bad', 'now', 'todo', 'todo']);
    expect(checkpointStates(a(true, false), 2, 5, true)).toEqual(['ok', 'bad', 'skip', 'skip', 'skip']);
  });
});

describe('Daily Drive: keyboard', () => {
  const ev = (key: string, target: Element | null = document.body, mods: Partial<KeyboardEvent> = {}) => ({
    key,
    target,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it('G / F only in the question phase; Enter / N / → only in the reveal', () => {
    expect(keyAction(ev('g'), 'question', false)).toBe('gta');
    expect(keyAction(ev('F'), 'question', false)).toBe('florida');
    expect(keyAction(ev('n'), 'question', false)).toBeNull();
    expect(keyAction(ev('g'), 'reveal', false)).toBeNull();
    for (const k of ['Enter', 'n', 'ArrowRight']) expect(keyAction(ev(k), 'reveal', false)).toBe('next');
    expect(keyAction(ev('g'), 'other', false)).toBeNull();
  });

  it('ignores keys while busy, with a modifier, or while typing', () => {
    expect(keyAction(ev('g'), 'question', true)).toBeNull();
    for (const m of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) expect(keyAction(ev('g', document.body, { [m]: true }), 'question', false)).toBeNull();
    for (const tag of ['input', 'textarea', 'select']) expect(keyAction(ev('f', document.createElement(tag)), 'question', false)).toBeNull();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    expect(keyAction(ev('n', editable), 'reveal', false)).toBeNull();
  });

  it('leaves Enter on links and buttons to the browser, but N / → still advance from a focused button', () => {
    const button = document.createElement('button');
    expect(keyAction(ev('Enter', button), 'reveal', false)).toBeNull();
    expect(keyAction(ev('Enter', document.createElement('a')), 'reveal', false)).toBeNull();
    expect(keyAction(ev('n', button), 'reveal', false)).toBe('next');
    expect(keyAction(ev('ArrowRight', button), 'reveal', false)).toBe('next');
  });
});

describe('Daily Drive: <DriveMap>', () => {
  it('drives one checkpoint per new result, rebuilds without animation on mount, and destroys on unmount', () => {
    const { rerender, unmount } = render(<DriveMap marks={[]} label="Route map" />);
    expect(maps).toHaveLength(1);
    const m = maps[0]!;
    expect(m.layout).toHaveBeenCalled();
    expect(m.drive).not.toHaveBeenCalled();

    rerender(<DriveMap marks={['ok']} label="Route map" />);
    expect(m.drive).toHaveBeenLastCalledWith(1, false, expect.any(Function));
    expect(m.setMark).toHaveBeenLastCalledWith(1, 'ok'); // set on arrival (the mock arrives at once)

    rerender(<DriveMap marks={['ok', 'bad']} label="Route map" />);
    expect(m.drive).toHaveBeenLastCalledWith(2, true, expect.any(Function));
    expect(m.setMark).toHaveBeenLastCalledWith(2, 'bad');
    expect(m.drive).toHaveBeenCalledTimes(2);

    rerender(<DriveMap marks={['ok', 'bad']} turbo label="Route map" />);
    expect(m.drive).toHaveBeenCalledTimes(2);
    expect(m.setTurbo).toHaveBeenLastCalledWith(true);

    unmount();
    expect(m.destroy).toHaveBeenCalledTimes(1);
  });

  it('resumes a round in progress without animating', () => {
    render(<DriveMap marks={['ok', 'bad', 'ok']} label="Route map" />);
    const m = maps[0]!;
    expect(m.drive).not.toHaveBeenCalled();
    expect(m.setMark.mock.calls).toEqual([
      [1, 'ok'],
      [2, 'bad'],
      [3, 'ok'],
      [4, ''],
      [5, ''],
    ]);
    expect(m.jump).toHaveBeenCalledWith(3);
  });

  it('renders a still placeholder when the engine is unavailable', () => {
    provideEngine(null);
    render(<DriveMap marks={['ok']} label="Route map" />);
    expect(screen.getByRole('img', { name: 'Route map' })).toBeInTheDocument();
    expect(maps).toHaveLength(0);
  });
});

/** Plays the same choices with either UI and returns the saved result. */
async function playRound(choices: readonly ('gta' | 'florida')[], useKeys: boolean) {
  mockApi();
  const user = userEvent.setup();
  let completed: StoredResult | null = null;
  const view = withProviders(<GameSession challenge={challenge} practice={false} onComplete={(r) => (completed = r)} />);
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i]!;
    await screen.findByRole('heading', { name: `Headline number ${i + 1}` });
    if (useKeys) await user.keyboard(c === 'gta' ? 'g' : 'f');
    else await user.click(screen.getByRole('button', { name: c === 'gta' ? /^GTA/ : /^FLORIDA/ }));
    const right = c === TRUTH[i];
    if (flag.on) await screen.findByRole('heading', { name: right ? 'CORRECT!' : 'WRONG WAY!' });
    else await screen.findByRole('heading', { name: right ? 'Correct!' : 'Not quite.' });
    if (useKeys && flag.on) await user.keyboard(i % 2 ? 'n' : '{ArrowRight}');
    else await user.click(screen.getByRole('button', { name: flag.on ? /NEXT HEADLINE|SEE MY POSTCARD/ : /Next headline|See my results/ }));
  }
  await waitFor(() => expect(completed).not.toBeNull());
  view.unmount();
  return completed!;
}

describe('Daily Drive: a full round through the existing game logic', () => {
  const CHOICES = ['florida', 'gta', 'florida', 'florida', 'florida'] as const; // 4 of 5 right, 3-in-a-row streak first

  it('plays with the mouse: verdicts, paused timer, map drives, streak banner, same saved result', async () => {
    mockApi();
    const user = userEvent.setup();
    let completed: StoredResult | null = null;
    withProviders(<GameSession challenge={challenge} practice={false} onComplete={(r) => (completed = r)} />);

    expect(await screen.findByRole('timer')).toHaveAccessibleName('60 seconds left');
    expect(screen.getByText('Welcome to Florida')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^FLORIDA/ }));
    expect(await screen.findByRole('heading', { name: 'CORRECT!' })).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveAccessibleName(/paused/);
    expect(screen.getByRole('link', { name: /Read full article/ })).toHaveAttribute('href', 'https://news.example/a');
    expect(screen.getByText('Exact Example Headline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /NEXT HEADLINE/ })).toHaveFocus();
    const map = maps.find((m) => !m.attract)!;
    expect(map.drive).toHaveBeenLastCalledWith(1, false, expect.any(Function));

    await user.click(screen.getByRole('button', { name: /NEXT HEADLINE/ }));
    expect(screen.getByText('Ocean Drive')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Headline number 2' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: /^FLORIDA/ }));
    expect(await screen.findByRole('heading', { name: 'WRONG WAY!' })).toBeInTheDocument();
    expect(screen.getByText(/A documented event from the games \(GTA III\)/)).toBeInTheDocument();
    expect(map.drive).toHaveBeenLastCalledWith(2, true, expect.any(Function));
    expect(screen.getByText('Checkpoint 2, Ocean Drive: wrong, detour')).toBeInTheDocument();

    for (const i of [2, 3, 4]) {
      await user.click(screen.getByRole('button', { name: /NEXT HEADLINE/ }));
      await user.click(await screen.findByRole('button', { name: i === 3 ? /^GTA/ : /^FLORIDA/ }));
      await screen.findByRole('heading', { name: 'CORRECT!' });
    }
    expect(map.setTurbo).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('TURBO STREAK ×3!')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /SEE MY POSTCARD/ }));
    await waitFor(() => expect(completed).not.toBeNull());
    expect(completed!).toMatchObject({ score: 4, total: 5, cells: [true, false, true, true, true] });
    expect(getResult('2026-11-19')?.score).toBe(4);
  });

  it('gives the same saved result with the flag on (keyboard) and off (legacy UI)', async () => {
    flag.on = true;
    const on = await playRound(CHOICES, true);
    localStorage.clear();
    flag.on = false;
    const off = await playRound(CHOICES, false);
    const strip = (r: StoredResult) => ({ ...r, completedAt: '', seconds: 0 });
    expect(strip(on)).toEqual(strip(off));
    expect(on.score).toBe(4);
  });

  it('time’s up: unanswered checkpoints are marked unanswered and the existing "see results" step remains', async () => {
    mockApi();
    localStorage.setItem(
      'gof:v1:progress:2026-11-19',
      JSON.stringify({
        date: '2026-11-19',
        questionIds: challenge.questions.map((q) => q.id),
        mode: 'daily',
        index: 1,
        phase: 'question',
        elapsedMs: 60_000,
        answers: [{ questionId: 'h1', choice: 'florida', correct: true, question: { id: 'h1', headline: 'Headline number 1', answer: 'florida', explanation: 'x', placeholder: false } }],
        updatedAt: new Date().toISOString(),
      }),
    );
    const user = userEvent.setup();
    let completed: StoredResult | null = null;
    withProviders(<GameSession challenge={challenge} practice={false} onComplete={(r) => (completed = r)} />);
    expect(await screen.findByRole('heading', { name: "TIME'S UP!" })).toHaveFocus();
    expect(screen.getByText('Checkpoint 2, Ocean Drive: unanswered')).toBeInTheDocument();
    expect(maps.find((m) => !m.attract)!.drive).not.toHaveBeenCalled(); // resumed: no animation
    await user.click(screen.getByRole('button', { name: /SEE MY POSTCARD/ }));
    await waitFor(() => expect(completed).not.toBeNull());
    expect(completed!).toMatchObject({ score: 1, cells: [true, null, null, null, null], timedOut: true });
  });
});

describe('Daily Drive: results', () => {
  const result: StoredResult = {
    date: '2026-11-19',
    number: 7,
    mode: 'daily',
    score: 4,
    total: 5,
    cells: [true, false, true, true, true],
    choices: ['florida', 'florida', 'florida', 'gta', 'florida'],
    seconds: 41,
    timedOut: false,
    completedAt: '2026-11-19T10:00:00Z',
    sample: false,
    questions: TRUTH.map((answer, i) => ({ id: `h${i + 1}`, headline: `Headline number ${i + 1}`, answer, explanation: `Why ${i + 1}`, placeholder: false })),
  };

  it('shows the ending title for the level reached and keeps the existing share text', async () => {
    document.body.classList.add('rm'); // score and postcard appear at once
    withProviders(<DriveResults result={result} />);
    expect(await screen.findByRole('heading', { name: 'FLORIDA VETERAN' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Share text/ })).toHaveValue(
      buildShareText({ date: result.date, cells: result.cells, seconds: result.seconds, url: window.location.origin }),
    );
    expect(screen.getByRole('list', { name: 'Answer history' })).toHaveTextContent(/Headline 2: wrong/);
    expect(screen.getByText('41s')).toBeInTheDocument();
  });

  it('counts the score up before the postcard enters', async () => {
    vi.useFakeTimers();
    try {
      withProviders(<DriveResults result={{ ...result, score: 2, cells: [true, true, false, false, false] }} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByRole('article', { name: 'Results postcard', hidden: true })).toHaveAttribute('data-hidden');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 220 + 260);
      });
      expect(screen.getByRole('article', { name: 'Results postcard' })).not.toHaveAttribute('data-hidden');
      expect(screen.getByRole('heading', { name: 'LOST IN THE EVERGLADES' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
