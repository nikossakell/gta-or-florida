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
import { parseSourcesConfig } from '@gof/ingest/normalize.ts';
import sourcesJson from '../../../data/sources.json';
import { runIngestion, StepBudgetError, type IngestParams, type StepLike } from './ingest.ts';
import { apiClientFor } from './api-client.ts';
import type { Env } from './env.ts';
import { parseLimits } from './limits.ts';
import { SubrequestMeter } from './subrequests.ts';

export type { Env };


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
    const limits = parseLimits(env);
    // One meter per instance run: API (Service Binding), discovery, link checks, AI and Workflow calls.
    const meter = new SubrequestMeter(limits.subrequestBudget);
    const client = apiClientFor(env, meter);
    const adapter: StepLike = { do: (name, config, fn) => step.do(name, config as never, fn as never) as never };
    try {
      return await runIngestion(
        { runId: evt.instanceId.replace(/[^A-Za-z0-9:_.#%\-/]/g, '_').slice(0, 80), startedAt: new Date(evt.timestamp).toISOString(), params: evt.payload ?? {} },
        adapter,
        {
          cfg,
          limits,
          client,
          ai: aiFor(env),
          fetchImpl: (input, init) => fetch(input, init),
          userAgent: env.HTTP_USER_AGENT || USER_AGENT,
          wikiApi: env.GRAND_THEFT_WIKI_API || 'https://www.grandtheftwiki.com/api.php',
          event,
          appEnv: env.APP_ENV,
          meter,
          nonRetryable: (e) => new NonRetryableError(e.message),
          spawn: async (id, params) => {
            try {
              await env.INGEST_WORKFLOW.create({ id, params });
            } catch (error) {
              // Deterministic successor ids: a second create for the same cursor is a no-op.
              if (!/already_exists/.test(String((error as Error)?.message))) throw error;
            }
          },
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
    // Historical DOJ backfill runs as its OWN instances (separate subrequest budget). The lease inside the
    // Workflow makes a second concurrent backfill exit immediately; a finished backfill exits too.
    if (env.DOJ_BACKFILL_ENABLED === 'true') {
      const bid = `backfill-${env.APP_ENV}-${new Date(controller.scheduledTime).toISOString().slice(0, 13).replace(/[-T:]/g, '')}`;
      try {
        await env.INGEST_WORKFLOW.create({ id: bid, params: { mode: 'backfill' } });
        event('ingest.backfill_started', { env: env.APP_ENV, instanceId: bid });
      } catch (error) {
        if (!/already_exists/.test(String((error as Error)?.message))) throw error;
      }
    }
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    // Not routed publicly (workers_dev: false); kept for `wrangler dev` health checks only.
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, env: env.APP_ENV });
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
