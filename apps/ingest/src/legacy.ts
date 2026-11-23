/**
 * One-off migration utility for the legacy better-sqlite3 database
 * (data/gta-or-florida.sqlite, written by the removed apps/api server).
 *
 *   npm run legacy:export                   → backups/legacy-export/*.ndjson (git-ignored)
 *   npm run legacy:import -- --to <url>     → re-import the discovered candidates into a Worker
 *                                             (staging first; uses INGESTION_IMPORT_TOKEN)
 *
 * Uses node:sqlite (built into Node 22), so no native dependency remains.
 * Nothing is approved by the migration: candidates stay candidates, rights stay unreviewed.
 * Missing database → a clear message and exit 0.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isGtaGame, type ImportItem } from '@gof/core';
import { createWorkerClient } from './import.ts';
import { digest, serializeUrl } from './pipeline.ts';
import { REPO_ROOT } from './paths.ts';

const TABLES = ['source_records', 'incidents', 'incident_sources', 'questions', 'daily_challenges', 'daily_challenge_questions', 'review_log', 'ingestion_runs', 'ingestion_checkpoints'] as const;

type Row = Record<string, unknown>;

export async function exportLegacy(dbPath: string, outDir: string): Promise<Record<string, number> | null> {
  if (!existsSync(dbPath)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  mkdirSync(outDir, { recursive: true });
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
    if (!exists) continue;
    const rows = db.prepare(`SELECT * FROM ${t}`).all() as Row[];
    writeFileSync(resolve(outDir, `${t}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    counts[t] = rows.length;
  }
  db.close();
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify({ exportedAt: new Date().toISOString(), source: dbPath, counts }, null, 2));
  return counts;
}

function readNdjson(file: string): Row[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
}

/** Legacy candidate rows → import items (GTA canon + Florida). Approved/rights fields are NOT carried over. */
export function legacyToImportItems(dir: string): ImportItem[] {
  const sources = new Map(readNdjson(resolve(dir, 'source_records.ndjson')).map((r) => [r.id as string, r]));
  const incidents = new Map(readNdjson(resolve(dir, 'incidents.ndjson')).map((r) => [r.id as string, r]));
  const items: ImportItem[] = [];
  for (const q of readNdjson(resolve(dir, 'questions.ndjson'))) {
    const s = sources.get(q.primary_source_id as string);
    const inc = incidents.get(q.incident_id as string);
    if (!s || !inc || q.is_fixture === 1 || q.status === 'rejected') continue;
    const kind = inc.kind as string;
    if (kind !== 'GTA_CANON' && kind !== 'FLORIDA_NEWS') continue;
    const url = serializeUrl(String(s.original_url));
    const canonical = serializeUrl(String(s.canonical_url));
    if (!url || !canonical) continue;
    const raw = (() => {
      try {
        return JSON.parse(String(s.raw_metadata_json ?? '{}')) as { pageId?: number; sectionAnchor?: string };
      } catch {
        return {};
      }
    })();
    const game = isGtaGame(inc.game) ? inc.game : null;
    items.push({
      kind,
      incidentKey: kind === 'GTA_CANON' ? `gta:grandtheftwiki:${s.provider_key}` : `fl:${digest(canonical).slice(0, 24)}`,
      reference: {
        provider: String(s.provider) === 'grandtheftwiki' ? 'grandtheftwiki' : 'legacy',
        providerKey: (s.provider_key as string | null) ?? null,
        originalUrl: url,
        canonicalUrl: canonical,
        originalTitle: String(s.original_title).slice(0, 400),
        publisher: (s.publisher as string | null) ?? null,
        publishedAt: null,
        providerSeenAt: (s.provider_seen_at as string | null) ?? null,
        wikiPageId: typeof raw.pageId === 'number' ? raw.pageId : null,
        wikiSection: raw.sectionAnchor ?? null,
        contentDigest: digest(`${s.original_title}\n${canonical}`),
        linkCheck: null,
      },
      incident: {
        category: 'other',
        gameDetected: game,
        floridaSignal: (['title', 'domain', 'none'].includes(String(inc.florida_signal)) ? inc.florida_signal : 'none') as 'title' | 'domain' | 'none',
        floridaEvidence: null,
        possibleDuplicateOfKey: null,
        similarity: null,
        notes: [`Migrated from legacy SQLite (${q.id})`, inc.event_notes ? String(inc.event_notes) : null].filter(Boolean).join('\n').slice(0, 1000),
      },
      question: { playTitleDraft: String(q.play_title).slice(0, 240), explanationDraft: String(q.explanation ?? '').slice(0, 800), difficulty: Number(q.difficulty) || 2 },
      ai: null,
      prefilter: { decision: 'candidate', reasonCodes: [] },
    });
  }
  return items;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { db: { type: 'string' }, dir: { type: 'string' }, to: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  const dir = values.dir ?? resolve(REPO_ROOT, 'backups/legacy-export');
  if (command === 'export') {
    const dbPath = values.db ?? resolve(REPO_ROOT, 'data/gta-or-florida.sqlite');
    const counts = await exportLegacy(dbPath, dir);
    if (!counts) {
      console.log(`No legacy database at ${dbPath}; nothing to export.`);
      return 0;
    }
    console.log(`Exported to ${dir}: ${JSON.stringify(counts)}`);
    return 0;
  }
  if (command === 'import') {
    const items = legacyToImportItems(dir);
    console.log(`${items.length} legacy candidate(s) ready (${items.filter((i) => i.kind === 'GTA_CANON').length} GTA, ${items.filter((i) => i.kind === 'FLORIDA_NEWS').length} Florida).`);
    if (values['dry-run']) return 0;
    const url = values.to ?? process.env.INGESTION_API_URL;
    const token = process.env.INGESTION_IMPORT_TOKEN;
    if (!url || !token) throw new Error('--to <worker url> (or INGESTION_API_URL) and INGESTION_IMPORT_TOKEN are required');
    const client = createWorkerClient({ baseUrl: url, token });
    const results = await client.importItems(`legacy_${digest(JSON.stringify(items)).slice(0, 12)}`, items);
    const tally: Record<string, number> = {};
    for (const r of results) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
    console.log(`Import results: ${JSON.stringify(tally)}`);
    const invalid = results.filter((r) => r.outcome === 'invalid').slice(0, 5);
    for (const r of invalid) console.log(`  invalid ${r.incidentKey}: ${r.errors?.join('; ')}`);
    return 0;
  }
  console.log('Usage: legacy export [--db path] [--dir out] | legacy import [--dir in] [--to url] [--dry-run]');
  return 1;
}

// pathToFileURL: a plain `file://${argv[1]}` never matches on Windows (backslashes, drive letter).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error((error as Error).message);
      process.exit(1);
    },
  );
}
