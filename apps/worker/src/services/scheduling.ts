/**
 * Daily round scheduler (D1): pre-generates days from the verified question bank.
 *
 *  - Planning is core/round-plan.ts (pure): 5 questions a day, each slot drawn Florida/GTA 50/50,
 *    no duplicate question or event in a day, a cooldown per event (default 30 days, before and after
 *    persisted days), least-used questions first. Randomness happens once, here; the order is persisted.
 *  - The whole requested period is planned before anything is written. If it cannot be planned in full,
 *    nothing is written and the response names the date and the inventory/cooldown that block it
 *    (`allowPartial`, used by the cron, writes the valid prefix instead so today still gets a round).
 *  - Existing days (published, scheduled or withdrawn) are never reshuffled or replaced. Concurrent
 *    runs are safe: day PRIMARY KEY, round number UNIQUE and UNIQUE(day, question_id) make a racing
 *    insert fail as a whole batch (D1 batches are transactions); we re-read and retry once.
 *  - Eligibility is services/eligibility.ts (shared with the public endpoint). Each item insert
 *    re-checks "still approved under the same audit row", so a revoke that lands between planning
 *    and writing fails the whole batch, which is re-planned once.
 *  - Spoilers are left out unless `includeSpoilers`. Nothing is invented: only approved questions.
 */
import { addDays, cryptoRng, daysBetween, isIsoDate, planSchedule, utcDate, type BankQuestion, type PlannedDay, type Rng, type ScheduleResponse, type ScheduledUse } from '@gof/core';
import { DAILY_SIZE, EVENT_COOLDOWN_DAYS, LOW_INVENTORY_DAYS, MAX_SCHEDULE_DAYS, SCHEDULE_AHEAD_DAYS } from '@gof/config';
import { getMeta, isConstraintError, logStmt, setMetaStmt } from '../db/repo.ts';
import { APPROVAL_LOG_JOIN, ELIGIBILITY_COLUMNS, ineligibility, type EligibilityRow } from './eligibility.ts';

export type ScheduleOptions = {
  startDate: string;
  days: number;
  dryRun?: boolean;
  /** Event cooldown in days (default EVENT_COOLDOWN_DAYS). */
  cooldownDays?: number;
  includeSpoilers?: boolean;
  /** Write the plannable prefix when the full period cannot be planned (cron). */
  allowPartial?: boolean;
  allowFixtures?: boolean;
  actorId?: string;
  actorType?: 'human' | 'service' | 'system';
  rng?: Rng;
  /** APP_ENV of the Worker (access rules differ in production). */
  appEnv?: string;
  /** Test seam: runs after planning, before the write (used to simulate a concurrent revoke). */
  beforeWrite?: () => Promise<void>;
};

const POOL_SQL = (allowFixtures: boolean) => `
  SELECT ${ELIGIBILITY_COLUMNS},
         q.answer_kind AS answer, COALESCE(q.event_id, q.incident_id) AS event_id, q.spoiler,
         inc.category, q.difficulty, sr.publisher
    FROM questions q
    JOIN incidents inc ON inc.id = q.incident_id
    JOIN source_references sr ON sr.id = q.primary_reference_id
    JOIN sources s ON s.id = sr.source_id
    ${APPROVAL_LOG_JOIN}
   WHERE q.quality_state = 'approved'
     AND q.is_fixture IN (${allowFixtures ? '0, 1' : '0'})
   ORDER BY q.id`;

type PoolRow = EligibilityRow & { question_id: string; answer: 'FLORIDA' | 'GTA'; event_id: string; spoiler: number; category: string; difficulty: number; publisher: string | null };
export type PoolQuestion = BankQuestion & { approvalLogId: number | null; spoiler: boolean };

