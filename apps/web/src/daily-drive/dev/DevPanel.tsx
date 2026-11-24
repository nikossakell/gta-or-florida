/**
 * Daily Drive preview tools (port of the prototype's DEV PANEL). Development builds only: boot.ts
 * imports this file under `import.meta.env.DEV`, so it and the sample data never reach production.
 *
 * It drives the presentational screens with fake props. Its round runs the real (pure) sessionReducer
 * on local state with sample questions; it never touches the app's stored progress, results or API.
 */
import { utcDate, type Answer, type ChallengeResponse, type RevealedQuestion, type ResultCell } from '@gof/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createContext, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { sessionReducer, type SessionState } from '../../features/game/session.ts';
import type { AnswerRecord, StoredResult } from '../../lib/storage.ts';
import { HudTimer } from '../components/HudTimer.tsx';
import { Gus } from '../components/Gus.tsx';
import { Shape } from '../components/Shape.tsx';
import type { MascotState } from '../engine/pixel-engine.js';
import { COPY } from '../lib/copy.ts';
import { DriveLanding } from '../screens/DriveLanding.tsx';
import { DriveResults } from '../screens/DriveResults.tsx';
import { DriveSession } from '../screens/DriveSession.tsx';
import sample from './sample-questions.json';

const STATES: MascotState[] = ['idle', 'correct', 'wrong', 'streak', 'nervous', 'perfect', 'low'];
const LIMIT_MS = 60_000;
const TODAY = utcDate();

const QS: RevealedQuestion[] = sample.questions.map((q, i) => ({
  id: `h${i + 1}`,
  headline: q.headline,
  answer: q.answer as Answer,
  explanation: q.explanation,
  placeholder: true,
  ...(q.answer === 'gta' ? { gtaSubtype: 'fiction' as const } : {}),
}));

const CHALLENGE: ChallengeResponse = {
  challengeId: 'dev-preview',
  date: TODAY,
  number: 147,
  today: TODAY,
  timeLimitSeconds: 60,
  sample: true,
  questions: QS.map((q) => ({ id: q.id, headline: q.headline })),
};

const record = (i: number, correct: boolean): AnswerRecord => {
  const q = QS[i]!;
  return { questionId: q.id, choice: correct ? q.answer : q.answer === 'gta' ? 'florida' : 'gta', correct, question: q };
};

const atQuestion = (n: number, correctBefore = n - 1): SessionState => ({
  index: n - 1,
  phase: 'question',
  answers: Array.from({ length: n - 1 }, (_, i) => record(i, i < correctBefore)),
  elapsedMs: Math.min(LIMIT_MS - 12_000, (n - 1) * 9_000),
  answerError: null,
  finishError: null,
  finishFrom: null,
});

function fakeResult(score: number, timedOut = false): StoredResult {
  const cells: ResultCell[] = QS.map((_, i) => (timedOut && i >= 3 ? null : i < score));
  return {
    date: TODAY,
    number: 147,
    mode: 'daily',
    score,
    total: 5,
    cells,
    choices: QS.map((q, i) => (cells[i] === null ? null : cells[i] ? q.answer : q.answer === 'gta' ? 'florida' : 'gta')),
    seconds: timedOut ? 60 : 42,
    timedOut,
    completedAt: new Date().toISOString(),
    sample: true,
    questions: QS,
  };
}

type View = { kind: 'off' } | { kind: 'landing' } | { kind: 'play' } | { kind: 'results'; score: number; replay: number } | { kind: 'gallery' };

type Ctrl = {
  view: View;
  session: SessionState;
  dispatch: (a: Parameters<typeof sessionReducer>[1] | { type: 'set'; state: SessionState }) => void;
  setView: (v: View) => void;
  frozen: boolean;
};
const DevCtx = createContext<Ctrl | null>(null);

function devReducer(state: SessionState, action: Parameters<typeof sessionReducer>[1] | { type: 'set'; state: SessionState }): SessionState {
  return action.type === 'set' ? action.state : sessionReducer(state, action);
}

