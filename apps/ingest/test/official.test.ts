import { describe, expect, it } from 'vitest';
import { importItemSchema, parse, type SourcePolicy } from '@gof/core';
import { sourceById, sourceForUrl } from '@gof/config';
import { parseFwcBulletin } from '../src/adapters/fwc.ts';
import { parseFlaglerRelease } from '../src/adapters/flagler.ts';
import { adapterForUrl, evaluateDocument, fetchVerdict, findPersonalData, legalStageOf, possibleDuplicate, splitSentences, toDiscovered } from '../src/official.ts';
import { buildImportItem, emptyStats, planCandidates } from '../src/pipeline.ts';
import { FLAGLER_HEADLINE, FLAGLER_RELEASE, FLAGLER_URL, FWC_BULLETIN, FWC_URL } from './official-fixtures.ts';

const NOW = new Date('2026-11-24T12:00:00Z');
const fwcSource = sourceForUrl(FWC_URL);
const flaglerSource = sourceForUrl(FLAGLER_URL);
const fwc = () => evaluateDocument(parseFwcBulletin(FWC_BULLETIN, new URL(FWC_URL)), { source: fwcSource });
const flagler = () => evaluateDocument(parseFlaglerRelease(FLAGLER_RELEASE, new URL(FLAGLER_URL), NOW), { source: flaglerSource });

describe('FWC weekly report extraction', () => {
  it('splits ONE bulletin into independent incidents under their county headings', () => {
    const doc = parseFwcBulletin(FWC_BULLETIN, new URL(FWC_URL));
    expect(doc.documentId).toBe('FLFFWCC/3a1b2c3');
    expect(doc.passages.map((p) => p.heading)).toEqual(['Gulf County', 'Lee County', 'Lee County', 'Broward County', 'Broward County']);
    expect(doc.period).toEqual({ from: '2025-01-03', to: '2025-01-09' });
    expect(doc.publishedAt).toBe('2025-01-15T15:05:00.000Z');
    // Intro text and the footer are not incidents.
    expect(doc.passages.some((p) => /Patrol, Protect|represents some events/.test(p.text))).toBe(false);
    expect(new Set(fwc().incidents.map((i) => i.providerKey)).size).toBe(5);
  });

  it('rejects the routine fishing-licence violation and the unsafe incidents; keeps the unusual wildlife cases for review', () => {
    const by = Object.fromEntries(fwc().incidents.map((i) => [i.passage.id, i]));
    expect(by.p1).toMatchObject({ decision: 'reject', reasons: expect.arrayContaining(['ROUTINE_ENFORCEMENT']) });
    expect(by.p3).toMatchObject({ decision: 'reject', reasons: expect.arrayContaining(['DEATH_OR_SERIOUS_INJURY']) });
    expect(by.p5).toMatchObject({ decision: 'reject', reasons: expect.arrayContaining(['MINOR_INVOLVED']) });
    expect(by.p2!.decision).toBe('candidate');
    expect(by.p2!.facts).toMatchObject({ incidentType: 'concealed_wildlife', legalStage: 'arrested', location: { state: 'Florida', county: 'Lee', verified: true, basis: 'report_heading' } });
    expect(by.p2!.facts.quality.total).toBeGreaterThan(by.p1!.facts.quality.total);
    expect(by.p4!.decision).toBe('candidate');
    expect(by.p4!.facts.incidentType).toBe('escaped_captive_wildlife');
    expect(by.p4!.facts.legalStage).toBe('cited');
  });

  it('keeps claim-level evidence references (passage, sentence, digest) and no source text or names', () => {
    const inc = fwc().incidents.find((i) => i.passage.id === 'p2')!;
    expect(inc.facts.evidenceUrl).toBe('https://content.govdelivery.com/accounts/FLFFWCC/bulletins/3a1b2c3');
    expect(inc.facts.claims.length).toBeGreaterThanOrEqual(3);
    for (const c of inc.facts.claims) {
      expect(c.evidence.passageId).toBe('p2');
      expect(c.evidence.digest).toMatch(/^[a-f0-9]{32}$/);
      expect(['supported', 'uncertain', 'disputed']).toContain(c.status);
    }
    const stored = JSON.stringify(inc.facts);
    expect(stored).not.toMatch(/Sample|Testman/);
    expect(stored).not.toContain('The driver said he planned to keep it');
    expect(inc.facts.redactions.personNames).toBeGreaterThanOrEqual(2);
  });
});

