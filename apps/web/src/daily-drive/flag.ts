/**
 * Daily Drive redesign flag (build time).
 *
 * - VITE_DAILY_DRIVE=1 / 0 always wins (0 = rollback to the legacy UI).
 * - Unset: ON (the approved default for `vite dev` and the Cloudflare Pages build), except in Vitest
 *   (MODE "test", so the legacy-UI tests stay unchanged) and in the legacy static demo build
 *   (MODE "pages", retired at the Netlify cutover).
 *
 * It is a constant, so a build with the flag off drops the Daily Drive code, CSS and fonts.
 */
export const DAILY_DRIVE: boolean =
  import.meta.env.VITE_DAILY_DRIVE === '1' ||
  (import.meta.env.VITE_DAILY_DRIVE !== '0' && import.meta.env.MODE !== 'test' && import.meta.env.MODE !== 'pages');
