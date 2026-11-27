/**
 * Human editorial review (admin token). Approval needs every check to pass;
 * all problems are reported together. Source rights come from the registry,
 * never from the request.
 */
import {
  addDays,
  cleanText,
  DEFAULT_WITHDRAWN_MESSAGE,
  explanationProblems,
  hostMatches,
  MANUAL_PROVIDER,
  nearCopyProblems,
  OFFICIAL_PROVIDER,
  placeholderProblems,
  playTitleProblems,
  sourceProblems,
  titleFingerprint,
  utcDate,
  type ContentKind,
  type FactualAttestation,
  type ReviewRequest,
  type WithdrawRequest,
} from '@gof/core';
import { DEFAULT_THRESHOLDS, POLICY_VERSION, sourceById } from '@gof/config';
import type { Principal } from '../security/auth.ts';
import { HttpError } from '../http.ts';
import { eventSideConflict, isConstraintError, logStmt, placeholders } from '../db/repo.ts';
import { sourceAccessProblems } from './eligibility.ts';

export type CandidateRow = {
  question_id: string;
  quality_state: string;
  gate_decision: string | null;
  gate_reasons: string | null;
  answer_kind: 'FLORIDA' | 'GTA';
  play_title: string;
  play_title_reviewed: number;
  explanation: string;
  difficulty: number;
  is_fixture: number;
  incident_id: string;
  incident_key: string;
  kind: ContentKind;
  category: string;
  game: string | null;
  game_detected: string | null;
  florida_location: string | null;
  florida_signal: string | null;
  location_verified: number;
  incident_status: string;
  possible_duplicate_of: string | null;
  similarity: number | null;
  notes: string | null;
  reference_id: string;
  provider: string;
  original_url: string;
  original_title: string;
  publisher: string | null;
  published_at: string | null;
  link_status: string;
  checked_at: string | null;
  final_url: string | null;
  source_id: string;
  source_host: string | null;
  license_status: string;
  can_use_editorial_summary: number;
  can_display_original_title: number;
  source_reviewed_by: string | null;
  source_reviewed_at: string | null;
  created_at: string;
  /** Structured facts JSON (official-report items only). */
  facts: string | null;
  /** Event shared by questions about the same underlying event (NULL = this question's incident). */
  event_id: string | null;
  spoiler: number;
};

const CANDIDATE_SQL = `
  SELECT q.id AS question_id, q.quality_state, q.gate_decision, q.gate_reasons, q.answer_kind, q.play_title, q.play_title_reviewed,
         q.explanation, q.difficulty, q.is_fixture, q.created_at, COALESCE(q.event_id, q.incident_id) AS event_id, q.spoiler,
         inc.id AS incident_id, inc.incident_key, inc.kind, inc.category, inc.game, inc.game_detected, inc.florida_location, inc.florida_signal,
         inc.location_verified, inc.status AS incident_status, inc.possible_duplicate_of, inc.similarity, inc.notes, inc.facts,
         sr.id AS reference_id, sr.provider, sr.original_url, sr.original_title, sr.publisher, sr.published_at, sr.link_status, sr.checked_at, sr.final_url,
         s.id AS source_id, s.canonical_host AS source_host, s.license_status, s.can_use_editorial_summary, s.can_display_original_title,
         s.reviewed_by AS source_reviewed_by, s.reviewed_at AS source_reviewed_at
    FROM questions q
    JOIN incidents inc ON inc.id = q.incident_id
    JOIN source_references sr ON sr.id = q.primary_reference_id
    JOIN sources s ON s.id = sr.source_id`;

export async function listCandidates(
  db: D1Database,
  opts: { kind?: string; state?: string; decision?: string; limit: number; offset: number },
): Promise<CandidateRow[]> {
  const where = ['q.quality_state = ?'];
  const args: unknown[] = [opts.state ?? 'candidate'];
  if (opts.kind) {
    where.push('inc.kind = ?');
    args.push(opts.kind);
  }
  if (opts.decision) {
    where.push('q.gate_decision = ?');
    args.push(opts.decision);
  }
  return (
    await db
      .prepare(`${CANDIDATE_SQL} WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC, q.id LIMIT ? OFFSET ?`)
      .bind(...args, opts.limit, opts.offset)
      .all<CandidateRow>()
  ).results;
}

export async function getCandidate(db: D1Database, id: string): Promise<CandidateRow | null> {
  return db.prepare(`${CANDIDATE_SQL} WHERE q.id = ? OR inc.id = ? OR inc.incident_key = ?`).bind(id, id, id).first<CandidateRow>();
}

