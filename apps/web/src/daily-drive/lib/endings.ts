import type { EndingKey } from '../engine/pixel-engine.js';
import { COPY } from './copy.ts';

/**
 * Ending band for a final score (redesign README "Ending bands"):
 * 5 Vice Legend · 4 Florida Veteran · 3 Tourist with Potential · 2 Lost in the Everglades · 0–1 Certified Florida Man.
 * Same rule as the engine's endingFor(); kept here so it is testable without a canvas.
 */
export function endingFor(score: number): EndingKey {
  return score >= 5 ? 'vice' : score === 4 ? 'veteran' : score === 3 ? 'tourist' : score === 2 ? 'glades' : 'fman';
}

/** The ending and its copy. Daily Drive is only shown for 5-question rounds, so `score` is out of 5. */
export function endingOf(score: number) {
  const key = endingFor(score);
  return { key, ...COPY.endings[key] };
}
