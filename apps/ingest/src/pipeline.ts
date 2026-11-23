/**
 * Discovered items → validated ImportItems. Pure orchestration with injected I/O
 * (Worker client, link checker, AI provider) so it is fully testable offline.
 *
 *   exact dedupe (run + Worker known keys) → fuzzy incident dedupe → deterministic
 *   prefilter → SSRF-safe link check → AI (budgeted) → ImportItem
 *
 * Each phase is also exported on its own with plain, serializable inputs and
 * outputs, so the Cloudflare Workflow (apps/ingest-worker) can run them as
 * separate bounded steps. `processDiscovered` composes the same phases.
 *
 * Nothing here can approve anything: the Worker decides, under the owner's policy.
 */
import { createHash } from 'node:crypto';
import { cleanText, draftPlayTitle, type AiTrace, type GtaGame, type ImportItem, type LinkCheck } from '@gof/core';
import { sourceForHost, sourceById } from '@gof/config';
import { classify, mapLimit, type AiProvider, type Budget } from './classify.ts';
import { createRunDeduper, type ExistingTitle } from './deduplicate.ts';
export type { ExistingTitle };
import type { FilterResult } from './filters.ts';
import type { WorkerClient } from './import.ts';

export type Discovered = {
  kind: 'FLORIDA_NEWS' | 'GTA_CANON';
  provider: 'gdelt' | 'rss' | 'grandtheftwiki' | 'manual';
  providerKey: string | null;
  title: string;
  originalUrl: string;
  canonicalUrl: string;
  publisher: string | null;
  /** Publisher-declared date (RSS pubDate). GDELT seendate is NOT a publication date. */
  publishedAt: string | null;
  seenAt: string | null;
  excerpt: string;
  gameHint: GtaGame | null;
  wikiPageId: number | null;
  wikiSection: string | null;
  floridaSignal: 'title' | 'domain' | 'none';
  floridaEvidence: string | null;
  notes: string | null;
  prefilter: FilterResult;
};

export type PipelineStats = {
  discovered: number;
  duplicates: number;
  attached: number;
  flaggedForReview: number;
  prefilterRejected: number;
  linkChecked: number;
  linkBroken: number;
  aiClassified: number;
  aiSkipped: number;
  toImport: number;
  rejectReasons: Record<string, number>;
};

export type PipelineDeps = {
  client: WorkerClient | null;
  ai: AiProvider | null;
  budget: Budget;
  checkLink: ((url: string) => Promise<LinkCheck>) | null;
  maxLinkChecks: number;
  aiConcurrency: number;
  existingTitles?: ExistingTitle[];
};

export const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/** WHATWG serialization percent-encodes quotes/spaces/angle brackets; returns null for non-https. */
export function serializeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.href.slice(0, 2048) : null;
  } catch {
    return null;
  }
}

export function incidentKeyFor(d: Discovered): string {
  return d.kind === 'GTA_CANON' ? `gta:grandtheftwiki:${d.providerKey}` : `fl:${digest(d.canonicalUrl).slice(0, 24)}`;
}

function sourceFor(d: Discovered) {
  if (d.kind === 'GTA_CANON') return sourceById('grandtheftwiki') ?? sourceForHost(new URL(d.canonicalUrl).hostname);
  return sourceForHost(new URL(d.canonicalUrl).hostname);
}

export type Planned = {
  d: Discovered;
  incidentKey: string;
  attachTo?: string;
  dupOf?: { key: string; similarity: number };
  link: LinkCheck | null;
  ai: AiTrace | null;
  playTitle: string | null;
  explanation: string | null;
};

export function emptyStats(discovered: number): PipelineStats {
  return {
    discovered,
    duplicates: 0,
    attached: 0,
    flaggedForReview: 0,
    prefilterRejected: 0,
    linkChecked: 0,
    linkBroken: 0,
    aiClassified: 0,
    aiSkipped: 0,
    toImport: 0,
    rejectReasons: {},
  };
}