export async function candidateDetails(db: D1Database, id: string) {
  const row = await getCandidate(db, id);
  if (!row) return null;
  const [refs, days, log] = await db.batch([
    db.prepare(`SELECT id, provider, source_id, original_title, original_url, publisher, published_at, link_status, checked_at FROM source_references WHERE incident_id = ? ORDER BY created_at`).bind(row.incident_id),
    db.prepare('SELECT day FROM daily_round_items WHERE question_id = ?').bind(row.question_id),
    db.prepare(`SELECT timestamp, actor_type, actor_id, decision, reason FROM review_log WHERE entity_id IN (?, ?, ?) ORDER BY id`).bind(row.question_id, row.incident_id, row.reference_id),
  ]);
  let facts: unknown = null;
  try {
    facts = row.facts ? JSON.parse(row.facts) : null;
  } catch {
    facts = null;
  }
  return { ...row, facts, references: refs!.results, scheduledOn: (days!.results as { day: string }[]).map((d) => d.day), log: log!.results };
}

export type ReviewResult = { ok: true; questionId: string; state: string } | { ok: false; errors: string[] };

const LINK_FRESH_MS = 24 * 3600_000;

/** Hosts of the candidate's source: the bundled registry first, else the host recorded in D1. */
function sourceHosts(row: Pick<CandidateRow, 'source_id' | 'source_host'>): string[] {
  return sourceById(row.source_id)?.hosts ?? (row.source_host ? [row.source_host] : []);
}

/**
 * Independent Factual Summary: who may publish verified facts in their own words, from where.
 * Replaces ONLY the reuse-rights check of the licensed path; every other check still applies.
 */
export function factualSummaryProblems(
  row: Pick<CandidateRow, 'kind' | 'provider' | 'source_id' | 'source_host' | 'license_status' | 'original_title' | 'original_url'> & {
    facts?: string | null;
    incident_key?: string;
    play_title?: string;
    explanation?: string;
  },
  req: Pick<ReviewRequest, 'playTitle' | 'explanation'> & { factual?: FactualAttestation },
  ctx: { appEnv?: string; now: Date },
): string[] {
  const out: string[] = [];
  const f = req.factual;
  // Access and collection restrictions are never bypassed by this mode (same rules as scheduling/serving).
  out.push(...sourceAccessProblems(row, ctx.appEnv));
  if (!f) {
    out.push('FACTUAL_ATTESTATION_MISSING: factual_summary mode needs the reviewer\'s verification (factual)');
    return out;
  }
  // Original wording: the reviewer writes both texts in this request (no stored or AI drafts).
  if (req.playTitle === undefined) out.push('FACTUAL_TITLE_MISSING: write the play title yourself in this request');
  if (req.explanation === undefined) out.push('FACTUAL_EXPLANATION_MISSING: write the explanation yourself in this request');
  const origin = f.textOrigin ?? 'human_written';
  if (origin === 'human_written' && !f.humanWritten) out.push('FACTUAL_NOT_HUMAN_WRITTEN: title and explanation must be written by the reviewer');
  if (origin === 'machine_draft_reviewed') {
    // Authorship is attested as it happened: a reviewed machine draft is never declared human-written.
    if (f.humanWritten) out.push('FACTUAL_ORIGIN_CONFLICT: a reviewed machine draft cannot also be attested as human-written');
    let draft: { problems?: unknown[] } | null = null;
    try {
      draft = row.facts ? ((JSON.parse(row.facts) as { draft?: { problems?: unknown[] } | null }).draft ?? null) : null;
    } catch {
      draft = null;
    }
    // Curated question-bank candidates (bank:import) are AI-assisted drafts that the owner reviewed before
    // import (owner decision, 2026-11-28). They may be approved as reviewed drafts, but only with the exact
    // text that was imported and reviewed; any change makes it the reviewer's own text (human_written).
    const curatedBank = row.provider === MANUAL_PROVIDER && (row.incident_key ?? '').startsWith('bank:');
    if (curatedBank) {
      const changed =
        (req.playTitle !== undefined && cleanText(req.playTitle, 240) !== row.play_title) ||
        (req.explanation !== undefined && cleanText(req.explanation, 800) !== row.explanation);
      if (changed) out.push('MACHINE_DRAFT_CHANGED: the text differs from the reviewed bank draft; approve it unchanged, or attest human_written for your own text');
    } else if (row.provider !== OFFICIAL_PROVIDER || !draft) {
      out.push('MACHINE_DRAFT_MISSING: only official-report candidates with a facts-first draft, or reviewed curated question-bank drafts, can use textOrigin machine_draft_reviewed');
    } else if (!Array.isArray(draft.problems) || draft.problems.length > 0) {
      out.push('MACHINE_DRAFT_INVALID: the stored draft failed validation; write the text yourself (textOrigin human_written)');
    }
  }
  if (!f.incidentVerified) out.push('FACTUAL_INCIDENT_UNVERIFIED: verify the incident itself, not just the headline');
  if (!f.claimsVerified) out.push('FACTUAL_CLAIMS_UNVERIFIED: every claim in the explanation must be supported by the evidence');
  if (!f.privacyChecked) out.push('FACTUAL_PRIVACY_UNCHECKED: confirm no private individual is named and allegations are worded as allegations');
  const day = Date.parse(`${f.verifiedDate}T00:00:00Z`);
  if (Number.isNaN(day) || day > ctx.now.getTime()) out.push('FACTUAL_DATE_INVALID: verifiedDate must be a real date, not in the future');
  if (row.kind === 'FLORIDA_NEWS' && !/\b(florida|fla\.?|fl)\b/i.test(f.verifiedLocation)) out.push('FACTUAL_LOCATION_NOT_FLORIDA: verifiedLocation must name the Florida place (e.g. "Pace, Florida")');
  // Provenance: the facts must have been checked at the candidate's own source (plus any corroboration).
  const hosts = sourceHosts(row);
  const onSource = f.evidenceUrls.some((u) => {
    try {
      return u === row.original_url || hostMatches(new URL(u).hostname, hosts);
    } catch {
      return false;
    }
  });
  if (!onSource) out.push(`FACTUAL_PROVENANCE: at least one evidence URL must be the candidate's source (${row.source_id})`);
  // Safeguards against near-copying the source headline (not proof of originality).
  if (req.playTitle) out.push(...nearCopyProblems(req.playTitle, row.original_title, 'PLAY_TITLE'));
  if (req.explanation) out.push(...nearCopyProblems(req.explanation, row.original_title, 'EXPLANATION'));
  return out;
}

