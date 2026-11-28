import { Link } from '@tanstack/react-router';
import { arcadeClass } from '../daily-drive/components/ArcadeButton.tsx';
import { EmptyState, Page } from '../daily-drive/components/Page.tsx';
import { DriveResults } from '../daily-drive/screens/DriveResults.tsx';
import { getResult } from '../lib/storage.ts';

export function ResultsScreen({ date }: { date: string }) {
  const result = getResult(date);
  if (!result) {
    return (
      <Page label="RESULTS">
        <EmptyState
          title="No result yet"
          action={
            <Link to="/play/$date" params={{ date }} className={arcadeClass('primary')}>
              <span className="big">PLAY THIS ROUND ▶</span>
            </Link>
          }
        >
          There’s no saved score for this round in this browser.
        </EmptyState>
      </Page>
    );
  }
  return <DriveResults result={result} />;
}
