/**
 * Polite JSON/text client for *configured* upstream APIs (MediaWiki, RSS feeds, …).
 *
 * - Only hosts on the allowlist can be requested (adapter URLs come from
 *   config, never from user input). Redirects are not followed.
 * - One request at a time per client, with a minimum gap between requests.
 * - Timeout, bounded retries, exponential backoff with jitter, Retry-After.
 * - Non-JSON bodies, 429 and 5xx are explicit, typed errors.
 */

export type UpstreamErrorKind = 'http' | 'rate_limited' | 'not_json' | 'network' | 'timeout' | 'forbidden_host' | 'api_error';

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(kind: UpstreamErrorKind, message: string, opts: { status?: number; retryAfterMs?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable =
      opts.retryable ?? (kind === 'rate_limited' || kind === 'network' || kind === 'timeout' || (kind === 'http' && (opts.status ?? 0) >= 500));
  }
}

export type MinimalResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type FetchFn = (input: URL, init: { signal: AbortSignal; headers: Record<string, string>; redirect: 'manual' }) => Promise<MinimalResponse>;

export type PoliteClientOptions = {
  allowedHosts: readonly string[];
  userAgent: string;
  timeoutMs?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  jitterRatio?: number;
  fetchImpl?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Inspect a parsed body; throw an UpstreamError for API-level errors (e.g. MediaWiki maxlag). */
  checkBody?: (body: unknown) => void;
  onRetry?: (attempt: number, error: UpstreamError, waitMs: number) => void;
};

/** Upstream responses larger than this are refused (feeds/API pages are small). */
const MAX_BODY_CHARS = 5_000_000;

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function createPoliteJsonClient(opts: PoliteClientOptions) {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchFn);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const minInterval = Math.max(opts.minIntervalMs ?? 1500, 0);
  const maxRetries = opts.maxRetries ?? 3;
  const base = opts.baseBackoffMs ?? 2000;
  const jitterRatio = opts.jitterRatio ?? 0.25;
  const hosts = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  let last = -Infinity;
  let queue: Promise<unknown> = Promise.resolve();

  async function pace() {
    const wait = last + minInterval - now();
    if (wait > 0) await sleep(wait);
    last = now();
  }

  async function once(url: URL, as: 'json' | 'text', accept: string): Promise<unknown> {
    await pace();
    let res: MinimalResponse;
    try {
      res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': opts.userAgent, accept },
        redirect: 'manual',
      });
    } catch (error) {
      const e = error as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new UpstreamError('timeout', `${url.host} timed out after ${timeoutMs}ms`);
      const cause = (e as Error & { cause?: { code?: string } }).cause?.code;
      throw new UpstreamError('network', `Network error contacting ${url.host}: ${e.message}${cause ? ` (${cause})` : ''}`);
    }
    if (res.status === 429) {
      throw new UpstreamError('rate_limited', `${url.host} HTTP 429`, { status: 429, retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), now()) });
    }
    if (res.status >= 300 && res.status < 400) throw new UpstreamError('http', `${url.host} redirected (HTTP ${res.status}); not followed`, { status: res.status, retryable: false });
    if (!res.ok) {
      throw new UpstreamError('http', `${url.host} HTTP ${res.status}`, { status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), now()) });
    }
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) throw new UpstreamError('http', `${url.host} response too large`, { retryable: false });
    if (as === 'text') return text;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UpstreamError('not_json', `${url.host} returned non-JSON: "${text.slice(0, 120).replace(/\s+/g, ' ')}"`);
    }
    opts.checkBody?.(body);
    return body;
  }

  async function get<T>(url: URL, as: 'json' | 'text', accept: string): Promise<T> {
    if (url.protocol !== 'https:' || !hosts.has(url.hostname.toLowerCase())) {
      throw new UpstreamError('forbidden_host', `Refusing to fetch ${url.protocol}//${url.hostname}: not an allowed upstream`, { retryable: false });
    }
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return (await once(url, as, accept)) as T;
        } catch (error) {
          const e = error instanceof UpstreamError ? error : new UpstreamError('network', String(error));
          if (!e.retryable || attempt >= maxRetries) throw e;
          const backoff = (e.kind === 'rate_limited' ? base * 3 : base) * 2 ** attempt;
          const wait = Math.max(e.retryAfterMs ?? 0, Math.round(backoff * (1 + jitterRatio * random())));
          opts.onRetry?.(attempt + 1, e, wait);
          await sleep(wait);
        }
      }
    };
    // Bounded concurrency: one in-flight request per client.
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    getJson: <T = unknown>(url: URL) => get<T>(url, 'json', 'application/json'),
    getText: (url: URL, accept = 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9') => get<string>(url, 'text', accept),
  };
}

export type PoliteJsonClient = ReturnType<typeof createPoliteJsonClient>;
