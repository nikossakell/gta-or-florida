/**
 * Per-INSTANCE subrequest budgeting for Workflows on Workers Free.
 *
 * Facts (developers.cloudflare.com, read 2026-11-24):
 *  - Free: "50 external subrequests and 1,000 subrequests to Cloudflare services per invocation"
 *    (Workflows limits). Steps do not reset it: staging instance cf_fbad78… failed after ~52 calls
 *    spread over 8 steps, including a Service Binding call.
 *  - "Each request to a Worker via a Service binding counts toward your subrequest limit."
 *  - "Each subrequest in a redirect chain counts against this limit."
 *  - Workers AI and Workflow-binding calls: bucket not stated → counted here, conservatively.
 *
 * Two layers:
 *  1. `SubrequestPlan` — deterministic RESERVATIONS made before each step from worst-case costs
 *     (every hop, every retry). A step that does not fit is deferred, never half-run. Because the
 *     plan depends only on config and earlier step outputs, a Workflow replay reaches the same plan.
 *  2. `SubrequestMeter` — counts ACTUAL outgoing calls and throws before the plan's ceiling would
 *     be crossed (defense in depth; should never fire if the reservations are right).
 */

export const CATEGORIES = ['api', 'discovery', 'link_check', 'ai', 'workflow'] as const;
export type SubrequestCategory = (typeof CATEGORIES)[number];

/** Worst-case subrequests per unit of work (keep in sync with the clients' retry/redirect settings). */
export const COST = {
  /** Service Binding call to the API Worker; the client is built with maxRetries 0. */
  apiCall: 1,
  /** One DOJ API page: redirect "manual", no retries. */
  dojPage: 1,
  /** One dataset day file: redirect "manual", no retries. */
  datasetDay: 1,
  /** robots.txt (1 + 3 same-host hops) + feed (1 + 3 hops). */
  rssFeed: 8,
  /** One GDELT query: 1 + 2 retries (429 is never retried). */
  gdeltQuery: 3,
  /** Wiki members: (categorymembers + resolve) × (1 + 1 retry) = 4 external, + 1 API "known" call. */
  wikiMembersExternal: 4,
  wikiMembersApi: 1,
  /** One wiki page: 1 + 1 retry. */
  wikiPage: 2,
  /** Link check with ≤ 2 redirects: 3 hops × (HEAD + GET fallback). */
  linkCheck: 6,
  /** Workers AI: triage + extract. */
  aiItem: 2,
  /** Starting the next backfill instance. */
  workflowCreate: 1,
} as const;

export const LINK_MAX_REDIRECTS = 2;

/** Worst-case items one discovery step can add (drives the dedupe/import tail reservation). */
export const MAX_ITEMS = { dojPage: 50, datasetDay: 120, rssFeed: 100, gdeltQuery: 100, wikiPage: 50 } as const;

export class SubrequestBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubrequestBudgetError';
  }
}

export type TailInput = { items: number; kinds: number; titlePagesPerKind: number; dryRun: boolean };

/** Calls that must ALWAYS remain available after discovery: dedupe, title index, import/guards, inventory. */
export function tailCost(t: TailInput): number {
  const known = Math.ceil(t.items / 90);
  const titles = t.kinds * t.titlePagesPerKind;
  // A dry run imports nothing but may persist the GDELT cooldown (one call); a real run imports in chunks of 20.
  const imports = t.dryRun ? 1 : Math.max(1, Math.ceil(t.items / 20));
  const inventory = 1;
  return (known + titles + imports + inventory) * COST.apiCall;
}

export class SubrequestPlan {
  readonly reserved: Record<SubrequestCategory, number> = { api: 0, discovery: 0, link_check: 0, ai: 0, workflow: 0 };
  constructor(readonly limit: number) {}

  get total(): number {
    return CATEGORIES.reduce((n, c) => n + this.reserved[c], 0);
  }
  remaining(): number {
    return this.limit - this.total;
  }
  /** Reserve `n` if `n + keep` still fits (keep = calls that must stay available afterwards). */
  tryReserve(category: SubrequestCategory, n: number, keep = 0): boolean {
    if (n < 0 || this.total + n + keep > this.limit) return false;
    this.reserved[category] += n;
    return true;
  }
  /** Reservation that must succeed (programming error otherwise). */
  reserve(category: SubrequestCategory, n: number): void {
    if (!this.tryReserve(category, n)) throw new SubrequestBudgetError(`subrequest plan exceeded: ${category} +${n} with ${this.total}/${this.limit} reserved`);
  }
}

export class SubrequestMeter {
  readonly used: Record<SubrequestCategory, number> = { api: 0, discovery: 0, link_check: 0, ai: 0, workflow: 0 };
  constructor(readonly limit: number) {}
  get total(): number {
    return CATEGORIES.reduce((n, c) => n + this.used[c], 0);
  }
  /** Count one outgoing call; refuse it if the instance ceiling would be crossed. */
  take(category: SubrequestCategory): void {
    if (this.total + 1 > this.limit) throw new SubrequestBudgetError(`subrequest ceiling ${this.limit} reached (${category}); deferring the rest of this run`);
    this.used[category]++;
  }
}

/** fetch() wrapper: every call — including each redirect hop and retry — passes through `take`. */
export function meteredFetch(fetchImpl: typeof fetch, meter: SubrequestMeter, category: SubrequestCategory): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    meter.take(category);
    return fetchImpl(input as never, init);
  }) as typeof fetch;
}

/** True for Cloudflare's own limit error, which a retry cannot fix in the same invocation. */
export const isSubrequestLimitError = (e: unknown) => e instanceof SubrequestBudgetError || /too many subrequests/i.test(String((e as Error)?.message ?? e));
