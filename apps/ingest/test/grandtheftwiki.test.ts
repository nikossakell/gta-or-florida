import { describe, expect, it } from 'vitest';
import { anchorKey, createWikiClient, detectGame, extractArticles, wikitextToPlain, type WikiPage } from '../src/adapters/grandtheftwiki.ts';
import { jsonResponse } from './helpers.ts';

/**
 * Fixtures mirror the *structure* verified on the live wiki (issue pages with
 * "== Articles ==" + linked level-3 headings, redirects with tofragment,
 * standalone "==Article==" pages). The text is synthetic, not Rockstar's.
 */
const ISSUE: WikiPage = {
  pageid: 900,
  title: 'Liberty Tree Articles in GTA III/February 2001',
  revid: 1,
  categories: ['Liberty_Tree_Articles'],
  wikitext: `'''The test issue''' of the fictional [[Liberty Tree]] newspaper promoted [[Grand Theft Auto III]].

== Articles ==
=== [http://www.rockstargames.com/libertytree/feb2001/story1.html Test Headline One] ===
{{quote|'''Synthetic subhead'''<br>
[[File:Test.jpg|right|thumb|200px|A caption with a [[Link]] inside]]
<p>Synthetic body text about a [[Liberty City in GTA III Era|city]] event.</p>}}

=== [http://www.rockstargames.com/libertytree/feb2001/story2.html Second Test Story: Odd Things!] ===
{{quote|<p>More synthetic text.</p>}}

=== [http://www.rockstargames.com/libertytree/feb2001/story5.html World News] ===
{{quote|<p>Several short synthetic items.</p>}}

=== Unlinked Column ===
Text.

== Trivia ==
* Not an article.
`,
  sections: [
    { level: 2, line: 'Articles', anchor: 'Articles', index: '1' },
    { level: 3, line: 'Test Headline One', anchor: 'Test_Headline_One', index: '2' },
    { level: 3, line: 'Second Test Story: Odd Things!', anchor: 'Second_Test_Story:_Odd_Things!', index: '3' },
    { level: 3, line: 'World News', anchor: 'World_News', index: '4' },
    { level: 3, line: 'Unlinked Column', anchor: 'Unlinked_Column', index: '5' },
    { level: 2, line: 'Trivia', anchor: 'Trivia', index: '6' },
  ],
};

const STANDALONE: WikiPage = {
  pageid: 901,
  title: 'Test Standalone Story',
  revid: 2,
  categories: [],
  wikitext: `'''Test Standalone Story''' is a [[Liberty Tree]] article in the [[Grand Theft Auto: Liberty City Stories]] manual.

==Article==
Synthetic article body that mentions [[Vice City]] later on.

==External link==
* x
`,
  sections: [
    { level: 2, line: 'Article', anchor: 'Article', index: '1' },
    { level: 2, line: 'External link', anchor: 'External_link', index: '2' },
  ],
};

const INDEX: WikiPage = { pageid: 902, title: 'Liberty Tree Articles in GTA III', revid: 3, categories: [], wikitext: 'Intro.\n\n== List of issues ==\n* a', sections: [] };

const ctx = { wikiBase: 'https://www.grandtheftwiki.com/', mode: 'sections' as const };

