/**
 * Grand Theft Wiki (MediaWiki Action API) adapter for documented in-universe GTA events.
 *
 *   API:        https://www.grandtheftwiki.com/api.php
 *   Members:    https://www.mediawiki.org/wiki/API:Categorymembers  (paged via continue.cmcontinue)
 *   Redirects:  action=query&redirects=1 → { from, to, tofragment }
 *   Content:    action=parse&prop=wikitext|sections
 *   Licensing:  https://www.grandtheftwiki.com/Grand_Theft_Wiki:Licensing
 *
 * Verified wiki structure (Category:Liberty Tree Articles):
 *  - Issue pages ("Liberty Tree Articles in GTA III/February 2001") hold several
 *    in-game articles as level-3 sections under "== Articles ==".
 *  - Many category members are *redirects* to one of those sections
 *    ("Car Jacking Back in Vogue" → …/February 2001#Car Jacking Back in Vogue).
 *  - Other members are standalone article pages with a single "Article" section.
 *
 * Identity of one in-game article = page id + section anchor. Redirect aliases are
 * recorded as metadata and never become separate incidents. One page is never
 * treated as one incident unless it really is a single article/mission.
 *
 * The wiki's CC licence covers contributors' text, NOT Rockstar's in-game text,
 * art or screenshots. We store the section heading as internal reference only;
 * players see an independently written summary.
 */
import type { GtaGame } from '@gof/core';
import { createPoliteJsonClient, UpstreamError, type FetchFn } from './http.ts';

export type WikiMember = { pageid: number; title: string; ns: number };

export type WikiResolution = {
  /** Title as listed in the category. */
  memberTitle: string;
  targetPageId: number;
  targetTitle: string;
  /** Section the redirect points at (display text), if any. */
  fragment: string | null;
  isRedirect: boolean;
};

export type WikiSection = { level: number; line: string; anchor: string; index: string };

export type WikiPage = {
  pageid: number;
  title: string;
  revid: number;
  wikitext: string;
  sections: WikiSection[];
  categories: string[];
};

export type ExtractionKind = 'issue_section' | 'issue_section_unlinked' | 'article_page' | 'page';

export type WikiArticle = {
  /** Stable provider key: "<pageid>#<anchor>" or "<pageid>" for whole-page items. */
  key: string;
  pageId: number;
  revId: number;
  pageTitle: string;
  sectionAnchor: string | null;
  /** In-game headline / mission name (internal reference, not cleared for reuse). */
  headline: string;
  /** Human-readable wiki URL, with #section when applicable. */
  url: string;
  /** Stable permalink by page id (survives renames). Used as canonical URL. */
  canonicalUrl: string;
  extraction: ExtractionKind;
  gameHint: GtaGame | null;
  outlet: string | null;
  /** Plain-text excerpt for the reviewer. Internal only, never served publicly. */
  lead: string;
  /** Rockstar's original page for the article, when the heading links to it. */
  originalInGameUrl: string | null;
  aliases: string[];
  needsReviewReason?: string;
};

export type ExtractMode = 'sections' | 'pages';

// ---------------------------------------------------------------------------
// Wikitext helpers (pure)
// ---------------------------------------------------------------------------

