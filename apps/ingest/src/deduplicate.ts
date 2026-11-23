/**
 * Run-scoped incident deduplication. The Worker enforces exact identity
 * (canonical URL, provider key, incident key — all UNIQUE in D1); fuzzy title
 * matching happens here, in the job, so the Worker stays within its CPU limit.
 *
 *  exact URL / provider key       → duplicate (skip)
 *  same fingerprint / very similar → Florida: attach as another outlet of that incident, but only
 *                                    when both were first seen within ATTACH_WINDOW_DAYS (the same
 *                                    stunt a year later is a different incident → flagged instead)
 *                                    GTA: flag possible duplicate (page+section identity wins)
 *  looser similarity               → new candidate flagged possibleDuplicateOf (a human decides)
 */
import { createDeduper } from '@gof/core';

export type Verdict =
  | { kind: 'new' }
  | { kind: 'duplicate'; reason: 'url' | 'provider_key' }
  | { kind: 'attach'; incidentKey: string; similarity: number }
  | { kind: 'review'; incidentKey: string; similarity: number };

export const ATTACH_WINDOW_DAYS = 21;

export type ExistingTitle = { incidentKey: string; title: string; seenAt?: string | null };

export function createRunDeduper(existing: ExistingTitle[], knownUrls: Iterable<string> = [], knownKeys: Iterable<string> = []) {
  const deduper = createDeduper(existing.map((e) => ({ id: e.incidentKey, title: e.title })));
  const seen = new Map<string, string>();
  for (const e of existing) if (e.seenAt && !seen.has(e.incidentKey)) seen.set(e.incidentKey, e.seenAt);
  const near = (key: string, at: string | null | undefined) => {
    const other = seen.get(key);
    if (!other || !at) return false;
    return Math.abs(Date.parse(other) - Date.parse(at)) <= ATTACH_WINDOW_DAYS * 86_400_000;
  };
  const urls = new Set(knownUrls);
  const keys = new Set(knownKeys);
  return {
    check(item: { kind: 'FLORIDA_NEWS' | 'GTA_CANON'; title: string; canonicalUrl: string; providerKey?: string | null; seenAt?: string | null }): Verdict {
      if (urls.has(item.canonicalUrl)) return { kind: 'duplicate', reason: 'url' };
      if (item.providerKey && keys.has(item.providerKey)) return { kind: 'duplicate', reason: 'provider_key' };
      const v = deduper.check({ title: item.title });
      if (v.kind === 'new') return { kind: 'new' };
      if (v.kind === 'duplicate' && item.kind === 'FLORIDA_NEWS' && near(v.of, item.seenAt)) return { kind: 'attach', incidentKey: v.of, similarity: v.similarity };
      return { kind: 'review', incidentKey: v.of, similarity: v.similarity };
    },
    add(item: { incidentKey: string; title: string; canonicalUrl: string; providerKey?: string | null; seenAt?: string | null }) {
      urls.add(item.canonicalUrl);
      if (item.seenAt && !seen.has(item.incidentKey)) seen.set(item.incidentKey, item.seenAt);
      if (item.providerKey) keys.add(item.providerKey);
      deduper.add({ id: item.incidentKey, title: item.title });
    },
  };
}
