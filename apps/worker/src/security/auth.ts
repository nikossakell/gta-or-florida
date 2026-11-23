/**
 * Bearer-token auth for /api/v1/admin/*. Two roles:
 *   service — the ingestion job (import, known-lookup, checkpoints, schedule)
 *   admin   — the owner (everything, incl. review/withdraw/stats)
 * Comparison is constant-time over SHA-256 digests. Missing secrets disable the role.
 */
import type { Env } from '../env.ts';
import { HttpError } from '../http.ts';

export type Role = 'service' | 'admin';
export type Principal = { role: Role; actorId: string };

const MIN_TOKEN_LENGTH = 32;

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time equality of two strings (lengths hidden by hashing first). */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function bearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  const m = /^Bearer ([\x21-\x7e]{1,512})$/.exec(h);
  return m ? m[1]! : null;
}

const ACTOR = /^[A-Za-z0-9 ._@-]{1,64}$/;

export async function authenticate(request: Request, env: Env, needed: Role): Promise<Principal> {
  const token = bearer(request);
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'Missing bearer token.', { 'WWW-Authenticate': 'Bearer' });
  const admin = env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= MIN_TOKEN_LENGTH ? env.ADMIN_TOKEN : null;
  const service = env.INGESTION_IMPORT_TOKEN && env.INGESTION_IMPORT_TOKEN.length >= MIN_TOKEN_LENGTH ? env.INGESTION_IMPORT_TOKEN : null;
  // Always run both comparisons so timing doesn't reveal which role matched.
  const [isAdmin, isService] = await Promise.all([
    admin ? timingSafeEqualStrings(token, admin) : Promise.resolve(false),
    service ? timingSafeEqualStrings(token, service) : Promise.resolve(false),
  ]);
  if (!isAdmin && !isService) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid token.', { 'WWW-Authenticate': 'Bearer' });
  const role: Role = isAdmin ? 'admin' : 'service';
  if (needed === 'admin' && role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'This operation needs the admin token.');
  const claimed = request.headers.get('x-actor')?.trim() ?? '';
  const actorId = role === 'admin' ? (ACTOR.test(claimed) ? claimed : 'admin') : 'ingestion-job';
  return { role, actorId };
}
