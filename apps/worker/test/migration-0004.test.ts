import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import type { Env } from '../src/env.ts';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const statements = (files: string[]) =>
  files
    .map((f) => readFileSync(resolve(dir, 'migrations', f), 'utf8'))
    .join('\n')
    .split('\n')
    .map((l) => l.replace(/\s+--.*$/, '').replace(/^--.*$/, ''))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({ configPath: resolve(dir, 'wrangler.jsonc'), environment: 'local', persist: false });
});
afterAll(() => proxy.dispose());

describe('migration 0004 (question bank scheduling)', () => {
  it('keeps every existing round, item and question unchanged, then allows reuse and 0-5 splits', async () => {
    const db = proxy.env.DB;
    const all = readdirSync(resolve(dir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const before = all.filter((f) => f < '0004');
    await db.batch(statements(before).map((s) => db.prepare(s)));

    // A published, a scheduled and a withdrawn day on the old schema (3/2 and 2/3 splits).
    await db.batch([
      db.prepare(`INSERT INTO sources (id, type, name, canonical_host, policy_version) VALUES ('s1','publisher','S','example.org','t')`),
      ...Array.from({ length: 15 }, (_, i) => [
        db.prepare(`INSERT INTO incidents (id, incident_key, kind) VALUES (?, ?, 'FLORIDA_NEWS')`).bind(`i${i}`, `k${i}`),
        db.prepare(`INSERT INTO source_references (id, incident_id, source_id, provider, original_url, canonical_url, original_title, content_digest) VALUES (?, ?, 's1', 'test', ?, ?, 't', 'deadbeefcafe')`).bind(`r${i}`, `i${i}`, `https://example.org/${i}`, `https://example.org/${i}`),
        db.prepare(`INSERT INTO questions (id, incident_id, primary_reference_id, answer_kind, play_title) VALUES (?, ?, ?, ?, ?)`).bind(`q${i}`, `i${i}`, `r${i}`, i % 2 ? 'GTA' : 'FLORIDA', `Title ${i}`),
      ]).flat(),
      db.prepare(`INSERT INTO daily_rounds (day, number, status, florida_count, published_at) VALUES ('2026-11-20', 1, 'published', 3, '2026-11-20T00:05:00Z')`),
      db.prepare(`INSERT INTO daily_rounds (day, number, status, florida_count) VALUES ('2026-11-21', 2, 'scheduled', 2)`),
      db.prepare(`INSERT INTO daily_rounds (day, number, status, florida_count, withdrawn_reason, public_message, content_version) VALUES ('2026-11-22', 3, 'withdrawn', 3, 'why', 'msg', 2)`),
      ...Array.from({ length: 15 }, (_, i) => db.prepare(`INSERT INTO daily_round_items (day, position, question_id) VALUES (?, ?, ?)`).bind(['2026-11-20', '2026-11-21', '2026-11-22'][Math.floor(i / 5)]!, (i % 5) + 1, `q${i}`)),
    ]);
    const snapshot = async () => ({
      rounds: (await db.prepare('SELECT * FROM daily_rounds ORDER BY day').all()).results,
      items: (await db.prepare('SELECT * FROM daily_round_items ORDER BY day, position').all()).results,
      questions: (await db.prepare('SELECT id, incident_id, answer_kind, play_title, quality_state FROM questions ORDER BY id').all()).results,
    });
    const old = await snapshot();

    await db.batch(statements(['0004_question_bank_scheduling.sql']).map((s) => db.prepare(s)));
    expect(await snapshot()).toEqual(old);
    const cols = (await db.prepare(`SELECT name FROM pragma_table_info('questions')`).all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(['event_id', 'spoiler']));
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE spoiler = 0 AND event_id IS NULL`).first<{ n: number }>())!.n).toBe(15);

    // Reuse on another day is allowed now; twice in one day is not.
    await db.batch([
      db.prepare(`INSERT INTO daily_rounds (day, number, florida_count) VALUES ('2026-12-30', 41, 0)`),
      db.prepare(`INSERT INTO daily_round_items (day, position, question_id) VALUES ('2026-12-30', 1, 'q0')`),
    ]);
    await expect(db.prepare(`INSERT INTO daily_round_items (day, position, question_id) VALUES ('2026-12-30', 2, 'q0')`).run()).rejects.toThrow(/UNIQUE/);
    await expect(db.prepare(`INSERT INTO daily_rounds (day, number, florida_count) VALUES ('2026-12-31', 42, 6)`).run()).rejects.toThrow(/CHECK/);
    await expect(db.prepare(`INSERT INTO daily_round_items (day, position, question_id) VALUES ('2027-01-09', 1, 'q1')`).run()).rejects.toThrow(/FOREIGN KEY/);
    const fk = await db.prepare('PRAGMA foreign_key_check').all();
    expect(fk.results).toEqual([]);
    expect((await db.prepare('PRAGMA quick_check').first<{ quick_check: string }>())!.quick_check).toBe('ok'); // D1 does not authorize integrity_check

    // Indexes: the rebuilt tables keep (or replace) every index the old ones had.
    const indexes = (t: string) => db.prepare(`SELECT name, "unique", origin FROM pragma_index_list(?) ORDER BY name`).bind(t).all<{ name: string; unique: number; origin: string }>();
    expect((await indexes('daily_rounds')).results.map((i) => [i.origin, i.unique, i.name.startsWith('sqlite_') ? 'auto' : i.name]).sort()).toEqual(
      [['c', 0, 'idx_rounds_status'], ['pk', 1, 'auto'], ['u', 1, 'auto']].sort(), // status index, day PK, UNIQUE(number)
    );
    expect((await indexes('daily_round_items')).results.map((i) => [i.origin, i.unique, i.name.startsWith('sqlite_') ? 'auto' : i.name]).sort()).toEqual(
      [['c', 0, 'idx_round_items_question'], ['pk', 1, 'auto'], ['u', 1, 'auto']].sort(), // question lookups, (day, position) PK, UNIQUE(day, question_id)
    );
    const plan = async (sql: string, ...args: unknown[]) => (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join(' | ');
    expect(await plan(`SELECT i.day, i.question_id FROM daily_round_items i WHERE i.day BETWEEN ? AND ?`, '2026-11-01', '2026-12-31')).toMatch(/USING (INDEX|PRIMARY KEY|COVERING INDEX) .*day/i);
    expect(await plan(`SELECT day FROM daily_round_items WHERE question_id = ?`, 'q1')).toMatch(/idx_round_items_question|sqlite_autoindex/);
    expect(await plan(`SELECT question_id, COUNT(*) FROM daily_round_items GROUP BY question_id`)).toMatch(/idx_round_items_question/);
    expect(await plan(`SELECT * FROM daily_rounds WHERE day = ?`, '2026-11-20')).toMatch(/USING INDEX sqlite_autoindex_daily_rounds|PRIMARY KEY/);

    // The Worker code before this branch still works on the new schema (rollback / deploy-order safety):
    // its scheduler inserts (2/3 splits, never-reused questions), its pool query and the public round query.
    await db.batch([
      db.prepare(`INSERT INTO daily_rounds (day, number, status, florida_count) VALUES (?, ?, 'scheduled', ?)`).bind('2027-01-05', 47, 3),
      db.prepare(`INSERT INTO daily_round_items (day, position, question_id) VALUES (?, ?, ?)`).bind('2027-01-05', 1, 'q14'),
    ]);
    const oldPool = await db.prepare(`SELECT q.id FROM questions q WHERE NOT EXISTS (SELECT 1 FROM daily_round_items d WHERE d.question_id = q.id)`).all();
    expect(oldPool.results).toEqual([]);
    const oldRound = await db
      .prepare(`SELECT r.day, r.number, r.status, i.position, q.play_title FROM daily_rounds r LEFT JOIN daily_round_items i ON i.day = r.day LEFT JOIN questions q ON q.id = i.question_id WHERE r.day = ? ORDER BY i.position`)
      .bind('2026-11-20')
      .all();
    expect(oldRound.results.map((r) => r.play_title)).toEqual(['Title 0', 'Title 1', 'Title 2', 'Title 3', 'Title 4']);

    const ddl = await db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'daily_round_items'`).first<{ sql: string }>();
    expect(ddl!.sql).toMatch(/REFERENCES "?daily_rounds"?\(day\)/);
  });
});
