/**
 * FWC Division of Law Enforcement weekly reports (GovDelivery bulletins, account FLFFWCC).
 *
 * Structure (verified 2026-11-24 on seven bulletins from 2024-2025): `h1.bulletin_subject`, a
 * "sent this bulletin at MM/DD/YYYY hh:mm AM EST" dateline, a reporting-period heading, then per
 * region a banner image (alt "Northwest Region"), section headings in capitals ("CASES",
 * "SEARCH AND RESCUE", …), county headings ("Monroe County") and one `<li>` (sometimes `<p>`) per
 * incident. ONE bulletin therefore yields MANY independent incidents, each its own passage.
 *
 * The weekly reports ended in March 2025: this adapter serves historical, owner-supplied URLs.
 * It never crawls GovDelivery and never reads images.
 */
import { floridaCounty, htmlText, OfficialParseError, parseLongDate, monthNumber, ymd, type OfficialAdapter, type OfficialDocument, type OfficialPassage } from './official-document.ts';

const BULLETIN_PATH = /^\/accounts\/FLFFWCC\/bulletins\/([0-9a-f]{5,12})\/?$/i;
const FOOTER = /wildlife alert|dle regions|granicus|powered by/i;
const MIN_PASSAGE = 40;

function sentAt(html: string): string | null {
  const m = /sent this bulletin at (\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) (AM|PM) (EST|EDT)/.exec(html);
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (m[6] === 'PM') hour += 12;
  const offset = m[7] === 'EDT' ? 4 : 5;
  const t = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour + offset, Number(m[5]));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** "FWC Law Enforcement Weekly Reports: Feb. 23-29" (+ year from the send date) or "Jan. 31-Feb. 6, 2025". */
function periodFromSubject(subject: string, sent: string | null): { from: string | null; to: string | null } {
  const m = /([A-Z][a-z]{2,8})\.?\s+(\d{1,2})\s*[-–]\s*(?:([A-Z][a-z]{2,8})\.?\s+)?(\d{1,2})(?:,\s*(\d{4}))?/.exec(subject);
  if (!m) return { from: null, to: null };
  const m1 = monthNumber(m[1]!);
  const m2 = m[3] ? monthNumber(m[3]) : m1;
  if (!m1 || !m2) return { from: null, to: null };
  let year = m[5] ? Number(m[5]) : sent ? Number(sent.slice(0, 4)) : null;
  if (!year) return { from: null, to: null };
  // A report sent in early January about late December belongs to the previous year.
  if (!m[5] && sent && m2 > Number(sent.slice(5, 7))) year -= 1;
  const fromYear = m1 > m2 ? year - 1 : year;
  return { from: ymd(fromYear, m1, Number(m[2])), to: ymd(year, m2, Number(m[4])) };
}

export function parseFwcBulletin(html: string, url: URL): OfficialDocument {
  const idMatch = BULLETIN_PATH.exec(url.pathname);
  if (url.hostname !== 'content.govdelivery.com' || !idMatch) throw new OfficialParseError('not an FWC GovDelivery bulletin URL');
  const subject = htmlText(/<h1 class=['"]bulletin_subject['"]>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '');
  if (!/weekly report/i.test(subject)) throw new OfficialParseError(`bulletin is not a law enforcement weekly report (subject: ${subject.slice(0, 80)})`);
  const bodyStart = html.search(/id=['"]bulletin_body['"]/);
  if (bodyStart < 0) throw new OfficialParseError('bulletin body not found');
  const body = html.slice(bodyStart);
  const published = sentAt(html);

  let period = periodFromSubject(subject, published);
  const passages: OfficialPassage[] = [];
  let region: string | null = null;
  let section: string | null = null;
  let heading: string | null = null;
  let excluded = 0;
  let done = false;
  const token = /<img\b[^>]*\balt="([^"]*)"[^>]*>|<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>|<li\b[^>]*>([\s\S]*?)<\/li>|<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  for (const m of body.matchAll(token)) {
    if (done) break;
    if (m[1] !== undefined) {
      const alt = htmlText(m[1]);
      if (FOOTER.test(alt)) done = true;
      else if (/\bregion\b/i.test(alt)) {
        region = alt;
        section = null;
        heading = null;
      }
      continue;
    }
    if (m[2] !== undefined) {
      const h = htmlText(m[2]);
      const range = /^(.+?\d{4}),?\s+through\s+(.+?\d{4})$/i.exec(h);
      if (range) {
        const from = parseLongDate(range[1]!);
        const to = parseLongDate(range[2]!);
        if (from && to) period = { from, to };
      } else if (/\bcounty$/i.test(h)) heading = h;
      else if (h.length > 3 && h === h.toUpperCase() && /[A-Z]/.test(h)) {
        section = h;
        heading = null;
      }
      continue;
    }
    const text = htmlText((m[3] ?? m[4])!);
    if (!text) continue;
    if (/^patrol, protect, preserve$/i.test(text)) {
      done = true;
      continue;
    }
    if (!region || !heading) {
      // Intro, notices and anything not filed under a region + county heading is not an incident.
      if (region) excluded++;
      continue;
    }
    if (text.length < MIN_PASSAGE) {
      excluded++;
      continue;
    }
    passages.push({ id: `p${passages.length + 1}`, heading, section, region, text: text.slice(0, 4000) });
    if (passages.length >= 200) break;
  }
  if (passages.length === 0) throw new OfficialParseError('no incident paragraphs found under county headings');

  return {
    adapterId: 'fwc_weekly',
    sourceId: 'publisher:myfwc.com',
    documentId: `FLFFWCC/${idMatch[1]!.toLowerCase()}`,
    url: `https://content.govdelivery.com/accounts/FLFFWCC/bulletins/${idMatch[1]!.toLowerCase()}`,
    title: subject,
    publishedAt: published,
    period,
    eventDate: null,
    passages,
    excludedParagraphs: excluded,
    agency: {
      name: 'Florida Fish and Wildlife Conservation Commission',
      reference: 'the Florida Fish and Wildlife Conservation Commission',
      actors: 'wildlife officers',
      documentLabel: 'weekly law enforcement report',
      county: null,
    },
  };
}

export const fwcAdapter: OfficialAdapter = {
  id: 'fwc_weekly',
  sourceId: 'publisher:myfwc.com',
  discovery: 'explicit_urls',
  matches: (url) => url.hostname === 'content.govdelivery.com' && BULLETIN_PATH.test(url.pathname),
  documentId: (url) => `FLFFWCC/${(BULLETIN_PATH.exec(url.pathname)?.[1] ?? '').toLowerCase()}`,
  parse: (html, url) => parseFwcBulletin(html, url),
};

export { floridaCounty };
