import { msUntilNextUtcDay, type HealthResponse } from '@gof/core';
import type { Env } from '../env.ts';
import { HttpError, json, only, readJson } from '../http.ts';
import { createChallengeService } from '../services/challenge.ts';

const DATE = '([0-9]{4}-[0-9]{2}-[0-9]{2})';
const ROUTES = {
  health: /^\/api\/(v1\/)?health$/,
  today: /^\/api\/challenge\/today$/,
  byDate: new RegExp(`^/api/challenge/${DATE}$`),
  answer: new RegExp(`^/api/challenge/${DATE}/answer$`),
  finish: new RegExp(`^/api/challenge/${DATE}/finish$`),
  archive: /^\/api\/archive$/,
};

const PUBLIC_BODY_LIMIT = 8 * 1024;

/** Browser cache for round data: short, and never past the next UTC midnight. */
function roundCache(isToday: boolean): string {
  const untilMidnight = Math.floor(msUntilNextUtcDay() / 1000) - 1;
  const maxAge = Math.max(0, Math.min(isToday ? 30 : 60, untilMidnight));
  return maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store';
}

export async function handlePublic(request: Request, env: Env, pathname: string, now: () => Date): Promise<Response | null> {
  const service = createChallengeService(env, now);
  let m: RegExpExecArray | null;

  if (ROUTES.health.test(pathname)) {
    only(request, 'GET');
    let db: 'ok' | 'error' = 'ok';
    try {
      await env.DB.prepare('SELECT 1').first();
    } catch {
      db = 'error';
    }
    const body: HealthResponse = {
      status: db === 'ok' ? 'ok' : 'degraded',
      time: now().toISOString(),
      version: env.APP_VERSION ?? 'dev',
      runtime: 'cloudflare-workers',
      db,
      todayReady: db === 'ok' ? await service.todayReady() : false,
    };
    return json(db === 'ok' ? 200 : 503, body);
  }
  const isToday = ROUTES.today.test(pathname);
  if (isToday || (m = ROUTES.byDate.exec(pathname))) {
    only(request, 'GET');
    const { body, etag } = await service.getChallenge(isToday ? 'today' : m![1]!);
    const headers = { 'Cache-Control': roundCache(isToday), ETag: etag };
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    return json(200, body, headers);
  }
  if ((m = ROUTES.answer.exec(pathname))) {
    only(request, 'POST');
    return json(200, await service.answer(m[1]!, await readJson(request, PUBLIC_BODY_LIMIT)));
  }
  if ((m = ROUTES.finish.exec(pathname))) {
    only(request, 'POST');
    return json(200, await service.finish(m[1]!, await readJson(request, PUBLIC_BODY_LIMIT)));
  }
  if (ROUTES.archive.test(pathname)) {
    only(request, 'GET');
    return json(200, await service.archive(), { 'Cache-Control': 'public, max-age=60' });
  }
  if (pathname.startsWith('/api/challenge/')) throw new HttpError(400, 'BAD_REQUEST', 'Challenge id must be "today" or a date (YYYY-MM-DD).');
  return null;
}
