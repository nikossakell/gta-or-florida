/**
 * Provider discovery → `Discovered` records. Each provider is rate-limited and
 * failure-isolated. Cursor checkpoints come from the Worker (D1) and only advance
 * after a successful import; `guards` (GDELT cooldown) are saved even when a run
 * fails, so a 429 is never followed by more requests before the cooldown ends.
 */
import { canonicalizeUrl, cleanText, hostMatches, type SourcePolicy } from '@gof/core';
import { sourceById } from '@gof/config';
import { buildGdeltUrl, createPacer, fetchGdeltArticles, GdeltError, type FetchLike } from './adapters/gdelt.ts';
import { extractArticles, type ExtractMode, type WikiClient } from './adapters/grandtheftwiki.ts';
import { allowedFeeds, checkRobots, fetchFeedConditional, type FeedConfig } from './adapters/rss.ts';
import { dojDateline, dojPageUrl, FLORIDA_DISTRICTS, isAllegation, parseDojPage, prefilterDoj, type LegalStatus } from './adapters/doj.ts';
import { datasetDayUrl, DATASET_DAYS, DATASET_PROVENANCE, parseDatasetDay } from './adapters/floridaman-dataset.ts';
import { describeUnusualness, floridaEvidence, prefilterFlorida, prefilterGta, unusualness } from './filters.ts';
import { createFloridaSignal, normalizePublisherUrl, selectBatches, type SourcesConfig } from './normalize.ts';
import type { Discovered } from './pipeline.ts';

export type Log = { info(m: string): void; warn(m: string): void; error(m: string): void };

export type Checkpoint = { provider: string; key: string; value: string };
export type DiscoveryResult = {
  items: Discovered[];
  errors: string[];
  /** Cursors: saved only with a successful import. */
  checkpoints: Checkpoint[];
  /** Safety state (rate-limit cooldowns): saved even when the run fails. */
  guards?: Checkpoint[];
  fetched: number;
  rateLimited: boolean;
  /** Why the provider did not run at all (e.g. cooldown). */
  skipped?: string;
};

/** Title + URL metadata → a Florida `Discovered` record (shared by GDELT, RSS and manual `ingest:url`). */
export function floridaRecord(
  cfg: SourcesConfig,
  a: { title: string; url: string; canonicalUrl?: string; seenAt?: string | null; publishedAt?: string | null; provider: 'gdelt' | 'rss' | 'manual' | 'doj' | 'floridaman_dataset'; guid?: string | null; notes?: string | null; aiAllowed?: boolean },
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
    ...(a.aiAllowed === false ? { aiAllowed: false } : {}),
  };
}

/** GDELT cooldown after a 429: 6 h, doubling per consecutive 429, capped at 48 h. */
export const GDELT_COOLDOWN_BASE_MS = 6 * 3600_000;
export const GDELT_COOLDOWN_MAX_MS = 48 * 3600_000;
export function gdeltCooldownMs(strikes: number): number {
  return Math.min(GDELT_COOLDOWN_BASE_MS * 2 ** Math.max(strikes - 1, 0), GDELT_COOLDOWN_MAX_MS);
}

export async function discoverGdelt(
  cfg: SourcesConfig,
  opts: { checkpoint: Map<string, string>; queries: number; timespan?: string; endpoint?: string; userAgent: string; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; log: Log; now?: Date },
): Promise<DiscoveryResult> {
  const g = cfg.gdelt;
  const out: DiscoveryResult = { items: [], errors: [], checkpoints: [], guards: [], fetched: 0, rateLimited: false };
  const now = opts.now ?? new Date();
  const until = Date.parse(opts.checkpoint.get('cooldownUntil') ?? '');
  if (!Number.isNaN(until) && now.getTime() < until) {
    out.skipped = `GDELT cooldown until ${new Date(until).toISOString()} after HTTP 429`;
    opts.log.info(`[gdelt] skipped: ${out.skipped}`);
    return out;
  }
  const strikes = Number(opts.checkpoint.get('strikes') ?? 0) || 0;
  const start = Number(opts.checkpoint.get('nextBatchIndex') ?? 0) || 0;
  const { selected, next } = selectBatches(g.batches, start, Math.min(opts.queries, 6));
  const pace = createPacer(g.minDelaySeconds * 1000, opts.sleep);
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
        retryRateLimited: false,
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
  if (out.rateLimited) {
    const s = strikes + 1;
    const wait = Math.max(gdeltCooldownMs(s), 0);
    out.guards!.push({ provider: 'gdelt', key: 'strikes', value: String(s) }, { provider: 'gdelt', key: 'cooldownUntil', value: new Date(now.getTime() + wait).toISOString() });
    opts.log.warn(`[gdelt] HTTP 429: cooling down ${Math.round(wait / 3600_000)} h (strike ${s})`);
  } else if (done > 0 && strikes > 0) {
    out.guards!.push({ provider: 'gdelt', key: 'strikes', value: '0' }, { provider: 'gdelt', key: 'cooldownUntil', value: '' });
  }
  // Advance the rotation only past batches that actually ran.
  const value = done === selected.length ? next : (start + done) % Math.max(g.batches.length, 1);
  if (done > 0) out.checkpoints.push({ provider: 'gdelt', key: 'nextBatchIndex', value: String(value) });
  return out;
}