/** Remove [[File:…]] / [[Image:…]] links, which can nest other links in captions. */
function stripFileLinks(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('[[', i) && /^\[\[\s*(file|image):/i.test(text.slice(i, i + 12))) {
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        if (text.startsWith('[[', j)) {
          depth++;
          j++;
        } else if (text.startsWith(']]', j)) {
          depth--;
          j++;
          if (depth === 0) break;
        }
      }
      i = j + 1;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Best-effort wikitext → plain text, for headings and reviewer excerpts. */
export function wikitextToPlain(text: string): string {
  return stripFileLinks(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{\s*quote\s*\|/gi, '') // keep the quoted article body
    .replace(/\{\{[^{}]*\}\}/g, '') // drop other (non-nested) templates
    .replace(/\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/[^\s\]]+\]/g, '')
    .replace(/'{2,}/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** "Car Jacking Back in Vogue" and "Car_Jacking_Back_in_Vogue" compare equal. */
export function anchorKey(text: string): string {
  return text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** MediaWiki-style anchor for a heading's display text (fallback when the API gives none). */
export function computeAnchor(line: string): string {
  return line.trim().replace(/\s+/g, '_');
}

function encodeTitle(title: string): string {
  return encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':');
}

function encodeFragment(anchor: string): string {
  return encodeURIComponent(anchor).replace(/%3A/g, ':');
}

const GAME_PATTERNS: [RegExp, GtaGame][] = [
  [/\bVice City Stories\b/i, 'GTA_VCS'],
  [/\bLiberty City Stories\b/i, 'GTA_LCS'],
  [/\bChinatown Wars\b/i, 'GTA_CW'],
  [/\bThe Lost and Damned\b/i, 'GTA_TLAD'],
  [/\bBallad of Gay Tony\b/i, 'GTA_TBOGT'],
  [/\bGTA Online\b|\bGrand Theft Auto Online\b/i, 'GTA_ONLINE'],
  [/\bGTA Advance\b|\bGrand Theft Auto Advance\b/i, 'GTA_ADVANCE'],
  [/\bLondon 19(61|69)\b/i, 'GTA_LONDON'],
  [/\bSan Andreas\b(?! in GTA)/i, 'GTA_SA'],
  [/\bVice City\b(?! in GTA)/i, 'GTA_VC'],
  [/\bGTA VI\b|\bGrand Theft Auto VI\b/i, 'GTA_VI'],
  [/\bGTA IV\b|\bGrand Theft Auto IV\b/i, 'GTA_IV'],
  [/\bGTA V\b|\bGrand Theft Auto V\b/i, 'GTA_V'],
  [/\bGTA III\b|\bGrand Theft Auto III\b/i, 'GTA_III'],
  [/\bGTA 2\b|\bGrand Theft Auto 2\b/i, 'GTA_2'],
  [/\bGTA 1\b/i, 'GTA_1'],
];

/** Explicit "in GTA X" suffix in a page or category title, e.g. "Missions in GTA V". */
function gameFromTitle(title: string): GtaGame | null {
  const m = /\bin (GTA [^/]+|The Lost and Damned|The Ballad of Gay Tony)(?:\/|$)/i.exec(title);
  return m ? detectGame(m[1]!) : null;
}

/** Heuristic game hint. A reviewer must confirm the game at approval time. */
export function detectGame(text: string): GtaGame | null {
  // Earliest mention wins (the lead sentence usually names the game first); ties go to the more specific pattern.
  let best: { index: number; game: GtaGame } | null = null;
  for (const [re, game] of GAME_PATTERNS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { index: m.index, game };
  }
  return best?.game ?? null;
}

type RawHeading = { level: number; raw: string; start: number; bodyStart: number };

function headingsOf(wikitext: string): RawHeading[] {
  const out: RawHeading[] = [];
  const re = /^(={1,6})\s*(.+?)\s*\1\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wikitext))) out.push({ level: m[1]!.length, raw: m[2]!, start: m.index, bodyStart: m.index + m[0].length });
  return out;
}

const META_SECTIONS = new Set(
  ['trivia', 'gallery', 'see also', 'references', 'external link', 'external links', 'navigation', 'notes', 'video', 'videos', 'bugs', 'glitches', 'achievements', 'trophies'].map(
    (s) => s,
  ),
);

/** Newspaper columns that usually bundle several short items under one heading. */
const COLUMN_HEADINGS = /^(world news|local news|business news|entertainment|sports?|weather|letters?|classifieds|horoscopes?|editorial|opinion|in brief|news in brief)\b/i;

function excerpt(text: string, max = 420): string {
  const plain = wikitextToPlain(text).replace(/\n+/g, ' ');
  return plain.length > max ? `${plain.slice(0, max).replace(/\s+\S*$/, '')}…` : plain;
}

export type ExtractContext = {
  wikiBase: string; // e.g. https://www.grandtheftwiki.com/
  mode: ExtractMode;
  /** Category the page was discovered through (game hint for e.g. "Missions in GTA V"). */
  category?: string;
  aliases?: string[];
};

/**
 * Split one wiki page into distinct in-game articles (pure, deterministic).
 * Returns [] with a reason when the page has no identifiable concrete event.
 */
