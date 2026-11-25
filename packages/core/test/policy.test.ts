import { describe, expect, it } from 'vitest';
import {
  evaluateAutoPublish,
  extractJsonObject,
  groundAssessment,
  parse,
  parseAutoPublishMode,
  s,
  type AutoPublishFacts,
  type SourcePolicy,
} from '../src/index.ts';

const SOURCE: SourcePolicy = {
  id: 'publisher:news.example.org',
  type: 'publisher',
  name: 'News',
  hosts: ['news.example.org'],
  licenseStatus: 'approved',
  canUseEditorialSummary: true,
  canDisplayOriginalTitle: false,
  autoPublishAllowed: true,
  reviewedBy: 'owner',
  reviewedAt: '2026-11-01',
};
const FACTS: AutoPublishFacts = {
  kind: 'FLORIDA_NEWS',
  fixture: false,
  source: SOURCE,
  linkStatus: 'ok',
  linkCheckedAt: '2026-11-21T00:00:00Z',
  linkFinalHostOk: true,
  playTitleProblems: [],
  explanationProblems: [],
  possibleDuplicate: false,
  publishedAt: '2026-11-20',
  floridaEvidence: true,
  deterministicGame: null,
  ai: { schemaValid: true, relevant: true, sensitive: false, needsReview: false, reasonCodes: [], gtaGame: null },
};
const BENCH = { policyVersion: 'p1', sampleSize: 300, falseApprovalRate: 0.003, measuredAt: '2026-11-20', measuredBy: 'owner' };
const T = { maxFalseApprovalRate: 0.01, minBenchmarkSize: 200, humanSampleRate: 0.1, maxLinkAgeDays: 14 };
const run = (o: Partial<Parameters<typeof evaluateAutoPublish>[0]> = {}, facts: Partial<AutoPublishFacts> = {}) =>
  evaluateAutoPublish({ mode: 'trusted_sources', facts: { ...FACTS, ...facts }, benchmark: BENCH, policyVersion: 'p1', thresholds: T, now: new Date('2026-11-22T00:00:00Z'), draw: 0.5, ...o });