/** HTTP cache validators saved for a feed (ETag / Last-Modified); tolerant of missing or bad values. */
function readCache(raw: string | undefined): { etag: string | null; lastModified: string | null } {
  try {
    const v = JSON.parse(raw ?? '{}') as { etag?: unknown; lastModified?: unknown };
    return { etag: typeof v.etag === 'string' ? v.etag : null, lastModified: typeof v.lastModified === 'string' ? v.lastModified : null };
  } catch {
    return { etag: null, lastModified: null };
  }
}

/**
 * RSS/Atom discovery for owner-allowed feeds (see allowedFeeds). Per feed, isolated:
 * robots.txt (fail closed) → conditional GET (ETag / Last-Modified from checkpoints) →
 * items whose link is on the feed's own source only → Florida records (metadata only).
 */
export async function discoverRss(
  cfg: SourcesConfig,
  opts: {
    userAgent: string;
    fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
    checkpoint?: Map<string, string>;
    lookup?: (id: string) => SourcePolicy | undefined;
    feeds?: FeedConfig[];
    log: Log;
  },
): Promise<DiscoveryResult> {
  const out: DiscoveryResult = { items: [], errors: [], checkpoints: [], fetched: 0, rateLimited: false };
  const lookup = opts.lookup ?? ((id: string) => sourceById(id));
  const { allowed, refused } = allowedFeeds(opts.feeds ?? cfg.rss ?? [], lookup);
  for (const r of refused) opts.log.info(`[rss:${r.id}] not fetched: ${r.reason}`);
  for (const feed of allowed) {
    const src = lookup(feed.sourceId)!;
    try {
      const robots = await checkRobots(feed.url, src.hosts, { fetchImpl: opts.fetchImpl, userAgent: opts.userAgent });
      if (!robots.allowed) {
        out.errors.push(`rss:${feed.id}: robots.txt disallows the feed (${robots.reason})`.slice(0, 300));
        continue;
      }
      const res = await fetchFeedConditional(feed, src.hosts, {
        fetchImpl: opts.fetchImpl,
        userAgent: opts.userAgent,
        ...readCache(opts.checkpoint?.get(`cache:${feed.id}`)),
      });
      if (res.status === 'not_modified') {
        opts.log.info(`[rss:${feed.id}] not modified`);
        continue;
      }
      out.fetched += res.items.length;
      let offSource = 0;
      const ai = src.licenseStatus === 'approved' || src.feedAccess?.aiClassification === true;
      for (const it of res.items) {
        let host = '';
        try {
          host = new URL(it.link).hostname;
        } catch {
          /* invalid link */
        }
        // Publisher mapping: a feed may only contribute its own articles (no third-party or redirector links).
        if (!host || !hostMatches(host, src.hosts)) {
          offSource++;
          continue;
        }
        const rec = floridaRecord(cfg, {
          title: it.title,
          url: it.link,
          publishedAt: it.publishedAt,
          provider: 'rss',
          guid: it.guid,
          aiAllowed: ai,
          notes: [`Feed: ${feed.id}${feed.region ? ` (${feed.region})` : ''}`, ai ? null : 'AI not run: source terms reviewed for feed metadata only.'].filter(Boolean).join('\n'),
        });
        if (rec) out.items.push(rec);
      }
      if (offSource) opts.log.warn(`[rss:${feed.id}] skipped ${offSource} item(s) linking outside ${src.id}`);
      if (res.truncated) opts.log.warn(`[rss:${feed.id}] feed larger than the cap; truncated`);
      // One checkpoint per feed (the import batch carries at most 20 checkpoints in total).
      if (res.etag || res.lastModified) out.checkpoints.push({ provider: 'rss', key: `cache:${feed.id}`, value: JSON.stringify({ etag: res.etag?.slice(0, 300) ?? null, lastModified: res.lastModified?.slice(0, 100) ?? null }) });
      opts.log.info(`[rss:${feed.id}] ${res.items.length} items (${Math.round(res.bytes / 1024)} KB)`);
    } catch (error) {
      if ((error as { kind?: string }).kind === 'rate_limited') out.rateLimited = true;
      out.errors.push(`rss:${feed.id}: ${(error as Error).message}`.slice(0, 300));
    }
  }
  return out;
}

