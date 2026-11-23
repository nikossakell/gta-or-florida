import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importItemSchema, parse } from '@gof/core';
import { discoverGdelt, discoverWiki } from '../src/discover.ts';
import { exportLegacy, legacyToImportItems } from '../src/legacy.ts';
import type { SourcesConfig } from '../src/normalize.ts';
import type { WikiClient } from '../src/adapters/grandtheftwiki.ts';

const quiet = { info() {}, warn() {}, error() {} };
const CFG: SourcesConfig = {
  version: 1,
  gdelt: { endpoint: 'https://api.gdeltproject.org/api/v2/doc/doc', minDelaySeconds: 5, maxRecords: 10, timespan: '1d', sort: 'DateDesc', queriesPerRun: 2, batches: [{ id: 'a', query: 'x' }, { id: 'b', query: 'y' }, { id: 'c', query: 'z' }] },
  grandTheftWiki: { categories: [{ name: 'Cat', mode: 'sections' }] },
  domains: { blocked: { list: [] }, floridaHints: { list: [] } },
  floridaPlaceNames: ['Florida'],
};

describe('GDELT discovery under rate limiting', () => {
  it('stops on persistent 429 without advancing the batch cursor or inventing items', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'slow down' });
    const r = await discoverGdelt(CFG, { checkpoint: new Map([['nextBatchIndex', '1']]), queries: 2, userAgent: 't', fetchImpl, sleep: async () => {}, log: quiet });
    expect(r.rateLimited).toBe(true);
    expect(r.items).toEqual([]);
    expect(r.checkpoints).toEqual([]);
    expect(r.errors[0]).toMatch(/gdelt:b/);
  });

  it('advances the rotation past batches that ran', async () => {
    const body = JSON.stringify({ articles: [{ url: 'https://news.example.org/a', title: 'Florida man rides a lawnmower to the bank', domain: 'news.example.org', seendate: '20261120T101500Z' }] });
    const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => body });
    const r = await discoverGdelt(CFG, { checkpoint: new Map(), queries: 2, userAgent: 't', fetchImpl, sleep: async () => {}, log: quiet });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ publishedAt: null, seenAt: expect.stringMatching(/^2026-11-20T10:15/) });
    expect(r.checkpoints).toEqual([{ provider: 'gdelt', key: 'nextBatchIndex', value: '2' }]);
  });
});

describe('wiki discovery under timeouts', () => {
  it('keeps the old cursor when the category listing fails', async () => {
    const client = {
      wikiBase: 'https://www.grandtheftwiki.com/',
      categoryMembers: async () => {
        throw Object.assign(new Error('timed out'), { kind: 'timeout' });
      },
    } as unknown as WikiClient;
    const r = await discoverWiki(CFG, client, { checkpoint: new Map([['cmcontinue:Cat', 'page|123']]), maxMemberPages: 1, log: quiet });
    expect(r.items).toEqual([]);
    expect(r.checkpoints).toEqual([]);
    expect(r.errors[0]).toMatch(/timed out/);
  });
});

describe('legacy export/import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gof-legacy-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('skips gracefully when there is no database', async () => {
    expect(await exportLegacy(join(dir, 'missing.sqlite'), join(dir, 'out0'))).toBeNull();
  });

  it('exports a legacy SQLite file and converts candidates without carrying approvals or rights', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const path = join(dir, 'legacy.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE source_records (id TEXT, provider TEXT, kind TEXT, provider_key TEXT, original_title TEXT, original_url TEXT, canonical_url TEXT, publisher TEXT, provider_seen_at TEXT, rights_state TEXT, raw_metadata_json TEXT);
             CREATE TABLE incidents (id TEXT, kind TEXT, game TEXT, florida_signal TEXT, event_notes TEXT);
             CREATE TABLE questions (id TEXT, incident_id TEXT, primary_source_id TEXT, play_title TEXT, explanation TEXT, difficulty INTEGER, status TEXT, is_fixture INTEGER);`);
    db.exec(`INSERT INTO source_records VALUES ('s1','grandtheftwiki','GTA_CANON','58257#Story','Test Story Heading','https://www.grandtheftwiki.com/Test#Story','https://www.grandtheftwiki.com/index.php?curid=58257#Story','Grand Theft Wiki',NULL,'exact_headline_allowed','{"pageId":58257,"sectionAnchor":"Story"}');
             INSERT INTO incidents VALUES ('i1','GTA_CANON','GTA_III','none','note');
             INSERT INTO questions VALUES ('q1','i1','s1','A city paper reports something odd','',2,'approved',0);`);
    db.close();
    const counts = await exportLegacy(path, join(dir, 'out'));
    expect(counts).toMatchObject({ source_records: 1, incidents: 1, questions: 1 });
    const items = legacyToImportItems(join(dir, 'out'));
    expect(items).toHaveLength(1);
    expect(parse(importItemSchema, items[0]).ok).toBe(true);
    expect(items[0]).toMatchObject({ incidentKey: 'gta:grandtheftwiki:58257#Story', ai: null, prefilter: { decision: 'candidate' } });
    // No approval/rights carried over: the import contract has no field for them at all.
    expect(JSON.stringify(items[0])).not.toMatch(/approved|exact_headline/);
  });
});
