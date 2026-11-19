import { useEffect, useRef } from 'react';
import { StopwatchIcon } from '../../components/Icons.tsx';
import { ResultGrid } from '../../components/ResultGrid.tsx';
import { Button } from '../../components/ui.tsx';
import type { AnswerRecord } from '../../lib/storage.ts';

export function TimeUpView({
  answers,
  total,
  onSeeResults,
  busy,
  error,
}: {
  answers: AnswerRecord[];
  total: number;
  onSeeResults: () => void;
  busy: boolean;
  error: string | null;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus({ preventScroll: true }), []);
  const right = answers.filter((a) => a.correct).length;
  const cells = Array.from({ length: total }, (_, i) => (answers[i] ? answers[i].correct : null));

  return (
    <section className="animate-pop flex flex-col items-center pt-8 text-center" aria-labelledby="timeup-title">
      <div className="bg-sun text-ink flex size-44 items-center justify-center rounded-full shadow-[0_10px_0_var(--color-pink)]" aria-hidden="true">
        <StopwatchIcon size={88} strokeWidth={2.5} />
      </div>
      <h1 id="timeup-title" ref={headingRef} tabIndex={-1} className="font-display text-sun mt-10 text-6xl focus:outline-none sm:text-7xl">
        Time’s up!
      </h1>
      <p className="mt-5 max-w-md text-lg">
        You answered {answers.length} of {total} headlines and got {right} right before the clock hit zero.
      </p>
      <div className="mt-7">
        <ResultGrid cells={cells} />
      </div>
      <p className="text-dim mt-5">Unanswered headlines count as misses.</p>
      <Button className="mt-8 w-full" onClick={onSeeResults} disabled={busy}>
        {busy ? 'Scoring…' : 'See my results'}
      </Button>
      {error && (
        <p className="text-ember mt-4 font-semibold" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