export async function review(db: D1Database, req: ReviewRequest, who: Principal, now: Date, appEnv?: string): Promise<ReviewResult> {
  const row = await getCandidate(db, req.questionId);
  if (!row || row.question_id !== req.questionId) return { ok: false, errors: [`No question with id ${req.questionId}`] };
  const actor = { actorType: 'human' as const, actorId: who.actorId, policyVersion: POLICY_VERSION };
  const stamp = now.toISOString();

  if (req.action === 'reject') {
    if (!req.reason?.trim()) return { ok: false, errors: ['reason is required to reject'] };
    if (!['candidate', 'approved'].includes(row.quality_state)) return { ok: false, errors: [`Question is ${row.quality_state}`] };
    const scheduled = await db.prepare('SELECT day FROM daily_round_items WHERE question_id = ?').bind(row.question_id).first<{ day: string }>();
    if (scheduled) return { ok: false, errors: [`Question is scheduled on ${scheduled.day}; withdraw it instead (it stays in the audit trail).`] };
    await db.batch([
      db.prepare(`UPDATE questions SET quality_state = 'rejected', rejected_reason = ?, updated_at = ? WHERE id = ?`).bind(cleanText(req.reason, 500), stamp, row.question_id),
      logStmt(db, { ...actor, entityType: 'question', entityId: row.question_id, decision: 'rejected', reason: req.reason }),
    ]);
    return { ok: true, questionId: row.question_id, state: 'rejected' };
  }

  if (req.action === 'revoke') return revokeApproval(db, row, req, actor, stamp);

  const playTitle = req.playTitle !== undefined ? cleanText(req.playTitle, 240) : row.play_title;
  const explanation = req.explanation !== undefined ? cleanText(req.explanation, 800) : row.explanation;

  if (req.action === 'edit') {
    // Scheduling metadata (event grouping, spoiler flag) can change on approved questions too; it only
    // affects future scheduling, never published wording. Text edits stay candidate-only.
    const metaOnly = req.playTitle === undefined && req.explanation === undefined && req.difficulty === undefined;
    if (row.quality_state !== 'candidate' && !(row.quality_state === 'approved' && metaOnly)) {
      return { ok: false, errors: ['Only candidates can be edited (approved questions: only --event-id / --spoiler)'] };
    }
    if (req.eventId && req.eventId !== row.event_id) {
      const conflict = await eventSideConflict(db, req.eventId, row.answer_kind, row.question_id);
      if (conflict) return { ok: false, errors: [`EVENT_SIDE_CONFLICT: event ${req.eventId} is already used by ${conflict}, which has the other answer`] };
      // Days already planned were checked against the old grouping; changing it could break the event cooldown there.
      const planned = await db
        .prepare(`SELECT i.day FROM daily_round_items i JOIN daily_rounds r ON r.day = i.day WHERE i.question_id = ? AND r.day > ? AND r.status = 'scheduled' LIMIT 1`)
        .bind(row.question_id, utcDate(now))
        .first<{ day: string }>();
      if (planned) return { ok: false, errors: [`Question is scheduled on ${planned.day}; withdraw it from that day before changing its event (the cooldown was planned with the current event).`] };
    }
    await db.batch([
      db
        .prepare('UPDATE questions SET play_title = ?, explanation = ?, difficulty = ?, event_id = COALESCE(?, event_id), spoiler = COALESCE(?, spoiler), updated_at = ? WHERE id = ?')
        .bind(playTitle, explanation, req.difficulty ?? row.difficulty, req.eventId ?? null, req.spoiler === undefined ? null : req.spoiler ? 1 : 0, stamp, row.question_id),
      logStmt(db, {
        ...actor,
        entityType: 'question',
        entityId: row.question_id,
        decision: 'edited',
        details: { ...(req.eventId ? { eventId: req.eventId } : {}), ...(req.spoiler !== undefined ? { spoiler: req.spoiler } : {}) },
      }),
    ]);
    return { ok: true, questionId: row.question_id, state: row.quality_state as 'candidate' | 'approved' };
  }

  // ---- approve -------------------------------------------------------------
  const errors: string[] = [];
  const err = (m: string) => errors.push(m);
  if (row.quality_state !== 'candidate') err(`Question is ${row.quality_state}; only candidates can be approved`);
  if (row.incident_status !== 'active') err(`Incident is ${row.incident_status}`);
  if (row.is_fixture) err('Fixture content cannot be approved as a real question');
  if (row.kind === 'GTA_PLAYER_EVENT') err('GTA_PLAYER_EVENT is disabled');
  if (row.possible_duplicate_of && !req.notDuplicate) err(`Flagged as possible duplicate of ${row.possible_duplicate_of}; merge it or pass notDuplicate after checking`);
  {
    const ev = req.eventId ?? row.event_id;
    const conflict = ev ? await eventSideConflict(db, ev, row.answer_kind, row.question_id) : null;
    if (conflict) err(`EVENT_SIDE_CONFLICT: event ${ev} is already used by ${conflict}, which has the other answer`);
  }

  const mode = req.mode ?? 'licensed';
  if (mode === 'factual_summary') {
    // Facts in the reviewer's own words + a link: no reuse of the publisher's wording, so the reuse-rights
    // check is replaced by access, provenance, verification and near-copy checks.
    for (const p of factualSummaryProblems(row, req, { appEnv, now })) err(p);
  } else {
    for (const p of sourceProblems({
      licenseStatus: row.license_status as never,
      canUseEditorialSummary: row.can_use_editorial_summary === 1,
      reviewedBy: row.source_reviewed_by ?? undefined,
      reviewedAt: row.source_reviewed_at ?? undefined,
    })) {
      err(`${p} (${row.source_id}). Rights are decided per source in packages/config/sources.policy.json, then deployed + synced. For your own wording of verified facts, use mode factual_summary.`);
    }
    // Official reports also need their per-operation access cleared; reuse rights alone do not cover it.
    if (row.provider === OFFICIAL_PROVIDER) for (const p of sourceAccessProblems(row, appEnv)) err(p);
  }
  if (req.playTitle === undefined && !row.play_title_reviewed) err('playTitle is required: write (or confirm) the neutral title yourself');
  const exactTitleAllowed = row.license_status === 'approved' && row.can_display_original_title === 1;
  for (const p of playTitleProblems(playTitle, { originalTitle: row.original_title, exactTitleAllowed })) err(p);
  if (req.explanation === undefined && !row.explanation) err('explanation is required');
  for (const p of explanationProblems(explanation)) err(p);
  // Template/placeholder text passes the length rules, so it is refused explicitly (every mode).
  for (const p of placeholderProblems(playTitle, 'PLAY_TITLE')) err(p);
  for (const p of placeholderProblems(explanation, 'EXPLANATION')) err(p);

  // For news the verified date is the incident's publication date; for GTA it is only when the reviewer checked (never shown as a date).
  const publishedAt = req.publishedAt ?? (mode === 'factual_summary' && row.kind === 'FLORIDA_NEWS' ? req.factual?.verifiedDate : undefined) ?? row.published_at;
  const publisher = req.publisher ?? row.publisher;
  const game = req.game ?? null;
  if (row.kind === 'FLORIDA_NEWS') {
    if (!(req.locationVerified ?? row.location_verified === 1) && !(mode === 'factual_summary' && req.factual)) err('locationVerified: confirm the event happened in Florida');
    if (!publishedAt) err('publishedAt (YYYY-MM-DD) is required for Florida news');
    if (!publisher) err('publisher is required for Florida news');
  }
  if (row.kind === 'GTA_CANON') {
    if (!game) err('game is required: name the GTA title you verified (e.g. GTA_III)');
    else if (row.game_detected && row.game_detected !== game) err(`game ${game} differs from the wiki page's detected game ${row.game_detected}; double-check the source`);
  }

  let linkStatus = row.link_status;
  let checkedAt = row.checked_at;
  let httpStatus: number | null = null;
  let finalUrl = row.final_url;
  if (req.linkVerifiedManually) {
    linkStatus = 'manual_ok';
    checkedAt = stamp;
  } else if (req.linkCheck) {
    if (req.linkCheck.status !== 'ok') err(`link check failed: ${req.linkCheck.status}${req.linkCheck.note ? ` (${req.linkCheck.note})` : ''}`);
    else if (now.getTime() - Date.parse(req.linkCheck.checkedAt) > LINK_FRESH_MS) err('link check is older than 24h; re-run it');
    linkStatus = req.linkCheck.status;
    checkedAt = req.linkCheck.checkedAt;
    httpStatus = req.linkCheck.httpStatus;
    finalUrl = req.linkCheck.finalUrl;
  } else if (!(row.link_status === 'ok' && row.checked_at && now.getTime() - Date.parse(row.checked_at) < DEFAULT_THRESHOLDS.maxLinkAgeDays * 86_400_000)) {
    err('a fresh link check is required (the admin CLI runs one automatically)');
  }
  // An automated "ok" must have landed on the source itself, not wherever a redirect chain ended.
  if (linkStatus === 'ok') {
    const hosts = sourceHosts(row);
    let finalHost: string | null = null;
    try {
      finalHost = finalUrl ? new URL(finalUrl).hostname : null;
    } catch {
      finalHost = null;
    }
    if (!finalHost) err('link check has no final URL; re-run it');
    else if (!hostMatches(finalHost, hosts)) err(`link check ended on ${finalHost}, outside source ${row.source_id} (${hosts.join(', ')}); verify the link by hand`);
  }
  if (errors.length) return { ok: false, errors };

  const decision = mode === 'factual_summary' ? 'approved:factual_summary' : 'approved';
  try {
    await db.batch([
      db
        .prepare('UPDATE source_references SET link_status = ?, checked_at = ?, http_status = COALESCE(?, http_status), final_url = ?, published_at = ?, publisher = ? WHERE id = ?')
        .bind(linkStatus, checkedAt, httpStatus, finalUrl, publishedAt, publisher, row.reference_id),
      db
        .prepare(`UPDATE incidents SET verification_status = 'verified', location_verified = ?, game = ?, category = ?, updated_at = ? WHERE id = ?`)
        .bind(row.kind === 'FLORIDA_NEWS' ? 1 : 0, row.kind === 'GTA_CANON' ? game : null, req.category ?? row.category, stamp, row.incident_id),
      logStmt(db, {
        ...actor,
        entityType: 'question',
        entityId: row.question_id,
        decision,
        // Provenance for factual summaries: what was verified, where, by whom (actor), under which policy.
        details: { linkStatus, game, gateDecision: row.gate_decision, mode, ...(mode === 'factual_summary' ? { factual: req.factual, sourceLicense: row.license_status } : {}) },
      }),
      // The approval in force = the audit row just written (scheduling and serving check it).
      db
        .prepare(
          `UPDATE questions SET play_title = ?, play_title_reviewed = 1, play_title_fingerprint = ?, explanation = ?, difficulty = ?,
             quality_state = 'approved', approved_by = ?, approved_at = ?, approval_actor_type = 'human', updated_at = ?,
             approval_mode = ?, event_id = COALESCE(?, event_id), spoiler = COALESCE(?, spoiler),
             approval_log_id = (SELECT MAX(id) FROM review_log WHERE entity_type = 'question' AND entity_id = ? AND decision = ?)
           WHERE id = ? AND quality_state = 'candidate'`,
        )
        .bind(
          playTitle,
          titleFingerprint(playTitle),
          explanation,
          req.difficulty ?? row.difficulty,
          who.actorId,
          stamp,
          stamp,
          mode,
          req.eventId ?? null,
          req.spoiler === undefined ? null : req.spoiler ? 1 : 0,
          row.question_id,
          decision,
          row.question_id,
        ),
    ]);
  } catch (error) {
    if (isConstraintError(error)) return { ok: false, errors: ['PLAY_TITLE_DUPLICATE: an approved question already uses this wording'] };
    throw error;
  }
  return { ok: true, questionId: row.question_id, state: 'approved' };
}

