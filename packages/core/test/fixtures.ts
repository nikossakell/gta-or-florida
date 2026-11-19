import type { Answer, Category, Difficulty, Question } from '../src/index.ts';

const CATS: Category[] = ['wildlife', 'crime', 'vehicles', 'weird', 'other'];
const WORDS = [
  'pelican', 'mango', 'airboat', 'flamingo', 'hurricane', 'boardwalk', 'manatee', 'pawnshop', 'jetski', 'iguana',
  'citrus', 'lighthouse', 'motel', 'parrot', 'swamp', 'marina', 'tiki', 'neon', 'causeway', 'sinkhole',
  'cowboy', 'karaoke', 'trampoline', 'submarine', 'blimp', 'kayak', 'taco', 'disco', 'rodeo', 'yacht',
  'saxophone', 'pinata', 'zeppelin', 'lasso', 'bowling', 'scooter', 'mermaid', 'carnival', 'helmet', 'bagpipe',
  'harpoon', 'snorkel', 'tuxedo', 'unicycle', 'volcano', 'waffle', 'xylophone', 'yodel', 'zucchini', 'accordion',
  'banjo', 'cactus', 'dumpling', 'escalator', 'fondue', 'gazebo', 'hammock', 'igloo', 'jukebox', 'kazoo',
];

/** Builds a verified question with a unique, dissimilar headline. */
export function makeQuestion(i: number, answer: Answer, overrides: Partial<Question> = {}): Question {
  const w1 = WORDS[i % WORDS.length]!;
  const w2 = WORDS[(i * 7 + 3) % WORDS.length]!;
  const base: Question = {
    id: `${answer}-${String(i).padStart(3, '0')}`,
    headline: `Item ${i}: ${w1} incident involving a ${w2} number ${i * 13}`,
    answer,
    explanation: 'Test explanation text for this item.',
    status: 'verified',
    category: CATS[i % CATS.length]!,
    difficulty: ((i % 3) + 1) as Difficulty,
    canonicalEventId: `evt-${answer}-${i}`,
    reviewedAt: '2026-11-01',
    ...(answer === 'florida'
      ? { sourceUrl: `https://news.example/story-${i}`, sourceName: 'Example News', publishedAt: '2026-10-01' }
      : { gtaSubtype: 'fiction' as const }),
  };
  return { ...base, ...overrides };
}

export function makeBank(florida: number, gta: number): Question[] {
  return [
    ...Array.from({ length: florida }, (_, i) => makeQuestion(i, 'florida')),
    ...Array.from({ length: gta }, (_, i) => makeQuestion(i + 1000, 'gta')),
  ];
}