describe('evaluateAutoPublish', () => {
  it('approves only when every gate passes in trusted_sources', () => {
    expect(run()).toMatchObject({ decision: 'auto_approve', effective: 'approve', reasons: [] });
  });

  it('shadow and off modes never act', () => {
    expect(run({ mode: 'shadow' })).toMatchObject({ decision: 'auto_approve', effective: 'candidate' });
    expect(run({ mode: 'shadow' }, { ai: { ...FACTS.ai!, sensitive: true } })).toMatchObject({ decision: 'reject', effective: 'candidate' });
    expect(run({ mode: 'off' }).effective).toBe('candidate');
    expect(parseAutoPublishMode('TRUSTED')).toBe('off');
  });

  it('a flawless model verdict cannot override deterministic failures', () => {
    for (const [facts, reason] of [
      [{ playTitleProblems: ['PLAY_TITLE_GIVEAWAY: florida'] }, 'PLAY_TITLE_GIVEAWAY'],
      [{ source: { ...SOURCE, licenseStatus: 'unreviewed' as const } }, 'SOURCE_UNREVIEWED'],
      [{ source: { ...SOURCE, autoPublishAllowed: false } }, 'SOURCE_NOT_AUTO_TRUSTED'],
      [{ linkStatus: 'unchecked' }, 'LINK_NOT_VERIFIED'],
      [{ linkCheckedAt: '2026-10-01T00:00:00Z' }, 'LINK_CHECK_STALE'],
      [{ linkFinalHostOk: false }, 'LINK_REDIRECT_OFF_SOURCE'],
      [{ publishedAt: null }, 'MISSING_PUBLISHED_DATE'],
      [{ floridaEvidence: false }, 'FLORIDA_LOCATION_UNSUPPORTED'],
      [{ possibleDuplicate: true }, 'POSSIBLE_DUPLICATE'],
      [{ ai: null }, 'AI_NOT_RUN'],
      [{ manualSubmission: true }, 'MANUAL_SUBMISSION'],
      [{ kind: 'GTA_CANON' as const, deterministicGame: 'GTA_III' as const, ai: { ...FACTS.ai!, gtaGame: 'GTA_IV' as const } }, 'GTA_GAME_UNVERIFIED'],
    ] as const) {
      const r = run({}, facts as Partial<AutoPublishFacts>);
      expect(r.effective, reason).not.toBe('approve');
      expect(r.reasons).toContain(reason);
    }
  });

  it('an unchecked link is reported as not verified, not as an off-source redirect', () => {
    const r = run({}, { linkStatus: 'unchecked', linkCheckedAt: null, linkFinalHostOk: false });
    expect(r.reasons).toContain('LINK_NOT_VERIFIED');
    expect(r.reasons).not.toContain('LINK_REDIRECT_OFF_SOURCE');
    expect(r.effective).not.toBe('approve');
    // A stale check that also left the source host still reports both.
    expect(run({}, { linkCheckedAt: '2026-10-01T00:00:00Z', linkFinalHostOk: false }).reasons).toEqual(expect.arrayContaining(['LINK_CHECK_STALE', 'LINK_REDIRECT_OFF_SOURCE']));
  });

  it('requires an owner benchmark for the current policy within the owner threshold', () => {
    expect(run({ benchmark: null }).reasons).toContain('NO_BENCHMARK_FOR_POLICY');
    expect(run({ benchmark: { ...BENCH, policyVersion: 'old' } }).reasons).toContain('NO_BENCHMARK_FOR_POLICY');
    expect(run({ benchmark: { ...BENCH, sampleSize: 50 } }).reasons).toContain('BENCHMARK_TOO_SMALL');
    expect(run({ benchmark: { ...BENCH, falseApprovalRate: 0.05 } }).reasons).toContain('BENCHMARK_ABOVE_THRESHOLD');
    expect(run({ thresholds: { ...T, maxFalseApprovalRate: null } }).reasons).toContain('NO_OWNER_THRESHOLD');
  });

  it('routes a random sample to humans', () => {
    const r = run({ draw: 0.05 });
    expect(r).toMatchObject({ decision: 'auto_approve', effective: 'candidate', sampledForHuman: true });
    expect(r.reasons).toContain('HUMAN_SAMPLE');
  });
});

describe('strict schema parsing', () => {
  const schema = s.object({ a: s.string({ max: 5 }), b: s.optional(s.int({ min: 0, max: 3 })), c: s.nullable(s.boolean()) });
  it('rejects unknown keys, wrong types and out-of-range values', () => {
    expect(parse(schema, { a: 'x', c: null })).toEqual({ ok: true, value: { a: 'x', c: null } });
    expect(parse(schema, { a: 'x', c: true, extra: 1 }).ok).toBe(false);
    expect(parse(schema, { a: 'toolong', c: true }).ok).toBe(false);
    expect(parse(schema, { a: 'x', b: 9, c: true }).ok).toBe(false);
    expect(parse(schema, { a: 'x' }).ok).toBe(false);
    expect(parse(schema, '{}').ok).toBe(false);
  });
});

describe('model output grounding', () => {
  it('extracts JSON from chatter and code fences', () => {
    expect(extractJsonObject('Sure!\n```json\n{"a": "}", "b": {"c": 1}}\n```')).toEqual({ a: '}', b: { c: 1 } });
    expect(extractJsonObject('no json here')).toBeUndefined();
  });

  it('flags invented evidence, giveaways and kind mismatches', () => {
    const g = groundAssessment(
      { relevant: true, incidentCategory: 'weird', playTitle: 'A Miami man does something odd at a bank', explanationDraft: 'The source says a man did something odd at a bank.', floridaEvidenceText: 'Orlando', gtaGame: 'GTA_V', sensitive: false, needsReview: false, reasonCodes: [] },
      { kind: 'FLORIDA_NEWS', sourceText: 'Tampa man does something odd at bank', originalTitle: 'Tampa man does something odd at bank', exactTitleAllowed: false, deterministicGame: null },
    );
    expect(g.reasonCodes).toEqual(expect.arrayContaining(['GROUND_PLAY_TITLE', 'GROUND_FLORIDA_EVIDENCE', 'GROUND_KIND_MISMATCH']));
  });
});
