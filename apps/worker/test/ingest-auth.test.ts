/**
 * Regression: Workflow → Service Binding → API Worker authentication.
 *
 * Staging failed at the Workflow's first step with "Missing bearer token": the header did reach the
 * API, but its value could never match the API's bearer format (malformed secret), because the client
 * only checked the token's length. These tests run the real pieces: the Workflow's client factory
 * (apiClientFor), the Workflow's first step (runIngestion), a Service Binding stand-in that hands the
 * API Worker a fresh Request (as the binding does), and the API Worker's real auth over local D1.
 * Token values are never printed; assertions only look at outcomes and message text.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiClientFor } from '../../ingest-worker/src/api-client.ts';
import { runIngestion, type StepConfig, type StepLike } from '../../ingest-worker/src/ingest.ts';
import { parseLimits } from '../../ingest-worker/src/limits.ts';
import { parseSourcesConfig } from '@gof/ingest/normalize.ts';
import { createMockAiProvider } from '@gof/ingest/classify.ts';
import { WorkerApiError } from '@gof/ingest/import.ts';
import sourcesJson from '../../../data/sources.json';
import { handleRequest } from '../src/index.ts';
import { createHarness, SERVICE_TOKEN, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ APP_ENV: 'staging' });
});
afterAll(() => h.dispose());

const BEARER = /^Bearer [\x21-\x7e]{1,512}$/;

/** Service Binding stand-in: the callee receives a new Request built from the caller's input/init. */
function binding() {
  const seen: { path: string; authorizationWellFormed: boolean }[] = [];
  const API = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push({ path: new URL(req.url).pathname, authorizationWellFormed: BEARER.test(req.headers.get('authorization') ?? '') });
      return handleRequest(req, h.env);
    },
  } as unknown as Fetcher;
  return { API, seen };
}

class Stop extends Error {}

/** Runs the Workflow up to (and including) its first step, then stops. */
async function firstStep(token: string, API: Fetcher) {
  let result: unknown;
  const step: StepLike = {
    async do<T>(name: string, _config: StepConfig, fn: () => Promise<T>): Promise<T> {
      if (name !== 'checkpoints') throw new Stop();
      result = await fn();
      return result as T;
    },
  };
  const client = apiClientFor({ API, INGESTION_IMPORT_TOKEN: token });
  await runIngestion(
    { runId: 'auth-regression', startedAt: '2026-11-23T00:00:00.000Z', params: { dryRun: true, sources: 'gta' } },
    step,
    {
      cfg: parseSourcesConfig(sourcesJson),
      limits: parseLimits({}),
      client,
      ai: createMockAiProvider(),
      fetchImpl: (() => {
        throw new Error('no external fetch in this test');
      }) as typeof fetch,
      userAgent: 'test',
      wikiApi: 'https://www.grandtheftwiki.com/api.php',
      event: () => {},
    },
  ).catch((e) => {
    if (!(e instanceof Stop)) throw e;
  });
  return result;
}

describe('Workflow → Service Binding → API Worker authentication', () => {
  it('authenticates the Workflow with the service token through the binding', async () => {
    const { API, seen } = binding();
    const cp = await firstStep(SERVICE_TOKEN, API);
    expect(cp).toEqual({ grandtheftwiki: {} }); // authenticated read; a GTA-only run reads only its own cursor
    expect(seen).toEqual([{ path: '/api/v1/admin/checkpoints', authorizationWellFormed: true }]);
  });

  it('rejects a malformed secret before sending anything, without revealing it', () => {
    const malformed = {
      'trailing newline': `${SERVICE_TOKEN}\n`,
      'pasted "Bearer " prefix': `Bearer ${SERVICE_TOKEN}`,
      'bracketed-paste escape codes': `\u001b[200~${SERVICE_TOKEN}\u001b[201~`,
      'inner space': `${SERVICE_TOKEN.slice(0, 20)} ${SERVICE_TOKEN.slice(20)}`,
      'non-breaking space': `${SERVICE_TOKEN} `,
      'too long': 'a'.repeat(513),
    };
    for (const [label, token] of Object.entries(malformed)) {
      const { API, seen } = binding();
      let message = '';
      try {
        apiClientFor({ API, INGESTION_IMPORT_TOKEN: token });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, label).toMatch(/^Worker token is invalid: /);
      expect(message.includes(SERVICE_TOKEN), `${label}: message must not contain the token`).toBe(false);
      expect(seen, label).toEqual([]);
    }
    for (const missing of [undefined, '', null]) {
      expect(() => apiClientFor({ API: binding().API, INGESTION_IMPORT_TOKEN: missing as never })).toThrow(/Worker token is invalid: missing/);
    }
  });

  it('a well-formed but wrong token is still refused by the API (auth not weakened)', async () => {
    const { API, seen } = binding();
    const err = await firstStep('wrong-service-token-0123456789abcdef0123', API).catch((e) => e);
    expect(err).toBeInstanceOf(WorkerApiError);
    expect(err).toMatchObject({ status: 401, message: 'Invalid token.' });
    expect(seen).toEqual([{ path: '/api/v1/admin/checkpoints', authorizationWellFormed: true }]);
  });

  it('the API still answers "Missing bearer token" when the header is absent or malformed', async () => {
    const res = await handleRequest(new Request('https://api.internal/api/v1/admin/checkpoints?provider=gdelt'), h.env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Missing bearer token.');
  });
});
