import type { ResultCell } from '@gof/core';
import { CheckIcon, CrossIcon } from './Icons.tsx';

/**
 * Right / wrong / unanswered tiles. Each state differs in icon and fill
 * (solid + check, solid + cross, dashed outline), not only in color.
 */
export function ResultGrid({ cells, size = 'md', label }: { cells: readonly ResultCell[]; size?: 'sm' | 'md'; label?: string }) {
  const box = size === 'sm' ? 'size-9 rounded-lg' : 'size-11 rounded-xl sm:size-12';
  const right = cells.filter((c) => c === true).length;
  const wrong = cells.filter((c) => c === false).length;
  const skipped = cells.length - right - wrong;
  const summary = label ?? `${right} right, ${wrong} wrong${skipped ? `, ${skipped} unanswered` : ''}`;

  return (
    <ol className="flex flex-wrap justify-center gap-2" aria-label={summary}>
      {cells.map((c, i) => (
        <li
          key={i}
          className={
            c === true
              ? `${box} flex items-center justify-center bg-teal-deep text-cream`
              : c === false
                ? `${box} flex items-center justify-center bg-ember text-ink`
                : `${box} border-[3px] border-dashed border-dim/70`
          }
        >
          <span className="sr-only">
            Headline {i + 1}: {c === true ? 'right' : c === false ? 'wrong' : 'unanswered'}
          </span>
          {c === true && <CheckIcon size={size === 'sm' ? 18 : 22} />}
          {c === false && <CrossIcon size={size === 'sm' ? 18 : 22} />}
        </li>
      ))}
    </ol>
  );
}
