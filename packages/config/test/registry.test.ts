import { describe, expect, it } from 'vitest';
import { loadRegistry, REGISTRY, sourceForHost } from '../src/index.ts';

const base = { id: 'publisher:a.example.org', type: 'publisher', name: 'A', hosts: ['a.example.org'], canUseEditorialSummary: false, canDisplayOriginalTitle: false, autoPublishAllowed: false };

describe('source policy registry', () => {
  it('ships with no approved sources (owner decision) and blocks satire outlets', () => {
    expect(REGISTRY.sources.filter((s) => s.licenseStatus === 'approved')).toEqual([]);
    expect(sourceForHost('www.theonion.com').licenseStatus).toBe('blocked');
    expect(sourceForHost('grandtheftwiki.com').id).toBe('grandtheftwiki');
  });

  it('treats unknown hosts as unreviewed (fail closed)', () => {
    expect(sourceForHost('brand-new-outlet.example.net')).toMatchObject({ licenseStatus: 'unreviewed', canUseEditorialSummary: false, autoPublishAllowed: false });
  });

  it('refuses permissions without an approved, reviewed status', () => {
    const load = (src: object) => () => loadRegistry({ policyVersion: 'x', sources: [{ ...base, licenseStatus: 'unreviewed', ...src }] });
    expect(load({ canUseEditorialSummary: true })).toThrow(/permissions granted/);
    expect(load({ licenseStatus: 'approved' })).toThrow(/reviewedBy/);
    expect(load({ licenseStatus: 'approved', reviewedBy: 'o', reviewedAt: '2026-11-01', autoPublishAllowed: true })).toThrow(/requires canUseEditorialSummary/);
    expect(load({ type: 'player_platform', licenseStatus: 'approved', reviewedBy: 'o', reviewedAt: '2026-11-01', canUseEditorialSummary: true, autoPublishAllowed: true })).toThrow(/player platforms/);
    expect(() => loadRegistry({ policyVersion: 'x', sources: [{ ...base, licenseStatus: 'unreviewed', extra: 1 }] })).toThrow(/unknown field/);
  });
});
