/** Worker bindings and vars (wrangler.jsonc). Secrets are set with `wrangler secret put`. */
export interface Env {
  DB: D1Database;
  /** local | staging | production */
  APP_ENV: string;
  APP_VERSION?: string;
  /** off | shadow | trusted_sources. Unknown values fail closed to "off". */
  AUTO_PUBLISH_MODE?: string;
  /** Owner-set from a benchmark (e.g. "0.01"). Unset → trusted_sources approves nothing. */
  AUTO_PUBLISH_MAX_FALSE_APPROVAL_RATE?: string;
  HUMAN_SAMPLE_RATE?: string;
  /** Exact production Pages origin, e.g. https://gta-or-florida.pages.dev */
  FRONTEND_ORIGIN?: string;
  /** Extra exact origins, comma-separated (e.g. http://localhost:5173). */
  EXTRA_ORIGINS?: string;
  /** Pages project name whose preview subdomains (<hash>.<project>.pages.dev) are allowed. */
  PAGES_PREVIEW_PROJECT?: string;
  /** Secret: service token for the ingestion job (import/known/checkpoints/schedule). */
  INGESTION_IMPORT_TOKEN?: string;
  /** Secret: owner token for review/withdraw/stats (and everything the service token can do). */
  ADMIN_TOKEN?: string;
  /** Optional Workers Rate Limiting binding (best effort, per Cloudflare location). */
  RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

export function isLocal(env: Env): boolean {
  return env.APP_ENV === 'local';
}
