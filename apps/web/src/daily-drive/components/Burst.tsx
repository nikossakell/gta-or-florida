import { useEffect, useState } from 'react';

export type BurstAt = { x: number; y: number; color: string; id: number };

/** 16 pixel bits flying out of a point (correct answer). Never rendered under reduced motion. */
export function Burst({ at }: { at: BurstAt | null }) {
  const [live, setLive] = useState<BurstAt | null>(null);
  useEffect(() => {
    if (!at) return;
    setLive(at);
    const id = window.setTimeout(() => setLive(null), 700);
    return () => window.clearTimeout(id);
  }, [at]);
  if (!live) return null;
  return (
    <div className="burst" aria-hidden="true">
      {Array.from({ length: 16 }, (_, i) => {
        const a = (i / 16) * Math.PI * 2;
        const d = 50 + ((i * 37) % 45);
        return (
          <i
            key={`${live.id}-${i}`}
            className="bit"
            style={{
              left: live.x,
              top: live.y,
              background: i % 3 ? live.color : '#FFD25A',
              ['--dx' as string]: `${Math.cos(a) * d}px`,
              ['--dy' as string]: `${Math.sin(a) * d * 0.8}px`,
            }}
          />
        );
      })}
    </div>
  );
}
