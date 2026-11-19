GTA or Florida? — Product & Technical Brief

Implementation-ready brief for Claude Code; visual/design brief for Claude Artifacts.
Language of product: English. Documentation: Greek with English technical terminology.
Status: MVP specification, not an assertion that APIs or third-party content have been licensed.

1. Product vision

GTA or Florida? is a fast, mobile-first browser trivia game. Players read an absurd headline/event and decide whether it is a verified real Florida incident or a fictional GTA-style scenario. The goal is a funny, trustworthy, highly shareable 60–90 second experience, with fresh daily questions and a large question bank.

Important semantic rule: The button GTA means fictional, GTA-style, not necessarily an event from an actual Grand Theft Auto game. The reveal screen must explicitly say Fictional GTA-style scenario. Do not claim a fictional scenario is GTA VI canon. An optional future GTA Lore category may contain independently verified actual GTA events, clearly labeled as such.

Audience: English-speaking GTA fans, Florida Man meme fans, casual daily-game players. Unofficial fan-made product; no Rockstar endorsement.

Goals
Complete one Daily Challenge in <90 seconds.
Make answers understandable and verifiable, with source links for real events.
Enable one-tap copy/share of spoiler-free results.
Maintain enough unique questions for many months without repeating the same stories frequently.
Ship a simple MVP with minimal infrastructure and no user accounts.
Non-goals for MVP

No multiplayer, login, payment, AI generation during gameplay, scraped full articles, or global leaderboard.

2. Gameplay
   Daily Challenge
   5 questions/day; same set and order for everyone globally, selected using UTC date and a deterministic daily schedule.
   Show a short headline and two large buttons: 🎮 GTA and 🐊 Florida.
   Once answered, lock the choice, show correct/incorrect, a short explanation, and Read original report when the answer is Florida.
   Next button advances; after question 5 show score, a spoiler-free emoji grid, and Copy result / native Share when available.
   One scored daily attempt per browser/device; store completion in localStorage. Clearly state that this is casual anti-repeat, not tamper-proof.
   If there are fewer than 5 valid unused questions, show a graceful fallback rather than silently recycle or invent content.
   Endless Mode (post-MVP)
   Randomized questions from the approved pool, streak counter, no global leaderboard.
   Avoid duplicates within a session; maintain recently-seen IDs in localStorage.
   On pool exhaustion, inform user before resetting history.
   Result format
   text
   GTA or Florida? 🐊 #2026-11-19
   🟩🟩🟥🟩🟩
   4/5 — Can you beat me?
   https://example.com

No correct answers leaked by the emoji grid; squares indicate whether the player was correct.

3. Screens & design brief for Claude Artifacts

Create polished mobile-first, responsive mockups for:

Landing / Start: brand wordmark, playful one-line pitch, Play today's challenge, optional How it works.
Question: progress 2 / 5, card with headline, large GTA/Florida buttons, accessible tap targets.
Answer reveal: correctness, explanatory text, source link for real Florida articles, Next.
Results: score, emoji grid, copy/share CTA, return tomorrow prompt.
Archive / About: past challenge status, attribution, rules, disclaimer, privacy.
Empty/error/loading: no approved questions, failed API/admin sync, offline-friendly UI.

Visual direction: original retro-Miami-inspired aesthetic, warm tropical sunset palette (coral, pink, teal, midnight navy), subtle grain, bold typography, rounded cards, playful alligator motif, restrained motion. Do not copy Rockstar logos, game artwork, characters, fonts, maps or screenshots. The app should look original, not like an official GTA property.

Design requirements: AA contrast, visible keyboard focus, reduced-motion support, 44px+ touch targets, sensible desktop max-width (~520px gameplay column), clear feedback not based on color alone. No intrusive ad placement during a question.

4. Stack & architecture
   React + TypeScript + Vite — frontend.
   Tailwind CSS — styling.
   TanStack Query — async fetching/caching of challenge data (not necessary for purely bundled static JSON, but useful when serving from Node).
   TanStack Router — typed routes (optional but recommended if multiple screens).
   Node.js — minimal HTTP backend using built-in node:http and fetch; no Express required.
   JSON files — approved question bank and scheduled daily sets; no database for MVP.
   Vitest — unit tests; Playwright optional for critical end-to-end flows.
   text
   apps/
   web/src/
   routes/
   components/
   features/game/
   lib/
   api/src/
   server.ts
   services/challenge.ts
   services/questions.ts
   scripts/
   import-gdelt.mjs
   validate-questions.mjs
   build-daily-schedule.mjs
   data/
   questions.approved.json
   questions.candidates.json
   daily-schedule.json
   sources.json

API contracts (our own app, not third-party endpoints):

