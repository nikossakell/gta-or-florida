import { describe, expect, it } from 'vitest';
import type { SourcePolicy } from '@gof/core';
import { sourceById } from '@gof/config';
import { officialSkips } from '../src/ingest.ts';

describe('unattended runs and official-report sources', () => {
  it('never fetch them while access is unresolved, and say so explicitly (not a silent "Completed")', () => {
    const skips = officialSkips((id) => sourceById(id));
    expect(skips.map((s) => s.sourceId).sort()).toEqual(['publisher:flaglersheriff.com', 'publisher:myfwc.com']);
    for (const s of skips) {
      expect(s.status).toBe('skipped');
      expect(s.reasons).toEqual(expect.arrayContaining(['SOURCE_OPERATION_UNRESOLVED', 'ACQUISITION_NOT_AUTOMATED']));
    }
  });

  it('even with every operation cleared they stay skipped until an unattended discovery adapter exists', () => {
    const cleared = (id: string): SourcePolicy | undefined => {
      const src = sourceById(id);
      if (!src?.access) return src;
      return {
        ...src,
        access: { ...src.access, acquisition: 'listing_page', operations: { discover: 'allowed', fetch: 'allowed', extractFacts: 'allowed', publishSummary: 'allowed' }, reviewedBy: 'o', reviewedAt: '2026-11-24', basis: ['https://x.example/terms'] },
      };
    };
    expect(officialSkips(cleared).every((s) => s.reasons.join() === 'AUTOMATED_DISCOVERY_NOT_IMPLEMENTED')).toBe(true);
    expect(officialSkips(() => undefined).every((s) => s.reasons.join() === 'SOURCE_NOT_IN_REGISTRY')).toBe(true);
  });
});