export function DevPanel() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: 'off' });
  const [session, dispatch] = useReducer(devReducer, atQuestion(1));
  const [frozen, setFrozen] = useState(false);
  const [rm, setRm] = useState(false);

  useEffect(() => {
    document.body.classList.toggle('rm', rm);
  }, [rm]);

  // Fake clock with the same rule as the game: it only runs while a question is waiting.
  useEffect(() => {
    if (view.kind !== 'play' || frozen || session.phase !== 'question') return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      dispatch({ type: 'tick', deltaMs: now - last, limitMs: LIMIT_MS });
      last = now;
    }, 200);
    return () => window.clearInterval(id);
  }, [view.kind, frozen, session.phase]);

  const play = (state: SessionState) => {
    dispatch({ type: 'set', state });
    setView({ kind: 'play' });
  };
  const reveal = (correct: boolean, base?: SessionState) => {
    const s = base ?? (view.kind === 'play' && session.phase === 'question' ? session : atQuestion(Math.min(session.index + 1, 5)));
    // Show the question first, then answer it, so the screen reacts as it would in a real round
    // (a screen that mounts with the answer already in place treats it as a resumed round and stays quiet).
    dispatch({ type: 'set', state: s });
    setView({ kind: 'play' });
    window.setTimeout(() => {
      dispatch({ type: 'choose' });
      dispatch({ type: 'answered', record: record(s.index, correct) });
    }, 120);
  };

  const ctrl: Ctrl = { view, session, dispatch, setView, frozen };
  const btn = (label: string, onClick: () => void, pressed?: boolean) => (
    <button key={label} type="button" onClick={onClick} aria-pressed={pressed}>
      {label}
    </button>
  );

  return (
    <DevCtx.Provider value={ctrl}>
      {view.kind !== 'off' && <Preview />}
      <button type="button" className="devtab" aria-expanded={open} aria-controls="dd-dev-panel" onClick={() => setOpen(!open)}>
        DEV PANEL
      </button>
      <aside className="dev" id="dd-dev-panel" hidden={!open} aria-label="Daily Drive preview panel">
        <header>
          <h2>PREVIEW TOOLS</h2>
          <button type="button" className="btn2" onClick={() => setOpen(false)}>
            Close
          </button>
        </header>
        <p>Development only. Fake props and sample data; the real round, storage and API are untouched.</p>
        <h3>SCREENS</h3>
        <div className="row">
          {btn('Back to app', () => setView({ kind: 'off' }))}
          {btn('Landing', () => setView({ kind: 'landing' }))}
          {[1, 2, 3, 4, 5].map((n) => btn(`Q${n}`, () => play(atQuestion(n))))}
          {btn('Reveal ✓', () => reveal(true))}
          {btn('Reveal ✕', () => reveal(false))}
          {btn('Gallery', () => setView({ kind: 'gallery' }))}
        </div>
        <h3>ENDINGS</h3>
        <div className="row">
          {[5, 4, 3, 2, 1, 0].map((s) => btn(`${s}/5`, () => setView({ kind: 'results', score: s, replay: Date.now() })))}
        </div>
        <h3>ROUTE AND CHECKPOINTS</h3>
        <div className="row">
          {btn('Drive on ✓', () => reveal(true))}
          {btn('Detour ✕', () => reveal(false))}
          {btn('Next', () => (session.index + 1 >= 5 ? setView({ kind: 'results', score: session.answers.filter((a) => a.correct).length, replay: Date.now() }) : dispatch({ type: 'next' })))}
          {btn('Reset route', () => play(atQuestion(1)))}
          {btn('Resume at Q4 (no anim)', () => play(atQuestion(4, 1)))}
        </div>
        <h3>EFFECTS</h3>
        <div className="row">
          {btn('3× streak', () => reveal(true, atQuestion(3)))}
          {btn('Timer to 9s', () => play({ ...atQuestion(Math.min(session.index + 1, 5)), elapsedMs: LIMIT_MS - 9_000 }))}
          {btn("Time's up", () => {
            play({ ...atQuestion(4, 2), elapsedMs: LIMIT_MS - 300 });
          })}
          {btn('Replay score reveal', () => setView({ kind: 'results', score: view.kind === 'results' ? view.score : 4, replay: Date.now() }))}
        </div>
        <h3>TOGGLES</h3>
        <div className="row">
          {btn('Simulate reduced motion', () => setRm(!rm), rm)}
          {btn('Freeze timer', () => setFrozen(!frozen), frozen)}
        </div>
      </aside>
    </DevCtx.Provider>
  );
}