export function extractArticles(page: WikiPage, ctx: ExtractContext): { articles: WikiArticle[]; skipped?: string } {
  const headings = headingsOf(page.wikitext);
  const anchorsByLine = new Map(page.sections.map((s) => [anchorKey(wikitextToPlain(s.line)), s.anchor]));
  const leadText = page.wikitext.slice(0, headings[0]?.start ?? page.wikitext.length);
  const gameHint =
    gameFromTitle(page.title) ?? detectGame(wikitextToPlain(leadText)) ?? (ctx.category ? gameFromTitle(ctx.category) : null);
  const outlet = /liberty tree/i.test(`${page.title} ${leadText} ${ctx.category ?? ''}`) ? 'Liberty Tree' : null;
  const pageUrl = `${ctx.wikiBase}${encodeTitle(page.title)}`;
  const permalink = `${ctx.wikiBase}index.php?curid=${page.pageid}`;
  const aliases = [...new Set(ctx.aliases ?? [])].sort();

  const bodyOf = (i: number) => {
    const h = headings[i]!;
    const next = headings.slice(i + 1).find((x) => x.level <= h.level);
    return page.wikitext.slice(h.bodyStart, next?.start ?? page.wikitext.length);
  };

  const base = { pageId: page.pageid, revId: page.revid, pageTitle: page.title, gameHint, outlet, aliases };

  // 1) Newspaper issue: level-3 sections under "== Articles ==".
  const articlesIdx = headings.findIndex((h) => h.level === 2 && /^articles?$/i.test(wikitextToPlain(h.raw)));
  if (articlesIdx >= 0 && headings.slice(articlesIdx + 1).some((h) => h.level === 3)) {
    const out: WikiArticle[] = [];
    for (let i = articlesIdx + 1; i < headings.length; i++) {
      const h = headings[i]!;
      if (h.level <= 2) break;
      if (h.level !== 3) continue;
      const line = wikitextToPlain(h.raw);
      if (!line || META_SECTIONS.has(line.toLowerCase())) continue;
      const linked = /^\[(?:https?:)?\/\/[^\s\]]+\s+[^\]]+\]$/.exec(h.raw.trim());
      const inGameUrl = linked ? (/^\[((?:https?:)?\/\/[^\s\]]+)/.exec(h.raw.trim())?.[1] ?? null) : null;
      const anchor = anchorsByLine.get(anchorKey(line)) ?? computeAnchor(line);
      const item: WikiArticle = {
        ...base,
        key: `${page.pageid}#${anchor}`,
        sectionAnchor: anchor,
        headline: line,
        url: `${pageUrl}#${encodeFragment(anchor)}`,
        canonicalUrl: `${permalink}#${encodeFragment(anchor)}`,
        extraction: linked ? 'issue_section' : 'issue_section_unlinked',
        lead: excerpt(bodyOf(i)),
        originalInGameUrl: inGameUrl,
        aliases: aliases.filter((a) => anchorKey(a) === anchorKey(line)),
      };
      if (!linked) item.needsReviewReason = 'Heading is not a linked headline (may be a column with several items); confirm it is one article.';
      else if (COLUMN_HEADINGS.test(line)) item.needsReviewReason = 'Heading looks like a newspaper column that may contain several items; use one concrete item or reject.';
      out.push(item);
    }
    return out.length ? { articles: out } : { articles: [], skipped: 'issue_without_articles' };
  }

  // 2) Standalone article page: one "Article" section.
  const articleIdx = headings.findIndex((h) => /^article$/i.test(wikitextToPlain(h.raw)));
  if (articleIdx >= 0) {
    const headline = wikitextToPlain(/'''(.+?)'''/.exec(leadText)?.[1] ?? page.title).replace(/\.$/, '') || page.title;
    return {
      articles: [
        {
          ...base,
          key: String(page.pageid),
          sectionAnchor: null,
          headline,
          url: pageUrl,
          canonicalUrl: permalink,
          extraction: 'article_page',
          lead: excerpt(bodyOf(articleIdx)),
          originalInGameUrl: null,
        },
      ],
    };
  }

  // 3) Whole-page events (missions, random events), only when explicitly requested.
  if (ctx.mode === 'pages') {
    const lead = excerpt(leadText || page.wikitext);
    if (lead.length < 40) return { articles: [], skipped: 'no_identifiable_event' };
    return {
      articles: [
        {
          ...base,
          key: String(page.pageid),
          sectionAnchor: null,
          headline: page.title,
          url: pageUrl,
          canonicalUrl: permalink,
          extraction: 'page',
          lead,
          originalInGameUrl: null,
          needsReviewReason: 'Whole-page candidate (mission / random event): confirm one concrete in-game event and write an original summary.',
        },
      ],
    };
  }

  return { articles: [], skipped: 'no_identifiable_article' };
}

// ---------------------------------------------------------------------------
// Network client
// ---------------------------------------------------------------------------

export type WikiClientOptions = {
  apiUrl: string;
  userAgent: string;
  timeoutMs?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: UpstreamError, waitMs: number) => void;
};

type ApiError = { error?: { code?: string; info?: string } };