describe('extractArticles', () => {
  it('splits one newspaper issue into distinct articles keyed by page id + section anchor', () => {
    const { articles } = extractArticles(ISSUE, { ...ctx, aliases: ['Test Headline One'] });
    expect(articles.map((a) => a.key)).toEqual(['900#Test_Headline_One', '900#Second_Test_Story:_Odd_Things!', '900#World_News', '900#Unlinked_Column']);
    const [first, second, column, unlinked] = articles;
    expect(first).toMatchObject({
      headline: 'Test Headline One',
      extraction: 'issue_section',
      gameHint: 'GTA_III',
      outlet: 'Liberty Tree',
      url: 'https://www.grandtheftwiki.com/Liberty_Tree_Articles_in_GTA_III/February_2001#Test_Headline_One',
      canonicalUrl: 'https://www.grandtheftwiki.com/index.php?curid=900#Test_Headline_One',
      originalInGameUrl: 'http://www.rockstargames.com/libertytree/feb2001/story1.html',
      aliases: ['Test Headline One'],
    });
    expect(first!.lead).toContain('Synthetic body text about a city event');
    expect(first!.lead).not.toMatch(/File:|caption|\[\[/);
    expect(second!.url).toContain('#Second_Test_Story:_Odd_Things!');
    expect(second!.needsReviewReason).toBeUndefined();
    expect(column!.needsReviewReason).toMatch(/column/);
    expect(unlinked!).toMatchObject({ extraction: 'issue_section_unlinked' });
    expect(unlinked!.needsReviewReason).toBeDefined();
    expect(articles.some((a) => a.headline === 'Trivia')).toBe(false);
  });

  it('treats a standalone article page as one article and detects the game from the lead', () => {
    const { articles } = extractArticles(STANDALONE, ctx);
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({ key: '901', extraction: 'article_page', headline: 'Test Standalone Story', gameHint: 'GTA_LCS', sectionAnchor: null });
  });

  it('skips pages without an identifiable article instead of guessing', () => {
    expect(extractArticles(INDEX, ctx)).toEqual({ articles: [], skipped: 'no_identifiable_article' });
  });

  it('whole-page mode (missions/random events) marks candidates for review and takes the game from the category', () => {
    const page: WikiPage = { pageid: 903, title: 'Test Mission', revid: 4, categories: [], sections: [], wikitext: 'Test Mission is a synthetic mission where an odd and specific thing happens in the game world.\n\n== Walkthrough ==\nx' };
    const { articles } = extractArticles(page, { ...ctx, mode: 'pages', category: 'Missions in GTA V' });
    expect(articles[0]).toMatchObject({ key: '903', extraction: 'page', gameHint: 'GTA_V' });
    expect(articles[0]!.needsReviewReason).toMatch(/Whole-page/);
  });
});

describe('wikitext helpers', () => {
  it('converts links, external links and templates to plain text', () => {
    expect(wikitextToPlain("[[A|B]] [[C]] [http://x.test Text] '''bold''' {{cite|x}}")).toBe('B C Text bold');
    expect(anchorKey('Car_Jacking  Back')).toBe(anchorKey('car jacking back'));
  });
  it('detects the earliest game mention', () => {
    expect(detectGame('appears in Grand Theft Auto: Liberty City Stories, set before Vice City')).toBe('GTA_LCS');
    expect(detectGame('GTA VI trailer')).toBe('GTA_VI');
    expect(detectGame('nothing here')).toBeNull();
  });
});

describe('createWikiClient', () => {
  function fakeWiki(routes: (u: URL) => unknown) {
    const calls: URL[] = [];
    const fetchImpl = async (u: URL) => {
      calls.push(u);
      return jsonResponse(200, routes(u));
    };
    const client = createWikiClient({ apiUrl: 'https://www.grandtheftwiki.com/api.php', userAgent: 'test', minIntervalMs: 0, sleep: async () => {}, fetchImpl });
    return { client, calls };
  }

  it('follows categorymembers continuation', async () => {
    const { client, calls } = fakeWiki((u) =>
      u.searchParams.get('cmcontinue')
        ? { query: { categorymembers: [{ pageid: 2, ns: 0, title: 'B' }] } }
        : { continue: { cmcontinue: 'page|abc|2', continue: '-||' }, query: { categorymembers: [{ pageid: 1, ns: 0, title: 'A' }] } },
    );
    const first = await client.categoryMembers('Liberty Tree Articles');
    expect(first).toEqual({ members: [{ pageid: 1, ns: 0, title: 'A' }], next: 'page|abc|2' });
    const second = await client.categoryMembers('Liberty Tree Articles', first.next!);
    expect(second.next).toBeNull();
    expect(calls[0]!.searchParams.get('cmtitle')).toBe('Category:Liberty Tree Articles');
    expect(calls[1]!.searchParams.get('cmcontinue')).toBe('page|abc|2');
    expect(calls[0]!.searchParams.get('maxlag')).toBe('5');
  });

  it('resolves redirects (with #fragment) to their target issue page', async () => {
    const { client } = fakeWiki(() => ({
      query: {
        normalized: [{ from: 'Test_Headline_One', to: 'Test Headline One' }],
        redirects: [{ from: 'Test Headline One', to: 'Liberty Tree Articles in GTA III/February 2001', tofragment: 'Test Headline One' }],
        pages: [
          { pageid: 900, title: 'Liberty Tree Articles in GTA III/February 2001' },
          { pageid: 901, title: 'Test Standalone Story' },
        ],
      },
    }));
    const r = await client.resolve(['Test_Headline_One', 'Test Standalone Story']);
    expect(r).toEqual([
      { memberTitle: 'Test_Headline_One', targetPageId: 900, targetTitle: 'Liberty Tree Articles in GTA III/February 2001', fragment: 'Test Headline One', isRedirect: true },
      { memberTitle: 'Test Standalone Story', targetPageId: 901, targetTitle: 'Test Standalone Story', fragment: null, isRedirect: false },
    ]);
  });

  it('retries maxlag and surfaces other API errors', async () => {
    let n = 0;
    const { client } = fakeWiki(() => (n++ === 0 ? { error: { code: 'maxlag', info: 'lagged' } } : { query: { categorymembers: [] } }));
    await expect(client.categoryMembers('X')).resolves.toEqual({ members: [], next: null });
    const bad = fakeWiki(() => ({ error: { code: 'badvalue', info: 'nope' } }));
    await expect(bad.client.categoryMembers('X')).rejects.toMatchObject({ kind: 'api_error' });
  });

  it('refuses hosts other than the configured wiki', async () => {
    const client = createWikiClient({ apiUrl: 'https://www.grandtheftwiki.com/api.php', userAgent: 't', minIntervalMs: 0 });
    // The client only ever builds URLs on its own host; a different host is rejected by the polite client.
    const { createPoliteJsonClient } = await import('../src/adapters/http.ts');
    const http = createPoliteJsonClient({ allowedHosts: ['www.grandtheftwiki.com'], userAgent: 't', minIntervalMs: 0 });
    await expect(http.getJson(new URL('https://169.254.169.254/latest'))).rejects.toMatchObject({ kind: 'forbidden_host' });
    await expect(http.getJson(new URL('http://www.grandtheftwiki.com/api.php'))).rejects.toMatchObject({ kind: 'forbidden_host' });
    expect(client.wikiBase).toBe('https://www.grandtheftwiki.com/');
  });
});
