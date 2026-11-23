import { utcDate } from '@gof/core';
import { QueryClient, queryOptions } from '@tanstack/react-query';
import { ApiError } from './client.ts';
import { api } from './index.ts';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => !(error instanceof ApiError && (error.isClientError || error.code === 'ROUND_WITHDRAWN' || error.code === 'DAILY_NOT_READY')) && count < 2,
        refetchOnWindowFocus: false,
        staleTime: 60_000,
      },
      mutations: { retry: false },
    },
  });
}

/**
 * "today" is keyed by the UTC date so a tab left open across midnight fetches the
 * new round instead of reusing yesterday's cache. The server still decides what
 * "today" is (the client clock is only used for cache keys).
 */
export const challengeQuery = (id: 'today' | string, utcDay: string = utcDate()) =>
  queryOptions({
    queryKey: id === 'today' ? ['challenge', 'today', utcDay] : ['challenge', id],
    queryFn: ({ signal }) => api.challenge(id, signal),
    // A dated challenge never changes once published.
    staleTime: id === 'today' ? 60_000 : Infinity,
  });

export const archiveQuery = () =>
  queryOptions({
    queryKey: ['archive'],
    queryFn: ({ signal }) => api.archive(signal),
  });
