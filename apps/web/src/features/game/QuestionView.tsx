import type { Answer, PublicQuestion } from '@gof/core';
import { useEffect, useRef } from 'react';
import { JoystickIcon, PalmIcon } from '../../components/Icons.tsx';

export function QuestionView({
  question,
  onChoose,
  busy,
  error,
  timed,
}: {
  question: PublicQuestion;
  onChoose: (choice: Answer) => void;
  busy: boolean;
  error: string | null;
  timed: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to each new headline so screen readers read it.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [question.id]);

  // Keyboard shortcuts: G = GTA, F = Florida.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (busy || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'g') onChoose('gta');
      if (key === 'f') onChoose('florida');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onChoose]);

  const choiceBase =
    'group flex min-h-40 flex-col items-center justify-center gap-1 rounded-[1.75rem] border-[3px] border-ink px-3 py-5 text-ink transition-transform duration-100 active:translate-y-1 disabled:opacity-70 disabled:active:translate-y-0 sm:min-h-44';

  return (
    <div className="animate-pop">
      <section className="card mt-7 p-7 sm:p-8" aria-labelledby={`q-${question.id}`}>
        <p className="label-wide text-dim text-xs sm:text-sm">Real report or game scenario?</p>
        <h1
          id={`q-${question.id}`}
          ref={headingRef}
          tabIndex={-1}
          className="mt-4 text-[1.7rem] leading-tight font-bold text-balance focus:outline-none sm:text-[2rem]"
        >
          {question.headline}
        </h1>
        <p className="text-muted mt-5">{timed ? 'Trust your gut. The clock is running.' : 'Trust your gut.'}</p>
      </section>

      <div className="mt-7 grid grid-cols-2 gap-4" role="group" aria-label="Your answer">
        <button
          type="button"
          disabled={busy}
          onClick={() => onChoose('gta')}
          aria-keyshortcuts="G"
          className={`${choiceBase} bg-pink shadow-[0_8px_0_var(--color-pink-deep)] active:shadow-[0_4px_0_var(--color-pink-deep)]`}
        >
          <JoystickIcon size={34} />
          <span className="btn-wide text-3xl sm:text-4xl">GTA</span>
          <span className="font-semibold">Fictional scenario</span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onChoose('florida')}
          aria-keyshortcuts="F"
          className={`${choiceBase} bg-teal shadow-[0_8px_0_var(--color-teal-deep)] active:shadow-[0_4px_0_var(--color-teal-deep)]`}
        >
          <PalmIcon size={34} />
          <span className="btn-wide text-2xl sm:text-[2rem]">FLORIDA</span>
          <span className="font-semibold">Real report</span>
        </button>
      </div>

      <div className="mt-6 min-h-6 text-center" aria-live="polite">
        {busy ? (
          <p className="text-muted">Checking…</p>
        ) : error ? (
          <p className="text-ember font-semibold" role="alert">
            {error}
          </p>
        ) : (
          <p className="text-dim">
            {timed ? 'The clock pauses while each answer is revealed.' : 'Take your time.'}{' '}
            <span className="hidden sm:inline">Keys: G / F.</span>
          </p>
        )}
      </div>
    </div>
  );
}
