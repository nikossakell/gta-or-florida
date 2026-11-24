/**
 * Daily Drive redesign flag (build time).
 *
 * - VITE_DAILY_DRIVE=1 / 0 always wins.
 * - Unset: on under `vite dev`, off in production builds and in Vitest (MODE "test"),
 *   so the legacy UI stays the default for production and for the existing tests.
 *
 * It is a constant, so a build with the flag off drops the Daily Drive code, CSS and fonts.
 */
export const DAILY_DRIVE: boolean =
  import.meta.env.VITE_DAILY_DRIVE === '1' ||
  (import.meta.env.VITE_DAILY_DRIVE !== '0' && import.meta.env.DEV && import.meta.env.MODE !== 'test');
