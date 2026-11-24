/**
 * Config-driven RSS/Atom discovery (Node CLI + Cloudflare Workers).
 *
 * Who may be fetched is the owner's decision in packages/config/sources.policy.json:
 * a feed runs only if its source is rights-approved OR has `feedAccess.status: "allowed"`
 * (documented, reviewed permission to read the feed for METADATA). Feed access never
 * grants reuse rights — `licenseStatus` still gates every question, and a human approves each one.
 *
 * Only metadata is kept (title, link, date, guid) — never article bodies, images or HTML.
 * Every fetch: robots.txt check (fail closed), conditional GET (ETag / Last-Modified),
 * redirects only within the source's hosts, size cap, XML content-type required.
 */
import { cleanText, feedFetchAllowed, hostMatches } from '@gof/core';
import type { SourcePolicy } from '@gof/core';
import { productToken, robotsVerdictFor, type RobotsVerdict } from '../robots.ts';

export type FeedConfig = { id: string; url: string; sourceId: string; region?: string };
export type FeedItem = { title: string; link: string; publishedAt: string | null; guid: string | null };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** CDATA/markup-stripping entity decoder for untrusted feed or page text. */
export function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ') // never keep markup from a feed
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    // Entity-encoded markup (Atom type="html") becomes tags only after decoding: strip it too.
    .replace(/<\/?[a-z][^<>]*>/gi, ' ');
}

function safeChar(code: number): string {
  return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
}

function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/**
 * First `<name …>…</name>` inside [from, to) of the item (case-insensitive), decoded; null if absent.
 * indexOf on a lowercased copy: feeds embed whole article bodies, and per-tag regexes rescanning
 * them cost several ms of CPU per feed (Workers Free allows 10 ms per step).
 */
function field(xml: string, lower: string, from: number, to: number, name: string): string | null {
  const open = `<${name}`;
  let i = lower.indexOf(open, from);
  while (i !== -1 && i < to) {
    const next = lower.charCodeAt(i + open.length);
    // '>' or whitespace or '/': exact tag name (so <title> never matches <titlex>)
    if (next === 62 || next === 32 || next === 9 || next === 10 || next === 13 || next === 47) {
      const gt = lower.indexOf('>', i);
      if (gt === -1 || gt >= to) return null;
      if (lower.charCodeAt(gt - 1) === 47) return null; // self-closing, no text
      const close = lower.indexOf(`</${name}>`, gt);
      if (close === -1 || close > to) return null;
      return decode(xml.slice(gt + 1, close)).trim();
    }
    i = lower.indexOf(open, i + 1);
  }
  return null;
}

/** Parse RSS 2.0 <item> or Atom <entry> blocks. Malformed entries are skipped, not fatal. */
export function parseFeed(xml: string, maxItems = 100): FeedItem[] {
  if (/<!DOCTYPE[^>]*\[/i.test(xml)) return []; // refuse inline DTDs (entity expansion)
  const lower = xml.toLowerCase();
  const out: FeedItem[] = [];
  const start = /<(item|entry)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = start.exec(lower)) && seen < maxItems) {
    const from = m.index + m[0].length;
    const to = lower.indexOf(`</${m[1]}>`, from);
    if (to === -1) break; // truncated feed: the last partial item is dropped
    start.lastIndex = to;
    seen++;
    const title = cleanText(field(xml, lower, from, to, 'title') ?? '', 400);
    let link = field(xml, lower, from, to, 'link');
    if (!link) link = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(xml.slice(from, to))?.[1] ?? null;
    if (!title || !link) continue;
    out.push({
      title,
      link: decode(link).trim(),
      publishedAt: toIsoDate(field(xml, lower, from, to, 'pubdate') ?? field(xml, lower, from, to, 'published') ?? field(xml, lower, from, to, 'updated') ?? field(xml, lower, from, to, 'dc:date')),
      guid: cleanText(field(xml, lower, from, to, 'guid') ?? field(xml, lower, from, to, 'id') ?? '', 300) || null,
    });
  }
  return out;
}

