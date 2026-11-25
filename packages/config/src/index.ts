/**
 * Validated application constants + the owner-reviewed source policy registry.
 * Bundled into the Worker and the ingestion job; no I/O, no secrets.
 */
import {
  ACQUISITION_METHODS,
  FEED_ACCESS_STATUSES,
  hostMatches,
  OPERATION_STATUSES,
  SOURCE_OPERATIONS,
  scopedHosts,
  urlBelongsToSource,
  LICENSE_STATUSES,
  parse,
  s,
  SOURCE_TYPES,
  formatIssues,
  unreviewedSource,
  type AutoPublishThresholds,
  type SourcePolicy,
} from '@gof/core';
import registryJson from '../sources.policy.json';

const opStatus = s.optional(s.enum(OPERATION_STATUSES));

const policySchema = s.object({
  id: s.string({ min: 1, max: 120, pattern: /^[a-z0-9:._-]+$/ }),
  type: s.enum(SOURCE_TYPES),
  name: s.string({ min: 1, max: 120 }),
  hosts: s.array(s.string({ min: 3, max: 120, pattern: /^[a-z0-9.-]+$/ }), { min: 1, max: 10 }),
  licenseStatus: s.enum(LICENSE_STATUSES),
  canUseEditorialSummary: s.boolean(),
  canDisplayOriginalTitle: s.boolean(),
  autoPublishAllowed: s.boolean(),
  attribution: s.optional(s.string({ max: 200 })),
  termsUrl: s.optional(s.string({ max: 300, pattern: /^https:\/\// })),
  reviewedBy: s.optional(s.string({ min: 1, max: 80 })),
  reviewedAt: s.optional(s.string({ max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ })),
  notes: s.optional(s.string({ max: 1000 })),
  feedAccess: s.optional(
    s.object({
      status: s.enum(FEED_ACCESS_STATUSES),
      basis: s.optional(s.array(s.string({ max: 300, pattern: /^https:\/\// }), { max: 10 })),
      aiClassification: s.optional(s.boolean()),
      reviewedBy: s.optional(s.string({ min: 1, max: 80 })),
      reviewedAt: s.optional(s.string({ max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ })),
      findings: s.optional(s.string({ max: 2000 })),
    }),
  ),
  pathScopes: s.optional(s.array(s.string({ min: 5, max: 200, pattern: /^[a-z0-9.-]+\/[A-Za-z0-9._~\/-]*$/ }), { max: 10 })),
  access: s.optional(
    s.object({
      officialGovernment: s.boolean(),
      operations: s.object({
        discover: opStatus,
        fetch: opStatus,
        store: opStatus,
        extractFacts: opStatus,
        aiProcessing: opStatus,
        publishSummary: opStatus,
        reproduceOriginal: opStatus,
        useMedia: opStatus,
      } satisfies Record<(typeof SOURCE_OPERATIONS)[number], unknown>),
      acquisition: s.enum(ACQUISITION_METHODS),
      minIntervalMs: s.int({ min: 1000, max: 3_600_000 }),
      robots: s.optional(s.string({ max: 300 })),
      basis: s.optional(s.array(s.string({ max: 300, pattern: /^https:\/\// }), { max: 10 })),
      reviewedBy: s.optional(s.string({ min: 1, max: 80 })),
      reviewedAt: s.optional(s.string({ max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ })),
      findings: s.optional(s.string({ max: 3000 })),
    }),
  ),
});

const registrySchema = s.object({
  $comment: s.optional(s.array(s.string({ max: 400 }), { max: 20 })),
  policyVersion: s.string({ min: 1, max: 40 }),
  sources: s.array(policySchema, { max: 500 }),
});

export type SourceRegistry = { policyVersion: string; sources: SourcePolicy[] };

/** Validate a registry and its invariants (throws with every problem listed). */
export function loadRegistry(raw: unknown): SourceRegistry {
  const r = parse(registrySchema, raw);
  if (!r.ok) throw new Error(`sources.policy.json is invalid: ${formatIssues(r.issues)}`);
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const src of r.value.sources) {
    if (ids.has(src.id)) problems.push(`${src.id}: duplicate id`);
    ids.add(src.id);
    const granted = src.canUseEditorialSummary || src.canDisplayOriginalTitle || src.autoPublishAllowed;
    if (granted && src.licenseStatus !== 'approved') problems.push(`${src.id}: permissions granted but licenseStatus is ${src.licenseStatus}`);
    if (src.licenseStatus === 'approved' && (!src.reviewedBy || !src.reviewedAt)) problems.push(`${src.id}: approved sources need reviewedBy + reviewedAt`);
    if (src.autoPublishAllowed && !src.canUseEditorialSummary) problems.push(`${src.id}: autoPublishAllowed requires canUseEditorialSummary`);
    if (src.type === 'player_platform' && src.autoPublishAllowed) problems.push(`${src.id}: player platforms can never be auto-published`);
    const fa = src.feedAccess;
    if (fa && fa.status !== 'unreviewed' && (!fa.reviewedBy || !fa.reviewedAt)) problems.push(`${src.id}: feedAccess ${fa.status} needs reviewedBy + reviewedAt`);
    if (fa?.status === 'allowed' && !fa.basis?.length) problems.push(`${src.id}: feedAccess allowed needs a documented basis (official URL)`);
    if (fa?.status === 'allowed' && src.licenseStatus === 'blocked') problems.push(`${src.id}: a blocked source cannot have feed access`);
    if (fa?.aiClassification && fa.status !== 'allowed') problems.push(`${src.id}: aiClassification requires feedAccess allowed`);
    for (const sc of src.pathScopes ?? []) {
      const host = sc.slice(0, sc.indexOf('/'));
      if (!src.hosts.includes(host)) problems.push(`${src.id}: pathScope ${sc} is not on one of its hosts`);
    }
    const ac = src.access;
    if (ac) {
      const allowed = Object.entries(ac.operations).filter(([, st]) => st === 'allowed').map(([op]) => op);
      if (allowed.length && (!ac.reviewedBy || !ac.reviewedAt || !ac.basis?.length)) problems.push(`${src.id}: allowed operations (${allowed.join(', ')}) need reviewedBy + reviewedAt + a documented basis`);
      if (allowed.length && src.licenseStatus === 'blocked') problems.push(`${src.id}: a blocked source cannot allow any operation`);
      if (ac.operations.publishSummary === 'allowed' && ac.operations.extractFacts !== 'allowed') problems.push(`${src.id}: publishSummary requires extractFacts allowed`);
      if (ac.operations.reproduceOriginal === 'allowed' && !src.canDisplayOriginalTitle) problems.push(`${src.id}: reproduceOriginal requires canDisplayOriginalTitle (rights review)`);
      if (ac.acquisition !== 'explicit_urls' && ac.acquisition !== 'none' && ac.operations.discover === 'allowed' && ac.operations.fetch !== 'allowed') problems.push(`${src.id}: automated discovery requires fetch allowed`);
    }
  }
  if (problems.length) throw new Error(`sources.policy.json: ${problems.join('; ')}`);
  return r.value as SourceRegistry;
}

export const REGISTRY: SourceRegistry = loadRegistry(registryJson);
export const POLICY_VERSION = REGISTRY.policyVersion;

/**
 * Resolve the policy for a URL host (fail closed: unknown hosts are unreviewed). A host that a source only
 * owns under specific paths (shared platforms, see `pathScopes`) never resolves to that source by host
 * alone: use `sourceForUrl` when the full URL is known.
 */
export function sourceForHost(host: string, registry: SourceRegistry = REGISTRY): SourcePolicy {
  const h0 = host.toLowerCase().replace(/^www\./, '');
  const found = registry.sources.find((src) => hostMatches(host, src.hosts) && !scopedHosts(src).includes(h0));
  if (found) return found;
  const h = host.toLowerCase().replace(/^www\./, '');
  return unreviewedSource(`publisher:${h}`, 'publisher', h, [h]);
}

/** Resolve the policy for a full URL (honours path scopes; fail closed like sourceForHost). */
export function sourceForUrl(raw: string | URL, registry: SourceRegistry = REGISTRY): SourcePolicy {
  const url = typeof raw === 'string' ? new URL(raw) : raw;
  const scoped = registry.sources.find((src) => (src.pathScopes?.length ?? 0) > 0 && urlBelongsToSource(url, src) && scopedHosts(src).includes(url.hostname.toLowerCase().replace(/^www\./, '')));
  return scoped ?? sourceForHost(url.hostname, registry);
}

export function sourceById(id: string, registry: SourceRegistry = REGISTRY): SourcePolicy | undefined {
  return registry.sources.find((src) => src.id === id);
}

// ---------------------------------------------------------------------------
// Workers AI (batch classification from GitHub Actions only)
// Model ids, formats and neuron rates verified against developers.cloudflare.com on 2026-11-22.
// Re-check before changing; neither model is listed for JSON Mode, so output is parsed + validated by us.
// ---------------------------------------------------------------------------

export const AI_MODELS = {
  triage: '@cf/ibm-granite/granite-4.0-h-micro',
  extract: '@cf/google/gemma-4-26b-a4b-it',
} as const;

/** Neurons per million tokens (Workers AI pricing page, 2026-11-22). Estimates only. */
export const NEURON_RATES: Record<string, { input: number; output: number }> = {
  [AI_MODELS.triage]: { input: 1542, output: 10158 },
  [AI_MODELS.extract]: { input: 9091, output: 27273 },
};

/** Free allocation is 10,000 neurons/day per account; keep the job well below it by default. */
export const AI_DEFAULT_BUDGET = {
  maxRequestsPerRun: 60,
  maxNeuronsPerRun: 2_500,
  maxOutputTokensTriage: 120,
  maxOutputTokensExtract: 500,
  maxInputChars: 1_200,
  timeoutMs: 30_000,
  concurrency: 2,
} as const;

export const PROMPT_VERSION = 'v1-2026-11-22';

export function estimateNeurons(model: string, tokensIn: number, tokensOut: number): number {
  const rate = NEURON_RATES[model];
  if (!rate) return 0;
  return (tokensIn * rate.input + tokensOut * rate.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Game / scheduling constants
// ---------------------------------------------------------------------------

export const DAILY_SIZE = 5;
/** Days the cron keeps scheduled ahead (Worker var SCHEDULE_AHEAD_DAYS overrides). */
export const SCHEDULE_AHEAD_DAYS = 30;
/** Longest period one schedule request may plan (30 and 90 are the documented horizons). */
export const MAX_SCHEDULE_DAYS = 90;
/** An event is not shown again within this many days of another showing (Worker var EVENT_COOLDOWN_DAYS overrides). */
export const EVENT_COOLDOWN_DAYS = 30;
export const LOW_INVENTORY_DAYS = 14;
export const ARCHIVE_DAYS = 7;
export const TIME_LIMIT_SECONDS = 60;

/** Defaults for the auto-publish gate. maxFalseApprovalRate stays null until the owner sets it from a benchmark. */
export const DEFAULT_THRESHOLDS: AutoPublishThresholds = {
  maxFalseApprovalRate: null,
  minBenchmarkSize: 200,
  humanSampleRate: 0.1,
  maxLinkAgeDays: 14,
};
