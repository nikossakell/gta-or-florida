/**
 * Single publisher article fetch for the owner's manual `ingest:url` command.
 *
 * The URL comes from the CLI, so it is treated as untrusted input:
 * - Shape: https only, port 443, no credentials, no IP literals, no local or
 *   single-label hostnames, no aggregator/AMP-cache hosts, not a blocked
 *   (satire) domain, and the host's source policy must be a non-blocked
 *   publisher. Unknown hosts are allowed and stay `unreviewed`.
 * - Network: every hop resolves through `safeLookup`, which refuses any
 *   private/reserved answer inside the socket's own lookup (no DNS-rebinding gap).
 * - Redirects: followed manually (max 5); every hop is re-validated, and a hop
 *   to a different source is refused (no shorteners or off-site laundering).
 * - Body: HTML only, read up to a byte cap, uncompressed. Only metadata is
 *   extracted (title, canonical link, publication date, site name); the
 *   article text is never kept.
 */
import { request } from 'node:https';
import { sourceForUrl } from '@gof/config';
import { domainMatches, normalizePublisherUrl, type SourcesConfig } from '../normalize.ts';
import { safeLookup, unsafeUrlReason } from '../verify.ts';
import { decode } from './rss.ts';

export type ArticleResponse = { status: number; location?: string; contentType?: string; body?: string; retryAfter?: string };
export type ArticleRequest = (url: URL) => Promise<ArticleResponse>;

export type FetchedArticle = { finalUrl: string; httpStatus: number; redirects: number; html: string };

export type ArticleMeta = { title: string | null; canonicalUrl: string | null; publishedAt: string | null; siteName: string | null };

export class ArticleRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArticleRefusedError';
  }
}

/** Non-2xx answer (carries the status so callers can back off on 429/5xx and stop on 401/403). */
export class ArticleHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ArticleHttpError';
  }
}

const LOCAL_SUFFIXES = /\.(local|localhost|internal|intranet|lan|home|corp|home\.arpa|localdomain)$/i;
const MAX_REDIRECTS = 5;
/** Enough for any <head> (metadata lives there); the rest of the page is never needed. */
const MAX_BYTES = 1_500_000;

/**
 * Why this URL may not be ingested (null = acceptable), before any network access.
 * Also used for every redirect hop and for the page's declared canonical URL.
 */
export function articleUrlProblem(raw: string, cfg: Pick<SourcesConfig, 'domains'>): string | null {
  const shape = unsafeUrlReason(raw);
  if (shape) return shape;
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || LOCAL_SUFFIXES.test(host)) return 'local or single-label hostname';
  if (!normalizePublisherUrl(url.href)) return 'aggregator or AMP-cache URL; submit the publisher\'s own article URL';
  if (domainMatches(host, cfg.domains.blocked.list)) return `${host} is a blocked (satire or excluded) domain`;
  const src = sourceForUrl(url);
  if (src.licenseStatus === 'blocked') return `source ${src.id} is blocked by the owner's source policy`;
  if (src.type !== 'publisher') return `source ${src.id} is a ${src.type}, not a news publisher`;
  return null;
}

