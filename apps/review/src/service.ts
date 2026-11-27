/**
 * Editorial review over the local Worker: one click per question (approve / investigate / reject).
 *
 * Decisions are the reviewer's editorial calls, stored in the dashboard tables (editorial_*) with an
 * append-only history. They are NOT the Worker's formal approval: a click never submits the Worker's
 * factual-summary attestations (authorship, source verification…), so nothing in the Worker's audit
 * trail claims checks that did not happen. The questions stay Worker candidates; formal approval for a
 * deployed environment remains the existing `npm run admin -- questions:approve` step.
 *
 * The master JSON is read once (on first start) and never written.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GTA_GAMES, formatIssues, parse, s, titleFingerprint, type Schema } from '@gof/core';
import { parseBankFile, toImportItem, validateBank, type BankEntry, type BankFile } from '../../ingest/src/bank.ts';
import { entryKey } from '../../ingest/src/bank-item.ts';
import { loadSourcesConfig } from '../../ingest/src/config-file.ts';
import { WorkerApiError } from '../../ingest/src/import.ts';
import type { SourcesConfig } from '../../ingest/src/normalize.ts';
import { REPO_ROOT } from '../../ingest/src/paths.ts';
import { openLocalWorker, sanitizeActor, type LocalWorker } from './local-worker.ts';

export const STATUSES = ['unreviewed', 'approved', 'investigate', 'rejected'] as const;
export type Status = (typeof STATUSES)[number];

export class ReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Editorial audit (suggestions only — never a decision)
// ---------------------------------------------------------------------------

export type AuditEntry = {
  recommendation: 'approve' | 'investigate' | 'reject';
  warnings: { code: string; message: string }[];
  suggestedHeadline?: string;
  suggestedExplanation?: string;
  note?: string;
};
export type AuditFile = { version: number; generatedAt: string; masterSha256?: string; items: Record<string, AuditEntry> };

function loadAudit(path: string | undefined): AuditFile | null {
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as AuditFile;
    if (!raw || typeof raw !== 'object' || typeof raw.items !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request schemas (server-side validation of everything the browser sends)
// ---------------------------------------------------------------------------

export const editSchema = s.object({
  headline: s.optional(s.string({ min: 1, max: 240 })),
  explanation: s.optional(s.string({ min: 1, max: 800 })),
  difficulty: s.optional(s.int({ min: 1, max: 3 })),
  editorNotes: s.optional(s.string({ max: 2000 })),
});
/** A decision needs nothing but the click; a note is optional. */
export const decisionSchema = s.object({ note: s.optional(s.string({ max: 500 })) });
export function validated<T>(schema: Schema<T>, body: unknown): T {
  const r = parse(schema, body ?? {});
  if (!r.ok) throw new ReviewError(400, 'Invalid request', [formatIssues(r.issues)]);
  return r.value;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type ItemRow = {
  event_id: string;
  question_id: string;
  origin: 'FLORIDA' | 'GTA';
  position: number;
  original_json: string;
  status: Status;
  status_note: string | null;
  headline: string;
  explanation: string;
  difficulty: number;
  editor_notes: string;
  updated_at: string;
};
type EventRow = { id: number; event_id: string; at: string; reviewer: string; action: string; from_status: string | null; to_status: string | null; note: string | null; before_json: string | null; after_json: string | null; worker_log_id: number | null };

const EDITORIAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS editorial_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS editorial_items (
     event_id TEXT PRIMARY KEY,
     question_id TEXT NOT NULL UNIQUE,
     origin TEXT NOT NULL CHECK (origin IN ('FLORIDA','GTA')),
     position INTEGER NOT NULL,
     original_json TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed','approved','investigate','rejected')),
     status_note TEXT,
     headline TEXT NOT NULL,
     explanation TEXT NOT NULL,
     difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
     editor_notes TEXT NOT NULL DEFAULT '',
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS editorial_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id TEXT NOT NULL,
     at TEXT NOT NULL,
     reviewer TEXT NOT NULL,
     action TEXT NOT NULL,
     from_status TEXT,
     to_status TEXT,
     note TEXT,
     before_json TEXT,
     after_json TEXT,
     worker_log_id INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS editorial_events_by_item ON editorial_events (event_id, id)`,
  // History is append-only.
  `CREATE TRIGGER IF NOT EXISTS editorial_events_no_update BEFORE UPDATE ON editorial_events BEGIN SELECT RAISE(ABORT, 'editorial history is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS editorial_events_no_delete BEFORE DELETE ON editorial_events BEGIN SELECT RAISE(ABORT, 'editorial history is append-only'); END`,
];

export type ServiceOptions = {
  masterPath: string;
  auditPath?: string;
  persistDir: string | false;
  reviewer: string;
  now?: () => Date;
  /** Tests: source policy override (defaults to the repo's data/ config, like bank:import). */
  sourcesConfig?: SourcesConfig;
};

export class ReviewService {
  private constructor(
    private readonly w: LocalWorker,
    private readonly opts: ServiceOptions,
    private readonly cfg: SourcesConfig,
    private readonly audit: AuditFile | null,
    readonly reviewer: string,
    private readonly masterSha: string,
    private readonly importedSha: string,
    private readonly importedFile: string,
    /** Questions already under review whose master entry now differs from the version imported for review. */
    private readonly changedEntries: string[],
  ) {}

  static async open(opts: ServiceOptions): Promise<ReviewService> {
    const reviewer = sanitizeActor(opts.reviewer);
    const now = opts.now ?? (() => new Date());
    const rawText = readFileSync(opts.masterPath, 'utf8');
    const masterSha = createHash('sha256').update(rawText).digest('hex');
    const cfg = opts.sourcesConfig ?? loadSourcesConfig(resolve(REPO_ROOT, 'data'));
    const w = await openLocalWorker({ persistDir: opts.persistDir, reviewer, now });
    try {
      await w.db.batch(EDITORIAL_SCHEMA.map((q) => w.db.prepare(q)));
      // First start imports the whole master; later starts only ADD questions that are new in the master.
      // Existing decisions, working text and history are never touched by a master update.
      const have = (await w.db.prepare('SELECT event_id, position FROM editorial_items').all<{ event_id: string; position: number }>()).results;
      await importMaster(w, rawText, masterSha, opts.masterPath, cfg, reviewer, now(), new Set(have.map((r) => r.event_id)), Math.max(0, ...have.map((r) => r.position)));
      const meta = await w.db.prepare(`SELECT key, value FROM editorial_meta`).all<{ key: string; value: string }>();
      const m = Object.fromEntries(meta.results.map((r) => [r.key, r.value]));
      // Compare entry by entry (not the file checksum, which moves whenever questions are added or removed):
      // a changed entry is NOT re-imported, so the reviewer must be told it differs.
      const stored = new Map(
        (await w.db.prepare('SELECT event_id, original_json FROM editorial_items').all<{ event_id: string; original_json: string }>()).results.map((r) => [r.event_id, r.original_json]),
      );
      const parsedMaster = parseBankFile(JSON.parse(rawText));
      const changed = parsedMaster.ok ? parsedMaster.file.questions.filter((e) => stored.has(e.eventId) && stored.get(e.eventId) !== JSON.stringify(e)).map((e) => e.eventId) : [];
      return new ReviewService(w, opts, cfg, loadAudit(opts.auditPath), reviewer, masterSha, m.master_sha256 ?? '', m.master_file ?? '', changed);
    } catch (error) {
      await w.dispose();
      throw error;
    }
  }

  dispose() {
    return this.w.dispose();
  }

  private now() {
    return (this.opts.now ?? (() => new Date()))();
  }

  // ---- reads ---------------------------------------------------------------

  private async items(): Promise<ItemRow[]> {
    return (await this.w.db.prepare('SELECT * FROM editorial_items ORDER BY position').all<ItemRow>()).results;
  }

  private async item(eventId: string): Promise<ItemRow> {
    if (!/^[a-z0-9][a-z0-9:._-]{2,79}$/.test(eventId)) throw new ReviewError(400, 'Invalid event id');
    const row = await this.w.db.prepare('SELECT * FROM editorial_items WHERE event_id = ?').bind(eventId).first<ItemRow>();
    if (!row) throw new ReviewError(404, `Unknown question ${eventId}`);
    return row;
  }

  private entryOf(row: ItemRow, text: Pick<ItemRow, 'headline' | 'explanation' | 'difficulty'> = row): BankEntry {
    const original = JSON.parse(row.original_json) as BankEntry;
    return { ...original, headline: text.headline, explanation: text.explanation, difficulty: text.difficulty };
  }

  /** The existing bank validators on the working copy, plus wording collisions across the whole bank. */
  private async contentProblems(row: ItemRow, text: Pick<ItemRow, 'headline' | 'explanation' | 'difficulty'> = row): Promise<{ problems: string[]; warnings: string[] }> {
    const entry = this.entryOf(row, text);
    const [report] = validateBank({ batch: 'editorial-review', questions: [entry] }, this.cfg);
    const problems = [...report!.problems];
    const fp = titleFingerprint(text.headline);
    const clash = (await this.items()).find((o) => o.event_id !== row.event_id && titleFingerprint(o.headline) === fp);
    if (clash) problems.push(`DUPLICATE_HEADLINE: same wording as ${clash.event_id}`);
    return { problems, warnings: report!.warnings };
  }

  async summary() {
    const rows = await this.items();
    const by = (st: Status, sub = rows) => sub.filter((r) => r.status === st).length;
    const total = rows.length;
    const origin = (o: 'FLORIDA' | 'GTA') => {
      const sub = rows.filter((r) => r.origin === o);
      return { total: sub.length, approved: by('approved', sub), investigate: by('investigate', sub), rejected: by('rejected', sub), unreviewed: by('unreviewed', sub) };
    };
    return {
      total,
      approved: by('approved'),
      investigate: by('investigate'),
      rejected: by('rejected'),
      unreviewed: by('unreviewed'),
      progressPercent: total ? Math.round(((total - by('unreviewed')) / total) * 1000) / 10 : 0,
      florida: origin('FLORIDA'),
      gta: origin('GTA'),
      reviewer: this.reviewer,
      master: { file: this.importedFile, sha256AtImport: this.importedSha, sha256Now: this.masterSha, changedSinceImport: this.changedEntries.length > 0, changedEntries: this.changedEntries },
      auditLoaded: !!this.audit,
    };
  }

  async list() {
    const rows = await this.items();
    return rows.map((r) => {
      const o = JSON.parse(r.original_json) as BankEntry;
      const a = this.audit?.items[r.event_id];
      return {
        eventId: r.event_id,
        position: r.position,
        origin: r.origin,
        headline: r.headline,
        difficulty: r.difficulty,
        status: r.status,
        publisher: o.publisher ?? null,
        sourceHost: hostOf(o.sourceUrl),
        game: o.game ?? null,
        edited: r.headline !== o.headline || r.explanation !== o.explanation || r.difficulty !== (o.difficulty ?? 2),
        recommendation: a?.recommendation ?? null,
        warningCodes: a?.warnings.map((x) => x.code) ?? [],
      };
    });
  }

  async detail(eventId: string) {
    const row = await this.item(eventId);
    const original = JSON.parse(row.original_json) as BankEntry;
    const events = (await this.w.db.prepare('SELECT * FROM editorial_events WHERE event_id = ? ORDER BY id').bind(eventId).all<EventRow>()).results;
    return {
      eventId,
      origin: row.origin,
      status: row.status,
      statusNote: row.status_note,
      working: { headline: row.headline, explanation: row.explanation, difficulty: row.difficulty, editorNotes: row.editor_notes },
      original,
      gameName: original.game ? GTA_GAMES[original.game] : null,
      audit: this.audit?.items[eventId] ?? null,
      history: events.map((e) => ({ ...e, before: e.before_json ? JSON.parse(e.before_json) : null, after: e.after_json ? JSON.parse(e.after_json) : null, before_json: undefined, after_json: undefined })),
    };
  }

  // ---- writes --------------------------------------------------------------

  private snapshot(r: Pick<ItemRow, 'headline' | 'explanation' | 'difficulty' | 'editor_notes' | 'status' | 'status_note'>) {
    return { headline: r.headline, explanation: r.explanation, difficulty: r.difficulty, editorNotes: r.editor_notes, status: r.status, statusNote: r.status_note };
  }

  private eventStmt(e: { eventId: string; action: string; from?: Status | null; to?: Status | null; note?: string | null; before?: unknown; after?: unknown }) {
    return this.w.db
      .prepare(`INSERT INTO editorial_events (event_id, at, reviewer, action, from_status, to_status, note, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(e.eventId, this.now().toISOString(), this.reviewer, e.action, e.from ?? null, e.to ?? null, e.note ?? null, e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after));
  }

  /**
   * One click = one decision. Any decision can replace any other (clicking a different button changes
   * it); every change is appended to the history. Clicking the current decision again changes nothing.
   */
  async decide(eventId: string, to: Status, body: unknown) {
    const { note } = validated(decisionSchema, body);
    const row = await this.item(eventId);
    const clean = note?.trim() || null;
    if (row.status === to && (clean ?? null) === (row.status_note ?? null)) return { ok: true, status: to, changed: false };
    await this.w.db.batch([
      this.w.db.prepare('UPDATE editorial_items SET status = ?, status_note = ?, updated_at = ? WHERE event_id = ?').bind(to, clean, this.now().toISOString(), eventId),
      this.eventStmt({ eventId, action: to === 'unreviewed' ? 'reopened' : to, from: row.status, to, note: clean }),
    ]);
    return { ok: true, status: to, changed: true };
  }

  /** Wording edits (API only; kept for applying audit suggestions later). Validators run; problems are returned. */
  async edit(eventId: string, body: unknown) {
    const req = validated(editSchema, body);
    const row = await this.item(eventId);
    const next = {
      headline: req.headline !== undefined ? req.headline.trim() : row.headline,
      explanation: req.explanation !== undefined ? req.explanation.trim() : row.explanation,
      difficulty: req.difficulty ?? row.difficulty,
      editor_notes: req.editorNotes !== undefined ? req.editorNotes.trim() : row.editor_notes,
    };
    const textChanged = next.headline !== row.headline || next.explanation !== row.explanation || next.difficulty !== row.difficulty;
    if (!textChanged && next.editor_notes === row.editor_notes) return { changed: false, validation: await this.contentProblems(row) };
    if (textChanged) {
      // Keep the local Worker candidate in step (same `questions:edit` path the CLI uses).
      try {
        await this.w.admin.review({ questionId: row.question_id, action: 'edit', playTitle: next.headline, explanation: next.explanation, difficulty: next.difficulty });
      } catch (error) {
        if (error instanceof WorkerApiError) throw new ReviewError(error.status === 422 ? 422 : 502, error.message, Array.isArray(error.details) ? (error.details as string[]) : []);
        throw error;
      }
    }
    await this.w.db.batch([
      this.w.db.prepare('UPDATE editorial_items SET headline = ?, explanation = ?, difficulty = ?, editor_notes = ?, updated_at = ? WHERE event_id = ?').bind(next.headline, next.explanation, next.difficulty, next.editor_notes, this.now().toISOString(), eventId),
      this.eventStmt({ eventId, action: textChanged ? 'edited' : 'notes_edited', before: this.snapshot(row), after: this.snapshot({ ...row, ...next }) }),
    ]);
    return { changed: true, validation: await this.contentProblems({ ...row, ...next }) };
  }

  // ---- exports -------------------------------------------------------------

  async exportFile(kind: 'approved' | 'investigate' | 'rejected' | 'history') {
    const rows = await this.items();
    const stamp = this.now().toISOString();
    if (kind === 'history') {
      const events = (await this.w.db.prepare('SELECT * FROM editorial_events ORDER BY id').all<EventRow>()).results.map((e) => ({ ...e, before: e.before_json ? JSON.parse(e.before_json) : null, after: e.after_json ? JSON.parse(e.after_json) : null, before_json: undefined, after_json: undefined }));
      return {
        exportedAt: stamp,
        reviewer: this.reviewer,
        master: { file: this.importedFile, sha256AtImport: this.importedSha },
        items: rows.map((r) => ({ eventId: r.event_id, origin: r.origin, status: r.status, statusNote: r.status_note, headline: r.headline, explanation: r.explanation, difficulty: r.difficulty, editorNotes: r.editor_notes })),
        editorialEvents: events,
      };
    }
    const decidedAt = new Map(
      (await this.w.db.prepare(`SELECT event_id, MAX(at) AS at FROM editorial_events WHERE to_status IS NOT NULL GROUP BY event_id`).all<{ event_id: string; at: string }>()).results.map((r) => [r.event_id, r.at]),
    );
    const label = { approved: 'Editorially approved', investigate: 'Marked for further investigation', rejected: 'Rejected' }[kind];
    const questions: BankEntry[] = rows
      .filter((r) => r.status === kind)
      .map((r) => {
        const o = JSON.parse(r.original_json) as BankEntry;
        const decision = `${label} in the local review dashboard by ${this.reviewer} at ${decidedAt.get(r.event_id) ?? stamp}${r.status_note ? ` (${r.status_note})` : ''}. Not a Worker approval.`;
        return { ...o, headline: r.headline, explanation: r.explanation, difficulty: r.difficulty, notes: `${decision} ${o.notes ?? ''}`.trim().slice(0, 1000) };
      });
    const file: BankFile = { batch: `editorial-review-${kind}-${stamp.slice(0, 10)}`, questions };
    if (questions.length) {
      const ok = parseBankFile(file);
      if (!ok.ok) throw new ReviewError(500, `Export does not match the question-bank schema: ${ok.error}`);
    }
    return file;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** First start: validate the frozen master with the bank validators, import it as local candidates, map ids. */
async function importMaster(w: LocalWorker, rawText: string, sha: string, path: string, cfg: SourcesConfig, reviewer: string, now: Date, existing: Set<string>, lastPosition: number): Promise<number> {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    throw new ReviewError(400, `Master file is not JSON: ${(error as Error).message}`);
  }
  const parsed = parseBankFile(raw);
  if (!parsed.ok) throw new ReviewError(400, `Master file is not a valid question-bank batch:\n${parsed.error}`);
  const file = parsed.file;
  if (file.fixture) throw new ReviewError(400, 'Fixture batches cannot be reviewed as real content.');
  const fresh = file.questions.filter((e) => !existing.has(e.eventId));
  if (!fresh.length) return 0;
  const bad = validateBank(file, cfg).filter((r) => r.problems.length && !existing.has(r.eventId));
  if (bad.length) throw new ReviewError(400, `Master has ${bad.length} invalid entr${bad.length === 1 ? 'y' : 'ies'}; fix them before reviewing`, bad.map((r) => `${r.eventId}: ${r.problems.join('; ')}`));
  const ids = new Set<string>();
  for (const e of file.questions) {
    if (ids.has(e.eventId)) throw new ReviewError(400, `Duplicate eventId ${e.eventId} in the master: the dashboard reviews one question per event.`);
    ids.add(e.eventId);
  }
  const items = fresh.map((e) => toImportItem(e, file, now));
  const results = await w.service.importItems(`review-${sha.slice(0, 12)}`, items);
  const refused = results.filter((r) => r.outcome === 'invalid');
  if (refused.length) throw new ReviewError(400, `The local Worker refused ${refused.length} item(s)`, refused.map((r) => `${r.incidentKey}: ${(r.errors ?? []).join('; ')}`));
  const stamp = now.toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const [i, e] of fresh.entries()) {
    const q = await w.db
      .prepare(`SELECT q.id, q.quality_state FROM questions q JOIN incidents inc ON inc.id = q.incident_id WHERE inc.incident_key = ?`)
      .bind(`bank:${entryKey(e)}`)
      .first<{ id: string; quality_state: string }>();
    if (!q) throw new ReviewError(500, `Imported ${e.eventId} but cannot find its question in the local database`);
    stmts.push(
      w.db
        .prepare(`INSERT INTO editorial_items (event_id, question_id, origin, position, original_json, status, headline, explanation, difficulty, updated_at) VALUES (?, ?, ?, ?, ?, 'unreviewed', ?, ?, ?, ?)`)
        .bind(e.eventId, q.id, e.origin, lastPosition + i + 1, JSON.stringify(e), e.headline.trim(), e.explanation.trim(), e.difficulty ?? 2, stamp),
      w.db
        .prepare(`INSERT INTO editorial_events (event_id, at, reviewer, action, to_status, note) VALUES (?, ?, ?, 'imported', 'unreviewed', ?)`)
        .bind(e.eventId, stamp, reviewer, `${existing.size ? 'Added from an updated master' : 'Imported'} ${path} (sha256 ${sha}) as local candidate ${q.id} (state ${q.quality_state}).`),
    );
  }
  stmts.push(
    w.db.prepare(`INSERT OR REPLACE INTO editorial_meta (key, value) VALUES ('master_sha256', ?)`).bind(sha),
    w.db.prepare(`INSERT OR REPLACE INTO editorial_meta (key, value) VALUES ('master_file', ?)`).bind(path),
    w.db.prepare(`INSERT OR REPLACE INTO editorial_meta (key, value) VALUES ('imported_at', ?)`).bind(stamp),
  );
  await w.db.batch(stmts);
  return fresh.length;
}