describe('Flagler County Sheriff release extraction', () => {
  it('extracts the single incident without inventing claims and preserves the allegation status', () => {
    const [inc] = flagler().incidents;
    expect(inc!.facts).toMatchObject({ incidentType: 'costumed_robbery', legalStage: 'arrested', eventDate: { from: '2026-11-07', precision: 'day', basis: 'stated_in_text' } });
    expect(inc!.facts.claims.some((c) => c.status === 'disputed')).toBe(true); // "denied being at the store"
    expect(inc!.facts.draft!.problems).toEqual([]);
    // Nothing the release does not say (no stolen vehicle, no weapon found, no conviction).
    expect(`${inc!.draft!.playTitle} ${inc!.draft!.explanation}`).not.toMatch(/stolen|SUV|gun|convicted|guilty of/i);
    expect(inc!.draft!.explanation).toMatch(/accusation, not proof of guilt/);
  });

  it('excludes personal data, the mugshot caption, the sheriff quote and prior arrests', () => {
    const doc = parseFlaglerRelease(FLAGLER_RELEASE, new URL(FLAGLER_URL), NOW);
    expect(doc.excludedParagraphs).toBeGreaterThanOrEqual(4);
    expect(doc.passages[0]!.text).not.toMatch(/booking photo|invisible|previous arrests|burglary/);
    const [inc] = flagler().incidents;
    const everything = `${inc!.draft!.playTitle} ${inc!.draft!.explanation} ${JSON.stringify(inc!.facts)}`;
    expect(everything).not.toMatch(/Jordan|Testcase|Sample|Daytona|\b34\b|booking\.jpeg|wp-content/);
    expect(findPersonalData(doc.passages[0]!.text)).toMatchObject({ names: expect.arrayContaining(['Jordan', 'Testcase', 'Sample']), ages: [34] });
  });

  it('sends a serious threat (robbery with an implied weapon) to safety review, never straight to the queue', () => {
    const [inc] = flagler().incidents;
    expect(inc!.decision).toBe('safety_review');
    expect(inc!.reasons).toEqual(expect.arrayContaining(['SERIOUS_THREAT', 'ALLEGATION_ONLY', 'DISPUTED_CLAIM']));
    expect(inc!.facts.phaseB).toMatchObject({ eligible: false, blockers: expect.arrayContaining(['SOURCE_RIGHTS_UNREVIEWED', 'NO_AUTOMATED_APPROVAL_MODE', 'CRIMINAL_ALLEGATION']) });
  });
});

describe('facts-first drafts', () => {
  it('builds titles from the facts, not from the headline, without leaking the answer', () => {
    const [inc] = flagler().incidents;
    const title = inc!.draft!.playTitle;
    expect(title).not.toMatch(/Bunnell|Flagler|Florida|Sheriff|Robber/i);
    expect(title.toLowerCase()).not.toBe(FLAGLER_HEADLINE.toLowerCase());
    const gator = fwc().incidents.find((i) => i.passage.id === 'p2')!;
    expect(gator.draft!.playTitle).toBe('Wildlife Officers Check a Cooler of Wet Towels and Find a Small Live Alligator');
    expect(gator.draft!.playTitle).not.toMatch(/Lee|County|FWC/);
    // The explanation (shown after answering) may reveal Florida and the source.
    expect(gator.draft!.explanation).toMatch(/Florida Fish and Wildlife Conservation Commission .* Lee County, Florida\.$/);
  });

  it('no frame → no machine draft: a human writes the text', () => {
    const odd = 'Officers received reports of a man disguised in a bear costume who was feeding marshmallows to wild raccoons behind a shopping center. The officers explained the feeding rules and he agreed to stop.';
    const doc = parseFwcBulletin(FWC_BULLETIN.replace(/Officers responded to a boating crash[^<]*/, odd), new URL(FWC_URL));
    const inc = evaluateDocument(doc, { source: fwcSource }).incidents.find((i) => i.passage.id === 'p3')!;
    expect(inc.draft).toBeNull();
    expect(inc.decision).toBe('candidate');
    expect(inc.reasons).toContain('DRAFT_REQUIRED');
  });

  it('keeps whole noun phrases, and refuses a frame draft that ends up replaying the source sentence', () => {
    const doc = parseFwcBulletin(FWC_BULLETIN.replace(/Officers responded to a boating crash[^<]*/, 'Officers found a large python inside a stolen golf cart parked at a marina. The owner had reported the golf cart missing.'), new URL(FWC_URL));
    const inc = evaluateDocument(doc, { source: fwcSource }).incidents.find((i) => i.passage.id === 'p3')!;
    expect(inc.draft?.playTitle).toBe('Wildlife Officers Find a Large Python Inside a Stolen Golf Cart');
    // The source sentence is almost the same words: not original → not offered as a draft; a human writes it.
    expect(inc.facts.draft?.problems.map((p) => p.split(':')[0])).toEqual(expect.arrayContaining(['PLAY_TITLE_SOURCE_PHRASE']));
    expect(inc.reasons).toContain('DRAFT_INVALID');
    expect(toDiscovered(doc, inc, NOW.toISOString()).draft).toBeNull();
  });

  it('splits sentences without breaking on abbreviations and initials', () => {
    expect(splitSentences('Lt. Warne and Officer T. Nelson arrived at 4:30 a.m. near St. Augustine. The subject left.')).toHaveLength(2);
    expect(legalStageOf('The subject was arrested and transported to jail.')).toBe('arrested');
    expect(legalStageOf('The operator received a citation.')).toBe('cited');
  });
});

