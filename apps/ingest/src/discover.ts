/**
 * Provider discovery → `Discovered` records. Each provider is rate-limited and
 * failure-isolated; a 429 stops that provider for this run (no infinite retry).
 * Checkpoints come from the Worker (D1) and are only advanced after a
 * successful import (see run.ts).
 */
import { canonicalizeUrl, cleanText } from '@gof/core';
import { sourceById } from '@gof/config';
import { buildGdeltUrl, createPacer, fetchGdeltArticles, GdeltError, type FetchLike } from './adapters/gdelt.ts';
import { extractArticles, type ExtractMode, type WikiClient } from './adapters/grandtheftwiki.ts';
import { createPoliteJsonClient } from './adapters/http.ts';
import { allowedFeeds, fetchFeed } from './adapters/rss.ts';
import { floridaEvidence, prefilterFlorida, prefilterGta } from './filters.ts';
import { createFloridaSignal, normalizePublisherUrl, selectBatches, type SourcesConfig } from './normalize.ts';
import type { Discovered } from './pipeline.ts';

export type Log = { info(m: string): void; warn(m: string): void; error(m: string): void };

export type DiscoveryResult = { items: Discovered[]; errors: string[]; checkpoints: { provider: string; key: string; value: string }[]; fetched: number; rateLimited: boolean };

