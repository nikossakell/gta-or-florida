import { buildShareText, msUntilNextUtcDay, scoreTitle, utcDate } from '@gof/core';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { PostcardStrip } from '../components/Gator.tsx';
import { ChevronDownIcon, ClockIcon, CopyIcon, ShareIcon } from '../components/Icons.tsx';
import { ResultGrid } from '../components/ResultGrid.tsx';
import { EmptyState } from '../components/StateScreens.tsx';
import { Button, ButtonLink, Column, TopBar } from '../components/ui.tsx';
import { AnswerDetails } from '../features/game/RevealView.tsx';
import { countdown, longDay } from '../lib/format.ts';
import { copyText, publicUrl, shareText } from '../lib/share.ts';
import { computeStats, getResult, getResults, type StoredResult } from '../lib/storage.ts';

function useCountdown(): string {
  const [ms, setMs] = useState(() => msUntilNextUtcDay());
  useEffect(() => {
    const id = window.setInterval(() => setMs(msUntilNextUtcDay()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return countdown(ms);
}

function Stat({ value, label, tone }: { value: string; label: string; tone: string }) {
  return (
    <div className="bg-card rounded-3xl px-2 py-5 text-center">
      <p className={`font-display text-3xl ${tone}`}>{value}</p>
      <p className="label-wide text-muted mt-1 text-xs">{label}</p>
    </div>
  );
}

export function ResultsView({ result, practice = false }: { result: StoredResult; practice?: boolean }) {
  const text = buildShareText({ date: result.date, cells: result.cells, seconds: result.seconds, url: publicUrl() });
  const [status, setStatus] = useState('');
  const today = utcDate();
  const stats = computeStats(getResults(), today);
  const next = useCountdown();
  const previewId = useId();

  async function onShare() {
    const outcome = await shareText(text);
    setStatus(
      outcome === 'shared'
        ? 'Shared!'
        : outcome === 'copied'
          ? 'Result copied to clipboard.'
          : outcome === 'cancelled'
            ? ''
            : 'Copying is blocked here — select the text below and copy it by hand.',
    );
  }

  async function onCopy() {
    const outcome = await copyText(text);
    setStatus(outcome === 'copied' ? 'Result copied to clipboard.' : 'Copying is blocked here — select the text below and copy it by hand.');
  }

  return (
    <Column>
      <TopBar />
      <main>
        <h1 className="sr-only">
          Your result: {result.score} out of {result.total}
        </h1>
        <section className="bg-cream text-ink mt-2 overflow-hidden rounded-[2rem] border-[3px] border-ink shadow-[0_10px_0_var(--color-pink)]" aria-label="Score card">
          <PostcardStrip className="block h-24 w-full" />
          <div className="px-6 pt-6 pb-7 text-center">
            <p className="label-wide text-[#5b4f86] text-xs sm:text-sm">
              Greetings from the swamp · {practice ? 'Replay' : result.mode === 'archive' ? 'Archive' : 'Daily'} #{result.number}
            </p>
            <p className="font-display text-pink-deep mt-2 text-3xl">GTA or Florida?</p>
            <p className="font-display mt-1 text-8xl leading-none">
              {result.score}/{result.total}
            </p>
            <p className="mt-3 text-lg font-semibold">{result.timedOut ? 'before the clock ran out' : `in ${result.seconds} second${result.seconds === 1 ? '' : 's'}`}</p>
            <p className="label-wide bg-ink text-sun mx-auto mt-4 inline-block rounded-full px-5 py-2 text-xs sm:text-sm">{scoreTitle(result.score, result.total)}</p>
            <div className="mt-5">
              <ResultGrid cells={result.cells} />
            </div>
            <p className="mt-4 text-[#4a4070]">{longDay(result.date)}</p>
            {result.sample && <p className="mt-2 text-sm text-[#4a4070]">Sample round with placeholder headlines.</p>}
          </div>
        </section>

        <div className="mt-8 flex gap-3">
          <Button variant="primaryCompact" onClick={onShare} className="min-w-0 flex-1">
            <ShareIcon /> Share result
          </Button>
          <Button variant="secondary" onClick={onCopy} className="shrink-0">
            <CopyIcon /> Copy
          </Button>
        </div>
        <p className="text-teal mt-3 min-h-6 text-center font-semibold" role="status" aria-live="polite">
          {status}
        </p>

        <label htmlFor={previewId} className="sr-only">
          Share text (select to copy manually)
        </label>
        <textarea
          id={previewId}
          readOnly
          value={text}
          rows={4}
          onFocus={(e) => e.currentTarget.select()}
          className="border-line bg-night-2 mt-3 w-full resize-none rounded-3xl border-[3px] border-dashed p-5 font-mono text-base leading-relaxed"
        />

        {!practice && (
          <>
            <div className="mt-6 grid grid-cols-3 gap-3">
              <Stat value={String(stats.played)} label="Played" tone="text-cream" />
              <Stat value={String(stats.streak)} label="Day streak" tone="text-sun" />
              <Stat value={stats.best ? `${stats.best.score}/${stats.best.total}` : '–'} label="Best" tone="text-teal" />
            </div>
            <p className="text-dim mt-3 text-center text-sm">
              Stats live only in this browser. {result.mode === 'archive' && 'Archive plays don’t change your streak.'}
            </p>
          </>
        )}

        <p className="border-line mt-6 flex min-h-14 items-center justify-center gap-3 rounded-2xl border-[3px] px-4 text-lg font-semibold">
          <ClockIcon size={22} /> Next round in <span className="tabular-nums">{next}</span>
        </p>

        <details className="group border-line mt-4 rounded-2xl border-[3px]">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-5 text-lg font-bold [&::-webkit-details-marker]:hidden">
            Review all {result.total} answers
            <ChevronDownIcon className="transition-transform group-open:rotate-180" />
          </summary>
          <ol className="space-y-4 px-4 pb-5">
            {result.questions.map((q, i) => {
              const cell = result.cells[i];
              const choice = result.choices[i];
              return (
                <li key={q.id} className="bg-card rounded-3xl p-5">
                  <p className="text-dim text-sm font-semibold">
                    #{i + 1} · {cell === true ? 'You got it' : cell === false ? 'Missed' : 'Unanswered'}
                    {choice ? ` — you said ${choice === 'gta' ? 'GTA' : 'Florida'}` : ''}
                  </p>
                  <p className="mt-2 text-lg font-bold">{q.headline}</p>
                  <AnswerDetails question={q} />
                </li>
              );
            })}
          </ol>
        </details>

        <div className="mt-8 flex flex-col items-center gap-4">
          {practice && (
            <ButtonLink to="/results/$date" params={{ date: result.date }} variant="secondary" className="w-full">
              Back to your scored result
            </ButtonLink>
          )}
          <Link to="/archive" className="text-sun text-lg font-bold underline decoration-2 underline-offset-4">
            Play a past round
          </Link>
        </div>
      </main>
    </Column>
  );
}

export function ResultsScreen({ date }: { date: string }) {
  const result = getResult(date);
  if (!result) {
    return (
      <Column>
        <TopBar />
        <EmptyState
          title="No result yet"
          action={
            <ButtonLink to="/play/$date" params={{ date }} className="w-full">
              Play this round
            </ButtonLink>
          }
        >
          There’s no saved score for this round in this browser.
        </EmptyState>
      </Column>
    );
  }
  return <ResultsView result={result} />;
}