/**
 * Revoke a human approval that should not stand (e.g. placeholder text), before it was ever scheduled.
 * The question goes back to `candidate` with its reviewed title flag and explanation cleared, so the
 * next approval must supply new text and pass every check again (factual-summary attestations are
 * per request and never stored, so they are always fresh). Source reference, provenance and earlier
 * review_log rows are untouched; the revoked text and approver are kept in the new log entry.
 * Scheduled questions are refused: published content goes through `withdraw` instead.
 */
async function revokeApproval(
  db: D1Database,
  row: CandidateRow,
  req: ReviewRequest,
  actor: { actorType: 'human'; actorId: string; policyVersion: string },
  stamp: string,
): Promise<ReviewResult> {
  const reason = cleanText(req.reason, 500);
  if (reason.length < 5) return { ok: false, errors: ['reason is required to revoke an approval (at least 5 characters)'] };
  if (row.quality_state !== 'approved') return { ok: false, errors: [`Question is ${row.quality_state}; only approved questions can be revoked`] };
  const scheduled = await db.prepare('SELECT day FROM daily_round_items WHERE question_id = ?').bind(row.question_id).first<{ day: string }>();
  if (scheduled) return { ok: false, errors: [`Question is scheduled on ${scheduled.day}; withdraw it instead (it stays in the audit trail).`] };
  const prior = await db
    .prepare('SELECT approved_by, approved_at, approval_actor_type FROM questions WHERE id = ?')
    .bind(row.question_id)
    .first<{ approved_by: string | null; approved_at: string | null; approval_actor_type: string | null }>();

  // Every statement re-checks "still approved and unscheduled", so a concurrent scheduler run or a
  // second revoke cannot leave a half-applied change; D1 runs the batch as one transaction.
  const stillRevocable = `EXISTS (SELECT 1 FROM questions WHERE id = ?1 AND quality_state = 'approved')
       AND NOT EXISTS (SELECT 1 FROM daily_round_items WHERE question_id = ?1)`;
  const details = {
    revoked: {
      playTitle: row.play_title,
      explanation: row.explanation,
      difficulty: row.difficulty,
      approvedBy: prior?.approved_by ?? null,
      approvedAt: prior?.approved_at ?? null,
      approvalActorType: prior?.approval_actor_type ?? null,
    },
  };
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO review_log (entity_type, entity_id, decision, reason, actor_type, actor_id, policy_version, details)
         SELECT 'question', ?1, 'approval_revoked', ?2, ?3, ?4, ?5, ?6 WHERE ${stillRevocable}`,
      )
      .bind(row.question_id, reason, actor.actorType, actor.actorId, actor.policyVersion, JSON.stringify(details)),
    db
      .prepare(`UPDATE incidents SET verification_status = 'unverified', updated_at = ?3 WHERE id = ?2 AND ${stillRevocable}`)
      .bind(row.question_id, row.incident_id, stamp),
    db
      .prepare(
        `UPDATE questions SET quality_state = 'candidate', play_title_reviewed = 0, explanation = '',
           approved_by = NULL, approved_at = NULL, approval_actor_type = NULL, approval_mode = NULL, approval_log_id = NULL, updated_at = ?2
         WHERE id = ?1 AND quality_state = 'approved' AND NOT EXISTS (SELECT 1 FROM daily_round_items WHERE question_id = ?1)`,
      )
      .bind(row.question_id, stamp),
  ]);
  if (!results[2]?.meta.changes) return { ok: false, errors: ['Question changed while revoking (scheduled or already revoked); nothing was modified'] };
  return { ok: true, questionId: row.question_id, state: 'candidate' };
}

/**
 * Withdraw a question or a whole day. Past/today rounds become `withdrawn`
 * (all visitors see ROUND_WITHDRAWN); future unpublished rounds that contain a
 * retired question are dropped so the scheduler can refill the date.
 */
export async function withdraw(db: D1Database, req: WithdrawRequest, who: Principal, now: Date) {
  const today = utcDate(now);
  const message = req.publicMessage ? cleanText(req.publicMessage, 200) : DEFAULT_WITHDRAWN_MESSAGE;
  const reason = cleanText(req.reason, 300);
  const base = { actorType: 'human' as const, actorId: who.actorId, policyVersion: POLICY_VERSION };
  const withdrawDay = (day: string) =>
    db
      .prepare(`UPDATE daily_rounds SET status = 'withdrawn', withdrawn_reason = ?, public_message = ?, content_version = content_version + 1 WHERE day = ?`)
      .bind(reason, message, day);

  if (req.target === 'day') {
    const r = await db.prepare('SELECT status FROM daily_rounds WHERE day = ?').bind(req.id).first<{ status: string }>();
    if (!r) throw new HttpError(404, 'NOT_FOUND', `No round on ${req.id}`);
    await db.batch([withdrawDay(req.id), logStmt(db, { ...base, entityType: 'day', entityId: req.id, decision: 'withdrawn', reason })]);
    return { withdrawnDays: [req.id], droppedFutureDays: [] as string[], retired: null as string | null };
  }

  const q = await db.prepare('SELECT id, quality_state FROM questions WHERE id = ?').bind(req.id).first<{ id: string; quality_state: string }>();
  if (!q) throw new HttpError(404, 'NOT_FOUND', `No question ${req.id}`);
  const { results } = await db
    .prepare(`SELECT r.day, r.status FROM daily_round_items i JOIN daily_rounds r ON r.day = i.day WHERE i.question_id = ?`)
    .bind(q.id)
    .all<{ day: string; status: string }>();
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE questions SET quality_state = 'retired', retired_reason = ?, updated_at = ? WHERE id = ?`).bind(reason, now.toISOString(), q.id),
    logStmt(db, { ...base, entityType: 'question', entityId: q.id, decision: 'retired', reason }),
  ];
  const withdrawnDays: string[] = [];
  const droppedFutureDays: string[] = [];
  for (const r of results) {
    if (r.day > today && r.status === 'scheduled') {
      stmts.push(db.prepare('DELETE FROM daily_round_items WHERE day = ?').bind(r.day), db.prepare('DELETE FROM daily_rounds WHERE day = ?').bind(r.day));
      stmts.push(logStmt(db, { ...base, entityType: 'day', entityId: r.day, decision: 'dropped_future_day', reason }));
      droppedFutureDays.push(r.day);
    } else if (r.status !== 'withdrawn') {
      stmts.push(withdrawDay(r.day), logStmt(db, { ...base, entityType: 'day', entityId: r.day, decision: 'withdrawn', reason }));
      withdrawnDays.push(r.day);
    }
  }
  await db.batch(stmts);
  return { withdrawnDays, droppedFutureDays, retired: q.id };
}

