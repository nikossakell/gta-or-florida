/**
 * Runtime-neutral URL safety + link checking (Node CLI and Cloudflare Workers).
 *
 * Shape rules apply everywhere: https only, port 443, no credentials, no IP
 * literals, no local hostnames. Redirects are followed manually and every hop
 * is re-validated, so a public URL can never bounce us to a disallowed target.
 *
 * DNS-level protection is runtime-specific:
 *  - Node (verify.ts) resolves through a socket `lookup` that refuses private answers.
 *  - Workers have no DNS API; outbound fetch leaves from Cloudflare's edge, which
 *    cannot reach the operator's private networks. The shape rules still block
 *    literal internal addresses and local names.
 */

export type LinkCheckResult =
  | { status: 'ok'; finalUrl: string; httpStatus: number; redirects: number }
  | { status: 'broken'; reason: string; httpStatus?: number; finalUrl?: string };

export type LinkRequest = (url: URL, method: 'HEAD' | 'GET') => Promise<{ status: number; location?: string }>;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for IPv4 dotted quads and IPv6 literals (URL hostnames keep IPv6 in brackets). */
export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return IPV4.test(h) || h.includes(':');
}

/**
 * Validates the URL shape before any network access. Returns an error message or null.
 * `isBlockedIp` (Node: BlockList) only refines the message for IP literals; every literal is refused.
 */
export function unsafeUrlReason(raw: string, isBlockedIp?: (ip: string) => boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'https:') return 'only https links are checked automatically (use --link-verified-manually after opening it yourself)';
  if (url.username || url.password) return 'credentials in URL';
  if (url.port && url.port !== '443') return 'non-standard port';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIpLiteral(host)) {
    if (!isBlockedIp) return 'IP address literals are not accepted as sources';
    return isBlockedIp(host) ? 'private or reserved address' : 'bare IP addresses are not accepted as sources';
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) return 'local hostname';
  return null;
}

/** Manual redirect walk with per-hop validation; `send` performs one request without following redirects. */
export async function checkLinkWith(
  raw: string,
  send: LinkRequest,
  opts: { maxRedirects?: number; isBlockedIp?: (ip: string) => boolean } = {},
): Promise<LinkCheckResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const reason = unsafeUrlReason(current, opts.isBlockedIp);
    if (reason) return { status: 'broken', reason: hop ? `redirect target rejected: ${reason}` : reason, finalUrl: current };
    const url = new URL(current);
    let res: { status: number; location?: string };
    try {
      res = await send(url, 'HEAD');
      // Many publishers reject HEAD; retry once with GET (body is not read).
      if (res.status === 405 || res.status === 403 || res.status === 501) res = await send(url, 'GET');
    } catch (error) {
      return { status: 'broken', reason: (error as Error).message, finalUrl: current };
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, url).toString();
      continue;
    }
    if (res.status >= 200 && res.status < 300) return { status: 'ok', finalUrl: current, httpStatus: res.status, redirects: hop };
    return { status: 'broken', reason: `HTTP ${res.status}`, httpStatus: res.status, finalUrl: current };
  }
  return { status: 'broken', reason: `more than ${maxRedirects} redirects` };
}

/** fetch()-based single hop for Workers: redirect "manual", body cancelled unread. */
export function fetchLinkRequest(opts: { userAgent: string; timeoutMs?: number; fetchImpl?: typeof fetch }): LinkRequest {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (url, method) => {
    const res = await fetchImpl(url.toString(), {
      method,
      redirect: 'manual',
      headers: { 'user-agent': opts.userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, location: res.headers.get('location') ?? undefined };
  };
}

/** Convert a check into the import contract's LinkCheck (https final URLs only). */
export function toLinkCheck(r: LinkCheckResult, now: Date = new Date()): import('@gof/core').LinkCheck {
  const finalUrl = r.finalUrl && /^https:\/\//.test(r.finalUrl) ? r.finalUrl.slice(0, 2048) : null;
  return {
    status: r.status === 'ok' ? 'ok' : 'broken',
    httpStatus: r.httpStatus ?? null,
    finalUrl,
    checkedAt: now.toISOString(),
    ...(r.status === 'broken' ? { note: r.reason.slice(0, 200) } : {}),
  };
}
