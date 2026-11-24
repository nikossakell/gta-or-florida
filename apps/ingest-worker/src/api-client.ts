/**
 * The Workflow's client for its own environment's API Worker.
 *
 * Requests travel over the Service Binding (`env.API.fetch`), never the public internet; the
 * URL host is a placeholder the binding ignores. Authentication is unchanged: the API Worker
 * still requires `Authorization: Bearer <INGESTION_IMPORT_TOKEN>`. The token is validated against
 * the API's exact bearer format up front (createWorkerClient), so a malformed secret fails here
 * with a clear message instead of reaching the API as "Missing bearer token". It is never logged.
 */
import { createWorkerClient, type WorkerClient } from '@gof/ingest/import.ts';
import type { Env } from './env.ts';
import { meteredFetch, type SubrequestMeter } from './subrequests.ts';

export function apiClientFor(env: Pick<Env, 'API' | 'INGESTION_IMPORT_TOKEN'>, meter?: SubrequestMeter): WorkerClient {
  const binding = ((input: RequestInfo | URL, init?: RequestInit) => env.API.fetch(input as never, init as never)) as typeof fetch;
  return createWorkerClient({
    baseUrl: 'https://api.internal',
    token: env.INGESTION_IMPORT_TOKEN,
    actor: 'ingest-workflow',
    // Every Service Binding call counts toward the instance's subrequest limit; no client retries
    // (a retry would spend budget the plan did not reserve).
    fetchImpl: meter ? meteredFetch(binding, meter, 'api') : binding,
    maxRetries: 0,
  });
}
