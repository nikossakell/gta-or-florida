export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

export function publicUrl(): string {
  const configured = import.meta.env.VITE_PUBLIC_URL;
  if (configured) return configured;
  if (typeof window === 'undefined') return '';
  // Include the base path so project sites (user.github.io/repo/) share the right link.
  return new URL(import.meta.env.BASE_URL, window.location.origin).href.replace(/\/$/, '');
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<'copied' | 'failed'> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
  } catch {
    /* fall through to legacy copy */
  }
  return legacyCopy(text) ? 'copied' : 'failed';
}

/** Native share sheet when available, otherwise copy to clipboard. */
export async function shareText(text: string): Promise<ShareOutcome> {
  const data: ShareData = { text };
  if (typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare(data))) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (error) {
      if ((error as Error).name === 'AbortError') return 'cancelled';
      // NotAllowedError etc. → try copying instead.
    }
  }
  return copyText(text);
}
