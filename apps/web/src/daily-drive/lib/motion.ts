import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** OS setting, or `body.rm` (used by the dev panel's "simulate reduced motion" toggle). */
export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.body?.classList.contains('rm')) return true;
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches;
}

export function useReducedMotion(): boolean {
  const [rm, setRm] = useState(prefersReducedMotion);
  useEffect(() => {
    const update = () => setRm(prefersReducedMotion());
    const mq = typeof matchMedia === 'function' ? matchMedia(QUERY) : null;
    mq?.addEventListener('change', update);
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(update) : null;
    if (mo && document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      mq?.removeEventListener('change', update);
      mo?.disconnect();
    };
  }, []);
  return rm;
}
