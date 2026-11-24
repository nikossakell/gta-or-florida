import { describe, expect, it } from 'vitest';
import { loadRegistry, REGISTRY, sourceById, sourceForHost, sourceForUrl } from '../src/index.ts';
import { SOURCE_OPERATIONS } from '@gof/core';

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

  describe('official-report sources (FWC, Flagler County Sheriff)', () => {
    const OFFICIAL = ['publisher:myfwc.com', 'publisher:flaglersheriff.com'];

    it('are registered with rights unreviewed and EVERY operation still unknown (no silent approval)', () => {
      // Changing any of this is an owner decision: update the registry deliberately, with reviewer, date and basis.
      for (const id of OFFICIAL) {
        const src = sourceById(id)!;
        expect(src).toMatchObject({ licenseStatus: 'unreviewed', canUseEditorialSummary: false, canDisplayOriginalTitle: false, autoPublishAllowed: false });
        expect(src.access).toMatchObject({ officialGovernment: true, acquisition: 'explicit_urls' });
        for (const op of SOURCE_OPERATIONS) expect(src.access!.operations[op], `${id} ${op}`).toBe('unknown');
      }
    });

    it('resolves GovDelivery by path: only the FWC account belongs to FWC', () => {
      expect(sourceForUrl('https://content.govdelivery.com/accounts/FLFFWCC/bulletins/3d0b75e').id).toBe('publisher:myfwc.com');
      expect(sourceForUrl('https://content.govdelivery.com/accounts/USDOJ/bulletins/1').id).toBe('publisher:content.govdelivery.com');
      expect(sourceForHost('content.govdelivery.com').id).toBe('publisher:content.govdelivery.com');
      expect(sourceForUrl('https://flaglersheriff.com/news/x/').id).toBe('publisher:flaglersheriff.com');
    });

    it('leaves the GTA wiki policy and the other sources untouched', () => {
      expect(sourceById('grandtheftwiki')).toMatchObject({ licenseStatus: 'unreviewed', canUseEditorialSummary: false, autoPublishAllowed: false });
      expect(sourceById('grandtheftwiki')!.access).toBeUndefined();
      expect(REGISTRY.sources.filter((s) => s.access).map((s) => s.id).sort()).toEqual([...OFFICIAL].sort());
    });

    it('refuses allowed operations without reviewer, date and documented basis, and other inconsistent grants', () => {
      const access = (operations: object, extra: object = {}) => ({ officialGovernment: true, operations, acquisition: 'explicit_urls', minIntervalMs: 5000, ...extra });
      const load = (a: object, src: object = {}) => () => loadRegistry({ policyVersion: 'x', sources: [{ ...base, licenseStatus: 'unreviewed', access: a, ...src }] });
      expect(load(access({ fetch: 'allowed' }))).toThrow(/need reviewedBy \+ reviewedAt \+ a documented basis/);
      const reviewed = { reviewedBy: 'owner', reviewedAt: '2026-11-24', basis: ['https://a.example.org/terms'] };
      expect(load(access({ fetch: 'allowed' }, reviewed))).not.toThrow();
      expect(load(access({ publishSummary: 'allowed', extractFacts: 'unknown' }, reviewed))).toThrow(/publishSummary requires extractFacts/);
      expect(load(access({ fetch: 'allowed' }, reviewed), { licenseStatus: 'blocked' })).toThrow(/blocked source cannot allow/);
      expect(load(access({ reproduceOriginal: 'allowed' }, reviewed))).toThrow(/reproduceOriginal requires canDisplayOriginalTitle/);
      expect(load(access({ discover: 'allowed', fetch: 'unknown' }, { ...reviewed, acquisition: 'feed' }))).toThrow(/automated discovery requires fetch/);
      expect(load(access({ fetch: 'perhaps' }))).toThrow(/expected one of/);
      expect(() => loadRegistry({ policyVersion: 'x', sources: [{ ...base, licenseStatus: 'unreviewed', pathScopes: ['other.example.org/x/'] }] })).toThrow(/not on one of its hosts/);
    });
  });
});
