import type { IngestParams } from './ingest.ts';
import type { LimitVars } from './limits.ts';

/** Bindings + vars of the ingestion Worker (see wrangler.jsonc). Secrets arrive as plain strings. */
export type Env = LimitVars & {
  APP_ENV: 'local' | 'staging' | 'production';
  /** "true" enables the cron. Manual `wrangler workflows trigger` runs work regardless. */
  INGEST_ENABLED?: string;
  /** binding (default) | mock | off */
  AI_PROVIDER?: string;
  GRAND_THEFT_WIKI_API?: string;
  HTTP_USER_AGENT?: string;
  /** Same value as the API Worker's INGESTION_IMPORT_TOKEN for this environment (secret). */
  INGESTION_IMPORT_TOKEN: string;
  /** Service binding to THIS environment's API Worker. */
  API: Fetcher;
  AI?: Ai;
  INGEST_WORKFLOW: Workflow<IngestParams>;
};
