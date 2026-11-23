/**
 * Request idempotency for mutating admin calls. Same key + same body → the
 * stored response is replayed; same key + different body → 409.
 * Unique constraints remain the real guarantee against duplicates.
 */
import { HttpError } from '../http.ts';

const KEY = /^[A-Za-z0-9:_.-]{8,128}$/;

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function idempotencyKey(request: Request, required: boolean): string | null {
  const key = request.headers.get('idempotency-key');
  if (!key) {
    if (required) throw new HttpError(400, 'BAD_REQUEST', 'Idempotency-Key header is required.');
    return null;
  }
  if (!KEY.test(key)) throw new HttpError(400, 'BAD_REQUEST', 'Idempotency-Key must be 8-128 characters of [A-Za-z0-9:_.-].');
  return key;
}

export async function replay(db: D1Database, key: string, requestHash: string): Promise<unknown | null> {
  const row = await db.prepare('SELECT request_hash, response_summary FROM idempotency_keys WHERE key = ?').bind(key).first<{ request_hash: string; response_summary: string }>();
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request body.');
  return JSON.parse(row.response_summary);
}

export function rememberStmt(db: D1Database, key: string, requestHash: string, response: unknown): D1PreparedStatement {
  return db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, request_hash, response_summary) VALUES (?, ?, ?)').bind(key, requestHash, JSON.stringify(response));
}

/** Old keys are only needed for retries; prune after 7 days. */
export function pruneStmt(db: D1Database): D1PreparedStatement {
  return db.prepare(`DELETE FROM idempotency_keys WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')`);
}