const STATUS_NOTE: Record<LegalStatus, string> = {
  sentenced: 'sentenced (a conviction)',
  convicted: 'convicted at trial',
  pleaded_guilty: 'pleaded guilty (a conviction)',
  civil: 'civil matter / settlement (not a criminal conviction)',
  charged: 'CHARGED ONLY: an allegation; the defendant is presumed innocent',
  arrested: 'ARRESTED ONLY: an allegation; the defendant is presumed innocent',
  other: 'unclear case stage: treat as an allegation unless the release says otherwise',
};

/**
 * DOJ press releases from Florida's three U.S. Attorney's Offices (public domain; see adapters/doj.ts).
 * Pages newest-first until `lookbackDays` are covered (≤ maxPages requests, ≥ 1 s apart). No cursor:
 * repeats inside the window are exact duplicates removed against D1.
 */
type DojOpts = { userAgent: string; fetchImpl?: (input: string, init: RequestInit) => Promise<Response>; includeAllegations: boolean; minUnusual?: number; sleep?: (ms: number) => Promise<void>; log: Log };

export async function discoverDoj(cfg: SourcesConfig, opts: DojOpts & { now?: Date; lookbackDays: number; maxPages: number }): Promise<DiscoveryResult> {
  const now = opts.now ?? new Date();
  const oldest = new Date(now.getTime() - opts.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const { out } = await dojPages(cfg, { ...opts, startPage: 0, oldest });
  opts.log.info(`[doj] ${out.items.length} Florida releases in the last ${opts.lookbackDays} day(s)`);
  return out;
}

/**
 * Historical backfill: walks older pages from a saved cursor (`backfillPage`) toward a date floor, a few
 * pages per call. New releases only push items to later pages, so resuming by page index can overlap
 * (exact duplicates, removed against D1) but never skip. Cursor value "done" stops it.
 */
export async function discoverDojBackfill(
  cfg: SourcesConfig,
  opts: DojOpts & { checkpoint?: Map<string, string>; now?: Date; days: number; pages: number },
): Promise<DiscoveryResult & { done: boolean; nextPage: number | null }> {
  const cursor = opts.checkpoint?.get('backfillPage') ?? '';
  if (cursor === 'done') return { items: [], errors: [], checkpoints: [], fetched: 0, rateLimited: false, skipped: 'DOJ backfill complete', done: true, nextPage: null };
  const startPage = Number(cursor) || 0;
  const now = opts.now ?? new Date();
  const oldest = new Date(now.getTime() - opts.days * 86_400_000).toISOString().slice(0, 10);
  const { out, pagesFetched, reachedFloor } = await dojPages(cfg, { ...opts, startPage, oldest, maxPages: opts.pages });
  const failed = out.errors.length > 0;
  // Advance only past pages that were actually read; a failure retries the same page next time.
  const nextPage = reachedFloor ? null : startPage + pagesFetched;
  if (pagesFetched > 0 || reachedFloor) out.checkpoints.push({ provider: 'doj', key: 'backfillPage', value: reachedFloor ? 'done' : String(nextPage) });
  opts.log.info(`[doj:backfill] pages ${startPage}..${startPage + pagesFetched - 1}: ${out.items.length} Florida releases${reachedFloor ? ' (reached the date floor)' : ''}${failed ? ' (stopped on error)' : ''}`);
  return { ...out, done: reachedFloor, nextPage };
}

async function dojPages(
  cfg: SourcesConfig,
  opts: DojOpts & { startPage: number; oldest: string; maxPages: number },
): Promise<{ out: DiscoveryResult; pagesFetched: number; reachedFloor: boolean }> {
  const out: DiscoveryResult = { items: [], errors: [], checkpoints: [], fetched: 0, rateLimited: false };
  const fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const oldest = opts.oldest;
  const seen = new Set<string>();
  let pagesFetched = 0;
  let reachedFloor = false;
  for (let page = opts.startPage; page < opts.startPage + opts.maxPages; page++) {
    if (page > opts.startPage) await sleep(1000); // DOJ: > 4 requests/second may be blocked
    let body: unknown;
    try {
      const res = await fetchImpl(dojPageUrl(page).toString(), { headers: { 'user-agent': opts.userAgent, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) {
        out.rateLimited = true;
        throw new Error('HTTP 429');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (error) {
      out.errors.push(`doj:page:${page}: ${(error as Error).message}`.slice(0, 300));
      break;
    }
    let parsed;
    try {
      parsed = parseDojPage(body);
    } catch (error) {
      out.errors.push(`doj:page:${page}: ${(error as Error).message}`.slice(0, 300));
      break;
    }
    for (const r of parsed.releases) {
      if (r.date < oldest || seen.has(r.url)) continue;
      seen.add(r.url);
      out.fetched++;
      const rule = prefilterDoj({ title: r.title, teaser: r.teaser, includeAllegations: opts.includeAllegations, minUnusual: opts.minUnusual });
      const rec = floridaRecord(cfg, {
        title: r.title,
        url: r.url,
        publishedAt: r.date,
        provider: 'doj',
        aiAllowed: true, // public domain (justice.gov/legalpolicies)
        notes: [
          `U.S. Attorney's Office, ${FLORIDA_DISTRICTS[r.district]} (official DOJ press release; public domain, photos/seals excluded).`,
          `Case status: ${STATUS_NOTE[rule.status]}.`,
          describeUnusualness(rule.unusual),
          isAllegation(rule.status) ? 'Wording must say "charged"/"accused", never imply guilt.' : null,
        ]
          .filter(Boolean)
          .join('\n'),
      });
      if (!rec) continue;
      // A Florida USAO release is Florida-related by jurisdiction; the dateline is the verbatim location evidence.
      const dateline = dojDateline(r.teaser);
      rec.excerpt = r.teaser;
      rec.publisher = `U.S. Attorney's Office, ${FLORIDA_DISTRICTS[r.district]}`;
      rec.providerKey = r.uuid ? `doj:${r.uuid}` : null;
      if (rec.floridaSignal === 'none') rec.floridaSignal = 'domain';
      rec.floridaEvidence = dateline ?? rec.floridaEvidence;
      const reasons = [...new Set([...rec.prefilter.reasonCodes.filter((c) => c !== 'NO_FLORIDA_SIGNAL'), ...rule.reasonCodes])];
      rec.prefilter = { decision: reasons.length ? 'reject' : 'candidate', reasonCodes: reasons };
      out.items.push(rec);
    }
    pagesFetched++;
    // Newest-first: once a page reaches past the window, older pages cannot contain newer releases.
    if (parsed.dates.length === 0 || parsed.dates.some((d) => d < oldest)) {
      reachedFloor = true;
      break;
    }
  }
  return { out, pagesFetched, reachedFloor };
}

/**
 * STAGING/DEV ONLY: the historical "Florida Man API" dataset as a discovery INDEX (see adapters/floridaman-dataset.ts).
 * Walks the calendar one day file at a time (cursor `nextDay`). Each headline keeps its original publisher URL;
 * rights belong to that publisher (unreviewed), so nothing from here is publishable without the owner's approval.
 */
export async function discoverFloridaManDataset(
  cfg: SourcesConfig,
  opts: { userAgent: string; fetchImpl?: (input: string, init: RequestInit) => Promise<Response>; checkpoint?: Map<string, string>; daysPerRun: number; log: Log },
): Promise<DiscoveryResult> {
  const out: DiscoveryResult = { items: [], errors: [], checkpoints: [], fetched: 0, rateLimited: false };
  const fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const start = (Number(opts.checkpoint?.get('nextDay') ?? 0) || 0) % DATASET_DAYS.length;
  let done = 0;
  for (; done < opts.daysPerRun; done++) {
    const day = DATASET_DAYS[(start + done) % DATASET_DAYS.length]!;
    try {
      const res = await fetchImpl(datasetDayUrl(day), { headers: { 'user-agent': opts.userAgent, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) continue; // no headlines for that date
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const records = parseDatasetDay(await res.json());
      out.fetched += records.length;
      for (const h of records) {
        const rec = floridaRecord(cfg, {
          title: h.title,
          url: h.url,
          publishedAt: h.date,
          provider: 'floridaman_dataset',
          aiAllowed: false,
          notes: `${DATASET_PROVENANCE} Original publisher: ${h.source || 'unknown'}.\n${describeUnusualness(unusualness(h.title))}`,
        });
        if (rec) out.items.push(rec);
      }
    } catch (error) {
      out.errors.push(`floridaman_dataset:${day}: ${(error as Error).message}`.slice(0, 300));
      break; // retry this day next run
    }
  }
  if (done > 0) out.checkpoints.push({ provider: 'floridaman_dataset', key: 'nextDay', value: String((start + done) % DATASET_DAYS.length) });
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
