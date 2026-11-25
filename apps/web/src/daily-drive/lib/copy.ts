import copyJson from '../data/copy.json';
import type { EndingKey, MascotState } from '../engine/pixel-engine.js';

type Ending = { title: string; dest: string; mood: MascotState; art: string; msg: string; scoreBand: string };

/** All Daily Drive UI copy (redesign/data/copy.json). */
export const COPY = copyJson as unknown as {
  zones: { n: string; s: string }[];
  detourSigns: string[];
  mascotLines: Record<MascotState, string[]>;
  mascotAlt: Record<MascotState, string>;
  endings: Record<EndingKey, Ending>;
  verdicts: {
    correct: string;
    wrong: string;
    streakBanner: string;
    timeUp: string;
    next: string;
    last: string;
    timerStates: { running: string; urgent: string; paused: string };
  };
  disclaimer: string;
  /** Spoiler policy notice; same text as the legacy footer's SPOILER_NOTICE. */
  spoilerNotice: string;
};

/** Zones are fixed by question position: Q1 Welcome … Q5 Vice. */
export const ZONE_COUNT = 5;
export const zoneFor = (index: number) => COPY.zones[Math.min(Math.max(index, 0), ZONE_COUNT - 1)]!;
