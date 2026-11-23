import { useState, type ReactNode } from 'react';
import { BackIcon } from '../components/Icons.tsx';
import { Button, ButtonLink, Column, IconLink } from '../components/ui.tsx';
import { clearAllLocalData } from '../lib/storage.ts';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card mt-6 p-6 sm:p-7">
      <h2 className="font-display text-sun text-3xl">{title}</h2>
      <div className="text-muted mt-3 space-y-3 leading-relaxed">{children}</div>
    </section>
  );
}

const ext = 'text-teal underline underline-offset-4 hover:text-cream';

export function About() {
  const [cleared, setCleared] = useState(false);
  return (
    <Column>
      <header className="flex items-center gap-5 py-4">
        <IconLink to="/" label="Back to home">
          <BackIcon />
        </IconLink>
        <h1 className="font-display text-5xl">About</h1>
      </header>

      <Section title="How it works">
        <p>
          Every day at midnight UTC a new round goes live — the same headlines in the same order for everyone. Read each one and decide: is it a{' '}
          <strong className="text-teal">real, reported Florida incident</strong>, or a <strong className="text-pink">documented event from a GTA game</strong>?
        </p>
        <p>The clock pauses while each answer is revealed. Unanswered headlines count as misses. Share your score as a spoiler-free emoji grid.</p>
        <p>Keyboard: press G for GTA, F for Florida, Enter for the next headline.</p>
      </Section>

      <Section title="What “GTA” means here">
        <p>
          “GTA” answers are <strong className="text-cream">events documented in actual Grand Theft Auto games</strong> — in-game newspaper stories,
          missions and random events — so they are fiction inside the game world, not real news. Each one names the game after you answer and links to a
          reference (for example{' '}
          <a className={ext} href="https://www.grandtheftwiki.com/" target="_blank" rel="noopener noreferrer">
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
          <a className={ext} href="https://www.gdeltproject.org/" target="_blank" rel="noopener noreferrer">
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
        <p>No accounts, no tracking cookies, no analytics. Your results, streak and in-progress round are saved in this browser’s local storage and never sent anywhere. Your answers are never stored anywhere but this browser.</p>
        <Button
          variant="secondary"
          className="mt-2 w-full"
          onClick={() => {
            clearAllLocalData();
            setCleared(true);
          }}
        >
          Clear my local data
        </Button>
        <p role="status" className="text-teal min-h-6 font-semibold">
          {cleared ? 'Local results and progress cleared.' : ''}
        </p>
      </Section>

      <Section title="Disclaimer">
        <p>
          GTA or Florida? is an unofficial, fan-made parody game. It is not affiliated with, endorsed by, or sponsored by Rockstar Games or Take-Two
          Interactive. Grand Theft Auto and GTA are trademarks of their respective owners. No game artwork, logos, fonts or other assets are used.
        </p>
      </Section>
    </Column>
  );
}

export function NotFound() {
  return (
    <Column className="pt-16 text-center">
      <h1 className="font-display text-sun text-5xl">Wrong exit</h1>
      <p className="text-muted mt-4 text-lg">That page doesn’t exist.</p>
      <ButtonLink to="/" className="mt-8 w-full">
        Back to the start
      </ButtonLink>
    </Column>
  );
}
