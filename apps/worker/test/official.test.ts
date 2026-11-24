import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImportItem, ImportResponse, IncidentFacts, OperationStatus, SourceOperation } from '@gof/core';
import { REGISTRY, sourceById, type SourceRegistry } from '@gof/config';
import { importBatch } from '../src/services/importer.ts';
import { ADMIN_TOKEN, APPROVED_PUBLISHER, APPROVED_WIKI, createHarness, floridaItem, postJson, seedApproved, seedSource, SERVICE_TOKEN, type Harness } from './harness.ts';

let h: Harness;
const TODAY = '2026-11-22';
const now = new Date(`${TODAY}T12:00:00Z`);
const call = (path: string, init: RequestInit = {}) => h.fetch(path, { ...init, now });
const importReq = (items: unknown[]) => call('/api/v1/admin/import', postJson({ items }, SERVICE_TOKEN, { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` }));
const review = (body: Record<string, unknown>) => call('/api/v1/admin/review', postJson(body, ADMIN_TOKEN, { 'x-actor': 'owner' }));
const errorsOf = async (r: { json(): Promise<unknown> }) => (((await r.json()) as { errors?: string[] }).errors ?? []).join('\n');

beforeAll(async () => {
  h = await createHarness({ APP_ENV: 'staging' });
});
afterAll(() => h.dispose());
beforeEach(() => h.reset());

const FWC_DOC = 'https://content.govdelivery.com/accounts/FLFFWCC/bulletins/3a1b2c3';
const AGENCY = 'Florida Fish and Wildlife Conservation Commission';
const DRAFT = {
  playTitle: 'Wildlife Officers Check a Cooler of Wet Towels and Find a Small Live Alligator',
  explanation:
    'Wildlife officers checking a cooler found a small live alligator under the wet towels inside it. The person was arrested on a charge of illegal possession of an American alligator; an arrest is an accusation, not proof of guilt.',
};

function facts(o: Partial<IncidentFacts> = {}): IncidentFacts {
  return {
    version: 1,
    extractor: 'fwc_weekly:rules@1',
    incidentType: 'concealed_wildlife',
    documentId: 'FLFFWCC/3a1b2c3',
    passageId: 'p2',
    evidenceUrl: FWC_DOC,
    location: { state: 'Florida', county: 'Lee', place: null, verified: true, basis: 'report_heading' },
    eventDate: { from: '2025-01-03', to: '2025-01-09', precision: 'range', basis: 'report_period' },
    participants: ['wildlife officers', 'individual'],
    objects: ['alligator', 'cooler'],
    actions: ['officers checked a cooler in the truck bed and found a small live alligator'],
    legalStage: 'arrested',
    claims: [{ id: 'c1', predicate: 'found', subject: 'officers', object: 'a small live alligator underneath several wet towels', status: 'supported', evidence: { passageId: 'p2', sentence: 2, digest: 'a'.repeat(32) } }],
    redactions: { personNames: 2, ages: 0, excludedParagraphs: 0 },
    safetyFlags: [],
    quality: {
      scores: { unusualness: 1, specificity: 0.8, entertainment: 0.9, gtaPlausibility: 0.4, factualConfidence: 1, geoConfidence: 0.95, safety: 1, sourceQuality: 0.9 },
      total: 90,
      decision: 'candidate',
      reasons: ['ALLEGATION_ONLY'],
    },
    draft: { origin: 'rules', generator: 'rules@1', frame: 'concealed_animal', problems: [] },
    signature: 'concealed_wildlife|Lee|2025-01|alligator,cooler',
    verification: 'pending',
    phaseB: { eligible: false, blockers: ['SOURCE_RIGHTS_UNREVIEWED', 'NO_AUTOMATED_APPROVAL_MODE'] },
    ...o,
  };
}

function officialItem(n = 1, o: { facts?: IncidentFacts | null; url?: string } = {}): ImportItem {
  const key = `${String(n).padStart(4, '0')}${'b'.repeat(12)}`;
  const base = floridaItem(700 + n);
  const doc = o.url ?? FWC_DOC;
  return {
    ...base,
    incidentKey: `fl:official${n}`,
    reference: {
      ...base.reference,
      provider: 'official_report',
      providerKey: `FLFFWCC/3a1b2c3#${key}`,
      originalUrl: doc,
      canonicalUrl: `${doc}#incident-${key}`,
      originalTitle: 'FWC Law Enforcement Weekly Reports: Jan. 3-9, 2025',
      publisher: AGENCY,
      publishedAt: '2025-01-15T15:05:00.000Z',
      linkCheck: { status: 'ok', httpStatus: 200, finalUrl: doc, checkedAt: '2026-11-22T11:00:00.000Z' },
    },
    incident: { ...base.incident, category: 'wildlife', floridaSignal: 'domain', floridaEvidence: 'Lee County', possibleDuplicateOfKey: null, similarity: null },
    question: { playTitleDraft: DRAFT.playTitle, explanationDraft: DRAFT.explanation, difficulty: 2 },
    ai: null,
    prefilter: { decision: 'candidate', reasonCodes: ['ALLEGATION_ONLY'] },
    ...(o.facts === null ? {} : { facts: o.facts ?? facts() }),
  };
}

