/**
 * Validated application constants + the owner-reviewed source policy registry.
 * Bundled into the Worker and the ingestion job; no I/O, no secrets.
 */
import {
  FEED_ACCESS_STATUSES,
  hostMatches,
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
  }
  if (problems.length) throw new Error(`sources.policy.json: ${problems.join('; ')}`);
  return r.value as SourceRegistry;
}

export const REGISTRY: SourceRegistry = loadRegistry(registryJson);
export const POLICY_VERSION = REGISTRY.policyVersion;

/** Resolve the policy for a URL host (fail closed: unknown hosts are unreviewed). */
export function sourceForHost(host: string, registry: SourceRegistry = REGISTRY): SourcePolicy {
  const found = registry.sources.find((src) => hostMatches(host, src.hosts));
  if (found) return found;
  const h = host.toLowerCase().replace(/^www\./, '');
  return unreviewedSource(`publisher:${h}`, 'publisher', h, [h]);
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
export const SCHEDULE_AHEAD_DAYS = 30;
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
