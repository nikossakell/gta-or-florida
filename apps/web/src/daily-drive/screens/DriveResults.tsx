import { buildShareText, utcDate } from '@gof/core';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { copyText, publicUrl, shareText } from '../../lib/share.ts';
import { computeStats, getResults, type StoredResult } from '../../lib/storage.ts';
import { useCountdown } from '../../lib/useCountdown.ts';
import { AnswerInfo, answerWord } from '../components/AnswerInfo.tsx';
import { ArcadeButton } from '../components/ArcadeButton.tsx';
import { Postcard } from '../components/Postcard.tsx';
import { ScoreReveal, useScoreCount } from '../components/ScoreReveal.tsx';
import { CalendarIcon, HomeIcon, Shape } from '../components/Shape.tsx';
import { zoneFor } from '../lib/copy.ts';
import { endingOf } from '../lib/endings.ts';
import { useAnnouncer } from '../lib/useAnnouncer.ts';

const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Daily Drive results: score count-up, postcard, share, stats, next-round countdown and the route.
 * Score, time, cells and share text all come from the saved result and the existing share helpers.
 */
export function DriveResults({ result, practice = false, replay = 0 }: { result: StoredResult; practice?: boolean; replay?: number }) {
  const text = buildShareText({ date: result.date, cells: result.cells, seconds: result.seconds, url: publicUrl() });
  const [status, setStatus] = useState('');
  const stats = computeStats(getResults(), utcDate());
  const next = useCountdown();
  const previewId = useId();
  const { shown, done } = useScoreCount(result.score, replay);
  const end = endingOf(result.score);
  const { message, announce } = useAnnouncer();
  const label = practice ? 'REPLAY' : result.mode === 'archive' ? 'ARCHIVE' : 'DAILY DRIVE';

  useEffect(() => {
    if (done) announce(`Final score ${result.score} out of ${result.total}. ${end.title}.`);
  }, [done, result.score, result.total, end.title, announce]);

  // Same outcomes and messages as the legacy results screen.
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
    <div className="wrap">
      <header className="hud">
        <Link to="/" className="iconbtn" aria-label="Home" title="Home">
          <HomeIcon />
        </Link>
        <div className="hud-mid">
          <div className="t1">
            {label} #{result.number}
          </div>
          <div className="t2">Trip complete</div>
        </div>
        <Link to="/archive" className="iconbtn" aria-label="Past rounds" title="Past rounds">
          <CalendarIcon />
        </Link>
      </header>
      <main>
        <h1 className="sr">
          Your result: {result.score} out of {result.total}
        </h1>
        <ScoreReveal shown={shown} total={result.total} done={done} />
        <Postcard
          score={result.score}
          total={result.total}
          cells={result.cells}
          timeText={result.timedOut ? 'TIME UP' : `${result.seconds}s`}
          number={result.number}
          dateShort={SHORT.format(new Date(`${result.date}T00:00:00Z`)).toUpperCase()}
          hidden={!done}
          entering={done}
        />
        {result.sample && <p className="nextday sample-note">Sample round with placeholder headlines.</p>}

        <div className="actions">
          <div className="share-row">
            <ArcadeButton variant="share" onClick={onShare} big="SHARE RESULT" hint="share sheet or clipboard" />
            <button type="button" className="btn2" onClick={onCopy}>
              COPY
            </button>
          </div>
          <p className="copystat" role="status" aria-live="polite">
            {status}
          </p>
          <label htmlFor={previewId} className="sr">
            Share text (select to copy manually)
          </label>
          <textarea id={previewId} className="sharetxt" readOnly value={text} rows={4} onFocus={(e) => e.currentTarget.select()} />

          {!practice && (
            <div className="stats">
              <span>
                PLAYED <strong>{stats.played}</strong>
              </span>
              <span>
                DAY STREAK <strong>{stats.streak}</strong>
              </span>
              <span>
                BEST <strong>{stats.best ? `${stats.best.score}/${stats.best.total}` : '–'}</strong>
              </span>
              <span className="note">
                Stats live only in this browser.{result.mode === 'archive' ? ' Archive plays don’t change your streak.' : ''}
              </span>
            </div>
          )}

          <p className="nextday lab">
            NEXT DRIVE IN <span className="countdown">{next}</span>
          </p>
          <div className="row2">
            {practice && (
              <Link to="/results/$date" params={{ date: result.date }} className="btn2">
                Back to your scored result
              </Link>
            )}
            <Link to="/archive" className="btn2">
              Play a past round
            </Link>
            <Link to="/" className="btn2">
              Start screen
            </Link>
          </div>
        </div>

        <section className="histbox panel" aria-labelledby="route-title">
          <h2 id="route-title" className="lab-h">
            YOUR ROUTE
          </h2>
          <ol>
            {result.questions.map((q, i) => {
              const cell = result.cells[i];
              const choice = result.choices[i];
              return (
                <li key={q.id}>
                  <Shape state={cell === true ? 'ok' : cell === false ? 'bad' : 'todo'} />
                  <div>
                    <span className="sr">
                      #{i + 1}: {cell === true ? 'You got it' : cell === false ? 'Missed' : 'Unanswered'}.{' '}
                    </span>
                    {q.headline}
                    <small>
                      {zoneFor(i).s.toUpperCase()} · ANSWER {answerWord(q.answer)} · YOU {choice ? answerWord(choice) : 'NO ANSWER'}
                    </small>
                    <details>
                      <summary>WHY + SOURCE</summary>
                      <AnswerInfo question={q} />
                    </details>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      </main>
      <p className="sr" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
