/**
 * Source-link verification with SSRF protection.
 *
 * Only URLs already stored in our own database are ever checked (never a URL
 * from a request body). Every hop is https, its DNS answer must be a public
 * unicast address (checked inside the socket's lookup, so there is no
 * resolve-then-connect gap for DNS rebinding), and redirects are followed
 * manually with the same checks, up to a small limit. Bodies are not read.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/** True for loopback, private (RFC 1918 / ULA), link-local, CGNAT, multicast, reserved and documentation ranges. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    // IPv4-mapped IPv6 is unwrapped and checked as IPv4. (No ::ffff:0:0/96 rule: BlockList
    // applies IPv6-mapped rules to plain IPv4 lookups too, which would block every address.)
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

export type LinkCheckResult =
  | { status: 'ok'; finalUrl: string; httpStatus: number; redirects: number }
  | { status: 'broken'; reason: string; httpStatus?: number; finalUrl?: string };

export type LinkCheckOptions = {
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Test seam: replaces the network request. */
  requestImpl?: (url: URL, method: 'HEAD' | 'GET') => Promise<{ status: number; location?: string }>;
};

/** Validates the URL shape before any network access. Returns an error message or null. */
export function unsafeUrlReason(raw: string): string | null {
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
  if (isIP(host) && isBlockedAddress(host)) return 'private or reserved address';
  if (isIP(host)) return 'bare IP addresses are not accepted as sources';
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) return 'local hostname';
  return null;
}

function safeLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || list.length === 0) {
      const e = new Error(`Refusing to connect: ${hostname} resolves to a non-public address`) as NodeJS.ErrnoException;
      e.code = 'EBLOCKED';
      return callback(e, '', 0);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
}

function nodeRequest(url: URL, method: 'HEAD' | 'GET', timeoutMs: number, userAgent: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      url,
      {
        method,
        lookup: safeLookup as never,
        timeout: timeoutMs,
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      },
      (res) => {
        res.resume(); // never read bodies
        const location = res.headers.location;
        resolvePromise({ status: res.statusCode ?? 0, location: Array.isArray(location) ? location[0] : location });
        res.destroy();
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

export async function checkLink(raw: string, opts: LinkCheckOptions = {}): Promise<LinkCheckResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const userAgent = opts.userAgent ?? 'gta-or-florida-linkcheck/0.2';
  const send = opts.requestImpl ?? ((u: URL, m: 'HEAD' | 'GET') => nodeRequest(u, m, timeoutMs, userAgent));

  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const reason = unsafeUrlReason(current);
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

/** Convert a network check into the import contract's LinkCheck (https final URLs only). */
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
