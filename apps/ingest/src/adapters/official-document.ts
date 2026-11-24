/**
 * Shared model for official incident publications (agency reports, sheriff news releases).
 *
 * An adapter turns ONE fetched document into passages — one per independent incident — plus the
 * document's own metadata. Parsing is pure (no I/O), runtime-neutral and bounded, so the same code
 * runs in the Node CLI and in the Cloudflare Workflow.
 *
 * Passages are held in memory only. What leaves the process is the structured facts record
 * (roles, normalized actions, claim → passage/sentence/digest references), never the source text.
 */
import type { AcquisitionMethod } from '@gof/core';
import { decode } from './rss.ts';

export type OfficialPassage = {
  /** Stable within the document ("p7"). */
  id: string;
  /** Verbatim county heading ("Monroe County") when the document groups incidents by county. */
  heading: string | null;
  /** Report section ("CASES", "SEARCH AND RESCUE", …) when present. */
  section: string | null;
  region: string | null;
  text: string;
};

export type OfficialDocument = {
  adapterId: string;
  sourceId: string;
  /** Stable document identity, e.g. "FLFFWCC/3d0b75e". */
  documentId: string;
  /** Document URL without query or fragment (what players are linked to). */
  url: string;
  /** Document title / headline. Internal only (copy and paraphrase checks); never displayed. */
  title: string;
  /** ISO publication timestamp, when the document states one. */
  publishedAt: string | null;
  /** Reporting period covered (weekly reports) as YYYY-MM-DD. */
  period: { from: string | null; to: string | null };
  /** Date stated for a single-incident release ("Oct. 31" → YYYY-MM-DD), when unambiguous. */
  eventDate: string | null;
  passages: OfficialPassage[];
  /** Paragraphs deliberately not used (quotes, mugshot captions, prior arrests, boilerplate). */
  excludedParagraphs: number;
  agency: {
    name: string;
    /** Used in explanations: "the Florida Fish and Wildlife Conservation Commission". */
    reference: string;
    /** Who acts in the report ("wildlife officers", "deputies"). */
    actors: string;
    /** "weekly law enforcement report", "news release". */
    documentLabel: string;
    /** County the agency covers (sheriffs), null for statewide agencies. */
    county: string | null;
  };
};

export interface OfficialAdapter {
  id: string;
  sourceId: string;
  /** How unattended runs would discover documents once the owner allows it (none is implemented as a crawler). */
  discovery: AcquisitionMethod;
  matches(url: URL): boolean;
  /** Stable document identity from the URL alone (checkpoint key before fetching). */
  documentId(url: URL): string;
  parse(html: string, url: URL, now: Date): OfficialDocument;
}

export class OfficialParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficialParseError';
  }
}

/** Plain text of an HTML fragment: tags removed, entities decoded, whitespace collapsed. */
export function htmlText(fragment: string): string {
  return decode(fragment.replace(/<br\s*\/?>/gi, ' ')).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export function monthNumber(name: string): number | null {
  return MONTHS[name.toLowerCase().replace(/\.$/, '')] ?? null;
}

export function ymd(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/** "January 31, 2025" / "Jan. 31, 2025" → 2025-01-31. */
export function parseLongDate(text: string): string | null {
  const m = /\b([A-Z][a-z]{2,8})\.?\s+(\d{1,2}),\s*(\d{4})\b/.exec(text);
  if (!m) return null;
  const month = monthNumber(m[1]!);
  return month ? ymd(Number(m[3]), month, Number(m[2])) : null;
}

/** Florida's 67 counties (geographic verification of report headings). */
export const FLORIDA_COUNTIES = [
  'Alachua', 'Baker', 'Bay', 'Bradford', 'Brevard', 'Broward', 'Calhoun', 'Charlotte', 'Citrus', 'Clay', 'Collier', 'Columbia', 'DeSoto',
  'Dixie', 'Duval', 'Escambia', 'Flagler', 'Franklin', 'Gadsden', 'Gilchrist', 'Glades', 'Gulf', 'Hamilton', 'Hardee', 'Hendry', 'Hernando',
  'Highlands', 'Hillsborough', 'Holmes', 'Indian River', 'Jackson', 'Jefferson', 'Lafayette', 'Lake', 'Lee', 'Leon', 'Levy', 'Liberty',
  'Madison', 'Manatee', 'Marion', 'Martin', 'Miami-Dade', 'Monroe', 'Nassau', 'Okaloosa', 'Okeechobee', 'Orange', 'Osceola', 'Palm Beach',
  'Pasco', 'Pinellas', 'Polk', 'Putnam', 'St. Johns', 'St. Lucie', 'Santa Rosa', 'Sarasota', 'Seminole', 'Sumter', 'Suwannee', 'Taylor',
  'Union', 'Volusia', 'Wakulla', 'Walton', 'Washington',
] as const;

/** "Monroe County" → "Monroe" when it is a real Florida county; null otherwise (typos are not guessed). */
export function floridaCounty(heading: string | null): string | null {
  if (!heading) return null;
  const m = /^(.+?)\s+County$/i.exec(heading.trim());
  if (!m) return null;
  const name = m[1]!.trim().toLowerCase();
  return FLORIDA_COUNTIES.find((c) => c.toLowerCase() === name || c.toLowerCase().replace(/\./g, '') === name.replace(/\./g, '')) ?? null;
}