/** Phase 1: exact identity within this run (same canonical URL or provider key). */
export function uniqueWithinRun(found: Discovered[], stats: PipelineStats): Discovered[] {
  const unique: Discovered[] = [];
  const seenUrl = new Set<string>();
  const seenKey = new Set<string>();
  for (const d of found) {
    if (seenUrl.has(d.canonicalUrl) || (d.providerKey && seenKey.has(d.providerKey))) {
      stats.duplicates++;
      continue;
    }
    seenUrl.add(d.canonicalUrl);
    if (d.providerKey) seenKey.add(d.providerKey);
    unique.push(d);
  }
  return unique;
}

/**
 * Phase 3: fuzzy incident dedupe + prefilter accounting. `existingTitles` may be the full
 * index or the reduced, order-preserving set from `scanExisting` (same verdicts).
 */
export function planCandidates(
  unique: Discovered[],
  known: { canonicalUrls: Iterable<string>; providerKeys: Iterable<string> },
  existingTitles: ExistingTitle[],
  stats: PipelineStats,
): Planned[] {
  const knownUrls = new Set(known.canonicalUrls);
  const knownKeys = new Set(known.providerKeys);
  const dedupers = {
    FLORIDA_NEWS: createRunDeduper(existingTitles.filter((e) => e.incidentKey.startsWith('fl:')), knownUrls, knownKeys),
    GTA_CANON: createRunDeduper(existingTitles.filter((e) => e.incidentKey.startsWith('gta:')), knownUrls, knownKeys),
  };
  const planned: Planned[] = [];
  for (const d of unique) {
    const deduper = dedupers[d.kind];
    const v = deduper.check({ kind: d.kind, title: d.title, canonicalUrl: d.canonicalUrl, providerKey: d.providerKey, seenAt: d.publishedAt ?? d.seenAt });
    if (v.kind === 'duplicate') {
      stats.duplicates++;
      continue;
    }
    const incidentKey = incidentKeyFor(d);
    const p: Planned = { d, incidentKey, link: null, ai: null, playTitle: null, explanation: null };
    if (v.kind === 'attach') {
      p.attachTo = v.incidentKey;
      stats.attached++;
    } else if (v.kind === 'review') {
      p.dupOf = { key: v.incidentKey, similarity: v.similarity };
      stats.flaggedForReview++;
    }
    deduper.add({ incidentKey: p.attachTo ?? incidentKey, title: d.title, canonicalUrl: d.canonicalUrl, providerKey: d.providerKey, seenAt: d.publishedAt ?? d.seenAt });
    if (d.prefilter.decision === 'reject') {
      stats.prefilterRejected++;
      for (const r of d.prefilter.reasonCodes) stats.rejectReasons[r] = (stats.rejectReasons[r] ?? 0) + 1;
    }
    planned.push(p);
  }
  return planned;
}

/** Items that may become questions and therefore get a link check (in plan order). */
export const needsLinkCheck = (p: Planned) => p.d.prefilter.decision === 'candidate';
/** Items that get AI: new, prefilter-passing, link working or unchecked. */
export const needsAi = (p: Planned) => !p.attachTo && p.d.prefilter.decision === 'candidate' && p.link?.status !== 'broken';

/** Phase 4: link check one planned item (mutates it). */
export async function linkCheckOne(p: Planned, checkLink: (url: string) => Promise<LinkCheck>, stats: PipelineStats): Promise<void> {
  p.link = await checkLink(p.d.originalUrl);
  stats.linkChecked++;
  if (p.link.status !== 'ok') stats.linkBroken++;
}

/** Phase 5: AI-classify one planned item under the shared budget (mutates it). Never throws. */
export async function classifyOne(p: Planned, ai: AiProvider, budget: Budget, stats: PipelineStats): Promise<void> {
  const src = sourceFor(p.d);
  const r = await classify(ai, budget, {
    kind: p.d.kind,
    title: p.d.title,
    excerpt: p.d.excerpt,
    gameHint: p.d.gameHint,
    exactTitleAllowed: src.licenseStatus === 'approved' && src.canDisplayOriginalTitle,
  });
  if (r.trace) stats.aiClassified++;
  else stats.aiSkipped++;
  p.ai = r.trace;
  p.playTitle = r.playTitle;
  p.explanation = r.explanation;
}

