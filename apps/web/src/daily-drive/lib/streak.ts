/**
 * In-round streak for display only (banner, turbo flames, Gus): the number of correct answers in a
 * row at the end of the answers so far. Not stored, not scored. The day streak is computeStats().
 */
export function trailingStreak(answers: readonly { correct: boolean }[]): number {
  let n = 0;
  for (let i = answers.length - 1; i >= 0 && answers[i]!.correct; i--) n++;
  return n;
}

export const STREAK_BANNER_AT = 3;
