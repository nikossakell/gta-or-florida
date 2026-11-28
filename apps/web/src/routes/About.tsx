import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { arcadeClass } from '../daily-drive/components/ArcadeButton.tsx';
import { Gus } from '../daily-drive/components/Gus.tsx';
import { Page } from '../daily-drive/components/Page.tsx';
import { COPY } from '../daily-drive/lib/copy.ts';
import { clearAllLocalData } from '../lib/storage.ts';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function About() {
  const [cleared, setCleared] = useState(false);
  return (
    <Page label="ABOUT">
      <main className="doc">
        <h1 className="page-title">About</h1>

        <Section title="How it works">
          <p>
            Every day at midnight UTC a new round goes live — the same headlines in the same order for everyone. Read each one and decide: is it a{' '}
            <strong className="fl">real, reported Florida incident</strong>, or a <strong className="gta">documented event from a GTA game</strong>?
          </p>
          <p>The clock pauses while each answer is revealed. Unanswered headlines count as misses. Share your score as a spoiler-free emoji grid.</p>
          <p>Keyboard: press G for GTA, F for Florida, Enter for the next headline.</p>
        </Section>

        <Section title="What “GTA” means here">
          <p>
            “GTA” answers are <strong>events documented in actual Grand Theft Auto games</strong> — in-game newspaper stories, missions and random events
            — so they are fiction inside the game world, not real news. Each one names the game after you answer and links to a reference (for example{' '}
            <a href="https://www.grandtheftwiki.com/" target="_blank" rel="noopener noreferrer">
              Grand Theft Wiki
            </a>
            ). We write our own short description; we never reproduce the games’ text, art or screenshots, and we never invent GTA events.
          </p>
        </Section>

        <Section title="Sources & attribution">
          <p>
            Florida answers come from published news reports about incidents that took place in Florida. Each real item links to the original article; we
            write our own short, neutral description (so the headline doesn’t give the answer away) and never republish article text or photos. The exact
            original headline is shown after you answer only where we have cleared it. Candidate stories are discovered with{' '}
            <a href="https://www.gdeltproject.org/" target="_blank" rel="noopener noreferrer">
              The GDELT Project
            </a>{' '}
            and every question is checked and approved by a person before it can appear.
          </p>
          <p>Rounds marked “Sample data” contain placeholder headlines written for development; they are not real news and have no source.</p>
        </Section>

        <Section title="Rules & fair play">
          <p>
            One scored attempt per day per browser. Completion is stored on your device only, so this is a casual anti-repeat measure, not a tamper-proof
            one. There are no accounts and no leaderboard.
          </p>
        </Section>

        <Section title="Privacy">
          <p>
            No accounts, no tracking cookies, no analytics. Your results, streak and in-progress round are saved in this browser’s local storage and never
            sent anywhere. Your answers are never stored anywhere but this browser.
          </p>
          <button
            type="button"
            className="btn2"
            onClick={() => {
              clearAllLocalData();
              setCleared(true);
            }}
          >
            Clear my local data
          </button>
          <p role="status" className="ok">
            {cleared ? 'Local results and progress cleared.' : ''}
          </p>
        </Section>

        <Section title="Disclaimer">
          <p>
            GTA or Florida? is an unofficial, fan-made parody game. It is not affiliated with, endorsed by, or sponsored by Rockstar Games or Take-Two
            Interactive. Grand Theft Auto and GTA are trademarks of their respective owners. No game artwork, logos, fonts or other assets are used.
          </p>
          <p>
            {COPY.spoilerNotice} GTA headlines describe mission events in general terms and avoid major story twists, endings and the deaths of important
            characters.
          </p>
        </Section>
      </main>
    </Page>
  );
}

export function NotFound() {
  return (
    <Page label="WRONG EXIT">
      <main>
        <section className="panel state">
          <Gus state="low" size="lg" decorative />
          <h1>Wrong exit</h1>
          <p>That page doesn’t exist.</p>
          <div className="acts">
            <Link to="/" className={arcadeClass('primary')}>
              <span className="big">BACK TO THE START</span>
            </Link>
          </div>
        </section>
      </main>
    </Page>
  );
}
