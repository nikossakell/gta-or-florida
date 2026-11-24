import { describe, expect, it } from 'vitest';
import { loadRegistry, REGISTRY, sourceForHost } from '../src/index.ts';

const base = { id: 'publisher:a.example.org', type: 'publisher', name: 'A', hosts: ['a.example.org'], canUseEditorialSummary: false, canDisplayOriginalTitle: false, autoPublishAllowed: false };

describe('source policy registry', () => {
  it('approves only the owner-reviewed public-domain DOJ source, never for auto-publishing, and blocks satire outlets', () => {
    const approved = REGISTRY.sources.filter((s) => s.licenseStatus === 'approved');
    expect(approved.map((s) => s.id)).toEqual(['publisher:justice.gov']);
    expect(approved[0]).toMatchObject({ canUseEditorialSummary: true, autoPublishAllowed: false, reviewedBy: expect.any(String), reviewedAt: '2026-11-24', termsUrl: 'https://www.justice.gov/legalpolicies' });
    expect(sourceForHost('grandtheftwiki.com').licenseStatus).toBe('unreviewed');
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

  it('feed access is a separate, documented owner decision that never grants rights', () => {
    const load = (feedAccess: object, src: object = {}) => () => loadRegistry({ policyVersion: 'x', sources: [{ ...base, licenseStatus: 'unreviewed', feedAccess, ...src }] });
    const reviewed = { reviewedBy: 'owner', reviewedAt: '2026-11-23' };
    expect(load({ status: 'allowed', basis: ['https://a.example.org/rss/'] })).toThrow(/needs reviewedBy/);
    expect(load({ status: 'allowed', ...reviewed })).toThrow(/documented basis/);
    expect(load({ status: 'allowed', basis: ['http://a.example.org/rss/'], ...reviewed })).toThrow(/basis/);
    expect(load({ status: 'unreviewed', aiClassification: true })).toThrow(/aiClassification requires/);
    expect(load({ status: 'allowed', basis: ['https://a.example.org/rss/'], ...reviewed }, { licenseStatus: 'blocked' })).toThrow(/blocked source/);
    const ok = loadRegistry({ policyVersion: 'x', sources: [{ ...base, licenseStatus: 'unreviewed', feedAccess: { status: 'allowed', basis: ['https://a.example.org/rss/'], ...reviewed } }] });
    // Feed access leaves every rights flag untouched.
    expect(ok.sources[0]).toMatchObject({ licenseStatus: 'unreviewed', canUseEditorialSummary: false, canDisplayOriginalTitle: false, autoPublishAllowed: false });
  });

  it('ships with every researched feed unreviewed and AI classification off', () => {
    const withFeed = REGISTRY.sources.filter((s) => s.feedAccess);
    expect(withFeed.length).toBeGreaterThanOrEqual(5);
    for (const s of withFeed) expect(s.feedAccess, s.id).toMatchObject({ status: 'unreviewed', aiClassification: false });
  });
});
