/**
 * Daily round scheduler (D1).
 *
 *  - Randomness happens once, here, when a day is created; the order is persisted.
 *  - Existing days are never reshuffled or replaced. Concurrent runs are safe:
 *    day PRIMARY KEY, round number UNIQUE and question_id UNIQUE make a racing
 *    insert fail as a whole batch (D1 batches are transactions); we re-read and retry once.
 *  - Only approved questions of verified, active incidents from owner-approved
 *    sources with a verified link are eligible. Never-scheduled only.
 *  - On shortage we stop at that date. Nothing is invented or reused.
 */
import { addDays, answerPattern, cryptoRng, daysBetween, isIsoDate, planDay, runwayDays, utcDate, type PoolQuestion, type Rng, type ScheduleResponse } from '@gof/core';
import { DAILY_SIZE, LOW_INVENTORY_DAYS } from '@gof/config';
import { getMeta, isConstraintError, logStmt, setMetaStmt } from '../db/repo.ts';

export type ScheduleOptions = {
  startDate: string;
  days: number;
  dryRun?: boolean;
  allowFixtures?: boolean;
  actorId?: string;
  actorType?: 'human' | 'service' | 'system';
  rng?: Rng;
};

const POOL_SQL = (allowFixtures: boolean) => `
  SELECT q.id, q.answer_kind AS answer, inc.category, q.difficulty, sr.publisher, inc.game
    FROM questions q
    JOIN incidents inc ON inc.id = q.incident_id
    JOIN source_references sr ON sr.id = q.primary_reference_id
    JOIN sources s ON s.id = sr.source_id
   WHERE q.quality_state = 'approved'
     AND inc.status = 'active'
     AND inc.verification_status = 'verified'
     AND inc.kind IN ('FLORIDA_NEWS','GTA_CANON')
     AND (inc.kind <> 'FLORIDA_NEWS' OR inc.location_verified = 1)
     AND (inc.kind <> 'GTA_CANON' OR inc.game IS NOT NULL OR q.is_fixture = 1)
     AND (q.is_fixture = 1 OR (s.license_status = 'approved' AND s.can_use_editorial_summary = 1 AND s.enabled = 1
          AND sr.link_status IN ('ok','manual_ok')))
     AND q.is_fixture IN (${allowFixtures ? '0, 1' : '0'})
     AND NOT EXISTS (SELECT 1 FROM daily_round_items d WHERE d.question_id = q.id)
   ORDER BY q.id`;

export async function eligiblePool(db: D1Database, allowFixtures = false): Promise<PoolQuestion[]> {
  return (await db.prepare(POOL_SQL(allowFixtures)).all<PoolQuestion>()).results;
}

export async function publishDueRounds(db: D1Database, today: string): Promise<number> {
  const r = await db
    .prepare(`UPDATE daily_rounds SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status = 'scheduled' AND day <= ?`)
    .bind(today)
    .run();
  return r.meta.changes ?? 0;
}

type ExistingDay = { day: string; florida_count: number; pattern: string };

async function existingDays(db: D1Database, from: string, to: string): Promise<Map<string, ExistingDay>> {
  const { results } = await db
    .prepare(
      `SELECT r.day, r.florida_count, group_concat(CASE q.answer_kind WHEN 'FLORIDA' THEN 'F' ELSE 'G' END, '') AS pattern
         FROM daily_rounds r
         LEFT JOIN (SELECT * FROM daily_round_items ORDER BY day, position) i ON i.day = r.day
         LEFT JOIN questions q ON q.id = i.question_id
        WHERE r.day BETWEEN ? AND ?
        GROUP BY r.day`,
    )
    .bind(from, to)
    .all<ExistingDay>();
  return new Map(results.map((r) => [r.day, r]));
}

export async function scheduleRounds(db: D1Database, opts: ScheduleOptions): Promise<ScheduleResponse> {
  if (!isIsoDate(opts.startDate)) throw new Error(`Invalid start date ${opts.startDate}`);
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 60) throw new Error('days must be 1-60');
  for (let attempt = 0; ; attempt++) {
    try {
      return await scheduleOnce(db, opts);
    } catch (error) {
      // Another run inserted overlapping days/questions first: re-read and plan again (once).
      if (attempt === 0 && isConstraintError(error)) continue;
      throw error;
    }
  }
}