/** Temporarily change the deployed registry's operations for FWC (restored after the callback). */
async function withFwcOperations(ops: Partial<Record<SourceOperation, OperationStatus>>, fn: () => Promise<void>) {
  const src = sourceById('publisher:myfwc.com')!;
  const saved = { ...src.access!.operations };
  Object.assign(src.access!.operations, ops);
  try {
    await fn();
  } finally {
    src.access!.operations = saved;
  }
}

const attest = (o: Record<string, unknown> = {}) => ({
  humanWritten: false,
  textOrigin: 'machine_draft_reviewed',
  incidentVerified: true,
  claimsVerified: true,
  privacyChecked: true,
  verifiedDate: '2025-01-09',
  verifiedLocation: 'Lee County, Florida',
  evidenceUrls: [FWC_DOC],
  ...o,
});
const approveBody = (id: string, o: Record<string, unknown> = {}) => ({
  questionId: id,
  action: 'approve',
  ...DRAFT,
  linkCheck: { status: 'ok', httpStatus: 200, finalUrl: FWC_DOC, checkedAt: '2026-11-22T11:00:00.000Z' },
  mode: 'factual_summary',
  factual: attest(),
  ...o,
});
async function importOfficial(n = 1) {
  const res = (await (await importReq([officialItem(n)])).json()) as ImportResponse;
  expect(res.results[0]).toMatchObject({ outcome: 'inserted', questionState: 'candidate' });
  return (await h.db.prepare(`SELECT q.id FROM questions q JOIN source_references sr ON sr.id = q.primary_reference_id WHERE sr.provider = 'official_report' ORDER BY q.created_at DESC`).first<{ id: string }>())!.id;
}

