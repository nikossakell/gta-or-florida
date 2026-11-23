/**
 * Worker test harness: a real local D1 (workerd SQLite via wrangler's
 * getPlatformProxy), the real migrations, and the Worker's fetch handler called
 * in-process. All seeded content is clearly fictional test data
 * (hosts are IANA-reserved example.org names).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { ImportItem, SourcePolicy } from '@gof/core';
import type { SourceRegistry } from '@gof/config';
import type { Env } from '../src/env.ts';
import { handleRequest } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, '..');

export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef0123456789';
export const SERVICE_TOKEN = 'test-service-token-0123456789abcdef01234567';

/** Statements of the migration files, in order (comments stripped). */
export function migrationStatements(): string[] {
  const sql = readFileSync(resolve(workerDir, 'migrations/0001_init.sql'), 'utf8');
  return sql
    .split('\n')
    .map((line) => line.replace(/\s+--.*$/, '').replace(/^--.*$/, ''))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The `vars` a wrangler.jsonc environment declares (so tests track the real config, not a copy). */
export function wranglerVars(environment: 'local' | 'staging' | 'production'): Partial<Env> {
  const text = readFileSync(resolve(workerDir, 'wrangler.jsonc'), 'utf8');
  const json = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str: string | undefined) => str ?? '');
  const config = JSON.parse(json) as { env: Record<string, { vars?: Record<string, string> }> };
  const vars = config.env[environment]?.vars;
  if (!vars) throw new Error(`wrangler.jsonc has no vars for env "${environment}"`);
  return vars;
}

const TABLES = ['daily_round_items', 'daily_rounds', 'review_log', 'questions', 'source_references', 'incidents', 'sources', 'ingestion_runs', 'ingestion_checkpoints', 'idempotency_keys', 'app_meta'];

/** Test responses: json() is loosely typed for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TestResponse = Omit<Response, 'json' | 'clone'> & { json(): Promise<any>; clone(): TestResponse };

export type Harness = {
  env: Env;
  db: D1Database;
  fetch(path: string, init?: RequestInit & { now?: Date; env?: Partial<Env> }): Promise<TestResponse>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
};

export async function createHarness(vars: Partial<Env> = {}): Promise<Harness> {
  const proxy = await getPlatformProxy<Env>({ configPath: resolve(workerDir, 'wrangler.jsonc'), environment: 'local', persist: false });
  const db = proxy.env.DB;
  await db.batch(migrationStatements().map((s) => db.prepare(s)));
  const env: Env = { ...proxy.env, ADMIN_TOKEN, INGESTION_IMPORT_TOKEN: SERVICE_TOKEN, APP_ENV: 'local', AUTO_PUBLISH_MODE: 'shadow', ...vars };
  return {
    env,
    db,
    async fetch(path, init = {}) {
      const { now, env: override, ...rest } = init;
      const req = new Request(`https://api.test.local${path}`, rest);
      return (await handleRequest(req, { ...env, ...override }, () => now ?? new Date())) as unknown as TestResponse;
    },
    async reset() {
      await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
    },
    dispose: () => proxy.dispose(),
  };
}

export const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra });

export function postJson(body: unknown, token?: string, extra: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: token ? auth(token, extra) : { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

let n = 0;
const CATS = ['wildlife', 'crime', 'vehicles', 'weird', 'other'] as const;
const GAMES = ['GTA_III', 'GTA_VC', 'GTA_SA', 'GTA_IV', 'GTA_V'] as const;

export const APPROVED_PUBLISHER: SourcePolicy = {
  id: 'publisher:news.example.org',
  type: 'publisher',
  name: 'Approved Test News',
  hosts: ['news.example.org'],
  licenseStatus: 'approved',
  canUseEditorialSummary: true,
  canDisplayOriginalTitle: true,
  autoPublishAllowed: true,
  reviewedBy: 'test-owner',
  reviewedAt: '2026-11-01',
};

export const APPROVED_WIKI: SourcePolicy = {
  id: 'grandtheftwiki',
  type: 'gta_wiki',
  name: 'Test Wiki',
  hosts: ['grandtheftwiki.com'],
  licenseStatus: 'approved',
  canUseEditorialSummary: true,
  canDisplayOriginalTitle: false,
  autoPublishAllowed: true,
  reviewedBy: 'test-owner',
  reviewedAt: '2026-11-01',
};

export const TEST_REGISTRY: SourceRegistry = { policyVersion: 'test-1', sources: [APPROVED_PUBLISHER, APPROVED_WIKI] };

/** Insert an approved source row directly (stands in for an owner-reviewed registry sync). */
export async function seedSource(db: D1Database, src: SourcePolicy = APPROVED_PUBLISHER): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO sources (id, type, name, canonical_host, license_status, can_display_original_title, can_use_editorial_summary, auto_publish_allowed, policy_version, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test-1', ?, ?)`,
    )
    .bind(src.id, src.type, src.name, src.hosts[0], src.licenseStatus, src.canDisplayOriginalTitle ? 1 : 0, src.canUseEditorialSummary ? 1 : 0, src.autoPublishAllowed ? 1 : 0, src.reviewedBy ?? null, src.reviewedAt ?? null)
    .run();
}

