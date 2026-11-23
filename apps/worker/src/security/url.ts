/**
 * Static URL safety for stored references. Network-level checks (DNS pinning,
 * per-hop redirect validation) happen in the Node job before import; the Worker
 * never fetches source URLs itself.
 */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.test', '.example', '.invalid'];

export function unsafeReferenceUrl(raw: string, opts: { allowInvalidTld?: boolean } = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'URL_MALFORMED';
  }
  if (url.protocol !== 'https:') return 'URL_NOT_HTTPS';
  if (url.username || url.password) return 'URL_CREDENTIALS';
  if (url.port && url.port !== '443') return 'URL_PORT';
  const host = url.hostname.toLowerCase();
  if (IPV4.test(host) || host.startsWith('[')) return 'URL_IP_LITERAL';
  if (!host.includes('.') || host === 'localhost') return 'URL_LOCAL_HOST';
  if (opts.allowInvalidTld && host.endsWith('.invalid')) return null;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return 'URL_LOCAL_HOST';
  return null;
}