export function createWikiClient(opts: WikiClientOptions) {
  const api = new URL(opts.apiUrl);
  const wikiBase = new URL('/', api).toString();
  const http = createPoliteJsonClient({
    allowedHosts: [api.hostname],
    userAgent: opts.userAgent,
    timeoutMs: opts.timeoutMs,
    minIntervalMs: opts.minIntervalMs,
    maxRetries: opts.maxRetries,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    onRetry: opts.onRetry,
    checkBody(body) {
      const err = (body as ApiError)?.error;
      if (!err) return;
      // https://www.mediawiki.org/wiki/Manual:Maxlag_parameter
      if (err.code === 'maxlag' || err.code === 'ratelimited') throw new UpstreamError('rate_limited', `MediaWiki ${err.code}: ${err.info ?? ''}`, { retryAfterMs: 5000 });
      throw new UpstreamError('api_error', `MediaWiki error ${err.code}: ${err.info ?? ''}`, { retryable: false });
    },
  });

  function url(params: Record<string, string>): URL {
    const u = new URL(api);
    for (const [k, v] of Object.entries({ format: 'json', formatversion: '2', maxlag: '5', ...params })) u.searchParams.set(k, v);
    return u;
  }

  /** One page of category members (main namespace). `next` is the cmcontinue token or null when done. */
  async function categoryMembers(category: string, cmcontinue?: string): Promise<{ members: WikiMember[]; next: string | null }> {
    const title = category.startsWith('Category:') ? category : `Category:${category}`;
    const params: Record<string, string> = { action: 'query', list: 'categorymembers', cmtitle: title, cmlimit: '50', cmnamespace: '0', cmprop: 'ids|title' };
    if (cmcontinue) params.cmcontinue = cmcontinue;
    const body = await http.getJson<{ query?: { categorymembers?: unknown }; continue?: { cmcontinue?: string } }>(url(params));
    const raw = body?.query?.categorymembers;
    if (!Array.isArray(raw)) throw new UpstreamError('api_error', 'categorymembers missing from MediaWiki response', { retryable: false });
    const members = raw
      .filter((m): m is WikiMember => typeof m?.pageid === 'number' && typeof m?.title === 'string')
      .map((m) => ({ pageid: m.pageid, title: m.title.slice(0, 300), ns: m.ns }));
    return { members, next: typeof body.continue?.cmcontinue === 'string' ? body.continue.cmcontinue : null };
  }

  /** Resolve up to 50 titles, following redirects (and their #fragments). */
  async function resolve(titles: string[]): Promise<WikiResolution[]> {
    if (titles.length === 0) return [];
    if (titles.length > 50) throw new Error('resolve() takes at most 50 titles');
    const body = await http.getJson<{
      query?: {
        normalized?: { from: string; to: string }[];
        redirects?: { from: string; to: string; tofragment?: string }[];
        pages?: { pageid?: number; title: string; missing?: boolean }[];
      };
    }>(url({ action: 'query', titles: titles.join('|'), redirects: '1', prop: 'info' }));
    const q = body?.query ?? {};
    const normalized = new Map((q.normalized ?? []).map((n) => [n.from, n.to]));
    const redirects = new Map((q.redirects ?? []).map((r) => [r.from, r]));
    const pages = new Map((q.pages ?? []).filter((p) => typeof p.pageid === 'number' && !p.missing).map((p) => [p.title, p.pageid!]));
    const out: WikiResolution[] = [];
    for (const memberTitle of titles) {
      let title = normalized.get(memberTitle) ?? memberTitle;
      let fragment: string | null = null;
      let isRedirect = false;
      for (let hops = 0; hops < 3 && redirects.has(title); hops++) {
        const r = redirects.get(title)!;
        isRedirect = true;
        fragment = r.tofragment ?? fragment;
        title = r.to;
      }
      const targetPageId = pages.get(title);
      if (targetPageId !== undefined) out.push({ memberTitle, targetPageId, targetTitle: title, fragment, isRedirect });
    }
    return out;
  }

  async function page(pageid: number): Promise<WikiPage> {
    const body = await http.getJson<{
      parse?: { pageid: number; title: string; revid: number; wikitext?: string; sections?: WikiSection[]; categories?: { category: string }[] };
    }>(url({ action: 'parse', pageid: String(pageid), prop: 'wikitext|sections|revid|categories', redirects: '1' }));
    const p = body?.parse;
    if (!p || typeof p.wikitext !== 'string') throw new UpstreamError('api_error', `parse returned no wikitext for page ${pageid}`, { retryable: false });
    return {
      pageid: p.pageid,
      title: p.title,
      revid: p.revid,
      wikitext: p.wikitext.slice(0, 500_000),
      sections: (p.sections ?? []).map((s) => ({ level: Number(s.level), line: String(s.line), anchor: String(s.anchor), index: String(s.index) })),
      categories: (p.categories ?? []).map((c) => c.category),
    };
  }

  return { wikiBase, categoryMembers, resolve, page };
}

export type WikiClient = ReturnType<typeof createWikiClient>;
