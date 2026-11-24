/**
 * Flagler County Sheriff's Office news releases (flaglersheriff.com/news/<slug>/).
 *
 * Structure (verified 2026-11-24): WordPress page; inside <main> a "NEWS RELEASE" label, the headline
 * (h1), a "Date:Monday, November 2, 2026" line, the release paragraphs, a mugshot caption, a
 * "Prepared By / Release #" list. One release = one incident (a single passage).
 *
 * Deliberately NOT used: quotes from officials (opinion, not facts), mugshot/photo captions, prior
 * arrest histories, contact boilerplate, and every image (og:image is a mugshot). Commander's Reports
 * and records pages are raw police records and are not handled by this adapter.
 */
import { htmlText, monthNumber, OfficialParseError, parseLongDate, ymd, type OfficialAdapter, type OfficialDocument } from './official-document.ts';

const RELEASE_PATH = /^\/news\/[a-z0-9-]{3,200}\/?$/;

/** Paragraphs never used as evidence (and why). */
const EXCLUDE: [reason: string, re: RegExp][] = [
  ['label', /^news release$/i],
  ['dateline', /^date:/i],
  ['photo_caption', /\b(mugshot|booking photo|photo courtesy|pictured)\b/i],
  ['prior_record', /\b(previous|prior) (arrests?|convictions?|charges)\b|\bcriminal history\b/i],
  ['quote', /^[“"]|[”"]\s*,?\s*said\b|\bsaid sheriff\b/i],
  ['boilerplate', /\b(public records law|do not report crimes|follow us|crime ?stoppers|anonymous tip|call \d{3})\b/i],
];

export function parseFlaglerRelease(html: string, url: URL, now: Date = new Date()): OfficialDocument {
  if (url.hostname.replace(/^www\./, '') !== 'flaglersheriff.com' || !RELEASE_PATH.test(url.pathname)) throw new OfficialParseError('not a Flagler County Sheriff news release URL');
  const mainStart = html.search(/<main\b/i);
  if (mainStart < 0) throw new OfficialParseError('page has no <main> element');
  const main = html.slice(mainStart, Math.max(html.search(/<\/main>/i), mainStart));
  const content = main.slice(Math.max(0, main.search(/entry-content/i)));
  const h1 = htmlText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1] ?? '');
  if (h1.length < 10) throw new OfficialParseError('release headline not found');

  const paragraphs = [...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => htmlText(m[1]!)).filter(Boolean);
  // The release ends at the "Prepared By" list; everything after is site chrome.
  const endIdx = content.search(/Prepared By/i);
  const inRelease = endIdx >= 0 ? [...content.slice(0, endIdx).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => htmlText(m[1]!)).filter(Boolean) : paragraphs;

  let published: string | null = null;
  const kept: string[] = [];
  let excluded = 0;
  for (const p of inRelease) {
    if (/^date:/i.test(p)) published ??= parseLongDate(p);
    const why = EXCLUDE.find(([, re]) => re.test(p));
    if (why) {
      excluded++;
      continue;
    }
    if (p.length < 25) {
      excluded++;
      continue;
    }
    kept.push(p);
  }
  if (kept.length === 0) throw new OfficialParseError('release has no usable paragraphs');
  const text = kept.join(' ').slice(0, 6000);

  // The incident date when the release states "on Oct. 31" (year from the release date; never guessed otherwise).
  let eventDate: string | null = null;
  const pubYear = published ? Number(published.slice(0, 4)) : now.getUTCFullYear();
  const d = /\bon (?:[A-Z][a-z]+day,? )?([A-Z][a-z]{2,8})\.? (\d{1,2})\b(?!,? \d{4})/.exec(text);
  const month = d ? monthNumber(d[1]!) : null;
  if (d && month) {
    eventDate = ymd(pubYear, month, Number(d[2]));
    if (eventDate && published && eventDate > published) eventDate = ymd(pubYear - 1, month, Number(d[2]));
  }
  const slug = url.pathname.replace(/^\/news\//, '').replace(/\/$/, '');
  return {
    adapterId: 'flagler_release',
    sourceId: 'publisher:flaglersheriff.com',
    documentId: `flaglersheriff/${slug}`.slice(0, 160),
    url: `https://flaglersheriff.com/news/${slug}/`,
    title: h1,
    publishedAt: published ? `${published}T12:00:00.000Z` : null,
    period: { from: null, to: null },
    eventDate,
    passages: [{ id: 'p1', heading: null, section: null, region: null, text }],
    excludedParagraphs: excluded,
    agency: {
      name: "Flagler County Sheriff's Office",
      reference: "the Flagler County Sheriff's Office",
      actors: 'deputies',
      documentLabel: 'news release',
      county: 'Flagler',
    },
  };
}

export const flaglerAdapter: OfficialAdapter = {
  id: 'flagler_release',
  sourceId: 'publisher:flaglersheriff.com',
  discovery: 'explicit_urls',
  matches: (url) => url.hostname.replace(/^www\./, '') === 'flaglersheriff.com' && RELEASE_PATH.test(url.pathname),
  documentId: (url) => `flaglersheriff/${url.pathname.replace(/^\/news\//, '').replace(/\/$/, '')}`.slice(0, 160),
  parse: (html, url, now) => parseFlaglerRelease(html, url, now),
};
