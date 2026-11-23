import type { ApiErrorBody, ApiErrorCode } from '@gof/core';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

export function errorResponse(error: HttpError): Response {
  const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
  return json(error.status, body, error.headers);
}

/** Read a JSON body with a hard size limit (counts actual bytes, not just Content-Length). */
export async function readJson(request: Request, limit: number): Promise<unknown> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large.');
  const buf = await request.arrayBuffer();
  if (buf.byteLength > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large.');
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'Body is not valid JSON.');
  }
}

export function only(request: Request, ...allowed: string[]): void {
  const m = request.method;
  if (allowed.includes(m) || (allowed.includes('GET') && m === 'HEAD')) return;
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Use ${allowed.join(' or ')}.`, { Allow: allowed.join(', ') });
}
