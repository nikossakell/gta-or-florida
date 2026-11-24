import { utcDate } from '@gof/core';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { Fragment, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { challengeQuery } from '../api/queries.ts';
import { EmptyState, ErrorState, LoadingBlock } from '../components/StateScreens.tsx';
import { ButtonLink, Column, TopBar } from '../components/ui.tsx';
import { DAILY_DRIVE } from '../daily-drive/flag.ts';
import { GameSession } from '../features/game/GameSession.tsx';
import { getResult, type StoredResult } from '../lib/storage.ts';
import { ResultsView } from './Results.tsx';

export function PlayScreen({ id, practice = false }: { id: 'today' | string; practice?: boolean }) {
  // Fixed for this visit: a round in progress at midnight is not swapped out mid-game.
  const [utcDay] = useState(() => utcDate());
  const query = useQuery(challengeQuery(id, utcDay));
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
    if (code === 'ROUND_WITHDRAWN') {
      // A published round was withdrawn after a correction: same message for everyone, never a silent substitute.
      return (
        <Column>
          <TopBar />
          <EmptyState
            title="Round withdrawn"
            action={
              <ButtonLink to="/archive" variant="secondary" className="w-full">
                Browse past rounds
              </ButtonLink>
            }
          >
            {err.message}
          </EmptyState>
        </Column>
      );
    }
    if (code === 'DAILY_NOT_READY' || code === 'NOT_FOUND' || code === 'FUTURE_CHALLENGE') {
      return (
        <Column>
          <TopBar />
          <EmptyState
            title={code === 'DAILY_NOT_READY' ? 'No headlines today' : code === 'FUTURE_CHALLENGE' ? 'No peeking' : 'Round not found'}
            action={
              <ButtonLink to="/archive" variant="secondary" className="w-full">
                Browse past rounds
              </ButtonLink>
            }
          >
            {code === 'DAILY_NOT_READY'
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

  // Daily Drive lays out its own full-height play screen (.wrap); the legacy UI keeps its column.
  const Shell = DAILY_DRIVE && challenge.questions.length === 5 ? Fragment : Column;
  return (
    <Shell>
      <GameSession
        key={`${challenge.challengeId}:${practice ? 'practice' : 'scored'}`}
        challenge={challenge}
        practice={practice}
        onComplete={(result, saved) => {
          if (saved) void navigate({ to: '/results/$date', params: { date: result.date } });
          else setPracticeResult(result);
        }}
      />
    </Shell>
  );
}
