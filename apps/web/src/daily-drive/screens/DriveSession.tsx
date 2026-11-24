import type { Answer, PublicQuestion } from '@gof/core';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { SessionState } from '../../features/game/session.ts';
import { ArcadeButton } from '../components/ArcadeButton.tsx';
import { Banner } from '../components/Banner.tsx';
import { Burst, type BurstAt } from '../components/Burst.tsx';
import { CheckpointRoute, checkpointStates } from '../components/CheckpointRoute.tsx';
import { DriveMap, type MapMark } from '../components/DriveMap.tsx';
import { Gus, useMascotLine } from '../components/Gus.tsx';
import { HudTimer } from '../components/HudTimer.tsx';
import { RevealPanel } from '../components/RevealPanel.tsx';
import { QuitIcon } from '../components/Shape.tsx';
import type { MascotState } from '../engine/pixel-engine.js';
import { COPY, zoneFor } from '../lib/copy.ts';
import { useDriveKeys } from '../lib/keys.ts';
import { useReducedMotion } from '../lib/motion.ts';
import { STREAK_BANNER_AT, trailingStreak } from '../lib/streak.ts';
import { useAnnouncer } from '../lib/useAnnouncer.ts';

const REACTION_MS = 2400;

export type DriveSessionProps = {
  /** "DAILY DRIVE", "ARCHIVE" or "REPLAY". */
  label: string;
  number: number;
  questions: readonly PublicQuestion[];
  /** The existing session state (features/game/session.ts). Read only. */
  state: Pick<SessionState, 'index' | 'phase' | 'answers' | 'answerError' | 'finishError' | 'finishFrom'>;
  remainingMs: number;
  limitMs: number;
  onChoose: (choice: Answer) => void;
  onNext: () => void;
  onFinish: () => void;
};

/**
 * Daily Drive play screen. Presentational: every reaction is driven by the existing session state
 * (index, phase, answers, time left). It never computes the answer; it only reacts to results that
 * the API already returned.
 */