async function scheduleOnce(db: D1Database, opts: ScheduleOptions): Promise<ScheduleResponse> {
  const rng = opts.rng ?? cryptoRng;
  const size = DAILY_SIZE;
  const end = addDays(opts.startDate, opts.days - 1);
  const [pool, existing, epochMeta] = await Promise.all([
    eligiblePool(db, opts.allowFixtures),
    existingDays(db, addDays(opts.startDate, -1), end),
    getMeta(db, 'schedule_epoch'),
  ]);
  const epoch = epochMeta ?? opts.startDate;
  const used = new Set<string>();
  const out: ScheduleResponse = {
    added: [],
    kept: [],
    shortageDate: null,
    warnings: [],
    inventory: { unusedFlorida: 0, unusedGta: 0, runwayDays: 0, scheduledAhead: 0 },
  };
  const stmts: D1PreparedStatement[] = [];
  let prev: { florida: number; pattern: string } | null = (() => {
    const d = existing.get(addDays(opts.startDate, -1));
    return d ? { florida: d.florida_count, pattern: d.pattern ?? '' } : null;
  })();

  for (let offset = 0; offset < opts.days; offset++) {
    const day = addDays(opts.startDate, offset);
    const have = existing.get(day);
    if (have) {
      out.kept.push(day);
      prev = { florida: have.florida_count, pattern: have.pattern ?? '' };
      continue;
    }
    const plan = planDay({
      pool: pool.filter((q) => !used.has(q.id)),
      size,
      previousFlorida: prev?.florida ?? null,
      previousPattern: prev?.pattern ?? null,
      rng,
    });
    if (!plan.ok) {
      out.shortageDate = day;
      out.warnings.push({
        code: 'shortage',
        date: day,
        message: `Not enough eligible approved questions for ${day} (unused Florida ${plan.floridaAvailable}, GTA ${plan.gtaAvailable}; need 2-3 of each). Scheduling stopped; nothing was invented.`,
      });
      break;
    }
    if (!plan.alternationKept) out.warnings.push({ code: 'alternation_broken', date: day, message: `${day}: repeated a ${plan.floridaCount}-Florida split (stock too low to alternate).` });
    plan.questions.forEach((q) => used.add(q.id));
    const number = daysBetween(epoch, day) + 1;
    if (number < 1) throw new Error(`Cannot schedule ${day} before the schedule epoch ${epoch}`);
    stmts.push(db.prepare(`INSERT INTO daily_rounds (day, number, status, florida_count) VALUES (?, ?, 'scheduled', ?)`).bind(day, number, plan.floridaCount));
    plan.questions.forEach((q, i) => stmts.push(db.prepare('INSERT INTO daily_round_items (day, position, question_id) VALUES (?, ?, ?)').bind(day, i + 1, q.id)));
    stmts.push(
      logStmt(db, {
        entityType: 'day',
        entityId: day,
        decision: 'scheduled',
        actorType: opts.actorType ?? 'system',
        actorId: opts.actorId ?? 'scheduler',
        details: { questionIds: plan.questions.map((q) => q.id), floridaCount: plan.floridaCount },
      }),
    );
    out.added.push({ date: day, floridaCount: plan.floridaCount });
    prev = { florida: plan.floridaCount, pattern: answerPattern(plan.questions) };
  }

  if (!opts.dryRun && stmts.length) {
    if (!epochMeta) stmts.unshift(db.prepare(`INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schedule_epoch', ?)`).bind(epoch));
    // One transaction for the whole run: all days or none.
    await db.batch(stmts);
  }

  const remaining = pool.filter((q) => !used.has(q.id));
  const unusedFlorida = remaining.filter((q) => q.answer === 'FLORIDA').length;
  const unusedGta = remaining.length - unusedFlorida;
  const aheadRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM daily_rounds WHERE day >= ? AND status <> 'withdrawn'`)
    .bind(opts.startDate)
    .first<{ n: number }>();
  const scheduledAhead = (aheadRow?.n ?? 0) + (opts.dryRun ? out.added.length : 0);
  out.inventory = { unusedFlorida, unusedGta, runwayDays: runwayDays(unusedFlorida, unusedGta, size), scheduledAhead };
  if (scheduledAhead + out.inventory.runwayDays < LOW_INVENTORY_DAYS) {
    out.warnings.push({
      code: 'low_inventory',
      message: `Only ${scheduledAhead} day(s) scheduled and ~${out.inventory.runwayDays} more fillable (unused approved: ${unusedFlorida} Florida / ${unusedGta} GTA). Target ≥ ${LOW_INVENTORY_DAYS} days.`,
    });
  }
  return out;
}

/** Cron + admin entry point: keep `aheadDays` scheduled from today, then mark due days published. */
export async function ensureSchedule(db: D1Database, opts: { now: Date; aheadDays: number; allowFixtures?: boolean; actorId?: string; actorType?: 'human' | 'service' | 'system' }) {
  const today = utcDate(opts.now);
  const result = await scheduleRounds(db, { startDate: today, days: opts.aheadDays, allowFixtures: opts.allowFixtures, actorId: opts.actorId, actorType: opts.actorType });
  const published = await publishDueRounds(db, today);
  await db.batch([setMetaStmt(db, 'last_schedule_run', JSON.stringify({ at: opts.now.toISOString(), added: result.added.length, shortage: result.shortageDate }))]);
  return { published, ...result };
}
