/**
 * Authenticated, idempotent candidate import from the ingestion job.
 *
 * The Worker is the enforcement point: it re-validates every item, resolves the
 * source policy from the *bundled, owner-reviewed* registry (never from the
 * payload), and runs the auto-publish gate itself. The job's opinion (prefilter,
 * AI trace) is input data, not authority.
 *
 * D1 budget: a handful of lookups + one batch (= one transaction) per request.
 */
import {
  accessOperationProblems,
  canonicalizeUrl,
  evaluateAutoPublish,
  OFFICIAL_PROVIDER,
  OFFICIAL_PUBLISH_OPERATIONS,
  operationStatus,
  explanationProblems,
  MANUAL_PROVIDER,
  parseAutoPublishMode,
  playTitleProblems,
  titleFingerprint,
  cleanText,
  type Benchmark,
  type GateDecision,
  type ImportBatch,
  type ImportItem,
  type ImportItemResult,
  type SourcePolicy,
} from '@gof/core';
import { DEFAULT_THRESHOLDS, POLICY_VERSION, REGISTRY, sourceById, sourceForUrl, type SourceRegistry } from '@gof/config';
import { isLocal, type Env } from '../env.ts';
import { getMeta, isConstraintError, logStmt, newId, placeholders, setMetaStmt } from '../db/repo.ts';
import { unsafeReferenceUrl } from '../security/url.ts';
import { sourceUpsertStmt } from './sources.ts';

export function thresholdsFrom(env: Env) {
  const rate = env.AUTO_PUBLISH_MAX_FALSE_APPROVAL_RATE?.trim();
  const sample = Number(env.HUMAN_SAMPLE_RATE);
  return {
    ...DEFAULT_THRESHOLDS,
    maxFalseApprovalRate: rate && Number.isFinite(Number(rate)) && Number(rate) >= 0 && Number(rate) <= 1 ? Number(rate) : null,
    humanSampleRate: Number.isFinite(sample) && sample >= 0.05 && sample <= 1 ? sample : DEFAULT_THRESHOLDS.humanSampleRate,
  };
}

export async function loadBenchmark(db: D1Database): Promise<Benchmark | null> {
  const raw = await getMeta(db, 'benchmark');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Benchmark;
  } catch {
    return null;
  }
}

