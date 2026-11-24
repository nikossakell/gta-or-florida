/**
 * "Florida Man API" — https://github.com/juliayxhuang/florida-man-api (verified 2026-11-23).
 *
 *   Static JSON on GitHub Pages: /api/{MM}/{DD}.json (one calendar day, all years), /api/index.json.
 *   ~10,000 headlines dated 2021-04-10 … 2026-04-24, "updated occasionally" — a historical backlog,
 *   not a live stream. Day files are ~18 KB (the 3.6 MB full file would not fit a 10 ms Workers step).
 *
 * Licensing: the repository is MIT-licensed, but the README says the dataset "is intended for personal,
 * educational, and non-commercial use", and its headlines were scraped from third-party publishers whose
 * rights neither license can grant. So this is a DISCOVERY INDEX for staging/development only: every item
 * keeps its original publisher URL and resolves to that publisher's (unreviewed) source policy. Nothing
 * from here can be published unless the owner separately approves that publisher's rights.
 */
import { cleanText } from '@gof/core';

export const DATASET_BASE = 'https://juliayxhuang.github.io/florida-man-api/api';
export const DATASET_PROVENANCE =
  'Discovered via the "Florida Man API" dataset (github.com/juliayxhuang/florida-man-api; MIT repo, dataset intended for personal/educational/non-commercial use). Staging/development only; headline rights belong to the original publisher.';

/** All 366 calendar days in order (MM/DD), the dataset's file layout. */
export const DATASET_DAYS: readonly string[] = (() => {
  const out: string[] = [];
  const lengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  lengths.forEach((n, m) => {
    for (let d = 1; d <= n; d++) out.push(`${String(m + 1).padStart(2, '0')}/${String(d).padStart(2, '0')}`);
  });
  return out;
})();

export const datasetDayUrl = (day: string) => `${DATASET_BASE}/${day}.json`;

export type DatasetHeadline = { title: string; url: string; source: string; date: string };

/** Validate one day file (untrusted JSON): https URLs, ISO dates, bounded sizes; malformed rows are skipped. */
export function parseDatasetDay(body: unknown, maxRows = 120): DatasetHeadline[] {
  if (!Array.isArray(body)) throw new Error('dataset day file is not an array');
  const out: DatasetHeadline[] = [];
  for (const raw of body.slice(0, maxRows)) {
    const r = raw as Record<string, unknown>;
    const title = cleanText(r?.title, 400);
    const url = typeof r?.url === 'string' ? r.url.trim().slice(0, 2048) : '';
    const date = typeof r?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : '';
    if (!title || !/^https:\/\//.test(url) || !date) continue;
    out.push({ title, url, source: cleanText(r?.source, 120), date });
  }
  return out;
}
