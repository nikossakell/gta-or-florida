/**
 * ONE definition of "this question may be scheduled / served now", shared by the scheduler and the
 * public challenge endpoint (and the access part by the review service), so the three never drift.
 *
 * Not just quality_state = 'approved': the approval in force must be traceable to its audit row
 * (questions.approval_log_id), match the persisted mode, not have been revoked since, and satisfy
 * that mode's rules:
 *  - licensed:        the source's reuse rights (owner-approved, editorial summary allowed). Unchanged.
 *  - factual_summary: a human 'approved:factual_summary' audit row whose stored attestations all
 *                     passed. Source reuse rights are NOT required (the text is the reviewer's own).
 * Both modes: verified active incident, verified link, enabled source, no placeholder text.
 * Factual summaries additionally need the access rules below (licensed rules stay exactly as before).
 * Official-report items (provider official_report) need the owner to have cleared fetch, extractFacts and
 * publishSummary for their source in BOTH modes — a rights approval or a reviewer cannot skip that.
 */
import { accessOperationProblems, feedFetchAllowed, OFFICIAL_PROVIDER, OFFICIAL_PUBLISH_OPERATIONS, placeholderProblems } from '@gof/core';
import { sourceById } from '@gof/config';

/** Columns every eligibility check needs. Aliases: q questions, inc incidents, sr source_references, s sources, al review_log. */
export const ELIGIBILITY_COLUMNS = `
  q.id AS question_id, q.quality_state, q.is_fixture, q.play_title, q.explanation, q.approved_by, q.approved_at,
  q.approval_mode, q.approval_log_id,
  inc.kind, inc.status AS incident_status, inc.verification_status, inc.location_verified, inc.game,
  sr.provider, sr.link_status,
  s.id AS source_id, s.license_status, s.can_use_editorial_summary, s.enabled AS source_enabled,
  al.entity_type AS approval_entity_type, al.entity_id AS approval_entity_id, al.decision AS approval_decision,
  al.actor_type AS approval_actor_type, al.details AS approval_details,
  (SELECT COUNT(*) FROM review_log rv
    WHERE rv.entity_type = 'question' AND rv.entity_id = q.id AND rv.decision = 'approval_revoked' AND rv.id > q.approval_log_id) AS revoked_after`;

export const APPROVAL_LOG_JOIN = 'LEFT JOIN review_log al ON al.id = q.approval_log_id';

export type EligibilityRow = {
  question_id: string | null;
  quality_state: string | null;
  is_fixture: number | null;
  play_title: string | null;
  explanation: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_mode: string | null;
  approval_log_id: number | null;
  kind: string | null;
  incident_status: string | null;
  verification_status: string | null;
  location_verified: number | null;
  game: string | null;
  provider: string | null;
  link_status: string | null;
  source_id: string | null;
  license_status: string | null;
  can_use_editorial_summary: number | null;
  source_enabled: number | null;
  approval_entity_type: string | null;
  approval_entity_id: string | null;
  approval_decision: string | null;
  approval_actor_type: string | null;
  approval_details: string | null;
  revoked_after: number | null;
};

export type EligibilityContext = { appEnv?: string; allowFixtures: boolean };

/**
 * Access/collection restrictions that no approval mode can override: blocked sources (D1 or the
 * deployed registry), feeds whose access is not currently allowed (unreviewed = unresolved), and the
 * staging-only Florida Man dataset in production.
 */
export function sourceAccessProblems(row: { provider: string | null; source_id: string | null; license_status: string | null }, appEnv?: string): string[] {
  const out: string[] = [];
  const src = row.source_id ? sourceById(row.source_id) : undefined;
  if (row.license_status === 'blocked' || src?.licenseStatus === 'blocked') out.push(`SOURCE_BLOCKED: ${row.source_id} may not be used in any mode`);
  if (row.provider === 'floridaman_dataset' && appEnv === 'production') out.push('PROVIDER_NOT_ALLOWED: the Florida Man dataset is staging/development only');
  if (row.provider === 'rss') {
    const access = src ? feedFetchAllowed(src) : { ok: false, reason: 'source not in the registry' };
    if (!access.ok) out.push(`UNAUTHORIZED_COLLECTION: this item came from a feed that is not currently allowed (${access.reason})`);
  }
  if (row.provider === OFFICIAL_PROVIDER) {
    // Re-read from the deployed registry every time: a later "denied" or a removed source invalidates eligibility.
    if (!src) out.push(`SOURCE_ACCESS_UNRESOLVED: ${row.source_id} is not in the deployed registry`);
    else for (const p of accessOperationProblems(src, OFFICIAL_PUBLISH_OPERATIONS)) out.push(`SOURCE_ACCESS_UNRESOLVED: ${p}`);
  }
  return out;
}

