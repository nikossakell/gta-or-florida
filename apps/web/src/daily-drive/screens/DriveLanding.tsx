import { utcDate } from '@gof/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { ApiError } from '../../api/client.ts';
import { challengeQuery } from '../../api/queries.ts';
import { numberWord, shortDay } from '../../lib/format.ts';
import { computeStats, getProgress, getResult, getResults } from '../../lib/storage.ts';
import { useUtcDay } from '../../lib/useUtcDay.ts';
import { ArcadeButton, arcadeClass } from '../components/ArcadeButton.tsx';
import { DriveMap } from '../components/DriveMap.tsx';
import { Gus } from '../components/Gus.tsx';
import { COPY } from '../lib/copy.ts';

/** Daily Drive landing. Same query and the same start/resume/result/error states as the legacy landing. */
export function DriveLanding() {
  const utcDay = useUtcDay();
  const today = useQuery(challengeQuery('today', utcDay));
  const count = today.data?.questions.length ?? 5;
  const seconds = today.data?.timeLimitSeconds ?? 60;
  const stats = computeStats(getResults(), utcDate());

  return (
    <div className="wrap wide">
      <div className="topbar">
        <span>
          {today.data ? (
            <span className="chip">
              DAILY #{today.data.number} · {shortDay(today.data.date).toUpperCase()}
            </span>
          ) : (
            <span className="chip">GTA OR FLORIDA?</span>
          )}
          {today.data?.sample && <span className="chip"> SAMPLE DATA</span>}
        </span>
        <span className="row2">
          <Link to="/archive">PAST ROUNDS</Link>
          <Link to="/about">ABOUT</Link>
        </span>
      </div>

      <main className="hero">
        <div className="hero-copy">
          <h1 className="logo">
            <span className="sr">GTA or Florida? </span>DAILY<span>DRIVE</span>
          </h1>
          <p className="pitch">
            {numberWord(count)} headlines{seconds > 0 ? `, ${seconds === 60 ? 'sixty' : seconds} seconds` : ''}. Is each one <b>real Florida news</b> or a{' '}
            <b>GTA mission</b>? Right calls keep you on the highway to Vice. Wrong ones take the scenic route.
          </p>
        </div>
        <div className="hero-pic">
          <DriveMap
            attract
            big
            label="A pink convertible drives from the Welcome to Florida sign past Ocean Drive, the Seven Mile Bridge and the Everglades to the Vice skyline"
          />
          <div className="meet">
            <Gus state="idle" size="lg" />
            <div className="bubble">Name’s Gus. I drive, you guess. Mind the gators. And the clock.</div>
          </div>
        </div>
        <div className="hero-cta">
          <TodayDrive />
          <ol className="steps">
            <li>
              <b>1</b>Read the headline. Long ones stay readable.
            </li>
            <li>
              <b>2</b>
              <span>
                Hit <kbd>G</kbd> for GTA or <kbd>F</kbd> for Florida.
              </span>
            </li>
            <li>
              <b>3</b>Reach Vice, then share your postcard.
            </li>
          </ol>
        </div>
      </main>

      <div className="stats">
        <span>
          STREAK{' '}
          <strong>
            {stats.streak} DAY{stats.streak === 1 ? '' : 'S'}
          </strong>
        </span>
        <span>
          BEST <strong>{stats.best ? `${stats.best.score}/${stats.best.total}` : '–'}</strong>
        </span>
        <span>
          DRIVES <strong>{stats.played}</strong>
        </span>
        <span className="note">Stats live only in this browser.</span>
      </div>
      <p className="foot">
        “GTA” answers are documented events from actual Grand Theft Auto games (in-game newspapers, missions, random events), each linked to its source.
      </p>
      <p className="foot">
        {COPY.disclaimer} All art on this page is original. <Link to="/about">About &amp; privacy</Link>
        <br />
        {COPY.spoilerNotice}
      </p>
    </div>
  );
}

/** Start / resume / result / not-ready / withdrawn / error: the legacy TodayCta states, restyled. */
function TodayDrive() {
  const utcDay = useUtcDay();
  const today = useQuery(challengeQuery('today', utcDay));
  const primary = useRef<HTMLAnchorElement>(null);

  // Enter on the landing page starts (or resumes) the drive, unless focus is on something that handles Enter itself.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('a, button, input, textarea, select, summary, [contenteditable]')) return;
      if (!primary.current) return;
      e.preventDefault();
      primary.current.click();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (today.isPending) {
    return (
      <div role="status" className="panel" style={{ minHeight: 76 }}>
        <span className="sr">Loading today’s round…</span>
      </div>
    );
  }

  if (today.isError) {
    const err = today.error;
    const code = err instanceof ApiError ? err.code : '';
    const noChallenge = code === 'DAILY_NOT_READY';
    const withdrawn = code === 'ROUND_WITHDRAWN';
    return (
      <>
        <div className="panel timeup-panel" role={noChallenge || withdrawn ? 'status' : 'alert'}>
          <h2>{noChallenge ? 'NO HEADLINES YET TODAY' : withdrawn ? 'ROUND WITHDRAWN' : 'STUCK IN TRAFFIC'}</h2>
          <p>
            {noChallenge
              ? 'Today’s round hasn’t been published. We never recycle or invent questions to fill a gap — try a past round instead.'
              : withdrawn
                ? err.message
                : 'We couldn’t load today’s headlines. Check your connection, then try again.'}
          </p>
          {!noChallenge && !withdrawn && <p className="lab">Error {err instanceof ApiError ? err.code : 'UNKNOWN'}</p>}
        </div>
        {!noChallenge && <ArcadeButton variant="primary" onClick={() => today.refetch()} big="TRY AGAIN" />}
        <Link to="/archive" className="btn2">
          Browse past rounds
        </Link>
      </>
    );
  }

  const c = today.data;
  const done = getResult(c.date);
  const inProgress = !done && getProgress(c.date);
  return (
    <>
      {done ? (
        <Link ref={primary} to="/results/$date" params={{ date: c.date }} className={arcadeClass('primary')}>
          <span className="big">
            SEE TODAY’S RESULT · {done.score}/{done.total}
          </span>
        </Link>
      ) : (
        <Link ref={primary} to="/play" className={arcadeClass('primary')}>
          <span className="big">{inProgress ? 'RESUME DRIVE ▶' : 'START DRIVE ▶'}</span>
          <span className="key">
            <kbd>Enter</kbd> today’s {c.questions.length} headlines
          </span>
        </Link>
      )}
      <Link to="/archive" className="btn2">
        Browse past rounds
      </Link>
    </>
  );
}
