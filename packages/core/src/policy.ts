/**
 * Source usage policy + the automated-publishing gate.
 *
 * - Rights are decided per *source* (publisher / wiki), by the owner, in the
 *   committed registry (packages/config/sources.policy.json). Nothing here —
 *   and no model — can grant a right.
 * - Auto-publishing is a state machine with three modes. The default is
 *   `shadow`: decisions are computed and logged, nothing is approved.
 * - `trusted_sources` approves only when every deterministic gate passes AND the
 *   owner recorded a benchmark for the current policy version that meets the
 *   owner-set threshold. Any doubt → review. Model "confidence" is never used.
 */
import type { ContentKind, GtaGame } from './content.ts';

export const LICENSE_STATUSES = ['unreviewed', 'approved', 'blocked'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export const SOURCE_TYPES = ['publisher', 'gta_wiki', 'player_platform'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type SourcePolicy = {
  /** Stable id, e.g. "publisher:tampabay.com" or "grandtheftwiki". */
  id: string;
  type: SourceType;
  name: string;
  /** Hosts whose URLs belong to this source (exact or subdomain match). */
  hosts: string[];
  licenseStatus: LicenseStatus;
  /** May we build a question around it with our own wording + a link? */
  canUseEditorialSummary: boolean;
  /** May the exact original title be shown publicly after answering? */
  canDisplayOriginalTitle: boolean;
  /** Owner allows policy-gated automatic publishing for this source. */
  autoPublishAllowed: boolean;
  attribution?: string;
  termsUrl?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  notes?: string;
  /**
   * Separate from rights: may our ingestion job FETCH this source's feed to collect candidate
   * metadata (title, link, date, guid)? Says nothing about reusing content — `licenseStatus` and the
   * can* flags still gate every question. Absent = unreviewed (feeds are not fetched).
   */
  feedAccess?: FeedAccess;
};

export const FEED_ACCESS_STATUSES = ['unreviewed', 'allowed', 'denied'] as const;
export type FeedAccessStatus = (typeof FEED_ACCESS_STATUSES)[number];

export type FeedAccess = {
  status: FeedAccessStatus;
  /** Official page(s) the decision rests on (terms of use, the publisher's RSS page). */
  basis?: string[];
  /** May headlines from this feed be sent to Workers AI for classification? Default false: human review only. */
  aiClassification?: boolean;
  reviewedBy?: string;
  reviewedAt?: string;
  /** Research summary for the reviewer (what the terms say about feeds, automation, reuse, AI). */
  findings?: string;
};

/** Whether the ingestion job may fetch this source's feed (rights-approved sources always may). */
export function feedFetchAllowed(src: Pick<SourcePolicy, 'licenseStatus' | 'feedAccess'>): { ok: boolean; reason: string } {
  if (src.licenseStatus === 'blocked') return { ok: false, reason: 'source is blocked' };
  if (src.feedAccess?.status === 'denied') return { ok: false, reason: 'feed access denied by the owner' };
  if (src.licenseStatus === 'approved') return { ok: true, reason: 'source rights approved' };
  if (src.feedAccess?.status === 'allowed') return { ok: true, reason: 'feed access allowed by the owner (metadata only)' };
  return { ok: false, reason: 'feed access not reviewed' };
}

/** Fallback for a host that is not in the registry: fail closed. */
export function unreviewedSource(id: string, type: SourceType, name: string, hosts: string[]): SourcePolicy {
  return { id, type, name, hosts, licenseStatus: 'unreviewed', canUseEditorialSummary: false, canDisplayOriginalTitle: false, autoPublishAllowed: false };
}

export function sourceProblems(src: Pick<SourcePolicy, 'licenseStatus' | 'canUseEditorialSummary' | 'reviewedBy' | 'reviewedAt'>): string[] {
  const out: string[] = [];
  if (src.licenseStatus === 'blocked') out.push('SOURCE_BLOCKED: source policy forbids use');
  else if (src.licenseStatus !== 'approved') out.push('SOURCE_UNREVIEWED: source terms have not been reviewed by the owner');
  else {
    if (!src.canUseEditorialSummary) out.push('SOURCE_NO_SUMMARY: source policy does not allow editorial summaries');
    if (!src.reviewedBy || !src.reviewedAt) out.push('SOURCE_REVIEW_MISSING: approved source lacks reviewer/date');
  }
  return out;
}

export function hostMatches(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return hosts.some((entry) => h === entry || h.endsWith(`.${entry}`));
}

/** `reference.provider` for owner-submitted URLs (`npm run ingest:url`). The gate never auto-approves these. */
export const MANUAL_PROVIDER = 'manual';

export const AUTO_PUBLISH_MODES = ['off', 'shadow', 'trusted_sources'] as const;
export type AutoPublishMode = (typeof AUTO_PUBLISH_MODES)[number];

export function parseAutoPublishMode(value: unknown): AutoPublishMode {
  // Anything unknown fails closed to "off" (no automated decisions at all).
  return (AUTO_PUBLISH_MODES as readonly unknown[]).includes(value) ? (value as AutoPublishMode) : 'off';
}

/** Owner-recorded measurement of the automated pipeline against human labels. */
export type Benchmark = {
  policyVersion: string;
  sampleSize: number;
  /** Items the pipeline would auto-approve that humans rejected / items it would auto-approve. */
  falseApprovalRate: number;
  measuredAt: string;
  measuredBy: string;
};

export type AutoPublishThresholds = {
  /** Owner-set, from observed data. Unset → trusted_sources cannot approve anything. */
  maxFalseApprovalRate: number | null;
  minBenchmarkSize: number;
  /** Fraction of otherwise auto-eligible items routed to a human anyway (0.05-0.10 recommended). */
  humanSampleRate: number;
  /** A link check older than this is not trusted. */
  maxLinkAgeDays: number;
};

export type AutoPublishFacts = {
  kind: ContentKind;
  fixture: boolean;
  /** Owner-submitted single URL (`ingest:url`): always routed to a human, never auto-approved. */
  manualSubmission?: boolean;
  source: SourcePolicy;
  linkStatus: string;
  linkCheckedAt: string | null;
  /** Final URL after redirects stays on the source's hosts. */
  linkFinalHostOk: boolean;
  playTitleProblems: string[];
  explanationProblems: string[];
  possibleDuplicate: boolean;
  publishedAt: string | null;
  /** Deterministic Florida location evidence (place name found in source text). */
  floridaEvidence: boolean;
  /** Game detected deterministically from the wiki page vs. the model's claim. */
  deterministicGame: GtaGame | null;
  ai: null | {
    schemaValid: boolean;
    relevant: boolean;
    sensitive: boolean;
    needsReview: boolean;
    reasonCodes: string[];
    gtaGame: GtaGame | null;
  };
};

export type GateDecision = {
  /** What the gate concludes. In shadow mode this is logged only. */
  decision: 'auto_approve' | 'review' | 'reject';
  /** What actually happens to the item. */
  effective: 'approve' | 'candidate' | 'reject';
  reasons: string[];
  mode: AutoPublishMode;
  sampledForHuman: boolean;
};

const REJECT_REASONS = new Set(['SOURCE_BLOCKED', 'AI_IRRELEVANT', 'SENSITIVE']);

export function evaluateAutoPublish(input: {
  mode: AutoPublishMode;
  facts: AutoPublishFacts;
  benchmark: Benchmark | null;
  policyVersion: string;
  thresholds: AutoPublishThresholds;
  now: Date;
  /** Uniform [0,1) draw for the human sample. */
  draw: number;
}): GateDecision {
  const { facts: f, thresholds: t, mode } = input;
  const reasons: string[] = [];
  const add = (r: string) => reasons.push(r);

  if (f.fixture) add('FIXTURE');
  if (f.manualSubmission) add('MANUAL_SUBMISSION');
  if (f.kind === 'GTA_PLAYER_EVENT') add('PLAYER_EVENTS_DISABLED');
  for (const p of sourceProblems(f.source)) add(p.split(':')[0]!);
  if (!f.source.autoPublishAllowed) add('SOURCE_NOT_AUTO_TRUSTED');
  if (f.linkStatus !== 'ok') add('LINK_NOT_VERIFIED');
  else if (!f.linkCheckedAt || input.now.getTime() - Date.parse(f.linkCheckedAt) > t.maxLinkAgeDays * 86_400_000) add('LINK_CHECK_STALE');
  // Only meaningful for a successful check: an unchecked/broken link has no trustworthy final URL, and LINK_NOT_VERIFIED already blocks it.
  if (f.linkStatus === 'ok' && !f.linkFinalHostOk) add('LINK_REDIRECT_OFF_SOURCE');
  for (const p of f.playTitleProblems) add(p.split(':')[0]!);
  for (const p of f.explanationProblems) add(p.split(':')[0]!);
  if (f.possibleDuplicate) add('POSSIBLE_DUPLICATE');
  if (f.kind === 'FLORIDA_NEWS') {
    if (!f.publishedAt) add('MISSING_PUBLISHED_DATE');
    if (!f.floridaEvidence) add('FLORIDA_LOCATION_UNSUPPORTED');
  }
  if (!f.ai) add('AI_NOT_RUN');
  else {
    if (!f.ai.schemaValid) add('AI_SCHEMA_INVALID');
    if (!f.ai.relevant) add('AI_IRRELEVANT');
    if (f.ai.sensitive) add('SENSITIVE');
    if (f.ai.needsReview) add('AI_NEEDS_REVIEW');
    for (const r of f.ai.reasonCodes) add(`AI_${r}`);
    if (f.kind === 'GTA_CANON' && (!f.deterministicGame || f.ai.gtaGame !== f.deterministicGame)) add('GTA_GAME_UNVERIFIED');
  }
  if (f.kind === 'GTA_CANON' && !f.ai && !f.deterministicGame) add('GTA_GAME_UNVERIFIED');

  const b = input.benchmark;
  if (!b || b.policyVersion !== input.policyVersion) add('NO_BENCHMARK_FOR_POLICY');
  else {
    if (b.sampleSize < t.minBenchmarkSize) add('BENCHMARK_TOO_SMALL');
    if (t.maxFalseApprovalRate === null) add('NO_OWNER_THRESHOLD');
    else if (b.falseApprovalRate > t.maxFalseApprovalRate) add('BENCHMARK_ABOVE_THRESHOLD');
  }

  const unique = [...new Set(reasons)];
  const decision: GateDecision['decision'] = unique.some((r) => REJECT_REASONS.has(r)) ? 'reject' : unique.length ? 'review' : 'auto_approve';
  const sampledForHuman = decision === 'auto_approve' && input.draw < t.humanSampleRate;

  let effective: GateDecision['effective'] = 'candidate';
  // shadow/off: the decision is only recorded; a human sees every item. trusted_sources acts on it.
  if (mode === 'trusted_sources' && decision === 'reject') effective = 'reject';
  if (mode === 'trusted_sources' && decision === 'auto_approve' && !sampledForHuman) effective = 'approve';
  if (sampledForHuman) unique.push('HUMAN_SAMPLE');
  return { decision, effective, reasons: unique, mode, sampledForHuman };
}