const LICENSED_DECISIONS = new Set(['approved', 'import:approved']);

/** The stored factual-summary attestation, re-checked: every human verification must have passed. */
function attestationPassed(details: string | null): boolean {
  if (!details) return false;
  try {
    const d = JSON.parse(details) as { mode?: string; factual?: Record<string, unknown> };
    const f = d.factual;
    // Who wrote the text is attested truthfully: the reviewer, or a facts-first machine draft the reviewer checked.
    const origin = f?.textOrigin ?? 'human_written';
    const authorship = (origin === 'human_written' && f?.humanWritten === true) || (origin === 'machine_draft_reviewed' && f?.humanWritten === false);
    return (
      d.mode === 'factual_summary' &&
      !!f &&
      authorship &&
      f.incidentVerified === true &&
      f.claimsVerified === true &&
      f.privacyChecked === true &&
      typeof f.verifiedDate === 'string' &&
      typeof f.verifiedLocation === 'string' &&
      Array.isArray(f.evidenceUrls) &&
      f.evidenceUrls.length > 0
    );
  } catch {
    return false;
  }
}

/** Why this question may not be scheduled/served now; null = eligible. */
export function ineligibility(r: EligibilityRow, ctx: EligibilityContext): string | null {
  if (!r.question_id) return 'MISSING_QUESTION';
  if (r.quality_state !== 'approved') return 'NOT_APPROVED';
  if (r.incident_status !== 'active') return 'INCIDENT_INACTIVE';
  if (r.kind !== 'FLORIDA_NEWS' && r.kind !== 'GTA_CANON') return 'KIND_NOT_PLAYABLE';
  if (r.is_fixture === 1) return ctx.allowFixtures ? null : 'FIXTURE';
  if (r.verification_status !== 'verified') return 'INCIDENT_UNVERIFIED';
  if (r.kind === 'FLORIDA_NEWS' && r.location_verified !== 1) return 'LOCATION_UNVERIFIED';
  if (r.kind === 'GTA_CANON' && !r.game) return 'GAME_MISSING';
  if (!r.approved_by || !r.approved_at) return 'APPROVAL_INCOMPLETE';
  // Provenance: the approval in force is an audit row about THIS question, not revoked since.
  if (r.approval_log_id === null || r.approval_entity_type !== 'question' || r.approval_entity_id !== r.question_id) return 'NO_APPROVAL_PROVENANCE';
  if ((r.revoked_after ?? 0) > 0) return 'APPROVAL_REVOKED';
  if (r.link_status !== 'ok' && r.link_status !== 'manual_ok') return 'LINK_UNVERIFIED';
  if (r.source_enabled !== 1) return 'SOURCE_DISABLED';
  if (placeholderProblems(r.play_title ?? '', 'PLAY_TITLE').length || placeholderProblems(r.explanation ?? '', 'EXPLANATION').length) return 'PLACEHOLDER_TEXT';

  if (r.approval_mode === 'licensed') {
    if (!r.approval_decision || !LICENSED_DECISIONS.has(r.approval_decision)) return 'APPROVAL_MODE_MISMATCH';
    if (!(r.license_status === 'approved' && r.can_use_editorial_summary === 1)) return 'SOURCE_RIGHTS';
    if (r.provider === OFFICIAL_PROVIDER && sourceAccessProblems(r, ctx.appEnv).length) return 'SOURCE_ACCESS';
    return null;
  }
  if (r.approval_mode === 'factual_summary') {
    if (r.approval_decision !== 'approved:factual_summary' || r.approval_actor_type !== 'human') return 'APPROVAL_MODE_MISMATCH';
    if (!attestationPassed(r.approval_details)) return 'ATTESTATION_INCOMPLETE';
    // Without reuse rights, access/collection restrictions must be resolved and respected.
    if (sourceAccessProblems(r, ctx.appEnv).length) return 'SOURCE_ACCESS';
    return null;
  }
  return 'NO_APPROVAL_MODE';
}
