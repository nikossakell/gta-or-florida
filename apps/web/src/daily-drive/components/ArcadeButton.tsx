import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ArcadeVariant = 'gta' | 'florida' | 'primary' | 'next' | 'share';

const VARIANT: Record<ArcadeVariant, string> = { gta: 'gta', florida: 'fl', primary: 'go', next: 'next', share: 'share' };

export function arcadeClass(variant: ArcadeVariant, extra = ''): string {
  return `arcade ${VARIANT[variant]} ${extra}`.trim();
}

/** Kit `.arcade` button: hover lift, pressed drop, disabled after a pick (CSS only). */
export const ArcadeButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ArcadeVariant; big: ReactNode; hint?: ReactNode }>(
  function ArcadeButton({ variant = 'primary', big, hint, className = '', ...rest }, ref) {
    return (
      <button ref={ref} type="button" className={arcadeClass(variant, className)} {...rest}>
        <span className="big">{big}</span>
        {hint && <span className="key">{hint}</span>}
      </button>
    );
  },
);
