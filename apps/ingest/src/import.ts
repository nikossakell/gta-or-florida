/**
 * Authenticated client for the Worker's protected routes.
 *
 * - Import is chunked (≤ MAX_IMPORT_ITEMS per request) with a deterministic
 *   Idempotency-Key per chunk, so a retried request can never double-insert.
 * - Retries only on network errors / 5xx / 429, with backoff; 4xx are final.
 * - Base URL must be https (http only for localhost `wrangler dev`).
 * - Tokens are sent only in the Authorization header and never logged.
 */
import { createHash } from 'node:crypto';
import {
  MAX_IMPORT_ITEMS,
  type ImportItem,
  type ImportItemResult,
  type ImportResponse,
  type KnownResponse,
  type ReviewRequest,
  type RunReport,
  type ScheduleResponse,
  type TitleIndexResponse,
  type WithdrawRequest,
} from '@gof/core';

export class WorkerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WorkerApiError';
  }
}

export type WorkerClientOptions = {
  baseUrl: string;
  token: string;
  actor?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
};

/** Accepts the API origin or the full import URL (…/api/v1/admin/import), returns the origin+prefix base. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid Worker API URL: ${raw}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Worker API URL must be https (http is allowed only for localhost)');
  if (url.username || url.password) throw new Error('Worker API URL must not contain credentials');
  return url.origin;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function createWorkerClient(opts: WorkerClientOptions) {
  const base = normalizeBaseUrl(opts.baseUrl);
  if (!opts.token || opts.token.length < 32) throw new Error('Worker token is missing or shorter than 32 characters');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 3;

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const url = `${base}/api/v1/admin${path}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      let networkError: Error | null = null;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${opts.token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(opts.actor ? { 'x-actor': opts.actor } : {}),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
      } catch (error) {
        networkError = error as Error;
      }
      const retryable = networkError !== null || (res !== null && (res.status >= 500 || res.status === 429));
      if (retryable && attempt < maxRetries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (networkError) throw new WorkerApiError(0, 'NETWORK', `Cannot reach Worker API: ${networkError.message}`);
      const parsed = (await res!.json().catch(() => null)) as { error?: { code?: string; message?: string }; errors?: string[] } | null;
      if (!res!.ok) {
        throw new WorkerApiError(res!.status, parsed?.error?.code ?? 'HTTP', parsed?.error?.message ?? `HTTP ${res!.status}`, parsed?.errors ?? parsed);
      }
      return parsed as T;
    }
  }

  /**
   * Import ONE chunk (≤ MAX_IMPORT_ITEMS). Deterministic Idempotency-Key from run id, chunk
   * index and body, so a retried chunk (or Workflow step) can never double-insert.
   */
  async function importChunk(runId: string, index: number, items: ImportItem[], run?: RunReport, checkpoints?: { provider: string; key: string; value: string }[]): Promise<ImportItemResult[]> {
    if (items.length > MAX_IMPORT_ITEMS) throw new Error(`importChunk takes at most ${MAX_IMPORT_ITEMS} items`);
    const body = { items, ...(run ? { run } : {}), ...(checkpoints?.length ? { checkpoints } : {}) };
    const key = `${runId}:${index}:${sha(JSON.stringify(body)).slice(0, 16)}`;
    const r = await request<ImportResponse>('POST', '/import', body, { 'idempotency-key': key });
    return r.results;
  }

  return {
    request,
    known: (canonicalUrls: string[], providerKeys: string[]) => request<KnownResponse>('POST', '/known', { canonicalUrls, providerKeys }),
    async titles(kind: string): Promise<TitleIndexResponse['items']> {
      const out: TitleIndexResponse['items'] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 200; page++) {
        const q: string = `/titles?kind=${encodeURIComponent(kind)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const r: TitleIndexResponse = await request<TitleIndexResponse>('GET', q);
        out.push(...r.items);
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      return out;
    },
    async checkpoints(provider: string): Promise<Map<string, string>> {
      const r = await request<{ checkpoints: { key: string; value: string }[] }>('GET', `/checkpoints?provider=${encodeURIComponent(provider)}`);
      return new Map(r.checkpoints.map((c) => [c.key, c.value]));
    },
    /** One page of the title index (keyset cursor = last incident key). */
    titlesPage: (kind: string, cursor: string | null, limit: number) =>
      request<TitleIndexResponse>('GET', `/titles?kind=${encodeURIComponent(kind)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    importChunk,
    /**
     * Import items in chunks. The run report and checkpoints ride on the LAST chunk only,
     * so a failed run never advances the cursor past items that were not stored.
     */
    async importItems(runId: string, items: ImportItem[], run?: RunReport, checkpoints?: { provider: string; key: string; value: string }[]): Promise<ImportItemResult[]> {
      const results: ImportItemResult[] = [];
      const chunks: ImportItem[][] = [];
      for (let i = 0; i < items.length; i += MAX_IMPORT_ITEMS) chunks.push(items.slice(i, i + MAX_IMPORT_ITEMS));
      if (chunks.length === 0) chunks.push([]);
      for (const [i, chunk] of chunks.entries()) {
        const last = i === chunks.length - 1;
        results.push(...(await importChunk(runId, i, chunk, last ? run : undefined, last ? checkpoints : undefined)));
      }
      return results;
    },
    schedule: (days: number, extra: { startDate?: string; dryRun?: boolean } = {}) => request<ScheduleResponse & { published?: number }>('POST', '/schedule', { days, ...extra }),
    stats: () => request<Record<string, unknown>>('GET', '/stats'),
    candidates: (q: { kind?: string; state?: string; decision?: string; limit?: number; offset?: number }) => {
      const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
      return request<{ items: Record<string, unknown>[] }>('GET', `/candidates?${p}`);
    },
    candidate: (id: string) => request<Record<string, unknown>>('GET', `/candidates/${encodeURIComponent(id)}`),
    review: (body: ReviewRequest) => request<{ ok: true; questionId: string; state: string }>('POST', '/review', body),
    withdraw: (body: WithdrawRequest) => request<Record<string, unknown>>('POST', '/withdraw', body),
    merge: (body: { action: 'merge' | 'unmerge'; incidentId: string; intoIncidentId?: string; reason: string }) => request<Record<string, unknown>>('POST', '/merge', body),
    syncSources: () => request<{ synced: number; policyVersion: string }>('POST', '/sources/sync', {}),
    recordBenchmark: (body: { policyVersion: string; sampleSize: number; falseApprovalRate: number; measuredAt: string; notes?: string }) =>
      request<Record<string, unknown>>('POST', '/benchmark', body),
  };
}

export type WorkerClient = ReturnType<typeof createWorkerClient>;
