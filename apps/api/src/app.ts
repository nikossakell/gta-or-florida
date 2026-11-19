import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiErrorBody } from '@gof/core';
import type { Config } from './config.ts';
import { HttpError } from './http-error.ts';
import { createRateLimiter } from './rate-limit.ts';
import type { ChallengeService } from './services/challenge.ts';
import { serveStatic } from './static.ts';

export type AppDeps = {
  config: Pick<Config, 'webDistDir' | 'rateLimit' | 'trustProxy' | 'maxBodyBytes' | 'logRequests'>;
  service: ChallengeService;
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; " +
    "connect-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
};

const DATE_SEGMENT = '([0-9]{4}-[0-9]{2}-[0-9]{2})';
const ROUTES = {
  health: /^\/api\/health$/,
  today: /^\/api\/challenge\/today$/,
  byDate: new RegExp(`^/api/challenge/${DATE_SEGMENT}$`),
  answer: new RegExp(`^/api/challenge/${DATE_SEGMENT}/answer$`),
  finish: new RegExp(`^/api/challenge/${DATE_SEGMENT}/finish$`),
  archive: /^\/api\/archive$/,
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: HttpError): void {
  const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
  sendJson(res, error.status, body, error.headers);
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large.');

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'Body is not valid JSON.');
  }
}

function clientKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function createApp({ config, service }: AppDeps) {
  const limiter = createRateLimiter(config.rateLimit);

  async function route(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const method = req.method ?? 'GET';
    const only = (allowed: string) => {
      if (method !== allowed && !(allowed === 'GET' && method === 'HEAD')) {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Use ${allowed}.`, { Allow: allowed });
      }
    };
    let m: RegExpExecArray | null;

    if (ROUTES.health.test(pathname)) {
      only('GET');
      const health = service.health();
      return sendJson(res, health.status === 'ok' ? 200 : 503, health);
    }
    if (ROUTES.today.test(pathname)) {
      only('GET');
      return sendJson(res, 200, service.getChallenge('today'));
    }
    if ((m = ROUTES.byDate.exec(pathname))) {
      only('GET');
      return sendJson(res, 200, service.getChallenge(m[1]!));
    }
    if ((m = ROUTES.answer.exec(pathname))) {
      only('POST');
      return sendJson(res, 200, service.answer(m[1]!, await readJsonBody(req, config.maxBodyBytes)));
    }
    if ((m = ROUTES.finish.exec(pathname))) {
      only('POST');
      return sendJson(res, 200, service.finish(m[1]!, await readJsonBody(req, config.maxBodyBytes)));
    }
    if (ROUTES.archive.test(pathname)) {
      only('GET');
      return sendJson(res, 200, service.archive());
    }
    throw new HttpError(404, 'NOT_FOUND', 'Unknown API route.');
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendError(res, new HttpError(400, 'BAD_REQUEST', 'Malformed URL.'));
      return;
    }

    try {
      if (pathname.startsWith('/api/')) {
        const wait = limiter.check(clientKey(req, config.trustProxy));
        if (wait !== null) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests, slow down.', { 'Retry-After': String(wait) });
        await route(req, res, pathname);
      } else if (!(config.webDistDir && serveStatic(config.webDistDir, req, res, pathname))) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(config.webDistDir ? 'Not found' : 'Not found (API-only mode: run the web app with `npm run dev`)');
      }
    } catch (error) {
      if (error instanceof HttpError) sendError(res, error);
      else {
        console.error('[api] unhandled error', error);
        sendError(res, new HttpError(500, 'INTERNAL', 'Something went wrong.'));
      }
    } finally {
      if (config.logRequests) console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }

  return {
    handler: (req: IncomingMessage, res: ServerResponse) => void handler(req, res),
    close: () => limiter.stop(),
  };
}
