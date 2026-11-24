/**
 * Protected operations. Bearer token required on every route; no CORS headers
 * (browsers cannot call these cross-origin). Bodies are size-limited and
 * schema-validated; mutating calls are audited in review_log.
 */
import {
  addDays,
  benchmarkSchema,
  formatIssues,
  importBatchSchema,
  knownRequestSchema,
  MAX_ADMIN_BODY_BYTES,
  MAX_IMPORT_BYTES,
  parse,
  reviewSchema,
  s,
  scheduleSchema,
  utcDate,
  withdrawSchema,
  CONTENT_KINDS,
  type ImportResponse,
  type Schema,
} from '@gof/core';
import { POLICY_VERSION, SCHEDULE_AHEAD_DAYS } from '@gof/config';
import { isLocal, type Env } from '../env.ts';
import { HttpError, json, only, readJson } from '../http.ts';
import { authenticate } from '../security/auth.ts';
import { idempotencyKey, pruneStmt, rememberStmt, replay, sha256Hex } from '../security/idempotency.ts';
import { logStmt, setMetaStmt } from '../db/repo.ts';
import { importBatch } from '../services/importer.ts';
import { candidateDetails, collectStats, knownKeys, listCandidates, mergeIncidents, review, titleIndex, withdraw } from '../services/review.ts';
import { ensureSchedule, scheduleRounds } from '../services/scheduling.ts';
import { syncSources } from '../services/sources.ts';

function validate<T>(schema: Schema<T>, body: unknown): T {
  const r = parse(schema, body);
  if (!r.ok) throw new HttpError(400, 'VALIDATION_FAILED', formatIssues(r.issues));
  return r.value;
}

const mergeSchema = s.object({
  action: s.enum(['merge', 'unmerge'] as const),
  incidentId: s.string({ min: 1, max: 80 }),
  intoIncidentId: s.optional(s.string({ min: 1, max: 80 })),
  reason: s.string({ min: 3, max: 300 }),
});

const intParam = (v: string | null, def: number, min: number, max: number) => {
  const n = v === null ? def : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'BAD_REQUEST', `Expected an integer ${min}-${max}.`);
  return n;
};

