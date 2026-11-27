/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public URL included in share text. Defaults to window.location.origin. */
  readonly VITE_PUBLIC_URL?: string;
  /**
   * Origin of the Cloudflare Worker API, e.g. https://gta-florida-api-production.<subdomain>.workers.dev.
   * Public (baked into the bundle) — never put secrets in VITE_* variables.
   * Empty: same-origin /api (Vite dev proxy → `wrangler dev`).
   */
  readonly VITE_API_BASE_URL?: string;
  /** Daily Drive redesign: "1" on, "0" off (rollback); unset = on, except in tests and the legacy static `pages` build (src/daily-drive/flag.ts). */
  readonly VITE_DAILY_DRIVE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
