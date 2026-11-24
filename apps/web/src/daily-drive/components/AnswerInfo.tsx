import type { RevealedQuestion } from '@gof/core';
import { publishedDay } from '../../lib/format.ts';

/**
 * Explanation + source for a revealed question: the same fields, under the same conditions, as the
 * legacy AnswerDetails (features/game/RevealView.tsx), restyled. Everything comes from the API's reveal.
 */
export function AnswerInfo({ question }: { question: RevealedQuestion }) {
  const lore = question.answer === 'gta' && question.gtaSubtype === 'gta_lore';
  return (
    <>
      {question.answer === 'gta' && !lore && <p className="lore">Fictional GTA-style scenario.</p>}
      {lore && <p className="lore">A documented event from the games{question.game ? ` (${question.game})` : ''} — fiction inside the game world.</p>}
      {question.originalTitle && (
        <p className="orig">
          <span className="lab">ORIGINAL HEADLINE</span>
          <q>{question.originalTitle}</q>
        </p>
      )}
      <p className="explain">{question.explanation}</p>
      {question.sourceUrl ? (
        <p className="source">
          <a href={question.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
            {question.sourceCta ?? (question.answer === 'gta' ? 'View GTA source' : 'Read full article')}
            <span className="sr"> (opens in a new tab)</span>
          </a>
          {(question.sourceName || question.publishedAt) && (
            <>
              {' · '}
              {[question.sourceName, question.publishedAt && publishedDay(question.publishedAt)].filter(Boolean).join(' · ')}
            </>
          )}
        </p>
      ) : (
        question.answer === 'florida' &&
        question.placeholder && <p className="source none">Source: none — sample placeholder</p>
      )}
    </>
  );
}

export function answerWord(answer: 'gta' | 'florida'): string {
  return answer === 'gta' ? 'GTA' : 'FLORIDA';
}

/** "Florida · Real report" style label that the legacy AnswerBadge shows. */
export function answerKind(question: RevealedQuestion): string {
  if (question.answer === 'florida') return question.placeholder ? 'Real-report slot' : 'Real report';
  return question.gtaSubtype === 'gta_lore' ? (question.game ?? 'In-game event') : 'GTA-style · Sample';
}
