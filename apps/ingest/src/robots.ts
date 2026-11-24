/**
 * robots.txt evaluation (RFC 9309), runtime-neutral (Node CLI + Workers).
 *
 * - Group selection: the group whose user-agent token is the longest case-insensitive prefix of our
 *   product token; otherwise "*". Rules of all groups naming the same agent are merged.
 * - Rule matching: longest matching path pattern wins ("*" wildcard, "$" end anchor); on a tie,
 *   allow wins. An empty Disallow allows everything.
 * - Fetch outcomes (RFC 9309 §2.3.1): 2xx → parse; 4xx → no restrictions; 5xx / network / redirect
 *   off-host → treat as complete disallow (fail closed).
 */

export type RobotsVerdict = { allowed: boolean; reason: string };

type Rule = { allow: boolean; pattern: string };

const MAX_ROBOTS_CHARS = 500 * 1024;

function parseGroups(text: string): { agents: string[]; rules: Rule[] }[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.slice(0, MAX_ROBOTS_CHARS).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      if (key === 'disallow' && value === '') continue; // "Disallow:" = allow all
      current.rules.push({ allow: key === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function toRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Is `pathAndQuery` (e.g. "/feed/?x=1") allowed for `userAgent` (product token, e.g. "gta-or-florida-ingest")? */
export function robotsAllows(robotsTxt: string, userAgent: string, pathAndQuery: string): RobotsVerdict {
  const ua = userAgent.toLowerCase();
  const groups = parseGroups(robotsTxt);
  let best = -1;
  for (const g of groups) for (const a of g.agents) if (a !== '*' && ua.startsWith(a) && a.length > best) best = a.length;
  const chosen = best >= 0 ? groups.filter((g) => g.agents.some((a) => a !== '*' && ua.startsWith(a) && a.length === best)) : groups.filter((g) => g.agents.includes('*'));
  const label = best >= 0 ? 'specific user-agent group' : chosen.length ? 'user-agent * group' : 'no applicable group';
  let match: Rule | null = null;
  for (const r of chosen.flatMap((g) => g.rules)) {
    if (!toRegExp(r.pattern).test(pathAndQuery)) continue;
    const len = r.pattern.replace(/\$$/, '').length;
    const bestLen = match ? match.pattern.replace(/\$$/, '').length : -1;
    if (len > bestLen || (len === bestLen && r.allow && !match!.allow)) match = r;
  }
  if (!match) return { allowed: true, reason: `${label}: no matching rule` };
  return { allowed: match.allow, reason: `${label}: ${match.allow ? 'Allow' : 'Disallow'}: ${match.pattern}` };
}

/** Map a robots.txt fetch outcome to a verdict for one path (RFC 9309 §2.3.1). */
export function robotsVerdictFor(fetchResult: { status: number; body?: string } | { error: string }, userAgent: string, pathAndQuery: string): RobotsVerdict {
  if ('error' in fetchResult) return { allowed: false, reason: `robots.txt unreachable (${fetchResult.error.slice(0, 80)}): fail closed` };
  const { status, body } = fetchResult;
  if (status >= 200 && status < 300) return robotsAllows(body ?? '', userAgent, pathAndQuery);
  if (status >= 400 && status < 500) return { allowed: true, reason: `robots.txt HTTP ${status}: no restrictions` };
  return { allowed: false, reason: `robots.txt HTTP ${status}: fail closed` };
}

/** Product token of a User-Agent string ("gta-or-florida-ingest/0.4 (…)" → "gta-or-florida-ingest"). */
export const productToken = (userAgent: string) => userAgent.trim().split(/[\s/]/)[0]!.toLowerCase();
