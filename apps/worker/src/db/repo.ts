/** Small D1 helpers. All SQL is parameterized; no string-built values. */

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export const nowIso = (now: Date = new Date()) => now.toISOString();

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM app_meta WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export function setMetaStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);
}

export type LogEntry = {
  entityType: 'question' | 'incident' | 'reference' | 'source' | 'day' | 'benchmark' | 'import';
  entityId: string;
  decision: string;
  reason?: string | null;
  actorType: 'human' | 'policy' | 'service' | 'system';
  actorId: string;
  policyVersion?: string | null;
  details?: unknown;
};

export function logStmt(db: D1Database, e: LogEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO review_log (entity_type, entity_id, decision, reason, actor_type, actor_id, policy_version, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(e.entityType, e.entityId, e.decision, e.reason ?? null, e.actorType, e.actorId, e.policyVersion ?? null, e.details === undefined ? null : JSON.stringify(e.details));
}

/**
 * Another live question (candidate or approved) already uses this event for the OTHER answer.
 * An event belongs to one side: the scheduler fills Florida/GTA slots per event.
 */
export async function eventSideConflict(db: D1Database, eventId: string, side: 'FLORIDA' | 'GTA', exceptQuestionId = ''): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM questions WHERE COALESCE(event_id, incident_id) = ? AND answer_kind <> ? AND id <> ? AND quality_state IN ('candidate', 'approved') LIMIT 1`,
    )
    .bind(eventId, side, exceptQuestionId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** True for D1 constraint violations (UNIQUE / PRIMARY KEY / CHECK / FK). */
export function isConstraintError(error: unknown): boolean {
  return /SQLITE_CONSTRAINT|UNIQUE constraint|constraint failed/i.test(String((error as Error)?.message ?? error));
}
