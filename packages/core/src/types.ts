/**
 * Domain model for GTA or Florida?
 *
 * "gta" always means *fictional GTA-style scenario* — never a claim that the
 * event happened in an actual Grand Theft Auto game.
 */

export const ANSWERS = ['florida', 'gta'] as const;
export type Answer = (typeof ANSWERS)[number];

export const STATUSES = ['candidate', 'verified', 'rejected'] as const;
export type QuestionStatus = (typeof STATUSES)[number];

export const CATEGORIES = ['wildlife', 'crime', 'vehicles', 'weird', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const DIFFICULTIES = [1, 2, 3] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * Sub-type of a GTA answer. MVP only ships `fiction`. `gta_lore` is reserved
 * for independently verified events from actual GTA titles and must cite a source.
 */
export const GTA_SUBTYPES = ['fiction', 'gta_lore'] as const;
export type GtaSubtype = (typeof GTA_SUBTYPES)[number];

export type Question = {
  id: string;
  headline: string;
  answer: Answer;
  explanation: string;
  status: QuestionStatus;
  category: Category;
  difficulty: Difficulty;
  canonicalEventId: string;
  /** Only meaningful when answer === 'gta'. Defaults to 'fiction'. */
  gtaSubtype?: GtaSubtype;
  sourceUrl?: string;
  sourceName?: string;
  publishedAt?: string;
  reviewedAt?: string;
  approvedAt?: string;
  rightsNotes?: string;
  /**
   * Development-only content invented for the sample bank. A placeholder
   * "florida" item is NOT a real report and must never carry a source URL.
   * The API refuses to serve placeholders unless explicitly allowed.
   */
  placeholder?: boolean;
};

export type QuestionBankFile = {
  version: 1;
  questions: Question[];
};

/** What the browser receives before answering: no answer, no explanation, no source. */
export type PublicQuestion = {
  id: string;
  headline: string;
};

/** What the browser receives after answering a question. */
export type RevealedQuestion = {
  id: string;
  headline: string;
  answer: Answer;
  gtaSubtype?: GtaSubtype;
  explanation: string;
  sourceUrl?: string;
  sourceName?: string;
  publishedAt?: string;
  placeholder: boolean;
};

export type ScheduleDay = {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  /** Sequential daily number (#1 is the schedule epoch). */
  number: number;
  challengeId: string;
  questionIds: string[];
};

export type QuestionUsage = {
  questionId: string;
  canonicalEventId: string;
  lastPublishedAt: string;
  timesPublished: number;
  approvedAt?: string;
};

export type ScheduleFile = {
  version: 1;
  /** First scheduled date, used to number challenges. */
  epoch: string;
  size: number;
  cooldownDays: number;
  seed: string;
  generatedAt?: string;
  days: ScheduleDay[];
  /** Scheduler metadata, recomputed on every build. */
  usage?: Record<string, QuestionUsage>;
};

export type CandidateStatus = 'candidate' | 'rejected' | 'promoted';

/** Raw discovery metadata from news search. Never playable as-is. */
export type Candidate = {
  id: string;
  title: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  discoveredAt: string;
  /** When the provider first saw the article (ISO), if known. */
  seenAt?: string;
  language?: string;
  sourceCountry?: string;
  provider: 'gdelt';
  query: string;
  fingerprint: string;
  status: CandidateStatus;
  /** Heuristic only: whether the title/domain suggests a Florida location. Reviewer must verify. */
  floridaSignal: 'title' | 'domain' | 'none';
  /** Set when a similar (not identical) headline already exists; needs human review. */
  possibleDuplicateOf?: string;
  similarity?: number;
  notes?: string;
};

export type CandidateFile = {
  version: 1;
  updatedAt?: string;
  /** Rotation cursor for query batches. */
  nextBatchIndex?: number;
  candidates: Candidate[];
};

export type PlayerChoice = Answer | null;
