/** HTTP layer: loopback binding, session token, host/origin guards, static allowlist, input limits, flows. */
import { request } from 'node:http';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReviewService } from '../src/service.ts';
import { startServer, type DashboardServer } from '../src/server.ts';
import { tempDir, writeBank } from './fixtures.ts';

let dir: string;
let svc: ReviewService;
let srv: DashboardServer;

beforeAll(async () => {
  dir = tempDir('http');
  svc = await ReviewService.open({ masterPath: writeBank(dir), persistDir: false, reviewer: 'HTTP Reviewer', now: () => new Date('2026-11-25T12:00:00Z') });
  srv = await startServer(svc, { port: 0 });
});
afterAll(async () => {
  await srv.close();
  await svc.dispose();
  rmSync(dir, { recursive: true, force: true });
});

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: string | Buffer; token?: boolean } = {}): Promise<Res> {
  const u = new URL(srv.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method, path, headers: { ...(opts.token === false ? {} : { 'x-review-token': srv.token }), ...(opts.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const post = (path: string, value: unknown, headers: Record<string, string> = {}) => call('POST', path, { body: JSON.stringify(value), headers: { 'content-type': 'application/json', ...headers } });

describe('binding and guards', () => {
  it('listens on 127.0.0.1 only', async () => {
    expect((srv.server.address() as { address: string }).address).toBe('127.0.0.1');
    await expect(startServer(svc, { port: 0, host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1/);
  });

  it('serves the page with the session token and strict security headers', async () => {
    const r = await call('GET', '/', { token: false });
    expect(r.status).toBe(200);
    expect(r.body).toContain(`content="${srv.token}"`);
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('requires the session token for every API call', async () => {
    expect((await call('GET', '/api/summary', { token: false })).status).toBe(401);
    expect((await call('GET', '/api/summary', { headers: { 'x-review-token': 'x'.repeat(64) } })).status).toBe(401);
    expect((await call('GET', '/api/export/history', { token: false })).status).toBe(401);
    expect((await call('GET', '/api/summary')).status).toBe(200);
  });

  it('refuses foreign Host headers (DNS rebinding), cross-site and cross-origin requests', async () => {
    expect((await call('GET', '/api/summary', { headers: { host: 'attacker.example:80' } })).status).toBe(421);
    expect((await call('GET', '/', { token: false, headers: { host: 'attacker.example' } })).status).toBe(421);
    expect((await call('GET', '/api/summary', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await post('/api/questions/test-fl-heron-pier/investigate', { note: 'drive-by request' }, { origin: 'https://attacker.example' })).status).toBe(403);
  });

  it('serves only allowlisted static files (no path traversal)', async () => {
    for (const p of ['/../package.json', '/%2e%2e/%2e%2e/package.json', '/src/server.ts', '/public/app.js', '/master.json', '/state']) expect((await call('GET', p, { token: false })).status).toBe(404);
    expect((await call('GET', '/app.js', { token: false })).headers['content-type']).toMatch(/javascript/);
  });

  it('validates input: content type, size, JSON, ids, methods', async () => {
    expect((await call('POST', '/api/questions/test-fl-heron-pier/investigate', { body: 'note=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    expect((await call('POST', '/api/questions/test-fl-heron-pier/investigate', { body: '{', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await call('POST', '/api/questions/test-fl-heron-pier/investigate', { body: JSON.stringify({ note: 'x'.repeat(70_000) }), headers: { 'content-type': 'application/json' } })).status).toBe(413);
    expect((await call('GET', '/api/questions/no-such-question')).status).toBe(404);
    expect((await call('GET', '/api/questions/..%2F..%2Fetc')).status).toBe(404);
    expect((await call('DELETE', '/api/questions/test-fl-heron-pier')).status).toBe(405);
    expect((await post('/api/questions/test-fl-heron-pier/delete', {})).status).toBe(405);
  });
});

describe('review flow over HTTP', () => {
  it('one click per decision, auto-counted, exported', async () => {
    expect((await call('GET', '/api/questions')).json().items).toHaveLength(4);
    expect((await post('/api/questions/test-fl-heron-pier/approve', {})).json()).toMatchObject({ ok: true, status: 'approved' });
    expect((await post('/api/questions/test-gta-crane-car/investigate', {})).json()).toMatchObject({ status: 'investigate' });
    expect((await post('/api/questions/test-fl-wheelbarrow-parade/reject', {})).json()).toMatchObject({ status: 'rejected' });
    expect((await call('GET', '/api/summary')).json()).toMatchObject({ approved: 1, investigate: 1, rejected: 1, unreviewed: 1 });
    const ex = await call('GET', '/api/export/approved');
    expect(ex.headers['content-disposition']).toMatch(/attachment; filename="gta-or-florida-review-approved-/);
    expect(ex.json().questions.map((q: { eventId: string }) => q.eventId)).toEqual(['test-fl-heron-pier']);
  });

  it('changing a decision is just another click', async () => {
    expect((await post('/api/questions/test-fl-wheelbarrow-parade/approve', {})).json()).toMatchObject({ status: 'approved', changed: true });
    expect((await call('GET', '/api/summary')).json()).toMatchObject({ approved: 2, rejected: 0 });
  });
});
