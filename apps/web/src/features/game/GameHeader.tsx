import { useEffect, useRef, useState } from 'react';
import { ClockIcon, CloseIcon, PauseIcon } from '../../components/Icons.tsx';
import { IconLink } from '../../components/ui.tsx';
import type { AnswerRecord } from '../../lib/storage.ts';

const ANNOUNCE_AT = [30, 10, 5];

export function GameHeader({
  number,
  index,
  total,
  remainingMs,
  limitMs,
  paused,
  answers,
  label,
}: {
  number: number;
  index: number;
  total: number;
  remainingMs: number;
  limitMs: number;
  paused: boolean;
  answers: AnswerRecord[];
  label: string;
}) {
  const seconds = Math.ceil(remainingMs / 1000);
  const timed = limitMs > 0;
  const fraction = timed ? Math.max(0, Math.min(1, remainingMs / limitMs)) : 1;
  const low = timed && seconds <= 10;

  // Announce a few thresholds to screen readers instead of every second.
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef(new Set<number>());
  useEffect(() => {
    if (!timed || paused) return;
    for (const t of ANNOUNCE_AT) {
      if (seconds === t && !announced.current.has(t)) {
        announced.current.add(t);
        setAnnouncement(`${t} seconds left`);
      }
    }
  }, [seconds, paused, timed]);

  return (
    <header className="pt-4">
      <div className="flex items-center justify-between gap-3">
        <IconLink to="/" label="Quit to home (progress is saved)">
          <CloseIcon />
        </IconLink>
        <div className="text-center">
          <p className="label-wide text-dim text-xs sm:text-sm">{label} #{number}</p>
          <p className="btn-wide text-base whitespace-nowrap sm:text-xl" aria-live="polite">
            Headline {Math.min(index + 1, total)} of {total}
          </p>
        </div>
        {timed ? (
          <div
            role="timer"
            aria-label={`${seconds} seconds left${paused ? ', paused' : ''}`}
            className={`flex h-14 min-w-20 items-center justify-center gap-1.5 rounded-2xl border-[3px] px-2.5 sm:min-w-24 sm:gap-2 sm:px-3 ${low ? 'border-ember text-ember' : 'border-teal text-teal'}`}
          >
            {paused ? <PauseIcon size={20} /> : <ClockIcon size={20} />}
            <span className="btn-wide text-lg tabular-nums sm:text-2xl">{seconds}s</span>
          </div>
        ) : (
          <div className="size-14" aria-hidden="true" />
        )}
      </div>

      {timed && (
        <div className="bg-line/60 mt-5 h-3 overflow-hidden rounded-full" aria-hidden="true">
          <div
            className={`h-full rounded-full transition-[width] duration-200 ease-linear ${low ? 'bg-ember' : 'bg-teal'}`}
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
      )}

      <ol className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }} aria-label="Progress">
        {Array.from({ length: total }, (_, i) => {
          const a = answers[i];
          const state = a ? (a.correct ? 'right' : 'wrong') : i === index ? 'current' : 'upcoming';
          const color = { right: 'bg-teal', wrong: 'bg-ember', current: 'bg-cream', upcoming: 'bg-line' }[state];
          return (
            <li key={i} className={`h-2 rounded-full ${color}`}>
              <span className="sr-only">
                Headline {i + 1}: {state}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="assertive">
        {announcement}
      </p>
    </header>
  );
}
