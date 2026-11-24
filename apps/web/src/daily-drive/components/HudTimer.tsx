import { useEffect, useRef, useState } from 'react';
import { COPY } from '../lib/copy.ts';

const SEGMENTS = 12;
/** Same thresholds as the legacy GameHeader: announced once each, not every second. */
const ANNOUNCE_AT = [30, 10, 5];

/**
 * Big pixel digits + a 12-segment bar (5 s each for the 60 s round). Under 10 s: orange, blinking, "HURRY!".
 * Paused (the existing clock stops whenever no question is waiting for an answer): muted, "PAUSED".
 * Display only: time comes from the existing session clock.
 */
export function HudTimer({ remainingMs, limitMs, paused, timedOut = false }: { remainingMs: number; limitMs: number; paused: boolean; timedOut?: boolean }) {
  const seconds = Math.ceil(remainingMs / 1000);
  const on = Math.ceil((remainingMs / limitMs) * SEGMENTS - 1e-9);
  const urgent = !paused && seconds <= 10;
  const label = timedOut ? COPY.verdicts.timeUp : paused ? COPY.verdicts.timerStates.paused : urgent ? COPY.verdicts.timerStates.urgent : COPY.verdicts.timerStates.running;

  const [announcement, setAnnouncement] = useState('');
  const announced = useRef(new Set<number>());
  useEffect(() => {
    if (paused) return;
    for (const t of ANNOUNCE_AT) {
      if (seconds === t && !announced.current.has(t)) {
        announced.current.add(t);
        setAnnouncement(`${t} seconds left`);
      }
    }
  }, [seconds, paused]);

  return (
    <>
      <div className={`timer${urgent ? ' urgent' : ''}${paused && !timedOut ? ' paused' : ''}`} role="timer" aria-label={`${seconds} seconds left${paused ? ', paused' : ''}`}>
        <b>{seconds}</b>
        <div className="tbar" aria-hidden="true">
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <i key={i} className={i >= on ? 'off' : undefined} />
          ))}
        </div>
        <div className="tstate" aria-hidden="true">
          {label}
        </div>
      </div>
      <p className="sr" aria-live="assertive">
        {announcement}
      </p>
    </>
  );
}