export async function handleAdmin(request: Request, env: Env, url: URL, now: () => Date): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/v1\/admin/, '');
  const db = env.DB;

  // --- service token (ingestion job) or admin ------------------------------
  if (path === '/import') {
    only(request, 'POST');
    const who = await authenticate(request, env, 'service');
    const key = idempotencyKey(request, true)!;
    const raw = await readJson(request, MAX_IMPORT_BYTES);
    const hash = await sha256Hex(JSON.stringify(raw));
    const previous = await replay(db, key, hash);
    if (previous) return json(200, { ...(previous as object), replayed: true });
    const batch = validate(importBatchSchema, raw);
    const results = await importBatch(batch, { env, actorId: who.actorId, now: now(), draw: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32 });
    const response: ImportResponse = { results, replayed: false };
    await db.batch([rememberStmt(db, key, hash, response), pruneStmt(db)]);
    return json(200, response);
  }
  if (path === '/known') {
    only(request, 'POST');
    await authenticate(request, env, 'service');
    const body = validate(knownRequestSchema, await readJson(request, MAX_ADMIN_BODY_BYTES));
    return json(200, await knownKeys(db, body.canonicalUrls, body.providerKeys));
  }
  if (path === '/titles') {
    only(request, 'GET');
    await authenticate(request, env, 'service');
    const kind = url.searchParams.get('kind') ?? '';
    if (!(CONTENT_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'BAD_REQUEST', 'kind is required');
    // Optional smaller pages let CPU-bounded callers (the ingestion Workflow) scan in steps.
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 500);
    return json(200, await titleIndex(db, kind, url.searchParams.get('cursor'), limit));
  }
  if (path === '/checkpoints') {
    only(request, 'GET');
    await authenticate(request, env, 'service');
    const provider = url.searchParams.get('provider') ?? '';
    const { results } = await db.prepare('SELECT key, value, updated_at FROM ingestion_checkpoints WHERE provider = ?').bind(provider).all();
    return json(200, { provider, checkpoints: results });
  }
  if (path === '/schedule') {
    only(request, 'POST');
    const who = await authenticate(request, env, 'service');
    const body = validate(scheduleSchema, await readJson(request, MAX_ADMIN_BODY_BYTES));
    const today = utcDate(now());
    if (body.startDate && body.startDate < today) throw new HttpError(400, 'BAD_REQUEST', 'startDate cannot be in the past (published rounds are immutable).');
    const actorType = who.role === 'admin' ? ('human' as const) : ('service' as const);
    if (!body.startDate && !body.dryRun) {
      return json(200, await ensureSchedule(db, { now: now(), aheadDays: Math.min(body.days, 60), allowFixtures: isLocal(env), actorId: who.actorId, actorType, appEnv: env.APP_ENV }));
    }
    return json(200, await scheduleRounds(db, { startDate: body.startDate ?? today, days: body.days, dryRun: body.dryRun, allowFixtures: isLocal(env), actorId: who.actorId, actorType, appEnv: env.APP_ENV }));
  }

  // --- admin only -----------------------------------------------------------
  const who = await authenticate(request, env, 'admin');
  if (path === '/stats') {
    only(request, 'GET');
    return json(200, await collectStats(db, now()));
  }
  if (path === '/candidates') {
    only(request, 'GET');
    const rows = await listCandidates(db, {
      kind: url.searchParams.get('kind') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      decision: url.searchParams.get('decision') ?? undefined,
      limit: intParam(url.searchParams.get('limit'), 30, 1, 200),
      offset: intParam(url.searchParams.get('offset'), 0, 0, 1_000_000),
    });
    return json(200, { items: rows });
  }
  const detail = /^\/candidates\/([A-Za-z0-9:_.#%!'()*~-]{1,600})$/.exec(path);
  if (detail) {
    only(request, 'GET');
    const d = await candidateDetails(db, decodeURIComponent(detail[1]!));
    if (!d) throw new HttpError(404, 'NOT_FOUND', 'Unknown question/incident');
    return json(200, d);
  }
  if (path === '/review') {
    only(request, 'POST');
    const body = validate(reviewSchema, await readJson(request, MAX_ADMIN_BODY_BYTES));
    const r = await review(db, body, who, now(), env.APP_ENV);
    return json(r.ok ? 200 : 422, r.ok ? r : { error: { code: 'VALIDATION_FAILED', message: r.errors.join('\n') }, errors: r.errors });
  }
  if (path === '/withdraw') {
    only(request, 'POST');
    const body = validate(withdrawSchema, await readJson(request, MAX_ADMIN_BODY_BYTES));
    return json(200, await withdraw(db, body, who, now()));
  }
  if (path === '/merge') {
    only(request, 'POST');
    const body = validate(mergeSchema, await readJson(request, MAX_ADMIN_BODY_BYTES));
    return json(200, await mergeIncidents(db, body, who));
  }
  if (path === '/sources/sync') {
    only(request, 'POST');
    return json(200, await syncSources(db, who.actorId));
  }
  if (path === '/benchmark') {
    only(request, 'POST');
    const body = validate(benchmarkSchema, await readJson(request, MAX_ADMIN_BODY_BYTES));
    if (body.policyVersion !== POLICY_VERSION) throw new HttpError(409, 'CONFLICT', `Benchmark is for policy ${body.policyVersion}; deployed policy is ${POLICY_VERSION}.`);
    const record = { ...body, measuredBy: who.actorId };
    await db.batch([
      setMetaStmt(db, 'benchmark', JSON.stringify(record)),
      logStmt(db, { entityType: 'benchmark', entityId: body.policyVersion, decision: 'recorded', actorType: 'human', actorId: who.actorId, policyVersion: POLICY_VERSION, details: record }),
    ]);
    return json(200, { recorded: record });
  }
  if (path === '/ensure-schedule') {
    only(request, 'POST');
    return json(200, await ensureSchedule(db, { now: now(), aheadDays: SCHEDULE_AHEAD_DAYS, allowFixtures: isLocal(env), actorId: who.actorId, actorType: 'human', appEnv: env.APP_ENV }));
  }
  throw new HttpError(404, 'NOT_FOUND', 'Unknown admin route.');
}

export { addDays };
