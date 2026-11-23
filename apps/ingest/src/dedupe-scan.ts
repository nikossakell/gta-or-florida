/**
 * Paged fuzzy-dedupe scan for CPU-bounded runtimes (Workflows steps on Workers Free).
 *
 * Preparing every existing title on every run is O(N) work that does not fit a
 * 10 ms step once the inventory grows. Instead, each step scans ONE page of the
 * existing title index against a chunk of candidates and keeps, per candidate:
 *   - the first existing entry with the same fingerprint, and
 *   - the earliest existing entry with the highest similarity.
 * `reducedExisting` then returns just those entries in their original order.
 *
 * Seeding the run deduper (planCandidates) with that reduced set gives exactly the
 * same verdicts as seeding it with the full index: the deduper only ever reports the
 * first fingerprint match or the earliest maximum, and both are kept for every
 * candidate (see dedupe-scan.test.ts for the randomized equivalence check).
 */
import { prepareTitle, preparedSimilarity, titleFingerprint } from '@gof/core';
import type { ExistingTitle } from './deduplicate.ts';

/** An existing title plus its position in the full index (page order, then row order). */
export type IndexedTitle = ExistingTitle & { order: number };
export type ScanHit = { fp: IndexedTitle | null; best: (IndexedTitle & { score: number }) | null };

const kindOf = (incidentKey: string) => (incidentKey.startsWith('fl:') ? 'FLORIDA_NEWS' : incidentKey.startsWith('gta:') ? 'GTA_CANON' : null);

/** Number positions across pages so the reduced set keeps the index order. */
export function indexPage(items: ExistingTitle[], pageNumber: number, pageSize: number): IndexedTitle[] {
  return items.map((e, i) => ({ incidentKey: e.incidentKey, title: e.title, seenAt: e.seenAt ?? null, order: pageNumber * Math.max(pageSize * 2, 1) + i }));
}

/** Scan one page against candidates, merging into `prior` (pages must be scanned in index order). */
export function scanExisting(candidates: { kind: 'FLORIDA_NEWS' | 'GTA_CANON'; title: string }[], page: IndexedTitle[], prior?: ScanHit[]): ScanHit[] {
  const hits: ScanHit[] = prior ? prior.map((h) => ({ ...h })) : candidates.map(() => ({ fp: null, best: null }));
  if (page.length === 0 || candidates.length === 0) return hits;
  const prepared = candidates.map((c) => ({ kind: c.kind, fp: titleFingerprint(c.title), p: prepareTitle(c.title) }));
  for (const e of page) {
    const kind = kindOf(e.incidentKey);
    if (!kind) continue;
    let efp: string | null = null;
    let ep: ReturnType<typeof prepareTitle> | null = null;
    for (let i = 0; i < prepared.length; i++) {
      const c = prepared[i]!;
      if (c.kind !== kind) continue;
      const h = hits[i]!;
      efp ??= titleFingerprint(e.title);
      if (!h.fp && efp === c.fp) h.fp = e;
      ep ??= prepareTitle(e.title);
      const score = preparedSimilarity(c.p, ep);
      // Strictly greater: an earlier entry keeps a tie, exactly like the deduper's pool scan.
      if (!h.best || score > h.best.score) h.best = { ...e, score };
    }
  }
  return hits;
}

/** The order-preserving union of every candidate's fingerprint hit and best match. */
export function reducedExisting(hits: ScanHit[]): ExistingTitle[] {
  const byOrder = new Map<number, IndexedTitle>();
  for (const h of hits) {
    if (h.fp) byOrder.set(h.fp.order, h.fp);
    if (h.best) byOrder.set(h.best.order, h.best);
  }
  return [...byOrder.values()].sort((a, b) => a.order - b.order).map((e) => ({ incidentKey: e.incidentKey, title: e.title, seenAt: e.seenAt }));
}
