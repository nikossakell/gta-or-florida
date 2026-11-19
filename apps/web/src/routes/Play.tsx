import { useQuery } from '@tanstack/react-query';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../api/client.ts';
import { challengeQuery } from '../api/queries.ts';
import { EmptyState, ErrorState, LoadingBlock } from '../components/StateScreens.tsx';
import { ButtonLink, Column, TopBar } from '../components/ui.tsx';
import { GameSession } from '../features/game/GameSession.tsx';
import { getResult, type StoredResult } from '../lib/storage.ts';
import { ResultsView } from './Results.tsx';

export function PlayScreen({ id, practice = false }: { id: 'today' | string; practice?: boolean }) {
  const query = useQuery(challengeQuery(id));
  const navigate = useNavigate();
  const [practiceResult, setPracticeResult] = useState<StoredResult | null>(null);

  if (query.isPending) {
    return (
      <Column>
        <TopBar />
        <div className="mt-4">
          <LoadingBlock label="Loading headlines…" />
        </div>
      </Column>
    );
  }

  if (query.isError) {
    const err = query.error;
    const code = err instanceof ApiError ? err.code : '';
    if (code === 'NO_CHALLENGE' || code === 'NOT_FOUND' || code === 'FUTURE_CHALLENGE') {
      return (
        <Column>
          <TopBar />
          <EmptyState
            title={code === 'NO_CHALLENGE' ? 'No headlines today' : code === 'FUTURE_CHALLENGE' ? 'No peeking' : 'Round not found'}
            action={
              <ButtonLink to="/archive" variant="secondary" className="w-full">
                Browse past rounds
              </ButtonLink>
            }
          >
            {code === 'NO_CHALLENGE'
              ? 'Today’s round hasn’t been published yet. We don’t recycle or invent questions to fill gaps — check back soon.'
              : code === 'FUTURE_CHALLENGE'
                ? 'That round isn’t out yet. Come back on the day.'
                : 'That round isn’t available. Only the last week of rounds can be played.'}
          </EmptyState>
        </Column>
      );
    }
    return (
      <Column>
        <TopBar />
        <ErrorState
          error={err}
          onRetry={() => query.refetch()}
          message={id === 'today' ? undefined : 'We couldn’t load this round’s headlines. Check your connection, then try again.'}
        />
      </Column>
    );
  }

  const challenge = query.data;

  if (practiceResult) {
    return <ResultsView result={practiceResult} practice />;
  }

  // One scored attempt per browser: completed rounds go to their results (or a replay).
  if (!practice && getResult(challenge.date)) {
    return <Navigate to="/results/$date" params={{ date: challenge.date }} replace />;
  }

  return (
    <Column>
      <GameSession
        key={`${challenge.challengeId}:${practice ? 'practice' : 'scored'}`}
        challenge={challenge}
        practice={practice}
        onComplete={(result, saved) => {
          if (saved) void navigate({ to: '/results/$date', params: { date: result.date } });
          else setPracticeResult(result);
        }}
      />
    </Column>
  );
}
