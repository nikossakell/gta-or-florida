import { utcDate } from '@gof/core';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../api/client.ts';
import { challengeQuery } from '../api/queries.ts';
import { EmptyState, ErrorState, LoadingState, Page, PastRoundsLink } from '../daily-drive/components/Page.tsx';
import { ZONE_COUNT } from '../daily-drive/lib/copy.ts';
import { DriveResults } from '../daily-drive/screens/DriveResults.tsx';
import { GameSession } from '../features/game/GameSession.tsx';
import { getResult, type StoredResult } from '../lib/storage.ts';

export function PlayScreen({ id, practice = false }: { id: 'today' | string; practice?: boolean }) {
  // Fixed for this visit: a round in progress at midnight is not swapped out mid-game.
  const [utcDay] = useState(() => utcDate());
  const query = useQuery(challengeQuery(id, utcDay));
  const navigate = useNavigate();
  const [practiceResult, setPracticeResult] = useState<StoredResult | null>(null);

  if (query.isPending) {
    return (
      <Page label="DAILY DRIVE">
        <LoadingState label="Loading headlines…" />
      </Page>
    );
  }

  if (query.isError) {
    const err = query.error;
    const code = err instanceof ApiError ? err.code : '';
    if (code === 'ROUND_WITHDRAWN') {
      // A published round was withdrawn after a correction: same message for everyone, never a silent substitute.
      return (
        <Page label="DAILY DRIVE">
          <EmptyState title="Round withdrawn" action={<PastRoundsLink />}>
            {err.message}
          </EmptyState>
        </Page>
      );
    }
    if (code === 'DAILY_NOT_READY' || code === 'NOT_FOUND' || code === 'FUTURE_CHALLENGE') {
      return (
        <Page label="DAILY DRIVE">
          <EmptyState
            title={code === 'DAILY_NOT_READY' ? 'No headlines today' : code === 'FUTURE_CHALLENGE' ? 'No peeking' : 'Round not found'}
            action={<PastRoundsLink />}
          >
            {code === 'DAILY_NOT_READY'
              ? 'Today’s round hasn’t been published yet. We don’t recycle or invent questions to fill gaps — check back soon.'
              : code === 'FUTURE_CHALLENGE'
                ? 'That round isn’t out yet. Come back on the day.'
                : 'That round isn’t available. Only the last week of rounds can be played.'}
          </EmptyState>
        </Page>
      );
    }
    return (
      <Page label="DAILY DRIVE">
        <ErrorState
          error={err}
          onRetry={() => query.refetch()}
          message={id === 'today' ? undefined : 'We couldn’t load this round’s headlines. Check your connection, then try again.'}
        />
      </Page>
    );
  }

  const challenge = query.data;

  if (practiceResult) {
    return <DriveResults result={practiceResult} practice />;
  }

  // One scored attempt per browser: completed rounds go to their results (or a replay).
  if (!practice && getResult(challenge.date)) {
    return <Navigate to="/results/$date" params={{ date: challenge.date }} replace />;
  }

  // A drive has exactly one headline per checkpoint.
  if (challenge.questions.length !== ZONE_COUNT) {
    return (
      <Page label="DAILY DRIVE">
        <EmptyState title="Round unavailable" action={<PastRoundsLink />}>
          This round doesn’t have {ZONE_COUNT} headlines, so it can’t be played.
        </EmptyState>
      </Page>
    );
  }

  return (
    <GameSession
      key={`${challenge.challengeId}:${practice ? 'practice' : 'scored'}`}
      challenge={challenge}
      practice={practice}
      onComplete={(result, saved) => {
        if (saved) void navigate({ to: '/results/$date', params: { date: result.date } });
        else setPracticeResult(result);
      }}
    />
  );
}
