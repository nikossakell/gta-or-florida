/**
 * The Worker approval request for a curated bank question the owner approved in the editorial review
 * dashboard. Pure (depends only on @gof/core), so the Worker's tests use exactly what `bank:approve` sends.
 */
import { cleanText, GTA_GAMES, type LinkCheck, type ReviewRequest } from '@gof/core';
import type { BankEntry } from './bank-item.ts';

/** The record the review dashboard writes into an approved question's notes. */
export const DASHBOARD_DECISION = /^Editorially approved in the local review dashboard by ([A-Za-z0-9 ._@-]{1,64}) at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;
/** Research verification date recorded in the bank notes ("Verified 2026-11-25 …"). */
export const RESEARCH_VERIFIED = /\bVerified (\d{4}-\d{2}-\d{2})\b/;

/** The approval request for one reviewed bank question (owner decision 2026-11-28: reviewed AI-assisted drafts, never declared human-written). */
export function approvalRequest(e: BankEntry, questionId: string, decision: { reviewer: string; at: string }, link: { check?: LinkCheck; manual?: boolean }): ReviewRequest {
  const researched = RESEARCH_VERIFIED.exec(e.notes ?? '')?.[1] ?? decision.at.slice(0, 10);
  const florida = e.origin === 'FLORIDA';
  return {
    questionId,
    action: 'approve',
    mode: 'factual_summary',
    // Exactly the reviewed text: the Worker refuses a reviewed draft whose text changed.
    playTitle: e.headline,
    explanation: e.explanation,
    ...(e.difficulty ? { difficulty: e.difficulty } : {}),
    ...(e.category ? { category: e.category } : {}),
    ...(florida ? { publishedAt: e.publishedAt, publisher: e.publisher } : { game: e.game }),
    eventId: e.eventId,
    ...(e.spoiler ? { spoiler: true } : {}),
    ...(link.manual ? { linkVerifiedManually: true } : link.check ? { linkCheck: link.check } : {}),
    factual: {
      humanWritten: false,
      textOrigin: 'machine_draft_reviewed',
      incidentVerified: true,
      claimsVerified: true,
      privacyChecked: true,
      // Florida: the report's publication date (stored as publishedAt). GTA: when the facts were verified.
      verifiedDate: florida ? e.publishedAt! : researched,
      verifiedLocation: florida ? e.location! : GTA_GAMES[e.game!],
      evidenceUrls: [e.sourceUrl],
      notes: cleanText(
        `AI-assisted draft from the curated question bank. Facts verified against the source during research (${researched}); wording approved unchanged by ${decision.reviewer} in the editorial review dashboard at ${decision.at}.`,
        500,
      ),
    },
  };
}

