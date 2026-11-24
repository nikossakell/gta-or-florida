import { useEffect, useRef, useState } from 'react';
import type { MascotState } from '../engine/pixel-engine.js';
import { useEngine } from '../engine.ts';
import { COPY } from '../lib/copy.ts';
import { useReducedMotion } from '../lib/motion.ts';

const FRAME_MS = 380;

/**
 * Gus the gator. Two frames swapped every 380 ms (frame 0 only under reduced motion), and a small
 * hop whenever the state changes. Pixel art comes from the engine's data-URL sprites (no image requests).
 */
export function Gus({ state, size = 'sm', decorative = false }: { state: MascotState; size?: 'sm' | 'lg' | 'stamp'; decorative?: boolean }) {
  const engine = useEngine();
  const rm = useReducedMotion();
  const [frame, setFrame] = useState(0);
  const [hop, setHop] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (rm) {
      setFrame(0);
      return;
    }
    const id = window.setInterval(() => setFrame((f) => f ^ 1), FRAME_MS);
    return () => window.clearInterval(id);
  }, [rm]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (rm) return;
    setHop(true);
    const id = window.setTimeout(() => setHop(false), 320);
    return () => window.clearTimeout(id);
  }, [state, rm]);

  const cls = `sprite ${size === 'lg' ? 'mascot-lg' : size === 'sm' ? 'mascot-sm' : ''}${hop ? ' hop' : ''}`;
  const alt = decorative ? '' : COPY.mascotAlt[state];
  const src = engine?.SPR[state]?.[rm ? 0 : frame];
  if (!src) return <span className={`gus-slot ${cls}`} role={decorative ? undefined : 'img'} aria-label={alt || undefined} data-state={state} />;
  return <img className={cls} src={src} alt={alt} data-state={state} width={32} height={32} />;
}

/** A line for the speech bubble, picked when the state changes. */
export function useMascotLine(state: MascotState): string {
  const [line, setLine] = useState(() => pickLine(state));
  const last = useRef(state);
  useEffect(() => {
    if (last.current === state) return;
    last.current = state;
    setLine(pickLine(state));
  }, [state]);
  return line;
}

function pickLine(state: MascotState): string {
  const lines = COPY.mascotLines[state] ?? COPY.mascotLines.idle;
  return lines[Math.floor(Math.random() * lines.length)] ?? '';
}