/** Merge a duplicate incident into another (reversible): its question is parked, references stay. */
export async function mergeIncidents(db: D1Database, req: { action: 'merge' | 'unmerge'; incidentId: string; intoIncidentId?: string; reason: string }, who: Principal) {
  const base = { actorType: 'human' as const, actorId: who.actorId, policyVersion: POLICY_VERSION };
  const inc = await db.prepare('SELECT id, status, merged_into FROM incidents WHERE id = ?').bind(req.incidentId).first<{ id: string; status: string; merged_into: string | null }>();
  if (!inc) throw new HttpError(404, 'NOT_FOUND', 'Unknown incident');
  const scheduled = await db
    .prepare('SELECT i.day FROM daily_round_items i JOIN questions q ON q.id = i.question_id WHERE q.incident_id = ?')
    .bind(inc.id)
    .first<{ day: string }>();
  if (req.action === 'merge') {
    if (!req.intoIncidentId || req.intoIncidentId === inc.id) throw new HttpError(400, 'BAD_REQUEST', 'intoIncidentId must be another incident');
    if (inc.status !== 'active') throw new HttpError(409, 'CONFLICT', `Incident is ${inc.status}`);
    if (scheduled) throw new HttpError(409, 'CONFLICT', `Incident is scheduled on ${scheduled.day}; withdraw first`);
    const into = await db.prepare(`SELECT id FROM incidents WHERE id = ? AND status = 'active'`).bind(req.intoIncidentId).first();
    if (!into) throw new HttpError(404, 'NOT_FOUND', 'Target incident not found or not active');
    await db.batch([
      db.prepare(`UPDATE incidents SET status = 'merged', merged_into = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(req.intoIncidentId, inc.id),
      db.prepare(`UPDATE questions SET quality_state = 'rejected', rejected_reason = 'merged' WHERE incident_id = ? AND quality_state = 'candidate'`).bind(inc.id),
      logStmt(db, { ...base, entityType: 'incident', entityId: inc.id, decision: 'merged', reason: req.reason, details: { into: req.intoIncidentId } }),
    ]);
  } else {
    if (inc.status !== 'merged') throw new HttpError(409, 'CONFLICT', 'Incident is not merged');
    await db.batch([
      db.prepare(`UPDATE incidents SET status = 'active', merged_into = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(inc.id),
      db.prepare(`UPDATE questions SET quality_state = 'candidate', rejected_reason = NULL WHERE incident_id = ? AND quality_state = 'rejected' AND rejected_reason = 'merged'`).bind(inc.id),
      logStmt(db, { ...base, entityType: 'incident', entityId: inc.id, decision: 'unmerged', reason: req.reason, details: { from: inc.merged_into } }),
    ]);
  }
  return { incidentId: inc.id, action: req.action };
}

export async function collectStats(db: D1Database, now: Date) {
  const today = utcDate(now);
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const [byState, byGate, sources, rounds, runs, usage, lastSchedule, benchmark, sourceYield] = await db.batch([
    db.prepare(`SELECT inc.kind, q.quality_state AS state, COUNT(*) AS n FROM questions q JOIN incidents inc ON inc.id = q.incident_id WHERE q.is_fixture = 0 GROUP BY inc.kind, q.quality_state`),
    db.prepare(`SELECT COALESCE(gate_decision, 'none') AS decision, quality_state AS state, COUNT(*) AS n FROM questions WHERE is_fixture = 0 GROUP BY 1, 2`),
    db.prepare(`SELECT license_status, COUNT(*) AS n FROM sources GROUP BY license_status`),
    db.prepare(`SELECT status, COUNT(*) AS n, MIN(day) AS first, MAX(day) AS last FROM daily_rounds WHERE day >= ? GROUP BY status`).bind(today),
    db.prepare(`SELECT id, provider, started_at, status, fetched_count, new_count, duplicate_count, rejected_count, errors FROM ingestion_runs ORDER BY started_at DESC LIMIT 6`),
    db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(ai_requests),0) AS requests, COALESCE(SUM(tokens_input),0) AS tokensIn, COALESCE(SUM(tokens_output),0) AS tokensOut, COALESCE(SUM(neurons_estimate),0) AS neurons FROM ingestion_runs WHERE started_at >= ?`).bind(since),
    db.prepare(`SELECT value FROM app_meta WHERE key = 'last_schedule_run'`),
    db.prepare(`SELECT value FROM app_meta WHERE key = 'benchmark'`),
    // Per-source yield: how many questions each source produced, by state (incl. used in rounds).
    db.prepare(
      `SELECT sr.source_id, sr.provider, q.quality_state AS state, COUNT(*) AS n,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM daily_round_items d WHERE d.question_id = q.id) THEN 1 ELSE 0 END) AS scheduled
         FROM questions q JOIN source_references sr ON sr.id = q.primary_reference_id
        WHERE q.is_fixture = 0 GROUP BY sr.source_id, sr.provider, q.quality_state ORDER BY sr.source_id`,
    ),
  ]);
  const ahead = (rounds!.results as { status: string; n: number }[]).filter((r) => r.status !== 'withdrawn').reduce((n, r) => n + r.n, 0);
  const todayRow = await db.prepare('SELECT status FROM daily_rounds WHERE day = ?').bind(today).first<{ status: string }>();
  const warnings: string[] = [];
  if (!todayRow || todayRow.status === 'withdrawn') warnings.push(`No playable round for today (${today}).`);
  if (ahead < 14) warnings.push(`Only ${ahead} round(s) scheduled from today (target 30).`);
  // Holes in the next 30 days: a missing day before a scheduled one.
  // Withdrawn days are not playable: they count as holes.
  const upcoming = await db.prepare(`SELECT day FROM daily_rounds WHERE day BETWEEN ? AND ? AND status <> 'withdrawn'`).bind(today, addDays(today, 29)).all<{ day: string }>();
  const have = new Set(upcoming.results.map((r) => r.day));
  const last = upcoming.results.map((r) => r.day).sort().at(-1);
  const holes: string[] = [];
  for (let i = 1; last && addDays(today, i) < last; i++) if (!have.has(addDays(today, i))) holes.push(addDays(today, i));
  if (holes.length) warnings.push(`Missing round(s) on ${holes.join(', ')} between scheduled days; run \`npm run admin -- schedule:top-up\` after approving more questions.`);
  const usageRow = usage!.results[0] as { neurons: number };
  if (usageRow.neurons > 8_000) warnings.push(`AI usage in the last 24h is ~${Math.round(usageRow.neurons)} neurons (free allocation 10,000/day).`);
  return {
    today,
    questions: byState!.results,
    gateDecisions: byGate!.results,
    sources: sources!.results,
    rounds: rounds!.results,
    scheduledAhead: ahead,
    recentRuns: runs!.results,
    aiUsage24h: usageRow,
    lastSchedule: (lastSchedule!.results[0] as { value?: string } | undefined)?.value ?? null,
    benchmark: (benchmark!.results[0] as { value?: string } | undefined)?.value ?? null,
    sourceYield: sourceYield!.results,
    policyVersion: POLICY_VERSION,
    warnings,
  };
}

