/** Checkpoint shapes: correct = teal square + check, wrong = orange cone + cross, pending = dashed circle, current = solid yellow. */
export type ShapeState = 'ok' | 'bad' | 'todo' | 'now';

export function OkIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1.5 5.5l2.5 2.5 4.5-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
    </svg>
  );
}

export function BadIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" />
    </svg>
  );
}

export function Shape({ state }: { state: ShapeState }) {
  return (
    <span className={`shape ${state}`} aria-hidden="true">
      {state === 'ok' ? <OkIcon /> : state === 'bad' ? <BadIcon /> : null}
    </span>
  );
}

export const QuitIcon = BadIcon;

export function HomeIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 5l4-4 4 4M2 4v5h6V4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function CalendarIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 2h8v7H1zM1 4h8M3 1v2M7 1v2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}