/** Resolve the policy for an item from the registry. Never trusts the payload. */
export function resolveSource(item: ImportItem, registry: SourceRegistry = REGISTRY): SourcePolicy {
  if (item.kind === 'GTA_CANON') {
    const wiki = sourceById('grandtheftwiki', registry);
    const host = new URL(item.reference.canonicalUrl).hostname;
    if (wiki && wiki.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return wiki;
  }
  return sourceForUrl(item.reference.canonicalUrl, registry);
}

function staticProblems(item: ImportItem, env: Env, source: SourcePolicy): string[] {
  const out: string[] = [];
  const fixture = item.fixture === true;
  if (fixture && !isLocal(env)) out.push('FIXTURE_NOT_ALLOWED: fixtures can only be imported into the local environment');
  if (item.kind === 'GTA_PLAYER_EVENT') out.push('PLAYER_EVENTS_DISABLED: GTA_PLAYER_EVENT is disabled');
  // Historical third-party dataset: development material only (see apps/ingest/src/adapters/floridaman-dataset.ts).
  if (item.reference.provider === 'floridaman_dataset' && env.APP_ENV === 'production') out.push('PROVIDER_NOT_ALLOWED: the Florida Man dataset is staging/development only');
  for (const u of [item.reference.originalUrl, item.reference.canonicalUrl]) {
    const bad = unsafeReferenceUrl(u, { allowInvalidTld: fixture && isLocal(env) });
    if (bad) out.push(`${bad}: ${u.slice(0, 80)}`);
  }
  if (!fixture && canonicalizeUrl(item.reference.originalUrl) === null) out.push('URL_MALFORMED: originalUrl');
  if (item.kind === 'GTA_CANON' && source.type !== 'gta_wiki' && !fixture) out.push('SOURCE_KIND_MISMATCH: GTA canon must come from a registered GTA wiki source');
  if (item.kind === 'FLORIDA_NEWS' && source.type !== 'publisher' && !fixture) out.push('SOURCE_KIND_MISMATCH: Florida news must come from a publisher');
  if (item.attachToIncidentKey && item.kind !== 'FLORIDA_NEWS') out.push('ATTACH_NOT_ALLOWED: only Florida reports can attach to an existing incident');
  // Official-report items: a registered official source whose fetch is not denied, with facts that point at
  // the referenced document. Unknown operations are allowed IN (as candidates) — never into a round.
  if (item.reference.provider === OFFICIAL_PROVIDER) {
    if (!source.access) out.push(`OFFICIAL_SOURCE_UNREGISTERED: ${source.id} has no per-operation access review`);
    else if (operationStatus(source, 'fetch') === 'denied') out.push(`SOURCE_OPERATION_DENIED: fetch is denied for ${source.id}`);
    if (!item.facts) out.push('FACTS_REQUIRED: official-report items carry their structured facts');
    else if (item.facts.evidenceUrl !== item.reference.originalUrl) out.push('FACTS_EVIDENCE_MISMATCH: facts.evidenceUrl must be the referenced document');
    if (item.kind !== 'FLORIDA_NEWS') out.push('SOURCE_KIND_MISMATCH: official reports are Florida incidents');
  } else if (item.facts) out.push('FACTS_NOT_ALLOWED: structured facts are only accepted from official-report adapters');
  return out;
}

type Ctx = {
  env: Env;
  actorId: string;
  now: Date;
  draw: () => number;
  /** Defaults to the bundled owner-reviewed registry; injectable for tests only. */
  registry?: SourceRegistry;
};

export async function importBatch(batch: ImportBatch, ctx: Ctx): Promise<ImportItemResult[]> {
  const { env } = ctx;
  const db = env.DB;
  const items = batch.items;
  const results: ImportItemResult[] = [];

  const mode = parseAutoPublishMode(env.AUTO_PUBLISH_MODE);
  const thresholds = thresholdsFrom(env);
  const urls = [...new Set(items.flatMap((i) => [i.reference.canonicalUrl]))];
  const pkeys = [...new Set(items.map((i) => i.reference.providerKey).filter((k): k is string => !!k))];
  const ikeys = [...new Set(items.flatMap((i) => [i.incidentKey, i.attachToIncidentKey, i.incident.possibleDuplicateOfKey]).filter((k): k is string => !!k))];

  const [urlRows, keyRows, incRows, benchmark] = await Promise.all([
    urls.length ? db.prepare(`SELECT canonical_url FROM source_references WHERE canonical_url IN (${placeholders(urls.length)})`).bind(...urls).all<{ canonical_url: string }>() : null,
    pkeys.length ? db.prepare(`SELECT provider || '|' || provider_key AS k FROM source_references WHERE provider_key IN (${placeholders(pkeys.length)})`).bind(...pkeys).all<{ k: string }>() : null,
    ikeys.length ? db.prepare(`SELECT id, incident_key FROM incidents WHERE incident_key IN (${placeholders(ikeys.length)})`).bind(...ikeys).all<{ id: string; incident_key: string }>() : null,
    loadBenchmark(db),
  ]);
  const seenUrls = new Set(urlRows?.results.map((r) => r.canonical_url));
  const seenKeys = new Set(keyRows?.results.map((r) => r.k));
  const incidents = new Map(incRows?.results.map((r) => [r.incident_key, r.id]));

  // Fingerprints of approved titles, for items the gate might approve.
  const fps = [...new Set(items.map((i) => titleFingerprint(cleanText(i.question.playTitleDraft, 240))))];
  const fpRows = fps.length
    ? await db
        .prepare(`SELECT play_title_fingerprint AS fp FROM questions WHERE quality_state IN ('approved','retired') AND play_title_fingerprint IN (${placeholders(fps.length)})`)
        .bind(...fps)
        .all<{ fp: string }>()
    : null;
  const approvedFps = new Set(fpRows?.results.map((r) => r.fp));

  const plans: { item: ImportItem; result: ImportItemResult; stmts: D1PreparedStatement[] }[] = [];
  const touchedSources = new Map<string, SourcePolicy>();

  for (const item of items) {
    const result: ImportItemResult = { incidentKey: item.incidentKey, outcome: 'invalid' };
    results.push(result);
    let source: SourcePolicy;
    try {
      source = resolveSource(item, ctx.registry);
    } catch {
      result.errors = ['URL_MALFORMED'];
      continue;
    }
    const problems = staticProblems(item, env, source);
    if (problems.length) {
      result.errors = problems;
      continue;
    }
    const ref = item.reference;
    const pkey = ref.providerKey ? `${ref.provider}|${ref.providerKey}` : null;
    if (seenUrls.has(ref.canonicalUrl) || (pkey && seenKeys.has(pkey))) {
      result.outcome = 'duplicate';
      continue;
    }
    seenUrls.add(ref.canonicalUrl);
    if (pkey) seenKeys.add(pkey);
    touchedSources.set(source.id, source);

    const fixture = item.fixture === true;
    const stmts: D1PreparedStatement[] = [];
    const refId = newId('ref');
    const link = ref.linkCheck;
    const insertRef = (incidentId: string) =>
      db
        .prepare(
          `INSERT INTO source_references (id, incident_id, source_id, provider, provider_key, original_url, canonical_url, original_title, publisher,
             published_at, provider_seen_at, wiki_page_id, wiki_section, content_digest, link_status, http_status, final_url, checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          refId,
          incidentId,
          source.id,
          ref.provider,
          ref.providerKey,
          ref.originalUrl,
          ref.canonicalUrl,
          cleanText(ref.originalTitle, 400),
          ref.publisher ? cleanText(ref.publisher, 120) : null,
          ref.publishedAt,
          ref.providerSeenAt,
          ref.wikiPageId,
          ref.wikiSection,
          ref.contentDigest,
          fixture ? 'manual_ok' : (link?.status ?? 'unchecked'),
          link?.httpStatus ?? null,
          link?.finalUrl ?? null,
          link?.checkedAt ?? null,
        );

    // Another outlet's report of a known incident → attach as an extra source.
    const existingIncident = incidents.get(item.attachToIncidentKey ?? '') ?? incidents.get(item.incidentKey);
    if (existingIncident) {
      stmts.push(insertRef(existingIncident));
      stmts.push(logStmt(db, { entityType: 'reference', entityId: refId, decision: 'attached', actorType: 'service', actorId: ctx.actorId, details: { incidentId: existingIncident } }));
      result.outcome = 'attached';
      plans.push({ item, result, stmts });
      continue;
    }

    const incidentId = newId('inc');
    const questionId = newId('q');
    incidents.set(item.incidentKey, incidentId);
    const playTitle = cleanText(item.question.playTitleDraft, 240);
    const explanation = cleanText(item.question.explanationDraft, 800);
    const exactTitleAllowed = source.licenseStatus === 'approved' && source.canDisplayOriginalTitle;
    const titleIssues = playTitleProblems(playTitle, { originalTitle: ref.originalTitle, exactTitleAllowed });
    if (approvedFps.has(titleFingerprint(playTitle))) titleIssues.push('PLAY_TITLE_DUPLICATE: same wording as an approved question');
    const dupOf = item.incident.possibleDuplicateOfKey ? (incidents.get(item.incident.possibleDuplicateOfKey) ?? null) : null;

    let gate: GateDecision | null = null;
    if (!fixture && mode !== 'off') {
      gate = evaluateAutoPublish({
        mode,
        policyVersion: ctx.registry?.policyVersion ?? POLICY_VERSION,
        benchmark,
        thresholds,
        now: ctx.now,
        draw: ctx.draw(),
        facts: {
          kind: item.kind,
          fixture,
          manualSubmission: ref.provider === MANUAL_PROVIDER,
          source,
          linkStatus: link?.status ?? 'unchecked',
          linkCheckedAt: link?.checkedAt ?? null,
          linkFinalHostOk: !!link?.finalUrl && source.hosts.some((h) => {
            const host = new URL(link.finalUrl!).hostname;
            return host === h || host.endsWith(`.${h}`);
          }),
          playTitleProblems: titleIssues,
          explanationProblems: explanationProblems(explanation),
          possibleDuplicate: !!item.incident.possibleDuplicateOfKey,
          publishedAt: ref.publishedAt,
          floridaEvidence: !!item.incident.floridaEvidence,
          deterministicGame: item.incident.gameDetected,
          ai: item.ai
            ? {
                schemaValid: item.ai.schemaValid,
                relevant: item.ai.relevant,
                sensitive: item.ai.sensitive,
                needsReview: item.ai.needsReview,
                reasonCodes: item.ai.reasonCodes,
                gtaGame: item.ai.gtaGame,
              }
            : null,
        },
      });
    }
    // Deterministic code-rule rejections (satire domain, tragedy terms, no Florida signal…) apply in every
    // mode: rejecting is fail-closed. They can never cause an approval. Model-based rejections only act
    // in trusted_sources; in shadow they are recorded and a human still sees the item.
    const prefilterReject = item.prefilter.decision === 'reject';
    const state = fixture
      ? 'approved'
      : prefilterReject || gate?.effective === 'reject'
        ? 'rejected'
        : gate?.effective === 'approve'
          ? 'approved'
          : 'candidate';
    const approvedByPolicy = state === 'approved' && !fixture;
    const accessReasons =
      ref.provider === OFFICIAL_PROVIDER && accessOperationProblems(source, OFFICIAL_PUBLISH_OPERATIONS).length ? ['SOURCE_ACCESS_UNRESOLVED'] : [];
    const reasons = [
      ...new Set([...(gate?.reasons ?? []), ...accessReasons, ...(prefilterReject ? item.prefilter.reasonCodes.map((r) => `PREFILTER_${r}`) : [])]),
    ];

    stmts.push(
      db
        .prepare(
          `INSERT INTO incidents (id, incident_key, kind, category, game, game_detected, florida_location, florida_signal, location_verified,
             verification_status, sensitivity, possible_duplicate_of, similarity, notes, is_fixture, facts, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          incidentId,
          item.incidentKey,
          item.kind,
          item.ai?.category ?? item.incident.category,
          approvedByPolicy || fixture ? item.incident.gameDetected : null,
          item.incident.gameDetected,
          item.incident.floridaEvidence,
          item.incident.floridaSignal,
          approvedByPolicy || (fixture && item.kind === 'FLORIDA_NEWS') ? 1 : 0,
          state === 'approved' ? 'verified' : 'unverified',
          item.ai ? (item.ai.sensitive ? 'sensitive' : 'ok') : 'unknown',
          dupOf,
          item.incident.similarity,
          item.incident.notes,
          fixture ? 1 : 0,
          item.facts ? JSON.stringify(item.facts) : null,
          item.facts?.eventDate.precision === 'day' ? item.facts.eventDate.from : null,
        ),
    );
    stmts.push(insertRef(incidentId));
    stmts.push(
      db
        .prepare(
          `INSERT INTO questions (id, incident_id, primary_reference_id, answer_kind, play_title, play_title_reviewed, play_title_fingerprint, explanation,
             difficulty, quality_state, gate_decision, gate_reasons, confidence_metadata, eligible_for_auto_publish, approved_by, approved_at,
             approval_actor_type, rejected_reason, is_fixture, event_id, spoiler)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          questionId,
          incidentId,
          refId,
          item.kind === 'FLORIDA_NEWS' ? 'FLORIDA' : 'GTA',
          playTitle,
          fixture ? 1 : 0,
          state === 'approved' ? titleFingerprint(playTitle) : null,
          explanation,
          item.question.difficulty,
          state,
          gate?.decision ?? null,
          reasons.length ? JSON.stringify(reasons) : null,
          item.ai ? JSON.stringify({ ...item.ai, policyVersion: POLICY_VERSION, mode }) : null,
          gate?.decision === 'auto_approve' ? 1 : 0,
          state === 'approved' ? (fixture ? 'fixture-import' : `policy:${POLICY_VERSION}`) : null,
          state === 'approved' ? ctx.now.toISOString() : null,
          state === 'approved' ? (fixture ? 'human' : 'policy') : null,
          state === 'rejected' ? `gate: ${reasons.join(', ')}`.slice(0, 500) : null,
          fixture ? 1 : 0,
          item.question.eventId ?? null,
          item.question.spoiler ? 1 : 0,
        ),
    );
    stmts.push(
      logStmt(db, {
        entityType: 'question',
        entityId: questionId,
        decision: `import:${state}`,
        reason: reasons.join(', ') || null,
        actorType: approvedByPolicy ? 'policy' : 'service',
        actorId: approvedByPolicy ? `policy:${POLICY_VERSION}` : ctx.actorId,
        policyVersion: POLICY_VERSION,
        details: { incidentKey: item.incidentKey, mode, gate, ai: item.ai, prefilter: item.prefilter },
      }),
    );
    if (state === 'approved') {
      // Policy (or local fixture) approvals are licensed approvals; record the audit row in force.
      stmts.push(
        db
          .prepare(
            `UPDATE questions SET approval_mode = 'licensed',
               approval_log_id = (SELECT MAX(id) FROM review_log WHERE entity_type = 'question' AND entity_id = ?1 AND decision = 'import:approved')
             WHERE id = ?1 AND quality_state = 'approved'`,
          )
          .bind(questionId),
      );
    }
    result.outcome = 'inserted';
    result.questionState = state;
    if (gate) result.gate = { decision: gate.decision, effective: gate.effective, reasons };
    plans.push({ item, result, stmts });
  }

  const sourceStmts = [...touchedSources.values()].map((src) => sourceUpsertStmt(db, src, POLICY_VERSION));
  const runStmts: D1PreparedStatement[] = [];
  if (batch.run) runStmts.push(runUpsertStmt(db, batch.run));
  for (const c of batch.checkpoints ?? []) {
    runStmts.push(
      db
        .prepare(
          `INSERT INTO ingestion_checkpoints (provider, key, value, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(provider, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(c.provider, c.key, c.value),
    );
  }

  const all = [...sourceStmts, ...plans.flatMap((p) => p.stmts), ...runStmts];
  if (all.length === 0) return results;
  try {
    await db.batch(all);
  } catch (error) {
    if (!isConstraintError(error)) throw error;
    // A concurrent import won a race: fall back to one transaction per item so the rest still lands.
    if (sourceStmts.length) await db.batch(sourceStmts);
    for (const p of plans) {
      try {
        await db.batch(p.stmts);
      } catch (e) {
        if (!isConstraintError(e)) throw e;
        p.result.outcome = 'duplicate';
        delete p.result.questionState;
      }
    }
    if (runStmts.length) await db.batch(runStmts);
  }
  return results;
}

export function runUpsertStmt(db: D1Database, run: NonNullable<ImportBatch['run']>): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ingestion_runs (id, provider, started_at, finished_at, status, fetched_count, new_count, duplicate_count, rejected_count, errors,
         model_id, ai_requests, tokens_input, tokens_output, neurons_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, status = excluded.status, fetched_count = excluded.fetched_count,
         new_count = excluded.new_count, duplicate_count = excluded.duplicate_count, rejected_count = excluded.rejected_count, errors = excluded.errors,
         model_id = excluded.model_id, ai_requests = excluded.ai_requests, tokens_input = excluded.tokens_input, tokens_output = excluded.tokens_output,
         neurons_estimate = excluded.neurons_estimate`,
    )
    .bind(
      run.id,
      run.provider,
      run.startedAt,
      run.finishedAt,
      run.status,
      run.fetched,
      run.newCount,
      run.duplicates,
      run.rejected,
      JSON.stringify(run.errors),
      run.models.join(',') || null,
      run.aiRequests,
      run.tokensIn,
      run.tokensOut,
      run.neuronsEstimate,
    );
}

export { setMetaStmt };
