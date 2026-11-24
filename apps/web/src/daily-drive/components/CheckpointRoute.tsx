import { COPY } from '../lib/copy.ts';
import { Shape, type ShapeState } from './Shape.tsx';

/** One entry per checkpoint. `skip` = left unanswered when the clock ran out (counts as a miss, drawn as pending). */
export type CheckpointState = 'ok' | 'bad' | 'now' | 'todo' | 'skip';

const SPOKEN: Record<CheckpointState, string> = {
  ok: 'correct',
  bad: 'wrong, detour',
  now: 'current',
  todo: 'not reached',
  skip: 'unanswered',
};

/** The five chips under the map: shape + icon + zone label, never colour alone. */
export function CheckpointRoute({ states }: { states: readonly CheckpointState[] }) {
  return (
    <ol className="route" aria-label="Checkpoints">
      {states.map((st, i) => {
        const zone = COPY.zones[i]!;
        const shape: ShapeState = st === 'skip' ? 'todo' : st;
        return (
          <li key={i} className={st === 'skip' ? 'todo' : st}>
            <Shape state={shape} />
            <span className="nm" aria-hidden="true">
              {zone.s.toUpperCase()}
            </span>
            <span className="sr">
              Checkpoint {i + 1}, {zone.n}: {SPOKEN[st]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Checkpoint states from the round so far (existing session state only). */
export function checkpointStates(answers: readonly { correct: boolean }[], index: number, total: number, finished: boolean): CheckpointState[] {
  return Array.from({ length: total }, (_, i) => {
    const a = answers[i];
    if (a) return a.correct ? 'ok' : 'bad';
    if (finished) return 'skip';
    return i === index ? 'now' : 'todo';
  });
}
