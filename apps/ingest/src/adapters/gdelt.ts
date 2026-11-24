/**
 * Minimal client for the GDELT DOC 2.0 API, ArtList mode, JSON output.
 * Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
 *
 * Only documented parameters are used: query, mode, format, maxrecords
 * (max 250), timespan, sort. Historical coverage has changed over time
 * (see the 2020 "1.5 year searching" update), so we don't hard-code a window:
 * keep `timespan` short and ingest regularly.
 *
 * GDELT returns news *metadata* and is a discovery index. It is not a licence
 * to copy publishers' headlines, text or images. `seendate` is when GDELT saw
 * the article, not necessarily when it was published.
 */

export const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
export const GDELT_MAX_RECORDS = 250;
/** Never go faster than one request per 5 seconds. */
export const GDELT_MIN_DELAY_MS = 5_000;

export type GdeltQueryOptions = {
  query: string;
  maxRecords?: number;
  timespan?: string;
  sort?: 'DateDesc' | 'DateAsc' | 'HybridRel';
  endpoint?: string;
};

export type GdeltArticle = {
  url: string;
  title: string;
  domain: string;
  seenAt?: string;
  language?: string;
  sourceCountry?: string;
};

export type GdeltErrorKind = 'http' | 'rate_limited' | 'not_json' | 'bad_shape' | 'api_message' | 'network' | 'timeout';

export class GdeltError extends Error {
  readonly kind: GdeltErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(kind: GdeltErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'GdeltError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable = kind === 'rate_limited' || kind === 'network' || kind === 'timeout' || (kind === 'http' && (opts.status ?? 0) >= 500);
  }
}

const TIMESPAN = /^\d+(min|h|hours|d|days|w|weeks|m|months)$/;

export function buildGdeltUrl(opts: GdeltQueryOptions): URL {
  const query = opts.query.trim();
  if (!query) throw new Error('GDELT query must not be empty');
  const maxRecords = opts.maxRecords ?? 100;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > GDELT_MAX_RECORDS) {
    throw new Error(`maxRecords must be 1-${GDELT_MAX_RECORDS}`);
  }
  const url = new URL(opts.endpoint ?? GDELT_ENDPOINT);
  url.searchParams.set('query', query);
  url.searchParams.set('mode', 'ArtList');
  url.searchParams.set('format', 'json');
  url.searchParams.set('maxrecords', String(maxRecords));
  if (opts.timespan) {
    if (!TIMESPAN.test(opts.timespan)) throw new Error(`Invalid timespan "${opts.timespan}" (e.g. 2w, 7d, 3m)`);
    url.searchParams.set('timespan', opts.timespan);
  }
  url.searchParams.set('sort', opts.sort ?? 'DateDesc');
  return url;
}

/** GDELT `seendate` looks like 20261119T153000Z. Returns ISO 8601 or undefined. */
export function parseSeenDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value.trim());
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : new Date(iso).toISOString();
}

function str(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

/**
 * Parse an ArtList JSON body. GDELT reports query problems as plain text
 * (with HTTP 200), so a non-JSON body is surfaced as an explicit error.
 */
export function parseGdeltBody(body: string): GdeltArticle[] {
  const trimmed = body.trim();
  if (trimmed === '' || trimmed === '{}') return [];
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    const snippet = trimmed.slice(0, 200).replace(/\s+/g, ' ');
    if (/limit requests|too many|rate/i.test(snippet)) {
      throw new GdeltError('rate_limited', `GDELT asked us to slow down: "${snippet}"`, { retryAfterMs: 10_000 });
    }
    throw new GdeltError(trimmed.startsWith('<') ? 'not_json' : 'api_message', `GDELT returned a non-JSON response: "${snippet}"`);
  }
  if (typeof payload !== 'object' || payload === null) throw new GdeltError('bad_shape', 'GDELT JSON is not an object');
  const articles = (payload as { articles?: unknown }).articles;
  if (articles === undefined) return [];
  if (!Array.isArray(articles)) throw new GdeltError('bad_shape', 'GDELT "articles" is not an array');

  const out: GdeltArticle[] = [];
  for (const raw of articles) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const url = str(r.url, 2000);
    const title = str(r.title, 400);
    if (!url || !title) continue;
    let domain = str(r.domain, 200);
    if (!domain) {
      try {
        domain = new URL(url).hostname;
      } catch {
        continue;
      }
    }
    out.push({
      url,
      title,
      domain: domain.toLowerCase().replace(/^www\./, ''),
      seenAt: parseSeenDate(r.seendate),
      language: str(r.language, 50),
      sourceCountry: str(r.sourcecountry, 80),
    });
  }
  return out;
}

