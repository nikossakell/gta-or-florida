/**
 * Cloudflare Worker entrypoint: routing only.
 *   /api/health, /api/challenge/*, /api/archive  → public game (CORS allowlist)
 *   /api/v1/admin/*                               → bearer-token protected, no CORS
 *   scheduled()                                   → keep the 30-day schedule topped up
 * No AI inference and no outbound source fetching happens here.
 */
import { SCHEDULE_AHEAD_DAYS } from '@gof/config';
import { isLocal, type Env } from './env.ts';
import { errorResponse, HttpError, json, SECURITY_HEADERS } from './http.ts';
import { handleAdmin } from './routes/admin.ts';
import { handlePublic } from './routes/public.ts';
import { allowedOrigin, corsHeaders } from './security/cors.ts';
import { ensureSchedule } from './services/scheduling.ts';

export type Clock = () => Date;

function withHeaders(res: Response, extra: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return out;
}

export async function handleRequest(request: Request, env: Env, now: Clock = () => new Date()): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return errorResponse(new HttpError(400, 'BAD_REQUEST', 'Malformed URL.'));
  }
  const pathname = url.pathname;
  const isAdmin = pathname.startsWith('/api/v1/admin/');
  const origin = isAdmin ? null : allowedOrigin(request.headers.get('origin'), env);
  // Public responses are cacheable, so they always vary on Origin — otherwise a cached copy without
  // Access-Control-Allow-Origin could be reused for an allowed cross-origin fetch.
  const cors: Record<string, string> = origin ? corsHeaders(origin) : isAdmin ? {} : { Vary: 'Origin' };

  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: origin ? 204 : 403, headers: { ...SECURITY_HEADERS, ...cors } });
    }
    if (isAdmin) return await handleAdmin(request, env, url, now);

    // Best-effort public rate limit keyed by the client IP Cloudflare sets (CF-Connecting-IP);
    // X-Forwarded-For is client-controlled and ignored.
    if (env.RATE_LIMITER && pathname.startsWith('/api/')) {
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests, slow down.', { 'Retry-After': '60' });
    }
    const res = await handlePublic(request, env, pathname, now);
    if (res) return withHeaders(res, cors);
    throw new HttpError(404, 'NOT_FOUND', 'Unknown API route.');
  } catch (error) {
    if (error instanceof HttpError) return withHeaders(errorResponse(error), cors);
    console.error('[worker] unhandled error', (error as Error)?.message ?? error);
    return withHeaders(json(500, { error: { code: 'INTERNAL', message: 'Something went wrong.' } }), cors);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      ensureSchedule(env.DB, { now: new Date(), aheadDays: SCHEDULE_AHEAD_DAYS, allowFixtures: isLocal(env), actorId: 'cron', actorType: 'system' }).then(
        (r) => console.log(`[cron] published ${r.published}, added ${r.added.length}, shortage ${r.shortageDate ?? 'none'}`),
        (e) => console.error('[cron] schedule failed', (e as Error)?.message ?? e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
