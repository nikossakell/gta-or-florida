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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