describe('official-report import', () => {
  it('stores the candidate with its structured facts, never approved, flagged SOURCE_ACCESS_UNRESOLVED', async () => {
    const id = await importOfficial();
    const row = await h.db
      .prepare(`SELECT q.quality_state, q.gate_reasons, inc.facts, sr.source_id, sr.original_url, sr.canonical_url FROM questions q JOIN incidents inc ON inc.id = q.incident_id JOIN source_references sr ON sr.id = q.primary_reference_id WHERE q.id = ?`)
      .bind(id)
      .first<{ quality_state: string; gate_reasons: string; facts: string; source_id: string; original_url: string; canonical_url: string }>();
    expect(row).toMatchObject({ quality_state: 'candidate', source_id: 'publisher:myfwc.com', original_url: FWC_DOC });
    expect(row!.canonical_url).toMatch(/#incident-/);
    expect(JSON.parse(row!.gate_reasons)).toContain('SOURCE_ACCESS_UNRESOLVED');
    expect(JSON.parse(row!.facts)).toMatchObject({ incidentType: 'concealed_wildlife', verification: 'pending', phaseB: { eligible: false } });
    // The admin detail view shows the facts to the reviewer; the source row is registered as unreviewed.
    const detail = await (await call(`/api/v1/admin/candidates/${id}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
    expect(detail.facts.claims[0].evidence).toMatchObject({ passageId: 'p2', sentence: 2 });
    expect(await h.db.prepare(`SELECT license_status FROM sources WHERE id = 'publisher:myfwc.com'`).first()).toEqual({ license_status: 'unreviewed' });
  });

  it('refuses facts from other providers, official items without facts, unregistered or denied sources', async () => {
    const gdelt = { ...floridaItem(1), facts: facts() };
    const unregistered = officialItem(2, { url: 'https://news.example.org/story/1' });
    unregistered.facts = facts({ evidenceUrl: 'https://news.example.org/story/1' });
    const mismatch = officialItem(3, { facts: facts({ evidenceUrl: 'https://content.govdelivery.com/accounts/FLFFWCC/bulletins/9999999' }) });
    const res = (await (await importReq([gdelt, officialItem(4, { facts: null }), unregistered, mismatch])).json()) as ImportResponse;
    expect(res.results.map((r) => r.outcome)).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
    expect(res.results.map((r) => (r.errors ?? []).join(' '))).toEqual([
      expect.stringMatching(/FACTS_NOT_ALLOWED/),
      expect.stringMatching(/FACTS_REQUIRED/),
      expect.stringMatching(/OFFICIAL_SOURCE_UNREGISTERED/),
      expect.stringMatching(/FACTS_EVIDENCE_MISMATCH/),
    ]);

    const fwc = sourceById('publisher:myfwc.com')!;
    const denied: SourceRegistry = { policyVersion: 'test-1', sources: [{ ...fwc, access: { ...fwc.access!, operations: { ...fwc.access!.operations, fetch: 'denied' } } }] };
    const [r] = await importBatch({ items: [officialItem(5)] }, { env: h.env, actorId: 't', now, draw: () => 0.5, registry: denied });
    expect(r).toMatchObject({ outcome: 'invalid', errors: [expect.stringMatching(/SOURCE_OPERATION_DENIED/)] });
  });
});

describe('official-report approval and eligibility', () => {
  it('human review cannot override unresolved source access (either mode)', async () => {
    const id = await importOfficial();
    const factual = await review(approveBody(id));
    expect(factual.status).toBe(422);
    expect(await errorsOf(factual)).toMatch(/SOURCE_ACCESS_UNRESOLVED[\s\S]*publishSummary/);
    const licensed = await review(approveBody(id, { mode: undefined, factual: undefined, locationVerified: true, publishedAt: '2025-01-09' }));
    expect(await errorsOf(licensed)).toMatch(/SOURCE_UNREVIEWED[\s\S]*SOURCE_ACCESS_UNRESOLVED/);
    expect(await h.db.prepare('SELECT quality_state FROM questions WHERE id = ?').bind(id).first()).toEqual({ quality_state: 'candidate' });
  });

  it('attests authorship truthfully: a reviewed machine draft is never "human-written"', async () => {
    await withFwcOperations({ fetch: 'allowed', extractFacts: 'allowed', publishSummary: 'allowed' }, async () => {
      const id = await importOfficial();
      expect(await errorsOf(await review(approveBody(id, { factual: attest({ humanWritten: true }) })))).toMatch(/FACTUAL_ORIGIN_CONFLICT/);
      await h.db.prepare(`UPDATE incidents SET facts = json_set(facts, '$.draft.problems', json_array('PLAY_TITLE_UNSUPPORTED: x')) WHERE id = (SELECT incident_id FROM questions WHERE id = ?)`).bind(id).run();
      expect(await errorsOf(await review(approveBody(id)))).toMatch(/MACHINE_DRAFT_INVALID/);
    });
    // A machine-draft attestation is only possible where a facts-first draft exists.
    const gdelt = floridaItem(9);
    gdelt.reference.provider = 'gdelt';
    gdelt.reference.linkCheck = null;
    await importReq([gdelt]);
    const gid = (await h.db.prepare(`SELECT q.id FROM questions q JOIN source_references sr ON sr.id = q.primary_reference_id WHERE sr.provider = 'gdelt'`).first<{ id: string }>())!.id;
    const url = (await h.db.prepare(`SELECT original_url FROM source_references WHERE provider = 'gdelt'`).first<{ original_url: string }>())!.original_url;
    expect(await errorsOf(await review(approveBody(gid, { linkCheck: { status: 'ok', httpStatus: 200, finalUrl: url, checkedAt: '2026-11-22T11:00:00.000Z' }, factual: attest({ evidenceUrls: [url], verifiedLocation: 'Ocala, Florida' }) })))).toMatch(/MACHINE_DRAFT_MISSING/);
  });

  it('once the owner clears access and a human approves: scheduled in a 3+2 round with correct attribution; a later denial pulls it', async () => {
    await withFwcOperations({ fetch: 'allowed', extractFacts: 'allowed', publishSummary: 'allowed' }, async () => {
      const id = await importOfficial();
      const ok = await review(approveBody(id));
      expect(ok.status, await ok.clone().text()).toBe(200);
      const log = await h.db.prepare(`SELECT decision, details FROM review_log WHERE entity_id = ? AND decision LIKE 'approved%'`).bind(id).first<{ decision: string; details: string }>();
      expect(log!.decision).toBe('approved:factual_summary');
      expect(JSON.parse(log!.details).factual).toMatchObject({ humanWritten: false, textOrigin: 'machine_draft_reviewed' });

      await seedOthers();
      const sched = await (await call('/api/v1/admin/schedule', postJson({ days: 1 }, SERVICE_TOKEN))).json();
      expect(sched.added).toEqual([{ date: TODAY, floridaCount: 3 }]);
      const ids = (await h.db.prepare('SELECT question_id FROM daily_round_items ORDER BY position').all<{ question_id: string }>()).results.map((r) => r.question_id);
      expect(ids).toContain(id);

      const today = await (await call('/api/challenge/today')).json();
      expect(today.questions).toHaveLength(5);
      expect(JSON.stringify(today)).not.toMatch(/govdelivery|Conservation Commission/); // nothing before answering
      const fin = await (await call(`/api/challenge/${TODAY}/finish`, postJson({ answers: today.questions.map((q: { id: string }) => ({ questionId: q.id, choice: 'FLORIDA' })) }))).json();
      const mine = fin.questions.find((q: { headline: string }) => q.headline === DRAFT.playTitle);
      expect(mine).toMatchObject({ answer: 'florida', sourceUrl: FWC_DOC, sourceName: AGENCY, sourceCta: 'Read full article', headline: DRAFT.playTitle });
      expect(mine.originalTitle).toBeUndefined();
      expect(mine.sourceUrl).not.toContain('#');

      // The owner later denies publication for the source: the round is no longer servable.
      src().access!.operations.publishSummary = 'denied';
      expect((await call('/api/challenge/today')).status).toBe(503);
    });
  });

  it('a revoked approval never reaches the scheduler', async () => {
    await withFwcOperations({ fetch: 'allowed', extractFacts: 'allowed', publishSummary: 'allowed' }, async () => {
      const id = await importOfficial();
      expect((await review(approveBody(id))).status).toBe(200);
      expect((await review({ questionId: id, action: 'revoke', reason: 'claims need another check' })).status).toBe(200);
      await seedOthers();
      const sched = await (await call('/api/v1/admin/schedule', postJson({ days: 1 }, SERVICE_TOKEN))).json();
      const added = (await h.db.prepare('SELECT question_id FROM daily_round_items').all<{ question_id: string }>()).results.map((r) => r.question_id);
      expect(added).not.toContain(id);
      expect(sched.added.every((d: { floridaCount: number }) => d.floridaCount === 2 || d.floridaCount === 3)).toBe(true);
    });
  });
});

const src = () => sourceById('publisher:myfwc.com')!;
void REGISTRY;

/** Two licensed Florida + two GTA questions, so a 3+2 round needs the official question. */
async function seedOthers() {
  await seedSource(h.db, APPROVED_PUBLISHER);
  await seedSource(h.db, APPROVED_WIKI);
  for (let i = 0; i < 2; i++) await seedApproved(h.db, 'FLORIDA');
  for (let i = 0; i < 2; i++) await seedApproved(h.db, 'GTA');
}
