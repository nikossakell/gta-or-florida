// Pure helpers for the review dashboard (no DOM): filtering, search, navigation. Unit-tested.

export const STATUS_LABELS = {
  unreviewed: 'Unreviewed',
  approved: 'Approved',
  investigate: 'Investigate',
  rejected: 'Rejected',
};

export const RECOMMENDATION_LABELS = {
  approve: 'Suggests approve',
  investigate: 'Suggests investigate',
  reject: 'Suggests reject',
};

/** Status shown for a list item (the reviewer's decision). */
export function displayStatus(item) {
  return item.status;
}

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * f: { origin: ''|'FLORIDA'|'GTA', status: ''|status, difficulty: ''|'1'|'2'|'3', source: ''|host,
 *      warning: ''|'any'|'none'|<code>|'rec:approve'|'rec:investigate'|'rec:reject', q: string }
 */
export function filterItems(items, f = {}) {
  const q = norm(f.q).trim();
  return items.filter((it) => {
    if (f.origin && it.origin !== f.origin) return false;
    if (f.status && displayStatus(it) !== f.status) return false;
    if (f.difficulty && String(it.difficulty) !== String(f.difficulty)) return false;
    if (f.source && it.sourceHost !== f.source) return false;
    if (f.warning) {
      if (f.warning === 'any' && it.warningCodes.length === 0) return false;
      if (f.warning === 'none' && it.warningCodes.length > 0) return false;
      if (f.warning.startsWith('rec:') && it.recommendation !== f.warning.slice(4)) return false;
      if (!['any', 'none'].includes(f.warning) && !f.warning.startsWith('rec:') && !it.warningCodes.includes(f.warning)) return false;
    }
    if (q) {
      const hay = norm(`${it.headline} ${it.eventId} ${it.sourceHost} ${it.publisher ?? ''} ${it.game ?? ''}`);
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** The next unreviewed item after `currentId` in `items` order (wrapping), or null. */
export function nextUnreviewed(items, currentId) {
  if (!items.length) return null;
  const start = items.findIndex((it) => it.eventId === currentId);
  for (let k = 1; k <= items.length; k++) {
    const it = items[(start + k + items.length) % items.length];
    if (it && displayStatus(it) === 'unreviewed' && it.eventId !== currentId) return it.eventId;
  }
  return null;
}

/** Previous/next neighbour in the (filtered) order, or null at the ends. */
export function neighbour(items, currentId, step) {
  const i = items.findIndex((it) => it.eventId === currentId);
  if (i < 0) return items[0]?.eventId ?? null;
  return items[i + step]?.eventId ?? null;
}

export function sourceOptions(items) {
  const counts = new Map();
  for (const it of items) counts.set(it.sourceHost, (counts.get(it.sourceHost) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([host, n]) => ({ host, n }));
}

export function warningOptions(items) {
  const counts = new Map();
  for (const it of items) for (const c of it.warningCodes) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, n]) => ({ code, n }));
}