GET /api/challenge/today -> date, challengeId, five public questions without answers.
POST /api/challenge/:id/finish -> submit 5 selected answers; server returns score and explanations. For a small anonymous game this is not cheat-proof; use it to avoid shipping answers before completion.
GET /api/health -> basic status.
GET /api/archive -> list of previous challenge dates (optional MVP).

For a fully static deployment, the answer key would be exposed to clients; this is acceptable only if cheating resistance is explicitly out of scope. A minimal Node API provides better separation. No secret news API keys in the browser.

Example domain model
ts
type Question = {
id: string;
headline: string;
answer: 'florida' | 'gta';
explanation: string;
status: 'candidate' | 'verified' | 'rejected';
category: 'wildlife' | 'crime' | 'vehicles' | 'weird' | 'other';
difficulty: 1 | 2 | 3;
canonicalEventId: string;
sourceUrl?: string;
sourceName?: string;
publishedAt?: string;
reviewedAt?: string;
rightsNotes?: string;
};

For public question responses, omit answer, explanation, internal moderation metadata, and source information if it would spoil the answer. Reveal them only after answering or completing, according to chosen gameplay UX. Validate all imported data server-side; do not trust generated content.

5. Finding hundreds of questions: data sourcing strategy

Do not treat news search results as ready-to-publish trivia. The pipeline discovers candidates, checks them, rewrites into original short descriptions, and requires human approval before publication.

A. Real Florida incidents — primary source: GDELT DOC 2.0

Official documentation: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
Endpoint: https://api.gdeltproject.org/api/v2/doc/doc

Free, no API key for discovery of news metadata and URLs; not a licensed full-article feed.
Supports article-list JSON, Boolean/phrase queries, date windows, and up to 250 article-list records per request.
Its searchable article window is rolling/recent (~3 months), so ingest continuously and persist approved questions. Do not assume it can search decades of historical articles via DOC 2.0.
Use slow, scheduled requests (start at <=1 request per 5 seconds), retry/backoff, and caching. Confirm current provider limits before deploying.

Example discovery request (illustrative; test response handling and query quality):

js
const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
url.searchParams.set('query', '"Florida man" (alligator OR stolen OR arrested)');
url.searchParams.set('mode', 'ArtList');
url.searchParams.set('format', 'json');
url.searchParams.set('maxrecords', '100');
url.searchParams.set('timespan', '3m');
url.searchParams.set('sort', 'DateDesc');

const response = await fetch(url);
if (!response.ok) throw new Error(`GDELT HTTP ${response.status}`);
const payload = await response.json();
const candidates = (payload.articles ?? []).map(({ title, url, domain, seendate }) => ({
title, url, domain, discoveredAt: seendate
}));

Search terms in rotating batches rather than one generic query:

"Florida man" alligator
"Florida woman" bizarre
Florida (iguanas OR python OR crocodile) incident
Florida (golf cart OR lawnmower OR boat) police
Florida (drive-thru OR convenience store) unusual
Florida (costume OR inflatable OR mascot) arrest
Other geographic variants: Miami, Tampa, Orlando, Jacksonville, Key West, Fort Lauderdale.

Use source-domain and geographic checks: an article mentioning Florida does not necessarily describe an event in Florida. Search multiple reputable publishers; exclude satire, unverified claims, and stories about real harm where a comedic presentation would be inappropriate.

B. Complementary Florida news RSS feeds

Use publisher-owned RSS feeds where officially available, e.g. local Florida news publishers, and confirm each feed's URL, current availability, robots/terms and reuse conditions before ingestion. Store metadata, title, original URL, date and publisher; link back. Do not assume any guessed RSS URL is valid. RSS ingestion is an adapter, not a dependency for initial launch.

C. GTA incidents — verified canon vs invented fiction

MVP default: original fictional GTA-style scenarios authored by humans or proposed by an LLM and reviewed by humans. These require no external GTA API, and provide full control over difficulty and content volume.

Optional expansion: actual GTA franchise lore from community-maintained wiki resources, Rockstar's published game materials, and carefully reviewed public information. Wiki APIs (MediaWiki/Fandom) may be available but availability, access rules and license conditions vary; do not assume an official, free GTA VI event API exists. Link to sources, keep citations and do not copy copyrighted prose/images. Keep actual canon in a separate gta_lore answer subtype, not confused with fictional events.

Potential source discovery links (verify before implementing):

https://gta.fandom.com/wiki/Grand_Theft_Auto_Wiki
https://www.mediawiki.org/wiki/API:Main_page
D. Optional commercial news APIs

NewsAPI: https://newsapi.org/pricing — its free Developer tier is development/testing only, not production, so do not use it to power a publicly deployed commercial MVP without a suitable plan. Evaluate other providers only after checking their current licenses and quotas.