describe('into the shared pipeline', () => {
  it('produces contract-valid import items: per-incident canonical URL, document link, facts, no media', () => {
    const ev = fwc();
    const doc = ev.doc;
    const keep = ev.incidents.filter((i) => i.decision !== 'reject');
    const discovered = keep.map((i) => toDiscovered(doc, i, NOW.toISOString()));
    const planned = planCandidates(discovered, { canonicalUrls: [], providerKeys: [] }, [], emptyStats(discovered.length));
    expect(planned).toHaveLength(2); // two incidents of ONE document are not deduplicated against each other
    for (const p of planned) {
      const item = buildImportItem(p);
      expect(parse(importItemSchema, item).ok).toBe(true);
      expect(item.reference.provider).toBe('official_report');
      expect(item.reference.originalUrl).toBe(doc.url);
      expect(item.reference.canonicalUrl).toMatch(/^https:\/\/content\.govdelivery\.com\/accounts\/FLFFWCC\/bulletins\/3a1b2c3#incident-[a-f0-9]{16}$/);
      expect(item.reference.publisher).toBe('Florida Fish and Wildlife Conservation Commission');
      expect(item.facts?.evidenceUrl).toBe(doc.url);
      expect(item.ai).toBeNull();
      expect(JSON.stringify(item)).not.toMatch(/\.jpe?g|\.png|fancy_images/);
    }
    expect(new Set(planned.map((p) => p.d.canonicalUrl)).size).toBe(2);
  });

  it('flags the same incident reported elsewhere (synonyms, different wording) for review instead of dropping it', () => {
    const inc = fwc().incidents.find((i) => i.passage.id === 'p2')!;
    const dup = possibleDuplicate(inc, [], [{ incidentKey: 'fl:other', title: 'Deputies find baby gator stuffed in a cooler', seenAt: '2025-01-12T00:00:00Z' }], '2025-01-09');
    expect(dup).toMatchObject({ key: 'fl:other' });
    const unrelated = possibleDuplicate(inc, [], [{ incidentKey: 'fl:x', title: 'Alligator crosses a golf course', seenAt: '2025-01-12T00:00:00Z' }], '2025-01-09');
    expect(unrelated).toBeNull();
    const muchLater = possibleDuplicate(inc, [], [{ incidentKey: 'fl:y', title: 'Deputies find baby gator stuffed in a cooler', seenAt: '2026-06-01T00:00:00Z' }], '2025-01-09');
    expect(muchLater).toBeNull();
  });
});

describe('access verdicts (rights stay with the owner)', () => {
  const allowed = (src: SourcePolicy): SourcePolicy => ({
    ...src,
    access: { ...src.access!, acquisition: 'listing_page', operations: Object.fromEntries(Object.keys({ discover: 1, fetch: 1, extractFacts: 1, publishSummary: 1 }).map((k) => [k, 'allowed'])), reviewedBy: 'o', reviewedAt: '2026-11-24', basis: ['https://x.example/terms'] },
  });

  it('pilot: explicit owner URLs may be evaluated while access is unknown; candidates stay in review', () => {
    const v = fetchVerdict(fwcSource, 'pilot');
    expect(v.allowed).toBe(true);
    expect(v.warnings.join('\n')).toMatch(/publishSummary has not been cleared[\s\S]*stay in review/);
  });

  it('automated runs need discover + fetch + extractFacts cleared and an automated acquisition method', () => {
    expect(fetchVerdict(fwcSource, 'automated').allowed).toBe(false);
    expect(fetchVerdict(allowed(fwcSource), 'automated').allowed).toBe(true);
    expect(fetchVerdict({ ...allowed(fwcSource), access: { ...allowed(fwcSource).access!, acquisition: 'explicit_urls' } }, 'automated').problems.join()).toMatch(/ACQUISITION_NOT_AUTOMATED/);
  });

  it('blocked sources and denied fetch are refused in every mode', () => {
    expect(fetchVerdict({ ...fwcSource, licenseStatus: 'blocked' }, 'pilot').problems.join()).toMatch(/SOURCE_BLOCKED/);
    expect(fetchVerdict({ ...fwcSource, access: { ...fwcSource.access!, operations: { fetch: 'denied' } } }, 'pilot').problems.join()).toMatch(/SOURCE_OPERATION_DENIED/);
    expect(fetchVerdict(sourceById('publisher:theonion.com')!, 'pilot').allowed).toBe(false);
  });

  it('only registered official adapters handle official URLs', () => {
    expect(adapterForUrl(new URL(FWC_URL))?.id).toBe('fwc_weekly');
    expect(adapterForUrl(new URL('https://content.govdelivery.com/accounts/OTHER/bulletins/1'))).toBeNull();
    expect(adapterForUrl(new URL('https://flaglersheriff.com/contact-us/records/'))).toBeNull();
  });
});