/** Title + URL metadata → a Florida `Discovered` record (shared by GDELT, RSS and manual `ingest:url`). */
export function floridaRecord(
  cfg: SourcesConfig,
  a: { title: string; url: string; canonicalUrl?: string; seenAt?: string | null; publishedAt?: string | null; provider: 'gdelt' | 'rss' | 'manual'; guid?: string | null; notes?: string | null },
): Discovered | null {
  const title = cleanText(a.title, 400);
  const canonicalUrl = normalizePublisherUrl(a.canonicalUrl ?? a.url);
  if (!title || !canonicalUrl || !/^https:\/\//.test(a.url)) return null;
  const domain = new URL(canonicalUrl).hostname;
  const signal = createFloridaSignal(cfg)({ title, domain });
  return {
    kind: 'FLORIDA_NEWS',
    provider: a.provider,
    providerKey: a.guid ? `${domain}:${a.guid}`.slice(0, 300) : null,
    title,
    originalUrl: a.url.slice(0, 2048),
    canonicalUrl,
    publisher: domain,
    publishedAt: a.publishedAt ?? null,
    seenAt: a.seenAt ?? null,
    excerpt: '',
    gameHint: null,
    wikiPageId: null,
    wikiSection: null,
    floridaSignal: signal,
    floridaEvidence: floridaEvidence(title, cfg.floridaPlaceNames),
    notes: a.notes ?? null,
    prefilter: prefilterFlorida({ title, domain, floridaSignal: signal, blockedDomains: cfg.domains.blocked.list }),
  };
}

export async function discoverGdelt(
  cfg: SourcesConfig,
  opts: { checkpoint: Map<string, string>; queries: number; timespan?: string; endpoint?: string; userAgent: string; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; log: Log },
): Promise<DiscoveryResult> {
  const g = cfg.gdelt;
  const start = Number(opts.checkpoint.get('nextBatchIndex') ?? 0) || 0;
  const { selected, next } = selectBatches(g.batches, start, Math.min(opts.queries, 6));
  const pace = createPacer(g.minDelaySeconds * 1000, opts.sleep);
  const out: DiscoveryResult = { items: [], errors: [], checkpoints: [], fetched: 0, rateLimited: false };
  let done = 0;
  for (const batch of selected) {
    const query = [batch.query, g.queryOperators].filter(Boolean).join(' ');
    try {
      await pace();
      const articles = await fetchGdeltArticles(buildGdeltUrl({ query, maxRecords: g.maxRecords, timespan: opts.timespan ?? g.timespan, sort: g.sort, endpoint: opts.endpoint }), {
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
        timeoutMs: 30_000,
        userAgent: opts.userAgent,
        jitterRatio: 0.2,
        maxRetries: 2,
        onRetry: (n, e, wait) => opts.log.warn(`[gdelt:${batch.id}] ${e.message}; retry ${n} in ${Math.round(wait / 1000)}s`),
      });
      out.fetched += articles.length;
      opts.log.info(`[gdelt:${batch.id}] ${articles.length} articles`);
      for (const a of articles) {
        const rec = floridaRecord(cfg, { title: a.title, url: a.url, seenAt: a.seenAt ?? null, provider: 'gdelt' });
        if (rec) out.items.push(rec);
      }
      done++;
    } catch (error) {
      out.errors.push(`gdelt:${batch.id}: ${(error as Error).message}`.slice(0, 300));
      opts.log.error(`[gdelt:${batch.id}] ${(error as Error).message}`);
      if (error instanceof GdeltError && error.kind === 'rate_limited') {
        out.rateLimited = true;
        break;
      }
    }
  }
  // Advance the rotation only past batches that actually ran.
  const value = done === selected.length ? next : (start + done) % Math.max(g.batches.length, 1);
  if (done > 0) out.checkpoints.push({ provider: 'gdelt', key: 'nextBatchIndex', value: String(value) });
  return out;
}

export async function discoverRss(cfg: SourcesConfig, opts: { userAgent: string; minIntervalMs: number; fetchImpl?: Parameters<typeof createPoliteJsonClient>[0]['fetchImpl']; log: Log }): Promise<DiscoveryResult> {
  const out: DiscoveryResult = { items: [], errors: [], checkpoints: [], fetched: 0, rateLimited: false };
  const { allowed, refused } = allowedFeeds(cfg.rss ?? [], (id) => sourceById(id));
  for (const r of refused) opts.log.info(`[rss:${r.id}] not fetched: ${r.reason}`);
  for (const feed of allowed) {
    const client = createPoliteJsonClient({ allowedHosts: [new URL(feed.url).hostname], userAgent: opts.userAgent, minIntervalMs: opts.minIntervalMs, fetchImpl: opts.fetchImpl, maxRetries: 2 });
    try {
      const items = await fetchFeed(client, feed);
      out.fetched += items.length;
      for (const it of items) {
        const rec = floridaRecord(cfg, { title: it.title, url: it.link, publishedAt: it.publishedAt, provider: 'rss', guid: it.guid });
        if (rec) out.items.push(rec);
      }
    } catch (error) {
      out.errors.push(`rss:${feed.id}: ${(error as Error).message}`.slice(0, 300));
    }
  }
  return out;
}

/** One page of category members resolved to target pages (redirect aliases grouped per target, API order). */
export async function wikiTargets(client: WikiClient, category: string, cont: string | undefined): Promise<{ targets: { pageId: number; aliases: string[] }[]; next: string | null }> {
  const { members, next } = await client.categoryMembers(category, cont);
  const resolutions = [];
  for (let i = 0; i < members.length; i += 50) resolutions.push(...(await client.resolve(members.slice(i, i + 50).map((m) => m.title))));
  const targets = new Map<number, string[]>();
  for (const r of resolutions) {
    const aliases = targets.get(r.targetPageId) ?? [];
    if (r.isRedirect) aliases.push(r.fragment ?? r.memberTitle);
    targets.set(r.targetPageId, aliases);
  }
  return { targets: [...targets].map(([pageId, aliases]) => ({ pageId, aliases })), next };
}

/** Fetch one wiki page and turn its in-game articles into GTA `Discovered` records. */
export async function wikiPageRecords(client: WikiClient, cat: { name: string; mode: string }, pageId: number, aliases: string[]): Promise<Discovered[]> {
  const page = await client.page(pageId);
  const { articles } = extractArticles(page, { wikiBase: client.wikiBase, mode: cat.mode as ExtractMode, category: cat.name, aliases });
  return articles.map((a) => {
    const title = cleanText(a.headline, 300);
    const canonicalUrl = canonicalizeUrl(a.canonicalUrl) ?? a.canonicalUrl;
    return {
      kind: 'GTA_CANON' as const,
      provider: 'grandtheftwiki' as const,
      providerKey: a.key,
      title,
      // Pretty URL with #section is what players open; the curid permalink is the stable identity.
      originalUrl: a.url,
      canonicalUrl: a.canonicalUrl.startsWith('https://') ? a.canonicalUrl : canonicalUrl,
      publisher: 'Grand Theft Wiki',
      publishedAt: null,
      seenAt: null,
      excerpt: cleanText(a.lead, 800),
      gameHint: a.gameHint,
      wikiPageId: a.pageId,
      wikiSection: a.sectionAnchor,
      floridaSignal: 'none' as const,
      floridaEvidence: null,
      notes: [a.needsReviewReason ? `REVIEW: ${a.needsReviewReason}` : null, a.outlet ? `Outlet: ${a.outlet}` : null, a.aliases.length ? `Aliases: ${a.aliases.join(', ')}` : null]
        .filter(Boolean)
        .join('\n') || null,
      prefilter: prefilterGta({ title, needsReviewReason: a.needsReviewReason }),
    };
  });
}

export async function discoverWiki(
  cfg: SourcesConfig,
  client: WikiClient,
  opts: { checkpoint: Map<string, string>; maxMemberPages: number; log: Log },
): Promise<DiscoveryResult> {
  const out: DiscoveryResult = { items: [], errors: [], checkpoints: [], fetched: 0, rateLimited: false };
  const fetchedPages = new Set<number>();
  for (const cat of cfg.grandTheftWiki?.categories ?? []) {
    const key = `cmcontinue:${cat.name}`;
    let cont: string | undefined = opts.checkpoint.get(key) || undefined;
    let ok = true;
    for (let n = 0; n < opts.maxMemberPages; n++) {
      try {
        const { targets, next } = await wikiTargets(client, cat.name, cont);
        for (const { pageId, aliases } of targets) {
          if (fetchedPages.has(pageId)) continue;
          fetchedPages.add(pageId);
          try {
            const records = await wikiPageRecords(client, cat, pageId, aliases);
            out.fetched += records.length;
            out.items.push(...records);
          } catch (error) {
            out.errors.push(`wiki:page:${pageId}: ${(error as Error).message}`.slice(0, 300));
          }
        }
        cont = next ?? undefined;
        if (!next) break;
      } catch (error) {
        ok = false;
        out.errors.push(`wiki:${cat.name}: ${(error as Error).message}`.slice(0, 300));
        if ((error as { kind?: string }).kind === 'rate_limited') out.rateLimited = true;
        break;
      }
    }
    // Empty value = category finished; the next run starts it again from the top (known keys skip repeats).
    if (ok) out.checkpoints.push({ provider: 'grandtheftwiki', key, value: cont ?? '' });
    if (out.rateLimited) break;
  }
  return out;
}