export type FetchLike = (input: URL, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type FetchArticlesOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  /** Adds up to this fraction of random jitter to each backoff (0 = none, for deterministic tests). */
  jitterRatio?: number;
  random?: () => number;
  onRetry?: (attempt: number, error: GdeltError, waitMs: number) => void;
  /** false: a 429 ends the request immediately (being told to slow down is not a transient error). */
  retryRateLimited?: boolean;
};

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function fetchOnce(url: URL, opts: Required<Pick<FetchArticlesOptions, 'timeoutMs' | 'userAgent'>> & { fetchImpl: FetchLike }) {
  let res;
  try {
    res = await opts.fetchImpl(url, {
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { 'user-agent': opts.userAgent, accept: 'application/json' },
    });
  } catch (error) {
    const e = error as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new GdeltError('timeout', `GDELT request timed out after ${opts.timeoutMs}ms`);
    const cause = (e as Error & { cause?: { code?: string } }).cause?.code;
    throw new GdeltError('network', `Network error contacting GDELT: ${e.message}${cause ? ` (${cause})` : ''}`);
  }
  if (res.status === 429) {
    throw new GdeltError('rate_limited', 'GDELT HTTP 429 (rate limited)', { status: 429, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) });
  }
  if (!res.ok) throw new GdeltError('http', `GDELT HTTP ${res.status}`, { status: res.status });
  return parseGdeltBody(await res.text());
}

/** Fetch one query with timeout, bounded retries and exponential backoff. */
export async function fetchGdeltArticles(url: URL, options: FetchArticlesOptions = {}): Promise<GdeltArticle[]> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const maxRetries = options.maxRetries ?? 3;
  const base = Math.max(options.baseBackoffMs ?? GDELT_MIN_DELAY_MS, 0);
  const sleep = options.sleep ?? defaultSleep;
  const settings = { fetchImpl, timeoutMs: options.timeoutMs ?? 30_000, userAgent: options.userAgent ?? 'gta-or-florida-ingest/0.2' };

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url, settings);
    } catch (error) {
      const e = error instanceof GdeltError ? error : new GdeltError('network', String(error));
      if (!e.retryable || attempt >= maxRetries || (e.kind === 'rate_limited' && options.retryRateLimited === false)) throw e;
      // Being told to slow down earns a longer pause than a transient server error.
      const step = e.kind === 'rate_limited' ? base * 3 : base;
      const backoff = step * 2 ** attempt;
      const jitter = (options.jitterRatio ?? 0) * backoff * (options.random ?? Math.random)();
      const wait = Math.max(e.retryAfterMs ?? 0, Math.round(backoff + jitter));
      options.onRetry?.(attempt + 1, e, wait);
      await sleep(wait);
    }
  }
}

/** Enforces a minimum gap between consecutive calls (conservative pacing). */
export function createPacer(minDelayMs: number, sleep: (ms: number) => Promise<void> = defaultSleep, now: () => number = Date.now) {
  const gap = Math.max(minDelayMs, GDELT_MIN_DELAY_MS);
  let last = -Infinity;
  return async function pace(): Promise<void> {
    const wait = last + gap - now();
    if (wait > 0) await sleep(wait);
    last = now();
  };
}
