/** Types for the parts of redesign/js/pixel-engine.js that the app uses. */
export type MascotState = 'idle' | 'correct' | 'wrong' | 'streak' | 'nervous' | 'perfect' | 'low';
export type EndingKey = 'vice' | 'veteran' | 'tourist' | 'glades' | 'fman';
export type Mark = 'ok' | 'bad' | '';

export declare class DriveMap {
  constructor(root: HTMLElement, attract?: boolean);
  readonly marks: Mark[];
  drive(k: number, wrong: boolean, onDone?: () => void): void;
  setMark(k: number, state: Mark): void;
  jump(k: number): void;
  reset(): void;
  setTurbo(on: boolean): void;
  layout(): void;
  destroy(): void;
}

export declare const STATES: readonly MascotState[];
/** Data-URL PNGs, 32×32: SPR[state][frame]. */
export declare const SPR: Record<MascotState, [string, string]>;
/** Convertible data-URL PNGs, 30×15: two wheel frames. */
export declare const CARU: [string, string];
export declare const ZONES: readonly { n: string; s: string }[];
export declare function drawArt(canvas: HTMLCanvasElement, key: EndingKey): void;
export declare function endingFor(score: number): EndingKey;
export declare function setReducedMotion(fn: () => boolean): void;
