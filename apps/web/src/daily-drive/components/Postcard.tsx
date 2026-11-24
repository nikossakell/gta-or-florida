import type { ResultCell } from '@gof/core';
import { useEffect, useRef } from 'react';
import { useEngine } from '../engine.ts';
import { endingOf } from '../lib/endings.ts';
import { Gus } from './Gus.tsx';
import { Shape } from './Shape.tsx';

/**
 * Results postcard: ending art (drawn by the engine into a 192×108 canvas, no image request),
 * destination, the ending title for the level reached, score, time, answer history, Gus stamp, message.
 */
export function Postcard({
  score,
  total,
  cells,
  timeText,
  number,
  dateShort,
  hidden,
  entering,
}: {
  score: number;
  total: number;
  cells: readonly ResultCell[];
  timeText: string;
  number: number;
  dateShort: string;
  hidden: boolean;
  entering: boolean;
}) {
  const engine = useEngine();
  const canvas = useRef<HTMLCanvasElement>(null);
  const end = endingOf(score);

  useEffect(() => {
    if (engine && canvas.current) engine.drawArt(canvas.current, end.key);
  }, [engine, end.key]);

  return (
    <article className={`postcard${entering ? ' enter' : ''}`} aria-label="Results postcard" data-hidden={hidden ? '' : undefined} data-ending={end.key}>
      <div className="art">
        <canvas ref={canvas} className="px" width={192} height={108} role="img" aria-label={end.art} />
        <p className="greet">
          GREETINGS FROM<span>{end.dest}</span>
        </p>
      </div>
      <div className="pc-side">
        <div className="pc-top">
          <div className="stamp">
            <Gus state={end.mood} size="stamp" decorative />
          </div>
          <div className="postmark lab" aria-hidden="true">
            DAILY
            <br />
            DRIVE
            <br />#{number}
            <br />
            {dateShort}
          </div>
        </div>
        <h2 className="pc-title">{end.title}</h2>
        <dl className="pc-stats">
          <div>
            <dt>SCORE</dt>
            <dd>
              {score}/{total}
            </dd>
          </div>
          <div>
            <dt>TIME</dt>
            <dd>{timeText}</dd>
          </div>
        </dl>
        <ol className="pc-hist" aria-label="Answer history">
          {cells.map((c, i) => (
            <li key={i}>
              <Shape state={c === true ? 'ok' : c === false ? 'bad' : 'todo'} />
              <span aria-hidden="true">Q{i + 1}</span>
              <span className="sr">
                Headline {i + 1}: {c === true ? 'right' : c === false ? 'wrong' : 'unanswered'}
              </span>
            </li>
          ))}
        </ol>
        <p className="pc-msg">{end.msg}</p>
      </div>
    </article>
  );
}
