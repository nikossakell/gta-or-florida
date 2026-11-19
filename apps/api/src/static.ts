import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function fileIfExists(path: string): string | null {
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/**
 * Serve the built SPA. Unknown paths without an extension fall back to
 * index.html so client-side routes work on reload. Returns false if nothing matched.
 */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes('\0')) return false;

  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  const target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(rootWithSep)) return false; // path traversal

  let file = fileIfExists(target);
  if (!file && !extname(decoded)) file = fileIfExists(resolve(root, 'index.html'));
  if (!file) return false;

  const isHtml = file.endsWith('.html');
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : isHtml ? 'no-cache' : 'public, max-age=3600');
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file)
    .on('error', () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    })
    .pipe(res);
  return true;
}
