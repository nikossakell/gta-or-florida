/**
 * CORS regression tests driven by the real wrangler.jsonc vars of each environment.
 * Covers: exact allowlisting, rejection of look-alike origins, CORS on error responses
 * (503 DAILY_NOT_READY, 404, 429), preflight, admin isolation, and staging/production separation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env.ts';
import { ADMIN_TOKEN, createHarness, wranglerVars, type Harness, type TestResponse } from './harness.ts';

const STAGING_PAGES = 'https://gta-or-florida-staging.pages.dev';
const now = new Date('2026-11-22T12:00:00Z');

const BLOCKED = [
  'https://evil.com',
  'null',
  'http://gta-or-florida-staging.pages.dev', // wrong scheme
  'https://gta-or-florida-staging.pages.dev:8443', // wrong port
  'https://gta-or-florida-staging.pages.dev/', // not a serialized origin
  'https://gta-or-florida-staging.pages.dev.evil.com', // suffix attack
  'https://a.b.gta-or-florida-staging.pages.dev', // a preview is exactly one label
  'https://abc123.gta-or-florida.pages.dev', // previews of the production Pages project
  'https://evilgta-or-florida-staging.pages.dev',
  'https://GTA-OR-FLORIDA-STAGING.pages.dev', // non-canonical form of the allowed origin
];

function expectCors(res: TestResponse, origin: string): void {
  expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  expect(res.headers.get('vary')).toMatch(/Origin/);
  expect(res.headers.get('access-control-allow-credentials')).toBeNull();
}

function expectNoCors(res: TestResponse): void {
  expect(res.headers.get('access-control-allow-origin')).toBeNull();
  expect(res.headers.get('access-control-allow-methods')).toBeNull();
}

describe('CORS — staging environment', () => {
  let h: Harness;
  const fetchAs = (path: string, origin: string | null, init: RequestInit & { env?: Partial<Env> } = {}) =>
    h.fetch(path, { ...init, headers: { ...(origin ? { origin } : {}), ...(init.headers as Record<string, string>) }, now });
  const preflight = (origin: string, path = '/api/challenge/today', method = 'GET') =>
    fetchAs(path, origin, { method: 'OPTIONS', headers: { 'access-control-request-method': method, 'access-control-request-headers': 'content-type' } });

  beforeAll(async () => {
    h = await createHarness(wranglerVars('staging'));
  });
  afterAll(() => h.dispose());

  it('declares the staging Pages project as an exact extra origin', () => {
    expect(wranglerVars('staging').EXTRA_ORIGINS?.split(',').map((o) => o.trim())).toContain(STAGING_PAGES);
  });

  it('answers preflight from the staging Pages origin', async () => {
    const res = await preflight(STAGING_PAGES);
    expect(res.status).toBe(204);
    expectCors(res, STAGING_PAGES);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type');
    const post = await preflight(STAGING_PAGES, '/api/challenge/2026-11-22/answer', 'POST');
    expect(post.status).toBe(204);
    expectCors(post, STAGING_PAGES);
  });

  it('adds CORS headers to 503 DAILY_NOT_READY for the staging Pages origin', async () => {
    const res = await fetchAs('/api/challenge/today', STAGING_PAGES);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('DAILY_NOT_READY');
    expect(res.headers.get('retry-after')).toBe('300');
    expectCors(res, STAGING_PAGES);
  });

  it('adds CORS headers to successful responses', async () => {
    const res = await fetchAs('/api/health', STAGING_PAGES);
    expect(res.status).toBe(200);
    expectCors(res, STAGING_PAGES);
  });

  it('adds CORS headers to 404 and 429 errors', async () => {
    const missing = await fetchAs('/api/nope', STAGING_PAGES);
    expect(missing.status).toBe(404);
    expectCors(missing, STAGING_PAGES);
    const limited = await fetchAs('/api/challenge/today', STAGING_PAGES, { env: { RATE_LIMITER: { limit: async () => ({ success: false }) } } });
    expect(limited.status).toBe(429);
    expectCors(limited, STAGING_PAGES);
  });

  it('allows the staging Pages project\'s preview deployments (hash and branch alias)', async () => {
    expect(wranglerVars('staging').PAGES_PREVIEW_PROJECT).toBe('gta-or-florida-staging');
    for (const origin of ['https://staging.gta-or-florida.pages.dev', 'https://28e5941b.gta-or-florida-staging.pages.dev', 'https://integration-redesign-question-bank.gta-or-florida-staging.pages.dev']) {
      const res = await fetchAs('/api/challenge/today', origin);
      expect(res.status).toBe(503);
      expectCors(res, origin);
      expect((await preflight(origin)).status).toBe(204);
    }
  });

  it.each(BLOCKED)('rejects %s on preflight and omits CORS on the 503', async (origin) => {
    const pre = await preflight(origin);
    expect(pre.status).toBe(403);
    expectNoCors(pre);
    const res = await fetchAs('/api/challenge/today', origin);
    expect(res.status).toBe(503);
    expectNoCors(res);
    expect(res.headers.get('vary')).toMatch(/Origin/);
  });

  it('never answers with a wildcard origin', async () => {
    for (const origin of [STAGING_PAGES, 'https://evil.com', null]) {
      const res = await fetchAs('/api/challenge/today', origin);
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    }
  });

  it('keeps admin routes CORS-free and token-protected for the staging origin', async () => {
    const anon = await fetchAs('/api/v1/admin/stats', STAGING_PAGES);
    expect(anon.status).toBe(401);
    expectNoCors(anon);
    const authed = await fetchAs('/api/v1/admin/stats', STAGING_PAGES, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(authed.status).toBe(200);
    expectNoCors(authed);
    const pre = await preflight(STAGING_PAGES, '/api/v1/admin/stats');
    expect(pre.status).toBe(403);
    expectNoCors(pre);
  });
});

describe('CORS — production environment is unchanged', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(wranglerVars('production'));
  });
  afterAll(() => h.dispose());

  it('does not allow the staging Pages origin', async () => {
    expect(wranglerVars('production').EXTRA_ORIGINS).toBeUndefined();
    const res = await h.fetch('/api/challenge/today', { headers: { origin: STAGING_PAGES }, now });
    expect(res.status).toBe(503);
    expectNoCors(res);
    expect((await h.fetch('/api/challenge/today', { method: 'OPTIONS', headers: { origin: STAGING_PAGES }, now })).status).toBe(403);
  });

  it('still allows the production Pages origin, including on 503', async () => {
    const origin = 'https://gta-or-florida.pages.dev';
    expect(wranglerVars('production').FRONTEND_ORIGIN).toBe(origin);
    const res = await h.fetch('/api/challenge/today', { headers: { origin }, now });
    expect(res.status).toBe(503);
    expectCors(res, origin);
  });
});
