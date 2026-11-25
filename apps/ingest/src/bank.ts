/**
 * Curated question bank batches: periodic, human-researched content collection
 * (Discover → Verify → Draft → [this file: validate + store as candidates] → Review → Approve → Schedule).
 *
 * A batch is a JSON file of drafts written in ORIGINAL wording from verified facts (see
 * docs/question-bank.md). Validation runs offline. Valid drafts are sent through the Worker's normal,
 * authenticated /import as `manual` submissions, which the Worker always routes to a human
 * (MANUAL_SUBMISSION). Nothing here approves, schedules or fetches anything.
 */
import { explanationProblems, nearCopyProblems, placeholderProblems, playTitleProblems, titleFingerprint, canonicalizeUrl } from '@gof/core';
import { sourceForUrl } from '@gof/config';
import { articleUrlProblem } from './adapters/article.ts';
import type { BankFile } from './bank-item.ts';
import type { SourcesConfig } from './normalize.ts';

export * from './bank-item.ts';

export type EntryReport = { index: number; eventId: string; headline: string; problems: string[]; warnings: string[] };

/** Offline checks for every entry; problems block the entry, warnings are for the reviewer. */
export function validateBank(file: BankFile, cfg: Pick<SourcesConfig, 'domains'>): EntryReport[] {
  const fixture = file.fixture === true;
  const reports: EntryReport[] = [];
  const originOf = new Map<string, string>();
  const seenFp = new Map<string, number>();
  file.questions.forEach((e, index) => {
    const problems: string[] = [];
    const warnings: string[] = [];
    const headline = e.headline.trim();
    const explanation = e.explanation.trim();

    // Original wording, no giveaways, not a copy of the source headline.
    problems.push(...playTitleProblems(headline, { originalTitle: e.sourceTitle, exactTitleAllowed: false }));
    problems.push(...nearCopyProblems(headline, e.sourceTitle, 'PLAY_TITLE'));
    problems.push(...explanationProblems(explanation));
    problems.push(...nearCopyProblems(explanation, e.sourceTitle, 'EXPLANATION'));
    if (!fixture) problems.push(...placeholderProblems(headline, 'PLAY_TITLE'), ...placeholderProblems(explanation, 'EXPLANATION'));

    // Source: https, not blocked, the right kind of source for the answer.
    let url: URL | null = null;
    try {
      url = new URL(e.sourceUrl);
    } catch {
      problems.push('SOURCE_URL_INVALID: not a URL');
    }
    if (url && url.protocol !== 'https:') problems.push('SOURCE_URL_NOT_HTTPS: use the https URL of the source page');
    else if (url && !fixture) {
      if (canonicalizeUrl(url.href) === null) problems.push('SOURCE_URL_INVALID: cannot be canonicalised');
      if (e.origin === 'FLORIDA') {
        const p = articleUrlProblem(url.href, cfg);
        if (p) problems.push(`SOURCE_REFUSED: ${p}`);
      } else {
        const src = sourceForUrl(url.href);
        if (src.licenseStatus === 'blocked') problems.push(`SOURCE_REFUSED: ${src.id} is blocked by the owner's source policy`);
        else if (src.type !== 'gta_wiki') problems.push(`SOURCE_KIND: GTA questions need a registered GTA reference source (Grand Theft Wiki, Rockstar Games, GTA Base); ${url.hostname} is not one`);
      }
    }

    // Origin-specific facts the reviewer will need.
    if (e.origin === 'GTA') {
      if (!e.game) warnings.push('game is missing: approval needs the verified GTA title');
      if (e.location) problems.push('LOCATION_NOT_ALLOWED: location is for Florida events');
    } else {
      if (e.game) problems.push('GAME_NOT_ALLOWED: game is for GTA events');
      if (!e.location) warnings.push('location is missing: approval needs the event verified as happening in Florida');
      if (!e.publishedAt) warnings.push('publishedAt is missing: approval needs the report date');
      if (!e.publisher) warnings.push('publisher is missing: approval needs it for Florida reports');
    }

    // Within the file: one origin per event, no duplicate wording.
    const prev = originOf.get(e.eventId);
    if (prev && prev !== e.origin) problems.push(`EVENT_ORIGIN_CONFLICT: event ${e.eventId} is also used for a ${prev} question`);
    originOf.set(e.eventId, e.origin);
    const fp = titleFingerprint(headline);
    const dup = seenFp.get(fp);
    if (dup !== undefined) problems.push(`DUPLICATE_HEADLINE: same wording as entry #${dup + 1}`);
    else seenFp.set(fp, index);

    reports.push({ index, eventId: e.eventId, headline, problems: [...new Set(problems)], warnings });
  });
  return reports;
}

