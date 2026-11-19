import type { RevealedQuestion } from '@gof/core';
import { useEffect, useRef } from 'react';
import { ArrowRightIcon, CheckIcon, CrossIcon, JoystickIcon, LinkIcon, PalmIcon } from '../../components/Icons.tsx';
import { Button } from '../../components/ui.tsx';
import { publishedDay } from '../../lib/format.ts';
import type { AnswerRecord } from '../../lib/storage.ts';

export function AnswerBadge({ question }: { question: RevealedQuestion }) {
  if (question.answer === 'florida') {
    return (
      <p className="label-wide bg-teal text-ink inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs sm:text-sm">
        <PalmIcon size={18} /> Florida · {question.placeholder ? 'Real-report slot' : 'Real report'}
      </p>
    );
  }
  return (
    <p className="label-wide bg-pink text-ink inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs sm:text-sm">
      <JoystickIcon size={18} /> {question.gtaSubtype === 'gta_lore' ? 'GTA lore · Actual game event' : 'GTA-style · Fictional'}
    </p>
  );
}

/** Explanation + source block, shared by the reveal and the results review. */
export function AnswerDetails({ question }: { question: RevealedQuestion }) {
  return (
    <>
      <div className="mt-4">
        <AnswerBadge question={question} />
      </div>
      {question.answer === 'gta' && question.gtaSubtype !== 'gta_lore' && (
        <p className="text-cream mt-4 font-semibold">Fictional GTA-style scenario.</p>
      )}
      <p className="text-muted mt-3 leading-relaxed">{question.explanation}</p>
      {question.sourceUrl ? (
        <a
          href={question.sourceUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="border-teal text-teal hover:bg-teal/10 mt-5 flex min-h-12 items-center gap-3 rounded-2xl border-[3px] px-4 py-2 font-semibold"
        >
          <LinkIcon size={20} />
          <span>
            Read original report
            <span className="text-muted block text-sm font-normal">
              {[question.sourceName, question.publishedAt && publishedDay(question.publishedAt)].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : (
        question.answer === 'florida' &&
        question.placeholder && (
          <p className="border-dim/70 text-muted mt-5 flex items-center gap-3 rounded-2xl border-[3px] border-dashed px-4 py-3">
            <LinkIcon size={20} /> Source: none — sample placeholder
          </p>
        )
      )}
    </>
  );
}

export function RevealView({ record, isLast, onNext, busy, error }: { record: AnswerRecord; isLast: boolean; onNext: () => void; busy: boolean; error: string | null }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [record.questionId]);

  // Enter / → advances, unless focus is on a link or button (let those act normally).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (busy || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('a, button, input, textarea, summary')) return;
      if (e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        onNext();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onNext]);

  const right = record.correct;
  return (
    <div className="animate-pop">
      <div className="mt-7 flex items-center gap-5">
        <div
          className={`flex size-24 shrink-0 items-center justify-center rounded-full ${right ? 'bg-teal text-ink' : 'bg-ember text-ink'}`}
          aria-hidden="true"
        >
          {right ? <CheckIcon size={44} /> : <CrossIcon size={44} />}
        </div>
        <div>
          <h1 ref={headingRef} tabIndex={-1} className={`font-display text-5xl leading-none focus:outline-none sm:text-6xl ${right ? 'text-teal' : 'text-ember'}`}>
            {right ? 'Correct!' : 'Not quite.'}
          </h1>
          <p className="mt-2 text-lg">You said {record.choice === 'gta' ? 'GTA' : 'FLORIDA'}.</p>
        </div>
      </div>

      <section className="card mt-7 p-7 sm:p-8" aria-label="Answer details">
        <p className="text-[1.35rem] leading-snug font-bold text-balance sm:text-2xl">{record.question.headline}</p>
        <AnswerDetails question={record.question} />
      </section>

      <Button className="mt-8 w-full" onClick={onNext} disabled={busy} aria-keyshortcuts="Enter">
        {busy ? 'Scoring…' : isLast ? 'See my results' : 'Next headline'} {!busy && <ArrowRightIcon />}
      </Button>
      {error && (
        <p className="text-ember mt-4 text-center font-semibold" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