/** Lookups for the job's prefilter (no fuzzy work in the Worker). */
export async function knownKeys(db: D1Database, canonicalUrls: string[], providerKeys: string[]) {
  const [u, k] = await Promise.all([
    canonicalUrls.length
      ? db.prepare(`SELECT canonical_url AS v FROM source_references WHERE canonical_url IN (${placeholders(canonicalUrls.length)})`).bind(...canonicalUrls).all<{ v: string }>()
      : null,
    providerKeys.length
      ? db.prepare(`SELECT provider_key AS v FROM source_references WHERE provider_key IN (${placeholders(providerKeys.length)})`).bind(...providerKeys).all<{ v: string }>()
      : null,
  ]);
  return { canonicalUrls: u?.results.map((r) => r.v) ?? [], providerKeys: k?.results.map((r) => r.v) ?? [] };
}

/** Paged title index (incident key + original title + reviewed play title) for client-side similarity. */
export async function titleIndex(db: D1Database, kind: string, cursor: string | null, limit = 500) {
  const { results } = await db
    .prepare(
      `SELECT inc.incident_key AS incidentKey, sr.original_title AS title, inc.kind, q.play_title AS playTitle, q.play_title_reviewed AS reviewed,
              COALESCE(sr.published_at, sr.provider_seen_at, inc.created_at) AS seenAt
         FROM incidents inc
         JOIN questions q ON q.incident_id = inc.id
         JOIN source_references sr ON sr.id = q.primary_reference_id
        WHERE inc.kind = ? AND inc.incident_key > ?
        ORDER BY inc.incident_key LIMIT ?`,
    )
    .bind(kind, cursor ?? '', limit)
    .all<{ incidentKey: string; title: string; kind: string; playTitle: string; reviewed: number; seenAt: string }>();
  const items = results.flatMap((r) => [
    { incidentKey: r.incidentKey, title: r.title, kind: r.kind, seenAt: r.seenAt },
    ...(r.reviewed ? [{ incidentKey: r.incidentKey, title: r.playTitle, kind: r.kind, seenAt: r.seenAt }] : []),
  ]);
  return { items, nextCursor: results.length === limit ? results[results.length - 1]!.incidentKey : null };
}

export { addDays };
