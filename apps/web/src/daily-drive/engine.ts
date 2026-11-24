/**
 * The pixel engine builds its sprites with <canvas> as soon as it is imported, so app modules
 * never import it directly. boot.ts (browser only, flag on) loads it and hands it over here;
 * tests hand over a mock with provideEngine().
 */
import { useSyncExternalStore } from 'react';
import type * as PixelEngine from './engine/pixel-engine.js';

export type Engine = Pick<typeof PixelEngine, 'DriveMap' | 'SPR' | 'drawArt' | 'setReducedMotion'>;

let current: Engine | null = null;
const listeners = new Set<() => void>();

export function provideEngine(engine: Engine | null): void {
  current = engine;
  listeners.forEach((l) => l());
}

export function getEngine(): Engine | null {
  return current;
}

/** The engine, or null where it isn't available (tests without a mock). Components render a still fallback then. */
export function useEngine(): Engine | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
}
