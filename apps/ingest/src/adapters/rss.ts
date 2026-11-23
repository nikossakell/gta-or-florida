/**
 * Config-driven RSS/Atom discovery for publishers whose source policy the owner
 * has APPROVED in packages/config/sources.policy.json. Feeds of unreviewed or
 * blocked sources are never fetched. Only metadata is kept (title, link, date,
 * guid) — never article bodies, images or HTML.
 */
import { cleanText } from '@gof/core';
import type { SourcePolicy } from '@gof/core';
import type { PoliteJsonClient } from './http.ts';

export type FeedConfig = { id: string; url: string; sourceId: string };
export type FeedItem = { title: string; link: string; publishedAt: string | null; guid: string | null };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ') // never keep markup from a feed
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decode(m[1]!).trim() : null;
}

function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Parse RSS 2.0 <item> or Atom <entry> blocks. Malformed entries are skipped, not fatal. */
export function parseFeed(xml: string, maxItems = 100): FeedItem[] {
  if (/<!DOCTYPE[^>]*\[/i.test(xml)) return []; // refuse inline DTDs (entity expansion)
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  const out: FeedItem[] = [];
  for (const block of blocks.slice(0, maxItems)) {
    const title = cleanText(tag(block, 'title') ?? '', 400);
    let link = tag(block, 'link');
    if (!link) link = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(block)?.[1] ?? null;
    if (!title || !link) continue;
    out.push({
      title,
      link: decode(link).trim(),
      publishedAt: toIsoDate(tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated') ?? tag(block, 'dc:date')),
      guid: cleanText(tag(block, 'guid') ?? tag(block, 'id') ?? '', 300) || null,
    });
  }
  return out;
}

/** Feeds allowed to run: the configured source exists AND its policy is approved. */
export function allowedFeeds(feeds: readonly FeedConfig[], lookup: (id: string) => SourcePolicy | undefined): { allowed: FeedConfig[]; refused: { id: string; reason: string }[] } {
  const allowed: FeedConfig[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const f of feeds) {
    const src = lookup(f.sourceId);
    if (!src) refused.push({ id: f.id, reason: `unknown source ${f.sourceId}` });
    else if (src.licenseStatus !== 'approved') refused.push({ id: f.id, reason: `source ${src.id} is ${src.licenseStatus}` });
    else if (!/^https:\/\//.test(f.url) || !src.hosts.some((h) => new URL(f.url).hostname === h || new URL(f.url).hostname.endsWith(`.${h}`))) {
      refused.push({ id: f.id, reason: 'feed URL is not https on the source host' });
    } else allowed.push(f);
  }
  return { allowed, refused };
}

export async function fetchFeed(client: PoliteJsonClient, feed: FeedConfig): Promise<FeedItem[]> {
  return parseFeed(await client.getText(new URL(feed.url)));
}
