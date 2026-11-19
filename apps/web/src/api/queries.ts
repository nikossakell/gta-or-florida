import { QueryClient, queryOptions } from '@tanstack/react-query';
import { api, ApiError } from './client.ts';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => !(error instanceof ApiError && error.isClientError) && count < 2,
        refetchOnWindowFocus: false,
        staleTime: 60_000,
      },
      mutations: { retry: false },
    },
  });
}

export const challengeQuery = (id: 'today' | string) =>
  queryOptions({
    queryKey: ['challenge', id],
    queryFn: ({ signal }) => api.challenge(id, signal),
    // A dated challenge never changes once published.
    staleTime: id === 'today' ? 60_000 : Infinity,
  });

export const archiveQuery = () =>
  queryOptions({
    queryKey: ['archive'],
    queryFn: ({ signal }) => api.archive(signal),
  });
