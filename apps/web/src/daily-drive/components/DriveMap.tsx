import { useEffect, useRef } from 'react';
import type { DriveMap as DriveMapEngine } from '../engine/pixel-engine.js';
import { useEngine } from '../engine.ts';

export type MapMark = 'ok' | 'bad';

/**
 * The road map. Mirrors the round's existing state; it never decides anything.
 *  - mount / remount / resume: rebuild with setMark + jump, no animation
 *  - exactly one new mark in this session: drive(k, wrong) and set the mark on arrival
 *  - unmount: destroy()
 */
export function DriveMap({ marks = [], turbo = false, attract = false, big = false, label }: { marks?: readonly MapMark[]; turbo?: boolean; attract?: boolean; big?: boolean; label: string }) {
  const engine = useEngine();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<DriveMapEngine | null>(null);
  /** Marks already drawn; null = a fresh map that must be rebuilt without animation. */
  const applied = useRef<MapMark[] | null>(null);

  useEffect(() => {
    if (!engine || !el.current) return;
    const m = new engine.DriveMap(el.current, attract);
    map.current = m;
    applied.current = null;
    m.layout();
    return () => {
      m.destroy();
      map.current = null;
    };
  }, [engine, attract]);

  useEffect(() => {
    const m = map.current;
    if (!m || attract) return;
    const prev = applied.current;
    const next = [...marks];
    if (prev && prev.length === next.length && prev.every((v, i) => v === next[i])) return;
    const k = next.length;
    const growsByOne = prev !== null && k === prev.length + 1 && prev.every((v, i) => v === next[i]);
    if (growsByOne) {
      // One new result in this session: animate the drive, mark the checkpoint on arrival.
      const mark = next[k - 1]!;
      m.drive(k, mark === 'bad', () => m.setMark(k, mark));
    } else {
      // Fresh map, resume or a jump (dev panel): rebuild without animation.
      for (let i = 1; i <= 5; i++) m.setMark(i, next[i - 1] ?? '');
      m.jump(k);
    }
    applied.current = next;
  }, [engine, attract, marks]);

  useEffect(() => {
    map.current?.setTurbo(turbo);
  }, [engine, turbo]);

  return <div ref={el} className={big ? 'map big' : 'map'} role="img" aria-label={label} />;
}
