import { useId } from 'react';

/**
 * Original mascot artwork: a cartoon alligator in sunglasses over a striped
 * sunset. Drawn from scratch for this project; no third-party game assets.
 */

const C = {
  ink: '#140f2b',
  sun: '#ffb547',
  ember: '#ff8a3d',
  pink: '#ff5fa2',
  teal: '#2ee6c9',
  gator: '#4cc78a',
  gatorDeep: '#2e9a63',
  cream: '#fff5e8',
  card: '#2e2459',
};

function GatorHead({ eyes = 'shades' }: { eyes?: 'shades' | 'sleep' | 'worried' }) {
  return (
    <g>
      {/* lower jaw */}
      <path d="M82 196 L276 176 Q290 175 290 186 L290 190 Q290 200 278 202 L96 222 Q80 224 78 212 Z" fill={C.gatorDeep} stroke={C.ink} strokeWidth="6" strokeLinejoin="round" />
      {/* upper head + snout */}
      <path
        d="M70 196 Q62 150 104 136 Q130 104 166 128 L266 138 Q300 142 302 164 Q303 180 284 182 L96 202 Q74 204 70 196 Z"
        fill={C.gator}
        stroke={C.ink}
        strokeWidth="6"
        strokeLinejoin="round"
      />
      {/* teeth */}
      <path d="M120 199 l7 12 l6 -13 M160 195 l7 12 l6 -13 M200 191 l7 12 l6 -13 M240 187 l7 11 l6 -13" fill={C.cream} stroke={C.ink} strokeWidth="4" strokeLinejoin="round" />
      {/* nostril */}
      <circle cx="282" cy="152" r="8" fill={C.gatorDeep} stroke={C.ink} strokeWidth="5" />
      {/* bumps */}
      <circle cx="198" cy="158" r="5" fill={C.gatorDeep} />
      <circle cx="222" cy="150" r="5" fill={C.gatorDeep} />
      <circle cx="176" cy="166" r="5" fill={C.gatorDeep} />
      {eyes === 'shades' && (
        <g>
          <path d="M92 132 L172 132" stroke={C.ink} strokeWidth="7" strokeLinecap="round" />
          <path d="M96 132 h32 v10 q0 18 -16 18 q-16 0 -16 -18z" fill={C.ink} />
          <path d="M138 132 h32 v10 q0 18 -16 18 q-16 0 -16 -18z" fill={C.ink} />
          <path d="M104 141 h12 M146 141 h12" stroke={C.pink} strokeWidth="4" strokeLinecap="round" />
        </g>
      )}
      {eyes === 'sleep' && (
        <g stroke={C.ink} strokeWidth="6" strokeLinecap="round" fill="none">
          <path d="M100 140 q12 10 24 0" />
          <path d="M142 140 q12 10 24 0" />
        </g>
      )}
      {eyes === 'worried' && (
        <g>
          <circle cx="114" cy="138" r="13" fill={C.cream} stroke={C.ink} strokeWidth="5" />
          <circle cx="152" cy="136" r="13" fill={C.cream} stroke={C.ink} strokeWidth="5" />
          <circle cx="117" cy="142" r="5" fill={C.ink} />
          <circle cx="155" cy="140" r="5" fill={C.ink} />
        </g>
      )}
    </g>
  );
}

function Palm({ x, flip = false, scale = 1 }: { x: number; flip?: boolean; scale?: number }) {
  return (
    <g transform={`translate(${x} 0) scale(${flip ? -scale : scale} ${scale})`} stroke={C.teal} strokeWidth="6" strokeLinecap="round" fill="none">
      <path d="M0 230 Q4 160 22 110" />
      <path d="M22 110 Q-10 92 -38 112 M22 110 Q12 80 -18 74 M22 110 Q46 86 74 96 M22 110 Q40 74 30 50" />
    </g>
  );
}

/** Landing hero: sunset, palms, gator in shades. */
export function SunsetGator({ className = '' }: { className?: string }) {
  const clipId = `sun-${useId().replace(/:/g, '')}`;
  return (
    <svg viewBox="0 0 400 280" className={className} role="img" aria-label="Cartoon alligator wearing sunglasses in front of a striped sunset with palm trees">
      <defs>
        <clipPath id={clipId}>
          <circle cx="200" cy="150" r="120" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect x="60" y="20" width="280" height="220" fill={C.sun} />
        {[96, 112, 128, 144].map((y, i) => (
          <rect key={y} x="60" y={y} width="280" height={8 + i * 2} fill={C.ember} />
        ))}
        {[162, 182, 202, 222].map((y, i) => (
          <rect key={y} x="60" y={y} width="280" height={10 + i * 2} fill={C.pink} />
        ))}
      </g>
      <Palm x={64} scale={0.75} />
      <Palm x={330} flip />
      <path d="M8 230 H392" stroke={C.teal} strokeWidth="5" strokeLinecap="round" />
      <path d="M30 248 H90 M120 262 H160 M250 248 H330 M280 262 H360" stroke={C.teal} strokeOpacity="0.55" strokeWidth="5" strokeLinecap="round" />
      <g transform="translate(0 4)">
        <GatorHead />
      </g>
    </svg>
  );
}

/** Empty state: snoozing gator. */
export function SleepingGator({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="40 40 300 220" className={className} aria-hidden="true">
      <ellipse cx="185" cy="230" rx="130" ry="16" fill={C.card} />
      <GatorHead eyes="sleep" />
      <g fill={C.sun} fontFamily="Shrikhand, serif" fontSize="34">
        <text x="236" y="102">z</text>
        <text x="262" y="78" fontSize="44">z</text>
      </g>
    </svg>
  );
}

/** Error state: worried gator with a "no signal" badge. */
export function OfflineGator({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="40 40 300 210" className={className} aria-hidden="true">
      <GatorHead eyes="worried" />
      <circle cx="300" cy="86" r="34" fill={C.ember} />
      <g transform="translate(282 68) scale(1.5)" stroke={C.ink} strokeWidth="2.5" strokeLinecap="round" fill="none">
        <path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4-2.4M19 13a10 10 0 0 0-2.3-1.6" />
      </g>
    </svg>
  );
}

/** Small postcard header for the results card. */
export function PostcardStrip({ className = '' }: { className?: string }) {
  const clipId = `strip-${useId().replace(/:/g, '')}`;
  return (
    <svg viewBox="0 0 340 90" className={className} aria-hidden="true" preserveAspectRatio="xMidYMax slice">
      <rect width="340" height="90" fill={C.sun} />
      <clipPath id={clipId}>
        <rect x="115" y="20" width="110" height="70" />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <circle cx="170" cy="90" r="54" fill={C.pink} />
        {[52, 64, 76].map((y) => (
          <rect key={y} x="115" y={y} width="110" height="5" fill={C.sun} />
        ))}
      </g>
      <g stroke={C.ink} strokeWidth="5" strokeLinecap="round" fill="none">
        <path d="M44 90 Q48 50 60 30" />
        <path d="M60 30 Q38 18 20 32 M60 30 Q56 12 38 8 M60 30 Q78 16 96 26 M60 30 Q74 40 78 56" />
      </g>
      <g transform="translate(212 22) scale(0.4)">
        <GatorHead />
      </g>
      <path d="M0 88 H340" stroke={C.ink} strokeWidth="4" />
    </svg>
  );
}