export function DriveSession({ label, number, questions, state, remainingMs, limitMs, onChoose, onNext, onFinish }: DriveSessionProps) {
  const { index, phase, answers } = state;
  const total = questions.length;
  const question = questions[index];
  const lastAnswer = answers[index];
  const timed = limitMs > 0;
  const seconds = Math.ceil(remainingMs / 1000);
  const showTimeUp = phase === 'timeup' || (phase === 'finishing' && state.finishFrom === 'timeup');
  const showReveal = (phase === 'reveal' || (phase === 'finishing' && state.finishFrom === 'reveal')) && Boolean(lastAnswer);
  const answering = phase === 'answering';
  const finishing = phase === 'finishing';
  const rm = useReducedMotion();
  const streak = trailingStreak(answers);
  const { message, announce } = useAnnouncer();

  // ---- reactions to new results (in this session only; a resumed round starts quiet) ----
  const [reaction, setReaction] = useState<MascotState | null>(null);
  const [streakToken, setStreakToken] = useState<number | null>(null);
  const [timeUpToken, setTimeUpToken] = useState<number | null>(null);
  const [burst, setBurst] = useState<BurstAt | null>(null);
  const [cardFx, setCardFx] = useState<'' | 'shake' | 'flash'>('');
  const buttons = useRef<Record<Answer, HTMLButtonElement | null>>({ gta: null, florida: null });
  const picked = useRef<Answer | null>(null);
  const seen = useRef({ answers: answers.length, timeUp: showTimeUp });

  useEffect(() => {
    if (answers.length <= seen.current.answers) {
      seen.current.answers = answers.length;
      return;
    }
    seen.current.answers = answers.length;
    const a = answers[answers.length - 1]!;
    const hitStreak = a.correct && streak === STREAK_BANNER_AT;
    setReaction(hitStreak ? 'streak' : a.correct ? 'correct' : 'wrong');
    announce(`${a.correct ? 'Correct.' : 'Wrong.'} It was ${a.question.answer === 'gta' ? 'GTA' : 'Florida'}.${hitStreak ? ' Three in a row. Turbo streak!' : ''}`);
    if (hitStreak) setStreakToken(Date.now());
    if (a.correct) {
      const btn = picked.current ? buttons.current[picked.current] : null;
      const r = btn?.getBoundingClientRect();
      if (r && !rm) setBurst({ x: r.left + r.width / 2, y: r.top + r.height / 2, color: a.choice === 'gta' ? '#FF5FA2' : '#2DE2C8', id: Date.now() });
    } else {
      setCardFx(rm ? 'flash' : 'shake');
    }
    const id = window.setTimeout(() => setReaction(null), REACTION_MS);
    const fx = window.setTimeout(() => setCardFx(''), 420);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(fx);
    };
    // Only a change in the number of answers is a new result.
  }, [answers.length]);

  useEffect(() => {
    if (showTimeUp && !seen.current.timeUp) {
      setTimeUpToken(Date.now());
      announce('Time’s up');
    }
    seen.current.timeUp = showTimeUp;
  }, [showTimeUp, announce]);

  // ---- mascot ----
  const base: MascotState = timed && phase === 'question' && seconds <= 10 ? 'nervous' : 'idle';
  const mood = reaction ?? base;
  const line = useMascotLine(mood);

  // ---- focus (same targets as the legacy views, except Next, which RevealPanel focuses) ----
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (phase === 'question') headingRef.current?.focus({ preventScroll: true });
  }, [question?.id]);

  const choose = (choice: Answer) => {
    if (phase !== 'question') return;
    picked.current = choice;
    onChoose(choice);
  };
  const next = () => {
    if (phase === 'reveal') onNext();
  };
  useDriveKeys(phase === 'question' ? 'question' : phase === 'reveal' && showReveal ? 'reveal' : 'other', answering || finishing, choose, next);

  const marks: MapMark[] = answers.map((a) => (a.correct ? 'ok' : 'bad'));
  const zone = zoneFor(index);
  const right = answers.filter((a) => a.correct).length;

  return (
    <div className="play">
      <div className="wrap">
        <header className="hud">
          <Link to="/" className="iconbtn" aria-label="Quit to home (progress is saved)" title="Quit to home (progress is saved)">
            <QuitIcon />
          </Link>
          <div className="hud-mid">
            <div className="t1">
              {label} #{number}
            </div>
            <div className="t2">{showTimeUp ? COPY.verdicts.timeUp : zone.n}</div>
          </div>
          {timed && <HudTimer remainingMs={remainingMs} limitMs={limitMs} paused={phase !== 'question'} timedOut={showTimeUp} />}
        </header>
        <p className="sr" aria-live="polite">
          Headline {Math.min(index + 1, total)} of {total}
        </p>

        <DriveMap marks={marks} turbo={streak >= STREAK_BANNER_AT} label={`Route map: ${answers.length} of ${total} checkpoints reached`} />
        <CheckpointRoute states={checkpointStates(answers, index, total, showTimeUp)} />

        <main className="stage">
          {question && (
            <article key={question.id} className={`card panel in${cardFx ? ` ${cardFx}` : ''}`} aria-labelledby={`q-${question.id}`}>
              <div className="meta">
                <span className="qlabel">
                  HEADLINE <b>{index + 1}</b> / {total}
                </span>
                <div className="buddy">
                  <div className="bubble sm" aria-hidden="true">
                    {line}
                  </div>
                  <Gus state={mood} />
                </div>
              </div>
              <h1 id={`q-${question.id}`} ref={headingRef} tabIndex={-1} className="headline">
                {question.headline}
              </h1>
            </article>
          )}

          {showTimeUp ? (
            <TimeUpPanel answered={answers.length} right={right} total={total} busy={finishing} error={state.finishError} onFinish={onFinish} />
          ) : showReveal && lastAnswer ? (
            <RevealPanel record={lastAnswer} isLast={index + 1 >= total} busy={finishing} error={state.finishError} onNext={onNext} />
          ) : (
            <div className="answers" role="group" aria-label="Your answer">
              <ArcadeButton
                ref={(el) => void (buttons.current.gta = el)}
                variant="gta"
                disabled={answering}
                onClick={() => choose('gta')}
                aria-keyshortcuts="G"
                big="GTA"
                hint={
                  <>
                    <kbd>G</kbd> game event
                  </>
                }
              />
              <ArcadeButton
                ref={(el) => void (buttons.current.florida = el)}
                variant="florida"
                disabled={answering}
                onClick={() => choose('florida')}
                aria-keyshortcuts="F"
                big="FLORIDA"
                hint={
                  <>
                    <kbd>F</kbd> real news
                  </>
                }
              />
              <div className="hint" aria-live="polite">
                {answering ? (
                  'Checking…'
                ) : state.answerError ? (
                  <span className="meta-status err" role="alert">
                    {state.answerError}
                  </span>
                ) : timed ? (
                  'The clock pauses while each answer is revealed. Keys: G / F.'
                ) : (
                  'Take your time. Keys: G / F.'
                )}
              </div>
            </div>
          )}
        </main>
      </div>
      <p className="sr" aria-live="polite">
        {message}
      </p>
      <Banner text={COPY.verdicts.streakBanner} token={streakToken} />
      <Banner text={COPY.verdicts.timeUp} token={timeUpToken} tone="timeup" />
      <Burst at={burst} />
    </div>
  );
}

function TimeUpPanel({ answered, right, total, busy, error, onFinish }: { answered: number; right: number; total: number; busy: boolean; error: string | null; onFinish: () => void }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <section className="timeup-panel panel" aria-labelledby="timeup-title">
      <h2 id="timeup-title" ref={ref} tabIndex={-1}>
        {COPY.verdicts.timeUp}
      </h2>
      <p>
        You answered {answered} of {total} headlines and got {right} right before the clock hit zero. Unanswered headlines count as misses.
      </p>
      <ArcadeButton variant="primary" onClick={onFinish} disabled={busy} big={busy ? 'SCORING…' : COPY.verdicts.last} />
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
