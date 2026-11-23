/**
 * gta-florida-ingest — scheduled content ingestion on Cloudflare (replaces the GitHub Actions job).
 *
 *   Cron Trigger (twice daily, UTC) → IngestWorkflow instance (durable, retried, bounded steps)
 *     → API Worker over a Service Binding (the only D1 writer + policy enforcement point)
 *     → Workers AI binding for classification
 *
 * No public routes (workers_dev is off). Manual runs: `wrangler workflows trigger`.
 * The API Worker decides every question state; nothing here can approve or publish.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { createMockAiProvider, createWorkersAiBindingProvider, type AiProvider } from '@gof/ingest/classify.ts';
import { createWorkerClient } from '@gof/ingest/import.ts';
import { parseSourcesConfig } from '@gof/ingest/normalize.ts';
import sourcesJson from '../../../data/sources.json';
import { runIngestion, StepBudgetError, type IngestParams, type StepLike } from './ingest.ts';
import { parseLimits, type LimitVars } from './limits.ts';

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

const USER_AGENT = 'gta-or-florida-ingest/0.4 (unofficial fan trivia project; metadata only)';
const cfg = parseSourcesConfig(sourcesJson);

function event(name: string, data: Record<string, unknown>) {
  const line = JSON.stringify({ event: name, ...data });
  if (/_low$|unexpected|error/.test(name)) console.warn(line);
  else console.log(line);
}

function aiFor(env: Env): AiProvider | null {
  const choice = env.AI_PROVIDER ?? 'binding';
  if (choice === 'off') return null;
  if (choice === 'mock' || !env.AI) return createMockAiProvider();
  return createWorkersAiBindingProvider(env.AI as never);
}

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  override async run(evt: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    const env = this.env;
    const client = createWorkerClient({
      // The host is a placeholder: requests go through the Service Binding, never the public internet.
      baseUrl: 'https://api.internal',
      token: env.INGESTION_IMPORT_TOKEN,
      actor: 'ingest-workflow',
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => env.API.fetch(input as never, init as never)) as typeof fetch,
      maxRetries: 1,
    });
    const adapter: StepLike = { do: (name, config, fn) => step.do(name, config as never, fn as never) as never };
    try {
      return await runIngestion(
        { runId: evt.instanceId.replace(/[^A-Za-z0-9:_.#%\-/]/g, '_').slice(0, 80), startedAt: new Date(evt.timestamp).toISOString(), params: evt.payload ?? {} },
        adapter,
        {
          cfg,
          limits: parseLimits(env),
          client,
          ai: aiFor(env),
          fetchImpl: (input, init) => fetch(input, init),
          userAgent: env.HTTP_USER_AGENT || USER_AGENT,
          wikiApi: env.GRAND_THEFT_WIKI_API || 'https://www.grandtheftwiki.com/api.php',
          event,
        },
      );
    } catch (error) {
      // Over budget is a configuration problem: retrying the instance cannot fix it.
      if (error instanceof StepBudgetError) throw new NonRetryableError(error.message);
      throw error;
    }
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (env.INGEST_ENABLED !== 'true') {
      event('ingest.cron_skipped', { env: env.APP_ENV, reason: 'INGEST_ENABLED is not "true"' });
      return;
    }
    // One instance per firing (hour precision): a duplicate delivery cannot start a second run.
    const id = `cron-${env.APP_ENV}-${new Date(controller.scheduledTime).toISOString().slice(0, 13).replace(/[-T:]/g, '')}`;
    try {
      const instance = await env.INGEST_WORKFLOW.create({ id, params: { sources: 'all' } });
      event('ingest.cron_started', { env: env.APP_ENV, instanceId: instance.id });
    } catch (error) {
      if (/already_exists/.test(String((error as Error)?.message))) event('ingest.cron_duplicate', { env: env.APP_ENV, instanceId: id });
      else throw error;
    }
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    // Not routed publicly (workers_dev: false); kept for `wrangler dev` health checks only.
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, env: env.APP_ENV });
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
