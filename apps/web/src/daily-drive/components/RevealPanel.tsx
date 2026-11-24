import { useEffect, useRef } from 'react';
import type { AnswerRecord } from '../../lib/storage.ts';
import { COPY } from '../lib/copy.ts';
import { AnswerInfo, answerKind, answerWord } from './AnswerInfo.tsx';
import { ArcadeButton } from './ArcadeButton.tsx';
import { BadIcon, OkIcon } from './Shape.tsx';

/** Replaces the answer buttons once the existing logic has the result. The Next button takes focus. */
export function RevealPanel({ record, isLast, busy, error, onNext }: { record: AnswerRecord; isLast: boolean; busy: boolean; error: string | null; onNext: () => void }) {
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [record.questionId]);

  const ok = record.correct;
  const q = record.question;
  return (
    <section className="reveal panel in" aria-labelledby={`verdict-${record.questionId}`}>
      <div className="verdict">
        <span className={`vicon ${ok ? 'ok' : 'bad'}`} aria-hidden="true">
          {ok ? <OkIcon /> : <BadIcon />}
        </span>
        <div>
          <h2 className={`vword ${ok ? 'ok' : 'bad'}`} id={`verdict-${record.questionId}`}>
            {ok ? COPY.verdicts.correct : COPY.verdicts.wrong}
          </h2>
          <p className="vsub">
            It was <b className={q.answer}>{answerWord(q.answer)}</b> · {answerKind(q)}
            {!ok && record.choice ? ` · you said ${record.choice === 'gta' ? 'GTA' : 'Florida'}` : ''}
          </p>
        </div>
      </div>
      <AnswerInfo question={q} />
      <ArcadeButton
        ref={nextRef}
        variant="next"
        onClick={onNext}
        disabled={busy}
        aria-keyshortcuts="Enter N ArrowRight"
        big={busy ? 'SCORING…' : isLast ? COPY.verdicts.last : COPY.verdicts.next}
        hint={<kbd>Enter</kbd>}
      />
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
