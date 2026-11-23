/**
 * CORS allowlist for the *public* routes only (admin routes never send CORS
 * headers, so browsers can't call them cross-origin). CORS is not authentication.
 */
import type { Env } from '../env.ts';

const PREVIEW_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function allowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null; // no paths, credentials or odd forms
  const exact = [env.FRONTEND_ORIGIN, ...(env.EXTRA_ORIGINS ?? '').split(',')].map((o) => o?.trim()).filter(Boolean);
  if (exact.includes(origin)) return origin;
  // Pages previews: https://<one label>.<project>.pages.dev — parsed, never substring-matched.
  const project = env.PAGES_PREVIEW_PROJECT?.trim();
  if (project && url.protocol === 'https:' && !url.port) {
    const suffix = `.${project}.pages.dev`;
    if (url.hostname.endsWith(suffix)) {
      const label = url.hostname.slice(0, -suffix.length);
      if (PREVIEW_LABEL.test(label)) return origin;
    }
  }
  return null;
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
