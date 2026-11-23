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
  playTitleProblems,
  sourceProblems,
  titleFingerprint,
  utcDate,
  type ContentKind,
  type ReviewRequest,
  type WithdrawRequest,
} from '@gof/core';
import { DEFAULT_THRESHOLDS, POLICY_VERSION, sourceById } from '@gof/config';
import type { Principal } from '../security/auth.ts';
import { HttpError } from '../http.ts';
import { isConstraintError, logStmt, placeholders } from '../db/repo.ts';

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
};

const CANDIDATE_SQL = `
  SELECT q.id AS question_id, q.quality_state, q.gate_decision, q.gate_reasons, q.answer_kind, q.play_title, q.play_title_reviewed,
         q.explanation, q.difficulty, q.is_fixture, q.created_at,
         inc.id AS incident_id, inc.incident_key, inc.kind, inc.category, inc.game, inc.game_detected, inc.florida_location, inc.florida_signal,
         inc.location_verified, inc.status AS incident_status, inc.possible_duplicate_of, inc.similarity, inc.notes,
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
  return { ...row, references: refs!.results, scheduledOn: (days!.results as { day: string }[]).map((d) => d.day), log: log!.results };
}

export type ReviewResult = { ok: true; questionId: string; state: string } | { ok: false; errors: string[] };

const LINK_FRESH_MS = 24 * 3600_000;

/** Hosts of the candidate's source: the bundled registry first, else the host recorded in D1. */
function sourceHosts(row: Pick<CandidateRow, 'source_id' | 'source_host'>): string[] {
  return sourceById(row.source_id)?.hosts ?? (row.source_host ? [row.source_host] : []);
}

export async function review(db: D1Database, req: ReviewRequest, who: Principal, now: Date): Promise<ReviewResult> {
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

  const playTitle = req.playTitle !== undefined ? cleanText(req.playTitle, 240) : row.play_title;
  const explanation = req.explanation !== undefined ? cleanText(req.explanation, 800) : row.explanation;

  if (req.action === 'edit') {
    if (row.quality_state !== 'candidate') return { ok: false, errors: ['Only candidates can be edited'] };
    await db.batch([
      db.prepare('UPDATE questions SET play_title = ?, explanation = ?, difficulty = ?, updated_at = ? WHERE id = ?').bind(playTitle, explanation, req.difficulty ?? row.difficulty, stamp, row.question_id),
      logStmt(db, { ...actor, entityType: 'question', entityId: row.question_id, decision: 'edited' }),
    ]);
    return { ok: true, questionId: row.question_id, state: 'candidate' };
  }

  // ---- approve -------------------------------------------------------------
  const errors: string[] = [];
  const err = (m: string) => errors.push(m);
  if (row.quality_state !== 'candidate') err(`Question is ${row.quality_state}; only candidates can be approved`);
  if (row.incident_status !== 'active') err(`Incident is ${row.incident_status}`);
  if (row.is_fixture) err('Fixture content cannot be approved as a real question');
  if (row.kind === 'GTA_PLAYER_EVENT') err('GTA_PLAYER_EVENT is disabled');
  if (row.possible_duplicate_of && !req.notDuplicate) err(`Flagged as possible duplicate of ${row.possible_duplicate_of}; merge it or pass notDuplicate after checking`);

  for (const p of sourceProblems({
    licenseStatus: row.license_status as never,
    canUseEditorialSummary: row.can_use_editorial_summary === 1,
    reviewedBy: row.source_reviewed_by ?? undefined,
    reviewedAt: row.source_reviewed_at ?? undefined,
  })) {
    err(`${p} (${row.source_id}). Rights are decided per source in packages/config/sources.policy.json, then deployed + synced.`);
  }
  if (req.playTitle === undefined && !row.play_title_reviewed) err('playTitle is required: write (or confirm) the neutral title yourself');
  const exactTitleAllowed = row.license_status === 'approved' && row.can_display_original_title === 1;
  for (const p of playTitleProblems(playTitle, { originalTitle: row.original_title, exactTitleAllowed })) err(p);
  if (req.explanation === undefined && !row.explanation) err('explanation is required');
  for (const p of explanationProblems(explanation)) err(p);

  const publishedAt = req.publishedAt ?? row.published_at;
  const publisher = req.publisher ?? row.publisher;
  const game = req.game ?? null;
  if (row.kind === 'FLORIDA_NEWS') {
    if (!(req.locationVerified ?? row.location_verified === 1)) err('locationVerified: confirm the event happened in Florida');
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

  try {
    await db.batch([
      db
        .prepare('UPDATE source_references SET link_status = ?, checked_at = ?, http_status = COALESCE(?, http_status), final_url = ?, published_at = ?, publisher = ? WHERE id = ?')
        .bind(linkStatus, checkedAt, httpStatus, finalUrl, publishedAt, publisher, row.reference_id),
      db
        .prepare(`UPDATE incidents SET verification_status = 'verified', location_verified = ?, game = ?, category = ?, updated_at = ? WHERE id = ?`)
        .bind(row.kind === 'FLORIDA_NEWS' ? 1 : 0, row.kind === 'GTA_CANON' ? game : null, req.category ?? row.category, stamp, row.incident_id),
      db
        .prepare(
          `UPDATE questions SET play_title = ?, play_title_reviewed = 1, play_title_fingerprint = ?, explanation = ?, difficulty = ?,
             quality_state = 'approved', approved_by = ?, approved_at = ?, approval_actor_type = 'human', updated_at = ?
           WHERE id = ? AND quality_state = 'candidate'`,
        )
        .bind(playTitle, titleFingerprint(playTitle), explanation, req.difficulty ?? row.difficulty, who.actorId, stamp, stamp, row.question_id),
      logStmt(db, { ...actor, entityType: 'question', entityId: row.question_id, decision: 'approved', details: { linkStatus, game, gateDecision: row.gate_decision } }),
    ]);
  } catch (error) {
    if (isConstraintError(error)) return { ok: false, errors: ['PLAY_TITLE_DUPLICATE: an approved question already uses this wording'] };
    throw error;
  }
  return { ok: true, questionId: row.question_id, state: 'approved' };
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
  const [byState, byGate, sources, rounds, runs, usage, lastSchedule, benchmark] = await db.batch([
    db.prepare(`SELECT inc.kind, q.quality_state AS state, COUNT(*) AS n FROM questions q JOIN incidents inc ON inc.id = q.incident_id WHERE q.is_fixture = 0 GROUP BY inc.kind, q.quality_state`),
    db.prepare(`SELECT COALESCE(gate_decision, 'none') AS decision, quality_state AS state, COUNT(*) AS n FROM questions WHERE is_fixture = 0 GROUP BY 1, 2`),
    db.prepare(`SELECT license_status, COUNT(*) AS n FROM sources GROUP BY license_status`),
    db.prepare(`SELECT status, COUNT(*) AS n, MIN(day) AS first, MAX(day) AS last FROM daily_rounds WHERE day >= ? GROUP BY status`).bind(today),
    db.prepare(`SELECT id, provider, started_at, status, fetched_count, new_count, duplicate_count, rejected_count, errors FROM ingestion_runs ORDER BY started_at DESC LIMIT 6`),
    db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(ai_requests),0) AS requests, COALESCE(SUM(tokens_input),0) AS tokensIn, COALESCE(SUM(tokens_output),0) AS tokensOut, COALESCE(SUM(neurons_estimate),0) AS neurons FROM ingestion_runs WHERE started_at >= ?`).bind(since),
    db.prepare(`SELECT value FROM app_meta WHERE key = 'last_schedule_run'`),
    db.prepare(`SELECT value FROM app_meta WHERE key = 'benchmark'`),
  ]);
  const ahead = (rounds!.results as { status: string; n: number }[]).filter((r) => r.status !== 'withdrawn').reduce((n, r) => n + r.n, 0);
  const todayRow = await db.prepare('SELECT status FROM daily_rounds WHERE day = ?').bind(today).first<{ status: string }>();
  const warnings: string[] = [];
  if (!todayRow || todayRow.status === 'withdrawn') warnings.push(`No playable round for today (${today}).`);
  if (ahead < 14) warnings.push(`Only ${ahead} round(s) scheduled from today (target 30).`);
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