/** Feeds allowed to run: the source exists, its feed may be fetched (owner policy), and the URL is https on its hosts. */
export function allowedFeeds(feeds: readonly FeedConfig[], lookup: (id: string) => SourcePolicy | undefined): { allowed: FeedConfig[]; refused: { id: string; reason: string }[] } {
  const allowed: FeedConfig[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const f of feeds) {
    const src = lookup(f.sourceId);
    if (!src) {
      refused.push({ id: f.id, reason: `unknown source ${f.sourceId}` });
      continue;
    }
    const access = feedFetchAllowed(src);
    let host = '';
    try {
      host = new URL(f.url).hostname;
    } catch {
      /* invalid URL → refused below */
    }
    if (!access.ok) refused.push({ id: f.id, reason: `${src.id}: ${access.reason}` });
    else if (!/^https:\/\//.test(f.url) || !host || !hostMatches(host, src.hosts)) refused.push({ id: f.id, reason: 'feed URL is not https on the source host' });
    else allowed.push(f);
  }
  return { allowed, refused };
}

// ---------------------------------------------------------------------------
// Network (fetch-based: works in Node 22 and Workers)
// ---------------------------------------------------------------------------

export class FeedError extends Error {
  constructor(
    readonly kind: 'robots' | 'http' | 'rate_limited' | 'not_feed' | 'redirect' | 'network' | 'timeout',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FeedError';
  }
}

export type FeedFetchResult =
  | { status: 'ok'; items: FeedItem[]; etag: string | null; lastModified: string | null; bytes: number; truncated: boolean }
  | { status: 'not_modified' };

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** Feeds are small; anything bigger is truncated (whole items only) to bound memory and CPU. */
export const MAX_FEED_CHARS = 1_000_000;
const MAX_HOPS = 3;

async function send(fetchImpl: FetchFn, url: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  try {
    return await fetchImpl(url, { method: 'GET', redirect: 'manual', headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const e = error as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new FeedError('timeout', `${new URL(url).host} timed out after ${timeoutMs}ms`);
    throw new FeedError('network', `network error contacting ${new URL(url).host}: ${e.message}`.slice(0, 200));
  }
}

/** GET with redirects followed only to https URLs on `hosts` (max 3 hops). */
async function getOnHosts(fetchImpl: FetchFn, url: string, hosts: readonly string[], headers: Record<string, string>, timeoutMs: number): Promise<{ res: Response; url: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await send(fetchImpl, current, headers, timeoutMs);
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      await res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get('location');
      if (!loc) throw new FeedError('redirect', `HTTP ${res.status} without Location`, res.status);
      const next = new URL(loc, current);
      if (next.protocol !== 'https:' || !hostMatches(next.hostname, hosts)) throw new FeedError('redirect', `redirect to ${next.protocol}//${next.hostname} leaves the source; not followed`, res.status);
      current = next.toString();
      continue;
    }
    return { res, url: current };
  }
  throw new FeedError('redirect', `more than ${MAX_HOPS} redirects`);
}

/** robots.txt verdict for the feed URL (RFC 9309; unreachable / 5xx → disallow). */
export async function checkRobots(feedUrl: string, hosts: readonly string[], opts: { fetchImpl?: FetchFn; userAgent: string; timeoutMs?: number }): Promise<RobotsVerdict> {
  const fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const u = new URL(feedUrl);
  let outcome: { status: number; body?: string } | { error: string };
  try {
    const { res } = await getOnHosts(fetchImpl, `https://${u.host}/robots.txt`, hosts, { 'user-agent': opts.userAgent, accept: 'text/plain' }, opts.timeoutMs ?? 10_000);
    outcome = { status: res.status, body: res.ok ? (await res.text()).slice(0, 500 * 1024) : (await res.body?.cancel().catch(() => undefined), undefined) };
  } catch (error) {
    outcome = { error: (error as Error).message };
  }
  return robotsVerdictFor(outcome, productToken(opts.userAgent), u.pathname + u.search);
}

/** Conditional GET of one feed. 304 → not_modified; never follows redirects off the source. */
export async function fetchFeedConditional(
  feed: FeedConfig,
  hosts: readonly string[],
  opts: { fetchImpl?: FetchFn; userAgent: string; etag?: string | null; lastModified?: string | null; timeoutMs?: number; maxChars?: number },
): Promise<FeedFetchResult> {
  const fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const headers: Record<string, string> = {
    'user-agent': opts.userAgent,
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
    ...(opts.etag ? { 'if-none-match': opts.etag } : {}),
    ...(opts.lastModified ? { 'if-modified-since': opts.lastModified } : {}),
  };
  const { res } = await getOnHosts(fetchImpl, feed.url, hosts, headers, opts.timeoutMs ?? 15_000);
  if (res.status === 304) return { status: 'not_modified' };
  if (res.status === 429) {
    await res.body?.cancel().catch(() => undefined);
    throw new FeedError('rate_limited', `${feed.id}: HTTP 429`, 429);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new FeedError('http', `${feed.id}: HTTP ${res.status}`, res.status);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/xml|rss|atom/i.test(type)) {
    await res.body?.cancel().catch(() => undefined);
    throw new FeedError('not_feed', `${feed.id}: not a feed (content-type ${type.slice(0, 60) || 'none'})`);
  }
  const max = opts.maxChars ?? MAX_FEED_CHARS;
  const text = await res.text();
  const truncated = text.length > max;
  return { status: 'ok', items: parseFeed(truncated ? text.slice(0, max) : text), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), bytes: text.length, truncated };
}