E. Candidate-to-approved pipeline
text
Scheduled GDELT searches + approved RSS sources
↓
Candidate metadata (title, publisher, URL, date)
↓
Canonical URL normalization + headline similarity clustering
↓
Check location, publisher, source validity and event facts
↓
Generate original short question wording + explanation
↓
Human moderation / approve / reject
↓
questions.approved.json
↓
Deterministic daily scheduler → daily-schedule.json
↓
Public game API

Use LLMs only to draft concise paraphrases and fiction candidates; never let an LLM invent source URLs or declare an article verified. The reviewer must open the original article, verify that the incident occurred in Florida, and confirm the summary. Keep attribution. Never republish article bodies or unlicensed photos.

6. Avoiding repeated questions
   Inventory targets
   Launch target: 300 approved unique questions (150 Florida / 150 GTA-style fiction) = 60 daily challenges of 5 questions without repeats.
   Healthy inventory: 900 approved questions = 180 days of unique daily challenges.
   Stretch: 1,825 approved questions = 365 days at 5/day.
   Maintain ~50/50 answer distribution over each challenge or across adjacent days; for 5 questions use a 2/3 or 3/2 split, not a predictable fixed pattern.
   Target intake: ~35 newly approved questions per week to sustain 5/day, plus buffer for rejected/retired content.
   Deduplication rules
   Canonicalize URLs (remove tracking parameters, normalize host/path).
   Compute a normalized title fingerprint; compare near-duplicate headlines.
   Assign a canonicalEventId to every real-world incident, so reports from five newspapers produce one playable question.
   Cluster paraphrases describing the same event using similarity; human-review uncertain matches.
   Reject repeated fictional plots with superficial wording changes.
   Keep published questions immutable within a day's schedule; don't reshuffle after players begin.
   Scheduling algorithm
   Generate the next 30–60 days in advance from approved, unused questions.
   Seed the selection by UTC date for deterministic output.
   Enforce answer balance, category diversity and difficulty mix.
   Prefer never-used questions; when pool exhausted, apply a configurable minimum cooldown (e.g. 180 days) and warn the editor.
   Persist scheduled IDs; do not select fresh random questions independently on each client request.
   Keep questionId, canonicalEventId, lastPublishedAt, timesPublished, approvedAt in scheduler metadata.
   Daily challenge schedule should be checked by CI for duplicates, insufficient inventory, and invalid references.

Note: A 180-day cooldown requires 900 unique questions for 5/day in steady state. At 300 launch questions, a 180-day cooldown is impossible without adding new questions regularly. Make shortage visible rather than violating the policy silently.

7. Security, privacy, reliability
   Never expose ingestion keys, internal moderation routes or unrevealed answer keys in the initial public payload.
   Restrict ingestion/admin scripts to local CLI or authenticated private jobs.
   Validate API inputs, limit payload sizes, apply basic rate limiting if needed, and escape displayed text.
   Store only local gameplay progress by default; no personal profiles or tracking cookies required for MVP.
   Handle failed ingestion gracefully: previously approved daily challenges continue to work.
   Respect GDELT attribution (https://www.gdeltproject.org/) and publisher rights; link to original reporting.
   Clearly label site as unofficial and independent of Rockstar Games / Take-Two.
8. Suggested build phases
   Phase 1 — Design & functional MVP
   Mockups for all six screen states.
   React/Tailwind responsive implementation.
   Minimal Node endpoints and 20–30 clearly labeled sample questions (fictional placeholders, not falsely sourced Florida news).
   Daily scoring, reveal, localStorage, sharing, loading/empty/error states.
   Phase 2 — Content ingestion
   GDELT import CLI, source adapters, JSON candidate queue.
   Deduplication and review workflow (initially manual JSON review).
   Approved bank >=300, reliable attribution and citations.
   Deterministic schedule generator and CI validation.
   Phase 3 — Growth
   Endless Mode, archive, streaks, analytics and SEO landing pages.
   Optional privacy-conscious ads only after measuring retention and checking ad policy.
   Optional authenticated moderation UI if manual JSON editing becomes burdensome.
9. Acceptance criteria
   A visitor can complete 5 questions, see score and copy/share a spoiler-free result.
   Same UTC date yields the same questions and order for all users.
   Florida answers always have a reviewed source URL and factual explanation.
   Fiction is explicitly identified as fictional; no unsupported GTA VI canon claims.
   No repeated canonical event within the scheduled window.
   Question bank validation fails on duplicate IDs, missing sources for Florida answers, invalid statuses or impossible daily schedules.
   Keyboard and mobile usability; no layout shift on reveal; readable error states.
   No secrets in frontend; no paid news API required for MVP.
