import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { archiveQuery } from '../api/queries.ts';
import { BackIcon } from '../components/Icons.tsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/StateScreens.tsx';
import { buttonClass, ButtonLink, Column, IconLink } from '../components/ui.tsx';
import { shortDay } from '../lib/format.ts';
import { getResults } from '../lib/storage.ts';
import { Link } from '@tanstack/react-router';

type Filter = 'all' | 'played' | 'unplayed';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'played', label: 'Played' },
  { id: 'unplayed', label: 'Not played' },
];

export function Archive() {
  const query = useQuery(archiveQuery());
  const [filter, setFilter] = useState<Filter>('all');
  const results = getResults();

  const days = query.data?.days ?? [];
  const visible = days.filter((d) => (filter === 'all' ? true : filter === 'played' ? Boolean(results[d.date]) : !results[d.date]));

  return (
    <Column>
      <header className="flex items-center gap-5 py-4">
        <IconLink to="/" label="Back to home">
          <BackIcon />
        </IconLink>
        <h1 className="font-display text-5xl">Archive</h1>
      </header>
      <p className="text-muted text-lg">Missed a day? Every round from the last week is playable. Archive plays don’t change your streak.</p>

      <div className="mt-6 flex flex-wrap gap-3" role="group" aria-label="Filter rounds">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={
              filter === f.id
                ? 'bg-cream text-ink inline-flex min-h-12 items-center rounded-full border-[3px] border-cream px-5 text-base font-bold sm:px-6 sm:text-lg'
                : 'border-line text-cream hover:border-dim inline-flex min-h-12 items-center rounded-full border-[3px] px-5 text-base font-bold sm:px-6 sm:text-lg'
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      <main className="mt-6">
        {query.isPending ? (
          <LoadingBlock label="Loading past rounds…" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} message="We couldn’t load past rounds. Check your connection, then try again." showArchive={false} />
        ) : visible.length === 0 ? (
          filter === 'played' ? (
            <EmptyState
              title="No rounds played yet"
              action={
                <ButtonLink to="/play" className="w-full">
                  Play today’s round
                </ButtonLink>
              }
            >
              Your scores land here after your first game.
            </EmptyState>
          ) : filter === 'unplayed' ? (
            <EmptyState title="All caught up">You’ve played every round from the last week. Nice.</EmptyState>
          ) : (
            <EmptyState title="Nothing here yet">No rounds have been published in the last week.</EmptyState>
          )
        ) : (
          <ul className="space-y-4">
            {visible.map((d) => {
              const r = results[d.date];
              return (
                <li key={d.date} className="bg-card border-line flex items-center gap-3 rounded-[1.75rem] border-[3px] py-4 pr-4 pl-5 sm:gap-4">
                  <span className="font-display text-sun min-w-14 shrink-0 text-2xl sm:min-w-20 sm:text-3xl">#{d.number}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-lg font-bold whitespace-nowrap sm:text-xl">
                      {shortDay(d.date)}
                    </p>
                    <p className="text-muted text-sm sm:text-base">
                      {d.isToday && <span className="text-teal font-semibold">Today · </span>}
                      {r ? `Scored ${r.score}/${r.total}${r.timedOut ? ', time ran out' : ` in ${r.seconds}s`}` : 'Not played yet'}
                    </p>
                  </div>
                  {r ? (
                    <Link
                      to="/play/$date"
                      params={{ date: d.date }}
                      search={{ replay: true }}
                      className={buttonClass('pill', 'shrink-0')}
                      aria-label={`Replay round ${d.number} (not scored)`}
                    >
                      Replay
                    </Link>
                  ) : (
                    <Link
                      to={d.isToday ? '/play' : '/play/$date'}
                      params={d.isToday ? {} : { date: d.date }}
                      className="bg-sun text-ink btn-wide inline-flex min-h-12 shrink-0 items-center rounded-full px-5 text-base sm:px-6 sm:text-lg"
                      aria-label={`Play round ${d.number}`}
                    >
                      Play
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </Column>
  );
}