/** Approved questions that pass the shared eligibility rules (spoilers included; callers filter), with the approval row in force. */
export async function eligiblePool(db: D1Database, allowFixtures = false, appEnv?: string): Promise<PoolQuestion[]> {
  const { results } = await db.prepare(POOL_SQL(allowFixtures)).all<PoolRow>();
  return results
    .filter((r) => ineligibility(r, { appEnv, allowFixtures }) === null)
    .map((r) => ({
      id: r.question_id,
      eventId: r.event_id,
      answer: r.answer,
      category: r.category,
      difficulty: r.difficulty,
      publisher: r.publisher,
      game: r.game,
      title: r.play_title ?? undefined,
      approvalLogId: r.approval_log_id,
      spoiler: r.spoiler === 1,
    }));
}

export async function publishDueRounds(db: D1Database, today: string): Promise<number> {
  const r = await db
    .prepare(`UPDATE daily_rounds SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status = 'scheduled' AND day <= ?`)
    .bind(today)
    .run();
  return r.meta.changes ?? 0;
}

export async function scheduleRounds(db: D1Database, opts: ScheduleOptions): Promise<ScheduleResponse> {
  if (!isIsoDate(opts.startDate)) throw new Error(`Invalid start date ${opts.startDate}`);
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > MAX_SCHEDULE_DAYS) throw new Error(`days must be 1-${MAX_SCHEDULE_DAYS}`);
  const cooldown = opts.cooldownDays ?? EVENT_COOLDOWN_DAYS;
  if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 365) throw new Error('cooldownDays must be 0-365');
  for (let attempt = 0; ; attempt++) {
    try {
      return await scheduleOnce(db, { ...opts, cooldownDays: cooldown });
    } catch (error) {
      // Another run inserted overlapping days first (or a question changed mid-run): re-read and plan again (once).
      if (attempt === 0 && isConstraintError(error)) continue;
      throw error;
    }
  }
}

