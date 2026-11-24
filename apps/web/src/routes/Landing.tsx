import { useQuery } from '@tanstack/react-query';
import { challengeQuery } from '../api/queries.ts';
import { useUtcDay } from '../lib/useUtcDay.ts';
import { ApiError } from '../api/client.ts';
import { SunsetGator } from '../components/Gator.tsx';
import { CalendarIcon, PlayIcon, RetryIcon } from '../components/Icons.tsx';
import { Badge, Button, ButtonLink, Disclaimer, IconLink, Wordmark } from '../components/ui.tsx';
import { numberWord, shortDay } from '../lib/format.ts';
import { getProgress, getResult } from '../lib/storage.ts';
import { DAILY_DRIVE } from '../daily-drive/flag.ts';
import { DriveLanding } from '../daily-drive/screens/DriveLanding.tsx';

const STEPS = [
  { n: 1, text: 'Read the headline', ring: 'border-sun text-sun' },
  { n: 2, text: 'Tap GTA or Florida', ring: 'border-pink text-pink' },
  { n: 3, text: 'Share your score', ring: 'border-teal text-teal' },
];

function Pitch({ count, seconds }: { count: number; seconds: number }) {
  const lead = `${numberWord(count)} headlines.${seconds > 0 ? ` ${seconds === 60 ? 'Sixty' : seconds} seconds.` : ''}`;
  return (
    <p className="text-cream/90 mx-auto max-w-xl text-xl leading-relaxed text-balance sm:text-2xl lg:mx-0">
      {lead} Is each one <strong className="text-teal font-semibold">real Florida news</strong> or a{' '}
      <strong className="text-pink font-semibold">made-up open-world crime caper</strong>?
    </p>
  );
}

function TodayCta() {
  const utcDay = useUtcDay();
  const today = useQuery(challengeQuery('today', utcDay));

  if (today.isPending) {
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading today’s round…</span>
        <div className="bg-line/50 mx-auto h-5 w-48 animate-pulse rounded-full lg:mx-0" />
        <div className="bg-line/40 h-16 animate-pulse rounded-2xl" />
      </div>
    );
  }

  if (today.isError) {
    const err = today.error;
    const code = err instanceof ApiError ? err.code : '';
    const noChallenge = code === 'DAILY_NOT_READY';
    const withdrawn = code === 'ROUND_WITHDRAWN';
    return (
      <div className="flex flex-col gap-4">
        <div className="card p-6 text-left" role={noChallenge || withdrawn ? 'status' : 'alert'}>
          <p className="font-display text-sun text-3xl">{noChallenge ? 'No headlines yet today' : withdrawn ? 'Round withdrawn' : 'Stuck in traffic'}</p>
          <p className="text-muted mt-2">
            {noChallenge
              ? 'Today’s round hasn’t been published. We never recycle or invent questions to fill a gap — try a past round instead.'
              : withdrawn
                ? err.message
                : 'We couldn’t load today’s headlines. Check your connection, then try again.'}
          </p>
          {!noChallenge && !withdrawn && <p className="text-dim mt-2 font-mono text-sm">Error {err instanceof ApiError ? err.code : 'UNKNOWN'}</p>}
        </div>
        {!noChallenge && (
          <Button onClick={() => today.refetch()}>
            <RetryIcon /> Try again
          </Button>
        )}
        <ButtonLink to="/archive" variant="secondary">
          Browse past rounds
        </ButtonLink>
      </div>
    );
  }

  const c = today.data;
  const done = getResult(c.date);
  const inProgress = !done && getProgress(c.date);
  return (
    <div className="flex flex-col gap-5">
      <p className="label-wide text-sun text-sm sm:text-base">
        Daily #{c.number} · {shortDay(c.date)}
      </p>
      {done ? (
        <ButtonLink to="/results/$date" params={{ date: c.date }}>
          See today’s result · {done.score}/{done.total}
        </ButtonLink>
      ) : (
        <ButtonLink to="/play">
          <PlayIcon /> {inProgress ? 'Resume today’s round' : 'Play today’s round'}
        </ButtonLink>
      )}
      <ButtonLink to="/archive" variant="secondary">
        Browse past rounds
      </ButtonLink>
    </div>
  );
}

export function Landing() {
  return DAILY_DRIVE ? <DriveLanding /> : <LegacyLanding />;
}

function LegacyLanding() {
  const utcDay = useUtcDay();
  const today = useQuery(challengeQuery('today', utcDay));
  const count = today.data?.questions.length ?? 5;
  const seconds = today.data?.timeLimitSeconds ?? 60;

  return (
    <div className="mx-auto w-full max-w-[520px] px-5 pb-10 lg:max-w-6xl">
      <header className="flex items-center justify-between gap-3 py-4">
        {today.data?.sample ? <Badge>Sample data</Badge> : <span />}
        <IconLink to="/archive" label="Past rounds">
          <CalendarIcon />
        </IconLink>
      </header>

      <main className="lg:grid lg:min-h-[80dvh] lg:grid-cols-2 lg:items-center lg:gap-16">
        <div className="flex justify-center">
          <SunsetGator className="animate-bob w-full max-w-md lg:max-w-lg" />
        </div>
        <div className="mt-6 text-center lg:mt-0 lg:text-left">
          <Wordmark size="lg" as="h1" />
          <div className="mt-6">
            <Pitch count={count} seconds={seconds} />
          </div>
          <div className="mt-7">
            <TodayCta />
          </div>
          <ol className="mt-10 grid grid-cols-3 gap-3 text-center">
            {STEPS.map((s) => (
              <li key={s.n} className="flex flex-col items-center gap-2">
                <span className={`btn-wide flex size-12 items-center justify-center rounded-full border-[3px] text-lg ${s.ring}`} aria-hidden="true">
                  {s.n}
                </span>
                <span className="text-muted">{s.text}</span>
              </li>
            ))}
          </ol>
          <p className="text-dim mt-6 text-sm">
            “GTA” answers are documented events from actual Grand Theft Auto games (in-game newspapers, missions, random events), each linked to its source.
          </p>
          <Disclaimer className="mt-6 lg:text-left" />
        </div>
      </main>
    </div>
  );
}