function Preview() {
  const ctrl = useContext(DevCtx)!;
  // Seeded cache + memory history: the landing preview never fetches, links never leave the preview.
  const [{ router, queryClient }] = useState(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(['challenge', 'today', TODAY], CHALLENGE);
    const root = createRootRoute({ component: PreviewScreen, notFoundComponent: PreviewScreen });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
    return { router, queryClient };
  });
  return (
    <div className="dev-preview">
      <DevCtx.Provider value={ctrl}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </DevCtx.Provider>
      <span className="dev-flag">PREVIEW · SAMPLE DATA</span>
    </div>
  );
}

function PreviewScreen() {
  const { view, session, dispatch, setView } = useContext(DevCtx)!;
  const results = useMemo(() => (view.kind === 'results' ? fakeResult(view.score) : null), [view]);
  if (view.kind === 'landing') return <DriveLanding />;
  if (view.kind === 'gallery') return <Gallery />;
  if (results && view.kind === 'results') return <DriveResults key={view.replay} result={results} replay={view.replay} />;
  if (view.kind !== 'play') return null;
  const remainingMs = Math.max(0, LIMIT_MS - session.elapsedMs);
  const finishToResults = () => setView({ kind: 'results', score: session.answers.filter((a) => a.correct).length, replay: Date.now() });
  return (
    <DriveSession
      label="DAILY DRIVE"
      number={147}
      questions={CHALLENGE.questions}
      state={session}
      remainingMs={remainingMs}
      limitMs={LIMIT_MS}
      onChoose={(choice) => {
        dispatch({ type: 'choose' });
        const q = QS[session.index]!;
        window.setTimeout(() => dispatch({ type: 'answered', record: { questionId: q.id, choice, correct: choice === q.answer, question: q } }), 250);
      }}
      onNext={() => (session.index + 1 >= 5 ? finishToResults() : dispatch({ type: 'next' }))}
      onFinish={finishToResults}
    />
  );
}

function Gallery(): ReactNode {
  return (
    <div className="wrap wide">
      <h2 className="pc-title">MASCOT STATES</h2>
      <div className="gallery">
        {STATES.map((s) => (
          <figure key={s}>
            <Gus state={s} size="lg" />
            <div className="bubble sm">{COPY.mascotLines[s][0]}</div>
            <figcaption>{s}</figcaption>
          </figure>
        ))}
      </div>
      <h2 className="pc-title">CHECKPOINTS AND TIMER</h2>
      <div className="gallery">
        {(['todo', 'now', 'ok', 'bad'] as const).map((s) => (
          <figure key={s}>
            <Shape state={s} />
            <figcaption>{s}</figcaption>
          </figure>
        ))}
        <figure>
          <HudTimer remainingMs={42_000} limitMs={LIMIT_MS} paused={false} />
          <figcaption>running</figcaption>
        </figure>
        <figure>
          <HudTimer remainingMs={7_000} limitMs={LIMIT_MS} paused={false} />
          <figcaption>under 10s</figcaption>
        </figure>
        <figure>
          <HudTimer remainingMs={31_000} limitMs={LIMIT_MS} paused />
          <figcaption>paused</figcaption>
        </figure>
      </div>
    </div>
  );
}
