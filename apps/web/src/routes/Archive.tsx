import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { archiveQuery } from '../api/queries.ts';
import { arcadeClass } from '../daily-drive/components/ArcadeButton.tsx';
import { EmptyState, ErrorState, LoadingState, Page } from '../daily-drive/components/Page.tsx';
import { shortDay } from '../lib/format.ts';
import { getResults } from '../lib/storage.ts';

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
    <Page label="PAST ROUNDS">
      <main>
        <h1 className="page-title">Past rounds</h1>
        <p className="intro">Missed a day? Every round from the last week is playable. Archive plays don’t change your streak.</p>

        <div className="filters" role="group" aria-label="Filter rounds">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="btn2" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>

        {query.isPending ? (
          <LoadingState label="Loading past rounds…" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} message="We couldn’t load past rounds. Check your connection, then try again." showArchive={false} />
        ) : visible.length === 0 ? (
          filter === 'played' ? (
            <EmptyState
              title="No rounds played yet"
              action={
                <Link to="/play" className={arcadeClass('primary')}>
                  <span className="big">PLAY TODAY’S ROUND ▶</span>
                </Link>
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
          <ul className="rounds">
            {visible.map((d) => {
              const r = results[d.date];
              return (
                <li key={d.date} className="panel round">
                  <span className="no">#{d.number}</span>
                  <div className="when">
                    <p className="day">{shortDay(d.date)}</p>
                    <p className="st">
                      {d.isToday && <b>TODAY · </b>}
                      {r ? `Scored ${r.score}/${r.total}${r.timedOut ? ', time ran out' : ` in ${r.seconds}s`}` : 'Not played yet'}
                    </p>
                  </div>
                  {r ? (
                    <Link to="/play/$date" params={{ date: d.date }} search={{ replay: true }} className="btn2" aria-label={`Replay round ${d.number} (not scored)`}>
                      Replay
                    </Link>
                  ) : (
                    <Link
                      to={d.isToday ? '/play' : '/play/$date'}
                      params={d.isToday ? {} : { date: d.date }}
                      className={arcadeClass('primary', 'mini')}
                      aria-label={`Play round ${d.number}`}
                    >
                      <span className="big">PLAY ▶</span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </Page>
  );
}
