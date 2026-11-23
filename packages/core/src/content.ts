/**
 * Content-model vocabulary shared by the Worker API, the ingestion job and the web app.
 *
 * Three independent content types (see README_DEPLOYMENT.md / migration-notes.md):
 *   FLORIDA_NEWS      real Florida incident, backed by an original publisher article
 *   GTA_CANON         documented in-universe event from an actual GTA game, backed by a game reference
 *   GTA_PLAYER_EVENT  gameplay clip with explicit permission (modeled, disabled by default)
 */

export const CONTENT_KINDS = ['FLORIDA_NEWS', 'GTA_CANON', 'GTA_PLAYER_EVENT'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const LINK_STATUSES = ['unchecked', 'ok', 'manual_ok', 'broken'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** Link states acceptable for publication. */
export const PUBLISHABLE_LINKS: readonly LinkStatus[] = ['ok', 'manual_ok'];

/** Verified GTA titles a GTA_CANON question may be labelled with. */
export const GTA_GAMES = {
  GTA_1: 'Grand Theft Auto',
  GTA_LONDON: 'GTA: London',
  GTA_2: 'GTA 2',
  GTA_III: 'GTA III',
  GTA_VC: 'GTA: Vice City',
  GTA_SA: 'GTA: San Andreas',
  GTA_ADVANCE: 'GTA Advance',
  GTA_LCS: 'GTA: Liberty City Stories',
  GTA_VCS: 'GTA: Vice City Stories',
  GTA_IV: 'GTA IV',
  GTA_TLAD: 'GTA IV: The Lost and Damned',
  GTA_TBOGT: 'GTA IV: The Ballad of Gay Tony',
  GTA_CW: 'GTA: Chinatown Wars',
  GTA_V: 'GTA V',
  GTA_ONLINE: 'GTA Online',
  GTA_VI: 'GTA VI',
} as const;
export type GtaGame = keyof typeof GTA_GAMES;

export function isGtaGame(value: unknown): value is GtaGame {
  return typeof value === 'string' && Object.hasOwn(GTA_GAMES, value);
}

export function gtaGameLabel(game: string | null | undefined): string | undefined {
  return isGtaGame(game) ? GTA_GAMES[game] : undefined;
}

export const SOURCE_CTA: Record<ContentKind, string> = {
  FLORIDA_NEWS: 'Read full article',
  GTA_CANON: 'View GTA source',
  GTA_PLAYER_EVENT: 'Watch original clip',
};

/**
 * Words that give the answer away before the player chooses. A `play_title`
 * containing any of these is rejected at approval time. Matching is on whole
 * words, case-insensitive.
 */
export const FLORIDA_GIVEAWAYS = [
  'florida', 'floridian', 'fla', 'miami', 'tampa', 'orlando', 'jacksonville', 'tallahassee', 'key west', 'fort lauderdale',
  'st. petersburg', 'st petersburg', 'clearwater', 'sarasota', 'fort myers', 'gainesville', 'pensacola', 'daytona',
  'palm beach', 'boca raton', 'hialeah', 'kissimmee', 'ocala', 'lakeland', 'everglades', 'florida keys', 'broward',
  'pinellas', 'hillsborough', 'volusia', 'osceola', 'brevard', 'miami-dade', 'panhandle',
];

export const GTA_GIVEAWAYS = [
  'gta', 'grand theft auto', 'rockstar', 'liberty city', 'liberty tree', 'vice city', 'san andreas', 'los santos',
  'san fierro', 'las venturas', 'blaine county', 'sandy shores', 'paleto bay', 'weazel', 'lcpd', 'lspd', 'vcpd',
  'alderney', 'algonquin', 'staunton', 'shoreside', 'portland harbor', 'leonida', 'vice beach', 'ammu-nation',
  'claude', 'tommy vercetti', 'cj', 'niko bellic', 'trevor philips', 'franklin clinton', 'michael de santa',
  'salvatore leone', 'donald love', 'lazlow', 'cluckin bell', 'sprunk', 'pisswasser', 'epsilon',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GIVEAWAY_PATTERN = new RegExp(
  `(?<![a-z0-9])(${[...FLORIDA_GIVEAWAYS, ...GTA_GIVEAWAYS].sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})(?![a-z0-9])`,
  'gi',
);

/** Giveaway terms found in a player-facing title (lowercased, unique). */
export function findGiveaways(text: string): string[] {
  const hits = new Set<string>();
  for (const m of text.toLowerCase().matchAll(GIVEAWAY_PATTERN)) hits.add(m[1]!);
  return [...hits];
}

/**
 * Rule-based *draft* of a neutral play title: strips the most common giveaways
 * from a source headline. Always a draft — a reviewer must read the source and
 * confirm or rewrite it before approval. Never invents facts.
 */
export function draftPlayTitle(originalTitle: string): string {
  return originalTitle
    .replace(/\s+[|–—-]\s+[^|–—-]{1,40}$/, '') // " - Publisher" suffix
    .replace(/\bFlorida (man|woman|teen|couple|deputies|deputy|police|officials)\b/gi, (_, who: string) => `A ${who.toLowerCase()}`)
    .replace(/\b(in|from|near|at) (South |Central |North |Northeast |Southwest )?Florida\b/gi, '')
    .replace(/\b(the )?Liberty Tree\b/gi, 'the local paper')
    .replace(/\bLiberty City's\b/gi, "the city's")
    .replace(/\b(in|across|around) Liberty City\b/gi, 'in the city')
    .replace(/\bLiberty City\b/gi, 'the city')
    .replace(/\bLiberty\b/g, 'the city')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?:;])/g, '$1')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}
