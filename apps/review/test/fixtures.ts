/** Fictional review fixtures on IANA-reserved / registered test hosts. Not real events. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BankFile } from '../../ingest/src/bank-item.ts';

export const BANK: BankFile = {
  batch: 'review-dashboard-test',
  questions: [
    {
      eventId: 'test-fl-heron-pier',
      origin: 'FLORIDA',
      headline: 'A heron kept stealing bait from the same fishing pier every morning for weeks',
      explanation: 'Test entry: the linked report says anglers documented one heron taking bait from a single pier for weeks.',
      sourceUrl: 'https://news.example.org/heron-pier',
      sourceTitle: 'Anglers say bird is a regular at local pier',
      publisher: 'Example News',
      publishedAt: '2026-10-02',
      location: 'Example Beach, Pinellas County, Florida',
      category: 'wildlife',
      difficulty: 1,
      notes: 'Fictional fixture for the review dashboard tests.',
    },
    {
      eventId: 'test-fl-wheelbarrow-parade',
      origin: 'FLORIDA',
      headline: 'A man pushed a wheelbarrow full of garden gnomes down the middle of a parade route',
      explanation: 'Test entry: the linked report says officers walked the man and his gnome-filled wheelbarrow to the sidewalk.',
      sourceUrl: 'https://news.example.org/wheelbarrow-parade',
      sourceTitle: 'Parade interrupted by unusual cargo',
      publisher: 'Example News',
      publishedAt: '2026-09-14',
      location: 'Sampletown, Example County, Florida',
      category: 'weird',
      difficulty: 2,
    },
    {
      eventId: 'test-gta-crane-car',
      origin: 'GTA',
      headline: 'A man lifted a parked sports car onto a rooftop with a construction crane',
      explanation: 'Test entry: stands in for a documented mission premise; it stays a candidate until a human reviews it.',
      sourceUrl: 'https://www.grandtheftwiki.com/Test_Crane_Car',
      sourceTitle: 'Test Crane Car',
      publisher: 'Grand Theft Wiki',
      game: 'GTA_SA',
      category: 'vehicles',
      difficulty: 3,
    },
    {
      eventId: 'test-gta-ice-rink-zamboni',
      origin: 'GTA',
      headline: 'Two men raced ice resurfacing machines around an empty arena after closing time',
      explanation: 'Test entry: another fictional premise so filters and navigation have something to work with.',
      sourceUrl: 'https://www.grandtheftwiki.com/Test_Ice_Rink',
      sourceTitle: 'Test Ice Rink',
      publisher: 'Grand Theft Wiki',
      game: 'GTA_V',
      category: 'weird',
      difficulty: 2,
      spoiler: true,
    },
  ],
};

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `gof-review-${prefix}-`));
}

export function writeBank(dir: string, bank: BankFile = BANK): string {
  const path = join(dir, 'master.json');
  writeFileSync(path, JSON.stringify(bank, null, 2));
  return path;
}

