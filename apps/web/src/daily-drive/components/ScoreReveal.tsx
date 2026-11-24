import { useEffect, useState } from 'react';
import { useReducedMotion } from '../lib/motion.ts';

const STEP_MS = 220;

/**
 * Counts up to the final score (220 ms per point), then reports `done` so the postcard can enter.
 * Reduced motion: the score and postcard appear at once. The score itself comes from the saved result.
 */
export function useScoreCount(score: number, replay = 0): { shown: number; done: boolean } {
  const rm = useReducedMotion();
  const [shown, setShown] = useState(rm ? score : 0);
  const [done, setDone] = useState(rm);
  useEffect(() => {
    if (rm) {
      setShown(score);
      setDone(true);
      return;
    }
    setShown(0);
    setDone(false);
    let i = 0;
    let finish: number | undefined;
    const end = () => (finish = window.setTimeout(() => setDone(true), score === 0 ? 300 : 250));
    if (score === 0) {
      end();
      return () => window.clearTimeout(finish);
    }
    const id = window.setInterval(() => {
      i++;
      setShown(i);
      if (i >= score) {
        window.clearInterval(id);
        end();
      }
    }, STEP_MS);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(finish);
    };
  }, [score, rm, replay]);
  return { shown, done };
}

export function ScoreReveal({ shown, total, done }: { shown: number; total: number; done: boolean }) {
  return (
    <div className="scorebox">
      <p className="lab">FINAL SCORE</p>
      <p className="bigscore" aria-hidden={!done}>
        <span key={shown} className={shown > 0 && !done ? 'tick' : undefined}>
          {shown}
        </span>
        /{total}
      </p>
    </div>
  );
}
