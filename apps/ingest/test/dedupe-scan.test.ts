import { describe, expect, it } from 'vitest';
import { indexPage, reducedExisting, scanExisting, type ScanHit } from '../src/dedupe-scan.ts';
import { prefilterFlorida } from '../src/filters.ts';
import { emptyStats, planCandidates, uniqueWithinRun, type Discovered } from '../src/pipeline.ts';
import type { ExistingTitle } from '../src/deduplicate.ts';

// Tiny vocabulary on purpose: forces fingerprint collisions, ties, attach and review verdicts.
const WORDS = ['florida', 'man', 'alligator', 'gator', 'lawnmower', 'deputies', 'arrested', 'pizza', 'drive-thru', 'iguana', 'van', 'heist', 'mission', 'triads'];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function title(r: () => number) {
  return Array.from({ length: 3 + Math.floor(r() * 4) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
}

function discovered(i: number, t: string, kind: 'FLORIDA_NEWS' | 'GTA_CANON', r: () => number): Discovered {
  const url = `https://news.example.org/${kind}/${i}`;
  return {
    kind,
    provider: kind === 'GTA_CANON' ? 'grandtheftwiki' : 'rss',
    providerKey: kind === 'GTA_CANON' ? `${i}#s` : null,
    title: t,
    originalUrl: url,
    canonicalUrl: url,
    publisher: null,
    publishedAt: null,
    seenAt: `2026-11-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}T00:00:00Z`,
    excerpt: '',
    gameHint: null,
    wikiPageId: null,
    wikiSection: null,
    floridaSignal: 'title',
    floridaEvidence: null,
    notes: null,
    prefilter: prefilterFlorida({ title: t, domain: 'news.example.org', floridaSignal: 'title', blockedDomains: [] }),
  };
}

const verdicts = (planned: ReturnType<typeof planCandidates>) => planned.map((p) => ({ key: p.incidentKey, attachTo: p.attachTo ?? null, dupOf: p.dupOf ?? null }));

describe('paged dedupe scan', () => {
  it('gives exactly the same verdicts as the full-index deduper (randomized)', () => {
    const seen = { duplicates: 0, attached: 0, review: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const existing: ExistingTitle[] = [];
      for (let i = 0; i < 5 + Math.floor(r() * 60); i++) {
        const kind = r() < 0.5 ? 'fl' : 'gta';
        const seenAt = `2026-11-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}T00:00:00Z`;
        existing.push({ incidentKey: `${kind}:e${i}`, title: title(r), seenAt });
        // Reviewed incidents appear twice in the index (original + play title), same seenAt.
        if (r() < 0.2) existing.push({ incidentKey: `${kind}:e${i}`, title: title(r), seenAt });
      }
      const found = Array.from({ length: 1 + Math.floor(r() * 25) }, (_, i) => {
        if (r() < 0.35) {
          // Another outlet's report of a known incident: same words, reshuffled (same fingerprint).
          const e = existing[Math.floor(r() * existing.length)]!;
          const words = e.title.split(' ').sort(() => r() - 0.5).join(' ');
          return discovered(i, words, e.incidentKey.startsWith('fl:') ? 'FLORIDA_NEWS' : 'GTA_CANON', r);
        }
        return discovered(i, title(r), r() < 0.5 ? 'FLORIDA_NEWS' : 'GTA_CANON', r);
      });
      // Some items are already stored in D1 (exact URL / provider-key duplicates).
      const known = {
        canonicalUrls: found.filter(() => r() < 0.15).map((d) => d.canonicalUrl),
        providerKeys: found.filter((d) => d.providerKey && r() < 0.15).map((d) => d.providerKey!),
      };

      const fullStats = emptyStats(found.length);
      const full = planCandidates(uniqueWithinRun(found, fullStats), known, existing, fullStats);

      // Paged: pages of 7 existing titles × chunks of 5 candidates, as separate "steps".
      const pagedStats = emptyStats(found.length);
      const unique = uniqueWithinRun(found, pagedStats);
      const hits: ScanHit[] = [];
      for (let c = 0; c < unique.length; c += 5) {
        const chunk = unique.slice(c, c + 5);
        let h: ScanHit[] | undefined;
        for (let p = 0; p * 7 < existing.length; p++) h = scanExisting(chunk, indexPage(existing.slice(p * 7, p * 7 + 7), p, 7), h);
        hits.push(...(h ?? chunk.map(() => ({ fp: null, best: null }))));
      }
      const reduced = reducedExisting(hits);
      expect(reduced.length).toBeLessThanOrEqual(unique.length * 2);
      const paged = planCandidates(unique, known, reduced, pagedStats);

      expect(verdicts(paged), `seed ${seed}`).toEqual(verdicts(full));
      expect(pagedStats, `seed ${seed}`).toEqual(fullStats);
      seen.duplicates += fullStats.duplicates;
      seen.attached += fullStats.attached;
      seen.review += fullStats.flaggedForReview;
    }
    // The random cases must actually exercise every verdict, or equality proves little.
    expect(seen.duplicates).toBeGreaterThan(10);
    expect(seen.attached).toBeGreaterThan(5);
    expect(seen.review).toBeGreaterThan(10);
  });

  it('keeps the earliest entry on ties and the first fingerprint match', () => {
    const page0 = indexPage([{ incidentKey: 'fl:a', title: 'florida man rides gator', seenAt: null }], 0, 1);
    const page1 = indexPage([{ incidentKey: 'fl:b', title: 'gator rides florida man', seenAt: null }], 1, 1);
    const cand = [{ kind: 'FLORIDA_NEWS' as const, title: 'florida man rides gator' }];
    const h = scanExisting(cand, page1, scanExisting(cand, page0));
    expect(h[0]!.fp!.incidentKey).toBe('fl:a');
    expect(h[0]!.best!.incidentKey).toBe('fl:a');
    // Other kinds are never compared.
    expect(scanExisting([{ kind: 'GTA_CANON', title: 'florida man rides gator' }], page0)[0]).toEqual({ fp: null, best: null });
  });
});