async function scheduleOnce(db: D1Database, opts: ScheduleOptions & { cooldownDays: number }): Promise<ScheduleResponse> {
  const rng = opts.rng ?? cryptoRng;
  const size = DAILY_SIZE;
  const cooldown = opts.cooldownDays;
  const end = addDays(opts.startDate, opts.days - 1);
  // Uses that can block a new day: within the cooldown before the period, inside it, and after it.
  const from = addDays(opts.startDate, -Math.max(cooldown - 1, 0));
  const to = addDays(end, Math.max(cooldown - 1, 0));
  const [pool, existing, history, usage, epochMeta] = await Promise.all([
    eligiblePool(db, opts.allowFixtures, opts.appEnv),
    db.prepare('SELECT day FROM daily_rounds WHERE day BETWEEN ? AND ?').bind(opts.startDate, end).all<{ day: string }>(),
    db
      .prepare(
        `SELECT i.day AS date, i.question_id AS questionId, COALESCE(q.event_id, q.incident_id) AS eventId
           FROM daily_round_items i JOIN questions q ON q.id = i.question_id
          WHERE i.day BETWEEN ? AND ?`,
      )
      .bind(from, to)
      .all<ScheduledUse>(),
    db.prepare('SELECT question_id, COUNT(*) AS n FROM daily_round_items GROUP BY question_id').all<{ question_id: string; n: number }>(),
    getMeta(db, 'schedule_epoch'),
  ]);
  const epoch = epochMeta ?? opts.startDate;
  const keptDays = new Set(existing.results.map((r) => r.day));
  const usageCounts = new Map(usage.results.map((r) => [r.question_id, r.n]));
  const bank = opts.includeSpoilers ? pool : pool.filter((q) => !q.spoiler);
  const approvalOf = new Map(pool.map((q) => [q.id, q.approvalLogId]));

  const dates: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < opts.days; i++) {
    const d = addDays(opts.startDate, i);
    if (keptDays.has(d)) kept.push(d);
    else dates.push(d);
  }

  const plan = planSchedule({ questions: bank, history: history.results, usageCounts, dates, size, cooldownDays: cooldown, rng });
  const toWrite: PlannedDay[] = plan.ok ? plan.days : opts.allowPartial ? plan.partial : [];

  const out: ScheduleResponse = {
    ok: plan.ok,
    added: [],
    kept,
    shortageDate: plan.ok ? null : plan.failure.date,
    error: plan.ok
      ? null
      : {
          code: 'SCHEDULE_INFEASIBLE',
          date: plan.failure.date,
          message: `${plan.failure.message} ${opts.allowPartial && !opts.dryRun ? `Wrote the ${plan.partial.length} day(s) before ${plan.failure.date}.` : 'Nothing was written.'}`,
          details: plan.failure,
        },
    warnings: [],
    inventory: {
      unusedFlorida: 0,
      unusedGta: 0,
      eligibleFlorida: bank.filter((q) => q.answer === 'FLORIDA').length,
      eligibleGta: bank.filter((q) => q.answer === 'GTA').length,
      floridaEvents: new Set(bank.filter((q) => q.answer === 'FLORIDA').map((q) => q.eventId)).size,
      gtaEvents: new Set(bank.filter((q) => q.answer === 'GTA').map((q) => q.eventId)).size,
      excludedSpoilers: pool.length - bank.length,
      runwayDays: 0,
      scheduledAhead: 0,
    },
    settings: { startDate: opts.startDate, days: opts.days, cooldownDays: cooldown, includeSpoilers: !!opts.includeSpoilers, dryRun: !!opts.dryRun, allowPartial: !!opts.allowPartial },
  };

  const stmts: D1PreparedStatement[] = [];
  for (const day of toWrite) {
    const number = daysBetween(epoch, day.date) + 1;
    if (number < 1) throw new Error(`Cannot schedule ${day.date} before the schedule epoch ${epoch}`);
    stmts.push(db.prepare(`INSERT INTO daily_rounds (day, number, status, florida_count) VALUES (?, ?, 'scheduled', ?)`).bind(day.date, number, day.floridaCount));
    // The subquery yields NULL (→ NOT NULL constraint → whole batch rolls back) if the question was
    // revoked, re-approved, marked as a spoiler or otherwise changed after the pool was read.
    day.questions.forEach((q, i) =>
      stmts.push(
        db
          .prepare(
            `INSERT INTO daily_round_items (day, position, question_id)
             VALUES (?, ?, (SELECT id FROM questions WHERE id = ? AND quality_state = 'approved' AND approval_log_id IS ? AND (spoiler = 0 OR ?)))`,
          )
          .bind(day.date, i + 1, q.id, approvalOf.get(q.id) ?? null, opts.includeSpoilers ? 1 : 0),
      ),
    );
    stmts.push(
      logStmt(db, {
        entityType: 'day',
        entityId: day.date,
        decision: 'scheduled',
        actorType: opts.actorType ?? 'system',
        actorId: opts.actorId ?? 'scheduler',
        details: { questionIds: day.questions.map((q) => q.id), eventIds: day.questions.map((q) => q.eventId), floridaCount: day.floridaCount, cooldownDays: cooldown, resampled: day.resampled },
      }),
    );
    out.added.push({ date: day.date, floridaCount: day.floridaCount });
  }

  if (!opts.dryRun && stmts.length) {
    await opts.beforeWrite?.();
    if (!epochMeta) stmts.unshift(db.prepare(`INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schedule_epoch', ?)`).bind(epoch));
    // One transaction for the whole run: all days or none.
    await db.batch(stmts);
  }

  // ---- inventory + warnings ----
  const planned = plan.ok ? plan.days : plan.partial;
  const used = new Set([...usageCounts.keys(), ...(opts.dryRun || !out.added.length ? [] : toWrite.flatMap((d) => d.questions.map((q) => q.id)))]);
  out.inventory.unusedFlorida = bank.filter((q) => q.answer === 'FLORIDA' && !used.has(q.id)).length;
  out.inventory.unusedGta = bank.filter((q) => q.answer === 'GTA' && !used.has(q.id)).length;
  const covered = new Set([...kept, ...(opts.dryRun ? planned.map((d) => d.date) : out.added.map((d) => d.date))]);
  let runway = 0;
  while (runway < opts.days && covered.has(addDays(opts.startDate, runway))) runway++;
  out.inventory.runwayDays = runway;
  const aheadRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM daily_rounds WHERE day >= ? AND status <> 'withdrawn'`)
    .bind(opts.startDate)
    .first<{ n: number }>();
  out.inventory.scheduledAhead = (aheadRow?.n ?? 0) + (opts.dryRun ? planned.length : 0);

  if (!plan.ok) out.warnings.push({ code: 'shortage', date: plan.failure.date, message: out.error!.message });
  if (runway < Math.min(LOW_INVENTORY_DAYS, opts.days)) {
    out.warnings.push({
      code: 'low_inventory',
      message: `Only ${runway} consecutive day(s) from ${opts.startDate} are covered (target ≥ ${Math.min(LOW_INVENTORY_DAYS, opts.days)}). Eligible bank: ${out.inventory.floridaEvents} Florida / ${out.inventory.gtaEvents} GTA events.`,
    });
  }
  // A 50/50 rotation under the cooldown needs about size/2 × cooldown distinct events per side.
  const perSide = Math.ceil((size / 2) * Math.min(cooldown, opts.days));
  for (const [side, n] of [['Florida', out.inventory.floridaEvents], ['GTA', out.inventory.gtaEvents]] as const) {
    if (n < perSide) {
      out.warnings.push({
        code: 'thin_inventory',
        message: `${side}: ${n} eligible event(s); a 50/50 rotation under a ${cooldown}-day cooldown uses about ${perSide}. Days will lean towards the other side (the draw is resampled when a split is impossible).`,
      });
    }
  }
  const resampled = planned.filter((d) => d.resampled).length;
  if (resampled) out.warnings.push({ code: 'split_resampled', message: `${resampled} day(s) had their Florida/GTA draw resampled because the inventory could not fill the first draw.` });
  return out;
}

/** Horizon and cooldown from Worker vars (SCHEDULE_AHEAD_DAYS, EVENT_COOLDOWN_DAYS), else the config defaults. */
export function scheduleVars(env: { SCHEDULE_AHEAD_DAYS?: string; EVENT_COOLDOWN_DAYS?: string }) {
  return { aheadDays: intVar(env.SCHEDULE_AHEAD_DAYS, SCHEDULE_AHEAD_DAYS, MAX_SCHEDULE_DAYS), cooldownDays: intVar(env.EVENT_COOLDOWN_DAYS, EVENT_COOLDOWN_DAYS, 365) };
}

/** Non-negative integer from a Worker var, else the default. */
export function intVar(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}

/** Cron + admin entry point: keep `aheadDays` scheduled from today (writing what can be planned), then mark due days published. */
export async function ensureSchedule(
  db: D1Database,
  opts: { now: Date; aheadDays?: number; cooldownDays?: number; allowFixtures?: boolean; actorId?: string; actorType?: 'human' | 'service' | 'system'; appEnv?: string; rng?: Rng },
) {
  const today = utcDate(opts.now);
  const result = await scheduleRounds(db, {
    startDate: today,
    days: Math.min(opts.aheadDays ?? SCHEDULE_AHEAD_DAYS, MAX_SCHEDULE_DAYS),
    cooldownDays: opts.cooldownDays,
    allowPartial: true,
    allowFixtures: opts.allowFixtures,
    actorId: opts.actorId,
    actorType: opts.actorType,
    appEnv: opts.appEnv,
    rng: opts.rng,
  });
  const published = await publishDueRounds(db, today);
  await db.batch([setMetaStmt(db, 'last_schedule_run', JSON.stringify({ at: opts.now.toISOString(), added: result.added.length, shortage: result.shortageDate }))]);
  return { published, ...result };
}