/** Phase 6: planned item → ImportItem (the Worker re-validates everything). */
export function buildImportItem(p: Planned): ImportItem {
  const d = p.d;
  return {
    kind: d.kind,
    incidentKey: p.incidentKey,
    ...(p.attachTo ? { attachToIncidentKey: p.attachTo } : {}),
    reference: {
      provider: d.provider,
      providerKey: d.providerKey,
      originalUrl: serializeUrl(d.originalUrl) ?? d.originalUrl,
      canonicalUrl: serializeUrl(d.canonicalUrl) ?? d.canonicalUrl,
      originalTitle: cleanText(d.title, 400),
      publisher: d.publisher ? cleanText(d.publisher, 120) : null,
      publishedAt: d.publishedAt,
      providerSeenAt: d.seenAt,
      wikiPageId: d.wikiPageId,
      wikiSection: d.wikiSection ? cleanText(d.wikiSection, 200) : null,
      contentDigest: digest(`${d.title}\n${d.canonicalUrl}`),
      linkCheck: p.link,
    },
    incident: {
      category: p.ai?.category ?? 'other',
      gameDetected: d.gameHint,
      floridaSignal: d.floridaSignal,
      floridaEvidence: d.floridaEvidence ? cleanText(d.floridaEvidence, 300) : null,
      possibleDuplicateOfKey: p.dupOf?.key ?? null,
      similarity: p.dupOf?.similarity ?? null,
      notes: d.notes ? cleanText(d.notes, 1000) : null,
    },
    question: {
      // AI drafts are suggestions for the reviewer; the rule-based draft is the fallback.
      playTitleDraft: (p.playTitle ?? (draftPlayTitle(d.title) || d.title)).slice(0, 240),
      explanationDraft: (p.explanation ?? '').slice(0, 800),
      difficulty: 2,
    },
    ai: p.ai,
    prefilter: d.prefilter,
  };
}

export async function processDiscovered(found: Discovered[], deps: PipelineDeps): Promise<{ items: ImportItem[]; stats: PipelineStats }> {
  const stats = emptyStats(found.length);
  const unique = uniqueWithinRun(found, stats);

  // 2. exact identity against D1 (any state, incl. rejected — rejected items never come back)
  const knownUrls = new Set<string>();
  const knownKeys = new Set<string>();
  if (deps.client) {
    for (let i = 0; i < unique.length; i += 90) {
      const chunk = unique.slice(i, i + 90);
      const r = await deps.client.known(chunk.map((d) => d.canonicalUrl), chunk.map((d) => d.providerKey).filter((k): k is string => !!k));
      r.canonicalUrls.forEach((u) => knownUrls.add(u));
      r.providerKeys.forEach((k) => knownKeys.add(k));
    }
  }

  // 3. fuzzy incident dedupe against existing titles of the same kind
  const planned = planCandidates(unique, { canonicalUrls: knownUrls, providerKeys: knownKeys }, deps.existingTitles ?? [], stats);

  // 4. link checks (only for items that may become questions)
  const needLink = planned.filter(needsLinkCheck).slice(0, deps.checkLink ? deps.maxLinkChecks : 0);
  await mapLimit(needLink, 2, (p) => linkCheckOne(p, deps.checkLink!, stats));

  // 5. AI on new, prefilter-passing items with a working (or unchecked) link
  const needAi = planned.filter(needsAi);
  if (deps.ai) await mapLimit(needAi, deps.aiConcurrency, (p) => classifyOne(p, deps.ai!, deps.budget, stats));
  else stats.aiSkipped += needAi.length;

  // 6. build import items
  const items = planned.map(buildImportItem);
  stats.toImport = items.length;
  return { items, stats };
}
