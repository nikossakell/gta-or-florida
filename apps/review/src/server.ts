/**
 * Local-only HTTP server for the editorial review dashboard.
 *   - binds 127.0.0.1 only; requests whose Host is not this loopback address are refused (DNS rebinding)
 *   - every /api call needs the per-start session token (embedded in the page, never logged), sent as a
 *     custom header, so other sites in the browser cannot read or drive the API
 *   - static files come from a fixed allowlist (no path from the URL ever touches the filesystem)
 *   - JSON bodies are size-limited and schema-validated in ReviewService
 *   - no child processes, no outbound requests, no analytics
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewError, type ReviewService } from './service.ts';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const MAX_BODY = 64 * 1024;
export const HOST = '127.0.0.1';

const STATIC: Record<string, { file: string; type: string }> = {
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/logic.js': { file: 'logic.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

export type DashboardServer = { server: Server; url: string; token: string; close(): Promise<void> };

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
  res.end(body);
}
const sendJson = (res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', extra);

async function readBody(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw new ReviewError(415, 'Send JSON (content-type: application/json).');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ReviewError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new ReviewError(400, 'Malformed JSON.');
  }
}

function tokenOk(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

export async function startServer(service: ReviewService, opts: { port: number; host?: string; log?: (m: string) => void }): Promise<DashboardServer> {
  const host = opts.host ?? HOST;
  if (host !== '127.0.0.1') throw new Error('The review dashboard binds to 127.0.0.1 only.');
  const token = randomBytes(32).toString('hex');
  const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
  const assets = Object.fromEntries(Object.entries(STATIC).map(([path, a]) => [path, { body: readFileSync(resolve(PUBLIC, a.file)), type: a.type }]));
  let allowedHosts = new Set<string>();

  const server = createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only our own loopback authority.
      if (!allowedHosts.has(String(req.headers.host ?? ''))) return sendJson(res, 421, { error: 'Unknown host.' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = url.pathname;

      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
        if (path === '/' || path === '/index.html') return send(res, 200, html.replace('__SESSION_TOKEN__', token), 'text/html; charset=utf-8');
        const a = assets[path];
        if (a) return send(res, 200, a.body, a.type);
        return sendJson(res, 404, { error: 'Not found.' });
      }

      // API: session token on every call; cross-site requests are refused outright.
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return sendJson(res, 403, { error: 'Cross-site request refused.' });
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^http:\/\//, ''))) return sendJson(res, 403, { error: 'Cross-origin request refused.' });
      if (!tokenOk(req.headers['x-review-token'], token)) return sendJson(res, 401, { error: 'Missing or invalid session token. Reload the page.' });

      const m = /^\/api\/questions\/([a-z0-9][a-z0-9:._-]{2,79})(?:\/(edit|approve|investigate|reject|reopen))?$/.exec(path);
      if (req.method === 'GET') {
        if (path === '/api/summary') return sendJson(res, 200, await service.summary());
        if (path === '/api/questions') return sendJson(res, 200, { items: await service.list() });
        if (m && !m[2]) return sendJson(res, 200, await service.detail(m[1]!));
        const ex = /^\/api\/export\/(approved|investigate|rejected|history)$/.exec(path);
        if (ex) {
          const kind = ex[1] as 'approved' | 'investigate' | 'rejected' | 'history';
          const body = await service.exportFile(kind);
          const name = `gta-or-florida-review-${kind}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
          return sendJson(res, 200, body, { 'content-disposition': `attachment; filename="${name}"` });
        }
        return sendJson(res, 404, { error: 'Unknown API route.' });
      }
      if (req.method === 'POST' && m && m[2]) {
        const body = await readBody(req);
        const id = m[1]!;
        const action = m[2];
        const to = { approve: 'approved', investigate: 'investigate', reject: 'rejected', reopen: 'unreviewed' } as const;
        const result = action === 'edit' ? await service.edit(id, body) : await service.decide(id, to[action as keyof typeof to], body);
        return sendJson(res, 200, result);
      }
      return sendJson(res, 405, { error: 'Method not allowed.' });
    } catch (error) {
      if (error instanceof ReviewError) return sendJson(res, error.status, { error: error.message, details: error.details });
      opts.log?.(`[review] unexpected error: ${(error as Error).message}`);
      return sendJson(res, 500, { error: 'Unexpected error (see the terminal).' });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolveListen());
  });
  const port = (server.address() as { port: number }).port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return {
    server,
    token,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