function nodeGet(url: URL, timeoutMs: number, userAgent: string): Promise<ArticleResponse> {
  return new Promise((resolvePromise, reject) => {
    const deadline = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    const req = request(
      url,
      {
        method: 'GET',
        lookup: safeLookup as never,
        timeout: timeoutMs,
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml;q=0.9', 'accept-encoding': 'identity', 'accept-language': 'en' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
        const contentType = res.headers['content-type'];
        const retryAfter = typeof res.headers['retry-after'] === 'string' ? res.headers['retry-after'] : undefined;
        const done = (body?: string) => {
          clearTimeout(deadline);
          resolvePromise({ status, location, contentType, body, retryAfter });
          res.destroy();
        };
        if (status < 200 || status >= 300 || !/html/i.test(contentType ?? '') || /gzip|br|deflate/i.test(String(res.headers['content-encoding'] ?? ''))) {
          res.resume();
          return done();
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          size += c.length;
          if (size >= MAX_BYTES) done(Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8'));
        });
        res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
        res.on('error', (e) => {
          clearTimeout(deadline);
          reject(e);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', (e) => {
      clearTimeout(deadline);
      reject(e);
    });
    req.end();
  });
}

/** Fetch one article page with per-hop validation. Throws ArticleRefusedError (policy) or Error (network/HTTP). */
export async function fetchArticle(
  raw: string,
  opts: { cfg: Pick<SourcesConfig, 'domains'>; userAgent: string; timeoutMs?: number; requestImpl?: ArticleRequest },
): Promise<FetchedArticle> {
  const send = opts.requestImpl ?? ((u: URL) => nodeGet(u, opts.timeoutMs ?? 15_000, opts.userAgent));
  const first = articleUrlProblem(raw, opts.cfg);
  if (first) throw new ArticleRefusedError(first);
  const sourceId = sourceForUrl(raw).id;

  let current = new URL(raw).href;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop > 0) {
      const problem = articleUrlProblem(current, opts.cfg);
      if (problem) throw new ArticleRefusedError(`redirect target rejected (${current.slice(0, 120)}): ${problem}`);
      const next = sourceForUrl(current).id;
      if (next !== sourceId) throw new ArticleRefusedError(`redirect leaves ${sourceId} for ${next}; submit the publisher's final article URL directly`);
    }
    const url = new URL(current);
    let res: ArticleResponse;
    try {
      res = await send(url);
    } catch (error) {
      throw new Error(`${url.host}: ${(error as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new Error(`${url.host} HTTP ${res.status} without a Location header`);
      current = new URL(res.location, url).href;
      continue;
    }
    const retryAfter = res.retryAfter && /^\d{1,5}$/.test(res.retryAfter) ? Number(res.retryAfter) : null;
    if (res.status === 429) throw new ArticleHttpError(429, `${url.host} HTTP 429 (rate limited); try again later`, retryAfter);
    if (res.status < 200 || res.status >= 300) throw new ArticleHttpError(res.status, `${url.host} HTTP ${res.status}`, retryAfter);
    if (!/html/i.test(res.contentType ?? '')) throw new ArticleRefusedError(`${url.host} did not return an HTML page (content-type: ${res.contentType ?? 'none'})`);
    if (res.body === undefined) throw new Error(`${url.host} returned an unreadable (compressed or empty) body`);
    return { finalUrl: current, httpStatus: res.status, redirects: hop, html: res.body };
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const k = m[1]!.toLowerCase();
    if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function toIso(value: string | undefined, now: Date): string | null {
  if (!value) return null;
  const t = Date.parse(value.trim());
  if (Number.isNaN(t)) return null;
  // Implausible dates (pre-web, or more than a day in the future) are dropped, not guessed.
  if (t < Date.UTC(1995, 0, 1) || t > now.getTime() + 86_400_000) return null;
  return new Date(t).toISOString();
}

const text = (v: string | undefined | null) => {
  const t = v ? decode(v).replace(/\s+/g, ' ').trim() : '';
  return t || null;
};

/** Page metadata only (never body text). All values are untrusted and length-capped downstream. */
export function extractArticleMeta(html: string, pageUrl: string, now: Date = new Date()): ArticleMeta {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html.slice(0, 300_000);
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = text(meta.get('og:title')) ?? text(meta.get('twitter:title')) ?? text(titleTag);

  let canonicalUrl: string | null = null;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a.rel ?? '').toLowerCase().split(/\s+/).includes('canonical') && a.href) {
      try {
        canonicalUrl = new URL(decode(a.href).trim(), pageUrl).href;
      } catch {
        canonicalUrl = null;
      }
      break;
    }
  }

  const jsonLdDate = /"datePublished"\s*:\s*"([^"]{8,40})"/.exec(html)?.[1];
  const publishedAt =
    ['article:published_time', 'datepublished', 'og:published_time', 'pubdate', 'parsely-pub-date', 'sailthru.date', 'dc.date', 'dc.date.issued', 'date']
      .map((k) => toIso(meta.get(k), now))
      .find((v) => v !== null) ??
    toIso(jsonLdDate, now) ??
    null;

  return { title, canonicalUrl, publishedAt, siteName: text(meta.get('og:site_name')) };
}

/** The page's canonical URL when it is acceptable and stays on the same source; otherwise the fetched URL. */
export function chooseCanonical(meta: ArticleMeta, finalUrl: string, cfg: Pick<SourcesConfig, 'domains'>): string {
  const c = meta.canonicalUrl;
  if (!c || articleUrlProblem(c, cfg)) return finalUrl;
  return sourceForUrl(c).id === sourceForUrl(finalUrl).id ? c : finalUrl;
}