/** Insert one approved, publishable question straight into D1 (bypasses review; for scheduler/public tests). */
export async function seedApproved(
  db: D1Database,
  side: 'FLORIDA' | 'GTA',
  o: { sourceId?: string; fixture?: boolean; link?: string; title?: string } = {},
): Promise<string> {
  const i = ++n;
  const kind = side === 'FLORIDA' ? 'FLORIDA_NEWS' : 'GTA_CANON';
  const inc = `inc_t${i}`;
  const ref = `ref_t${i}`;
  const q = `q_t${i}`;
  const host = side === 'FLORIDA' ? 'news.example.org' : 'grandtheftwiki.com';
  await db.batch([
    db
      .prepare(
        `INSERT INTO incidents (id, incident_key, kind, category, game, location_verified, verification_status, is_fixture) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?)`,
      )
      .bind(inc, `test:${i}`, kind, CATS[i % CATS.length], side === 'GTA' ? GAMES[i % GAMES.length] : null, side === 'FLORIDA' ? 1 : 0, o.fixture ? 1 : 0),
    db
      .prepare(
        `INSERT INTO source_references (id, incident_id, source_id, provider, original_url, canonical_url, original_title, publisher, published_at, content_digest, link_status, checked_at)
         VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?, 'deadbeefcafe', ?, '2026-11-20T00:00:00Z')`,
      )
      .bind(
        ref,
        inc,
        o.sourceId ?? (side === 'FLORIDA' ? APPROVED_PUBLISHER.id : APPROVED_WIKI.id),
        `https://${host}/story-${i}`,
        `https://${host}/story-${i}`,
        `TEST ORIGINAL HEADLINE ${i}`,
        side === 'FLORIDA' ? `Test Publisher ${i % 3}` : 'Test Wiki',
        side === 'FLORIDA' ? '2026-10-01' : null,
        o.link ?? 'ok',
      ),
    db
      .prepare(
        `INSERT INTO questions (id, incident_id, primary_reference_id, answer_kind, play_title, play_title_reviewed, explanation, difficulty, quality_state, approved_by, approved_at, approval_actor_type, is_fixture)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'approved', 'tester', '2026-11-01', 'human', ?)`,
      )
      .bind(q, inc, ref, side, o.title ?? `Test play title number ${i} about an odd event`, `SECRET-EXPLANATION for test question ${i}.`, (i % 3) + 1, o.fixture ? 1 : 0),
  ]);
  return q;
}

export async function seedMany(db: D1Database, florida: number, gta: number): Promise<void> {
  await seedSource(db, APPROVED_PUBLISHER);
  await seedSource(db, APPROVED_WIKI);
  for (let i = 0; i < florida; i++) await seedApproved(db, 'FLORIDA');
  for (let i = 0; i < gta; i++) await seedApproved(db, 'GTA');
}

const WORDS = ['lawnmower', 'kayak', 'scooter', 'tractor', 'canoe', 'wheelbarrow', 'skateboard', 'unicycle', 'forklift', 'jetski', 'segway', 'rickshaw'];
const PLACES = ['drive-thru', 'parking garage', 'bank lobby', 'school zone', 'car wash', 'hotel pool', 'bowling alley', 'farmers market'];
/** Distinct wording per index (titles differing only by a number share a fingerprint by design). */
export const distinctTitle = (i: number) => `A man steers a ${WORDS[i % WORDS.length]} through a ${PLACES[Math.floor(i / WORDS.length) % PLACES.length]} at dawn`;

/** A valid import item for an approved Florida publisher (fictional test content). */
export function floridaItem(i: number, o: Partial<ImportItem> & { title?: string; playTitle?: string } = {}): ImportItem {
  const url = `https://news.example.org/news/odd-story-${i}`;
  return {
    kind: 'FLORIDA_NEWS',
    incidentKey: `fl:test${i}`,
    reference: {
      provider: 'rss',
      providerKey: null,
      originalUrl: url,
      canonicalUrl: url,
      originalTitle: o.title ?? `Florida man ${i} found riding a lawnmower through a drive-thru`,
      publisher: 'Approved Test News',
      publishedAt: '2026-11-20',
      providerSeenAt: null,
      wikiPageId: null,
      wikiSection: null,
      contentDigest: `abcdef${String(i).padStart(4, '0')}`,
      linkCheck: { status: 'ok', httpStatus: 200, finalUrl: url, checkedAt: '2026-11-22T10:00:00.000Z' },
    },
    incident: {
      category: 'vehicles',
      gameDetected: null,
      floridaSignal: 'title',
      floridaEvidence: 'Florida man',
      possibleDuplicateOfKey: null,
      similarity: null,
      notes: null,
    },
    question: {
      playTitleDraft: o.playTitle ?? distinctTitle(i),
      explanationDraft: 'The linked report describes a man steering a ride-on mower through a drive-thru lane before deputies arrived.',
      difficulty: 2,
    },
    ai: {
      models: ['test-model'],
      promptVersion: 'test',
      schemaValid: true,
      relevant: true,
      sensitive: false,
      needsReview: false,
      gtaGame: null,
      category: 'vehicles',
      reasonCodes: [],
      tokensIn: 100,
      tokensOut: 50,
    },
    prefilter: { decision: 'candidate', reasonCodes: [] },
    ...o,
  } as ImportItem;
}
