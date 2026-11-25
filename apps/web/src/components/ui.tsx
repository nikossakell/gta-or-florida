import { Link, type LinkProps } from '@tanstack/react-router';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { CalendarIcon, HomeIcon } from './Icons.tsx';

const base =
  'inline-flex items-center justify-center gap-3 rounded-2xl text-center transition-transform duration-100 select-none disabled:cursor-not-allowed disabled:opacity-60';

const variants = {
  /** Sunset-yellow primary with a pink "3D" lip. */
  primary:
    `${base} btn-wide min-h-16 px-6 border-[3px] border-ink bg-sun text-ink text-xl shadow-[0_8px_0_var(--color-pink)] ` +
    'hover:brightness-105 active:translate-y-1 active:shadow-[0_4px_0_var(--color-pink)] sm:text-2xl',
  /** Same look as primary, for tight rows. */
  primaryCompact:
    `${base} btn-wide min-h-16 px-4 border-[3px] border-ink bg-sun text-ink text-lg whitespace-nowrap shadow-[0_8px_0_var(--color-pink)] ` +
    'hover:brightness-105 active:translate-y-1 active:shadow-[0_4px_0_var(--color-pink)] sm:text-xl',
  secondary: `${base} min-h-14 px-5 border-[3px] border-line bg-transparent text-cream font-bold text-lg hover:border-dim hover:bg-white/5`,
  pill: `${base} min-h-12 rounded-full border-[3px] border-line px-4 font-bold sm:px-5 text-cream hover:border-dim`,
} as const;

export type ButtonVariant = keyof typeof variants;

export function buttonClass(variant: ButtonVariant, extra = ''): string {
  return `${variants[variant]} ${extra}`.trim();
}

export function Button({ variant = 'primary', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type="button" className={buttonClass(variant, className)} {...rest} />;
}

export function ButtonLink({ variant = 'primary', className = '', ...rest }: LinkProps & { variant?: ButtonVariant; className?: string; children?: ReactNode }) {
  return <Link className={buttonClass(variant, className)} {...rest} />;
}

const iconBtn =
  'inline-flex size-14 shrink-0 items-center justify-center rounded-2xl border-[3px] border-line bg-card text-cream hover:border-dim active:translate-y-0.5';

export function IconLink({ label, children, ...rest }: LinkProps & { label: string; children: ReactNode }) {
  return (
    <Link aria-label={label} title={label} className={iconBtn} {...rest}>
      {children}
    </Link>
  );
}

export function IconButton({ label, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" aria-label={label} title={label} className={`${iconBtn} ${className}`} {...rest} />;
}

export function Wordmark({ size = 'sm', as: Tag = 'p' }: { size?: 'sm' | 'lg'; as?: 'p' | 'h1' }) {
  if (size === 'lg') {
    return (
      <Tag className="font-display leading-[0.95] text-balance">
        <span className="text-pink text-7xl sm:text-8xl">GTA</span> <span className="text-cream text-4xl sm:text-5xl">or</span>
        <br />
        <span className="text-teal text-7xl sm:text-8xl">Florida?</span>
      </Tag>
    );
  }
  return (
    <Tag className="font-display text-2xl leading-none sm:text-3xl">
      <span className="text-pink">GTA</span> <span className="text-cream">or</span> <span className="text-teal">Florida?</span>
    </Tag>
  );
}

/** Home · wordmark · archive. */
export function TopBar({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <header className="flex items-center justify-between gap-3 py-4">
      <IconLink to="/" label="Home">
        <HomeIcon />
      </IconLink>
      {wordmark && (
        <Link to="/" className="rounded-xl px-1" aria-label="GTA or Florida? home">
          <Wordmark />
        </Link>
      )}
      <IconLink to="/archive" label="Past rounds">
        <CalendarIcon />
      </IconLink>
    </header>
  );
}

/** Narrow, centered gameplay column (~520px). */
export function Column({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[520px] px-5 pb-12 ${className}`}>{children}</div>;
}

export function Badge({ children, tone = 'sun' }: { children: ReactNode; tone?: 'sun' | 'pink' | 'teal' }) {
  const tones = { sun: 'border-sun text-sun', pink: 'border-pink text-pink', teal: 'border-teal text-teal' };
  return <span className={`label-wide inline-flex items-center rounded-full border-[3px] px-4 py-1.5 text-xs sm:text-sm ${tones[tone]}`}>{children}</span>;
}

/** Spoiler policy notice (Nov 2026): shown discreetly in the footer of both landing variants and on About. */
export const SPOILER_NOTICE = 'Some questions may contain minor spoilers from the Grand Theft Auto series.';

export function Disclaimer({ className = '' }: { className?: string }) {
  return (
    <p className={`text-dim text-center text-sm ${className}`}>
      Fan-made parody game. Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive.{' '}
      <Link to="/about" className="text-muted underline underline-offset-4 hover:text-cream">
        About &amp; privacy
      </Link>
      <span className="mt-1 block">{SPOILER_NOTICE}</span>
    </p>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
