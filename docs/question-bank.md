# Question bank and daily schedule

The game is a verified question bank that a human fills every 3–4 months, plus a scheduler that writes the daily rounds ahead of time. Nothing is generated while people play: the public API only reads rounds that were already persisted.

## How it fits together

| Concept | Where it lives |
| --- | --- |
| Question (`id`, `headline`, `origin`, `status`, `sourceUrl`) | D1 `questions` (`play_title`, `answer_kind`, `quality_state`) and its `source_references.original_url` |
| `eventId` | `questions.event_id`. Empty means the question's own incident. Questions about the same underlying event share it. |
| `spoiler` | `questions.spoiler`. Spoilers are left out of scheduling unless you include them. |
| Draft / approved / rejected | `quality_state` `candidate` / `approved` / `rejected` (also `retired`, for withdrawn questions) |
| `DailyChallenge { date, questionIds }` | `daily_rounds` (day, number, status, Florida count) and `daily_round_items` (day, position 1–5, question) |
| Player progress and scores | The player's browser only (unchanged) |

- **Approval is always by a human, and audited.** It goes through `questions:approve`, and `services/eligibility.ts` decides what may be scheduled and served.
- **The public API is unchanged.** Players get `h1`…`h5` and headlines only. The answer, source and event are revealed one question at a time after a guess.

## Collecting content (every 3–4 months)

The flow is Discover → Verify → Draft → Review → Approve → Store → Schedule.

1. **Discover and verify by hand.** Use the research sources below, and open the original page each time:
   - Florida: ClickOrlando "Strange Florida", the Polk and Flagler County Sheriff's Offices, the Florida Fish and Wildlife Conservation Commission, Tampa Police.
   - GTA: Rockstar Newswire and the official GTA VI pages, GTA Base, Grand Theft Wiki.

   These are verification sources, not feeds. Nothing is approved because of where it came from.
2. **Draft a batch file** in your own words (format below). Keep real batch files out of git: they contain the answers. `data/bank/*.json` is git-ignored, except the dev fixtures.
3. **Validate offline**, then import the batch as candidates:

   ```bash
   npm run bank:import -- --file data/bank/2027-q1.json --env staging --dry-run
   npm run bank:import -- --file data/bank/2027-q1.json --env staging
   ```

   The validation refuses:
   - a headline that copies or closely paraphrases the source headline (`sourceTitle`);
   - wording that gives the answer away ("Florida", "GTA", game names…);
   - placeholder text;
   - a blocked or satire source;
   - a GTA item whose URL is not a registered GTA reference;
   - one event used for both origins;
   - duplicate wording.

   Re-running the same file is safe: drafts that were already imported come back as duplicates.
4. **Review and approve** each candidate. The approval command re-checks the link and records your attestations.

   ```bash
   npm run admin -- candidates:list --state candidate
   npm run admin -- candidates:show --id <q>

   # Florida
   npm run admin -- questions:approve --id <q> --factual-summary \
     --attest-human-written --attest-incident --attest-claims --attest-privacy \
     --verified-date 2026-10-02 --verified-location "Lakeland, Florida" --evidence-url <https-url> \
     --location-verified --published-at 2026-10-02 --publisher "Polk County Sheriff's Office"

   # GTA
   npm run admin -- questions:approve --id <q> --factual-summary \
     --attest-human-written --attest-incident --attest-claims --attest-privacy \
     --verified-date 2026-11-20 --verified-location "Liberty City" --evidence-url <https-url> --game GTA_III
   ```

   - Add `--event-id <id>` to group a question with others about the same event.
   - Add `--spoiler` to keep it out of scheduling (for example, unreleased GTA VI story).
   - After approval, change only that metadata with `questions:edit --id <q> --event-id … | --spoiler | --no-spoiler`.
   - To drop a question: `questions:reject` for candidates, `withdraw --question` for anything already scheduled.
5. **Generate the schedule** (next section).

Aim for an inventory of about 300 approved questions (150 Florida, 150 GTA). A 30-day event cooldown needs at least 5 × 30 = 150 distinct events to rotate indefinitely, and about 75 per side for 50/50 days. The scheduler warns when you are below that. Never fill the bank with invented or placeholder content.

### Batch file format

```json
{
  "batch": "2027-Q1",
  "questions": [
    {
      "eventId": "fl-2026-lakeland-heron",
      "origin": "FLORIDA",
      "headline": "A heron keeps stealing bait from the same pier every morning",
      "explanation": "Deputies say anglers reported the bird for weeks; it was never caught.",
      "sourceUrl": "https://www.polksheriff.org/…",
      "sourceTitle": "The source page's own headline (internal; used only for the copy check)",
      "publisher": "Polk County Sheriff's Office",
      "publishedAt": "2026-10-02",
      "location": "Lakeland, Polk County, Florida",
      "category": "wildlife",
      "difficulty": 2,
      "notes": "Verified against the release and a second report."
    },
    {
      "eventId": "gta3-armored-van",
      "origin": "GTA",
      "headline": "A crew rams an armoured van until its guards abandon it",
      "explanation": "A documented mission: ram the security van until the guards flee, then deliver it.",
      "sourceUrl": "https://www.grandtheftwiki.com/…",
      "sourceTitle": "Mission page title",
      "game": "GTA_III",
      "category": "crime",
      "spoiler": false
    }
  ]
}
```

| Field | Rules |
| --- | --- |
| `eventId` | Lowercase letters, digits and `:._-`, 3–80 characters. Two questions about the same event share it. |
| `origin` | `FLORIDA` or `GTA` |
| `headline` | 12–200 characters, original wording, no giveaways |
| `explanation` | 20–600 characters, original wording |
| `sourceUrl` | https; for GTA, a registered GTA reference |
| `sourceTitle` | The source page's own headline. Internal only; used for the copy check. |
| `category` | `wildlife`, `crime`, `vehicles`, `weird` or `other` (default `other`) |
| `difficulty` | 1–3 (default 2) |
| `game` | GTA only (e.g. `GTA_V`, `GTA_VI`) |
| `location`, `publisher`, `publishedAt` | Florida: needed at approval |
| `spoiler` | Optional; default `false` |
| `notes` | Optional, internal |

## Generating the schedule

```bash
npm run admin -- schedule --days 30 --dry-run    # plan and report, write nothing
npm run admin -- schedule --days 30              # write the next 30 days (from today, UTC)
npm run admin -- schedule --days 90 --start 2027-01-01 [--cooldown 30] [--include-spoilers]
npm run admin -- schedule:top-up                 # what the cron does (see below)
```

**Rules**, enforced in `packages/core/src/round-plan.ts` and `apps/worker/src/services/scheduling.ts`:

- **Five questions a day.** Each slot is independently Florida or GTA with probability ½, so any split from 0/5 to 5/0 can happen, in random order.
  - If the inventory on a date cannot fill the draw, it is resampled among the splits that can be filled. That is exactly equivalent to redrawing until it fits, but bounded.
- **Hard constraints (never broken):**
  - no question or event twice in a day;
  - no event within the cooldown (default 30 days) of another showing, before or after, including days that already exist;
  - only approved, eligible questions;
  - spoilers excluded unless `--include-spoilers`.
- **Preferences**, in order: least-used questions first, then no near-identical headlines on one day, then variety of category, publisher, game and difficulty.
- **Questions are reused** once their event's cooldown has passed.
- **All or nothing.** The whole period is planned before anything is written. If it cannot be filled, nothing is written and the command explains why. For example:

  > Cannot fill 2027-01-17: only 3 event(s) are usable that day (1 Florida, 2 GTA; 5 needed) under the 30-day event cooldown. The eligible bank has 40 Florida and 35 GTA event(s)…

  To fix it: approve more questions about different events, plan fewer days, or use a shorter `--cooldown`. `--allow-partial` writes the valid days before the blocked date.
- **Existing days are never regenerated.** Published, scheduled or withdrawn days keep their questions and order, so re-running is idempotent. Concurrent runs are safe: each run is one D1 transaction, protected by unique keys.
- **A day is a UTC calendar day.** The same day starts at midnight UTC for every player.

### The cron

The cron, `apps/worker/wrangler.jsonc`, runs twice a day (`5 0,12 * * *`). It publishes due days and tops the schedule up to `SCHEDULE_AHEAD_DAYS` (default 30, at most 90) with cooldown `EVENT_COOLDOWN_DAYS` (default 30), both optional Worker vars.

When the inventory runs low, the cron still writes the days it can fill, so today keeps a round. The response, the stats and the ingest alarm (`runwayDays`) report the shortage well before it reaches today.

### Performance

The planner was measured in Node: a 90-day plan from 300 questions takes about 5 ms of CPU when warm, and the cron's daily top-up about 0.3 ms. Workers Free allows 10 ms of CPU per request. If a 90-day request ever exceeds that on a cold start, re-run it: nothing is written unless the whole plan succeeds. Alternatively, run it as `--days 30` three times with consecutive `--start` dates; each run respects the days already written.

## Development fixtures

These are clearly labelled placeholders, and the Worker accepts and serves them only with `APP_ENV=local`.

```bash
npm run dev                                         # local Worker + web
npm run dev:seed                                    # 50 placeholder questions + a week of rounds
npm run bank:import -- --file data/bank/dev-fixtures.json --env local --to http://127.0.0.1:8787
npm run admin -- schedule --days 7 --dry-run --cooldown 3
```

`data/bank/dev-fixtures.json` contains placeholder wording, `fixture.invalid` URLs, events with two wordings, and one spoiler.

## Deploying this change

1. Apply migration `0004_question_bank_scheduling.sql` before deploying the Worker:

   ```bash
   npm run db:migrate:staging -w @gof/worker
   ```

   It adds `event_id`/`spoiler` and rebuilds the two round tables, so questions can be reused and any split stored. Every existing round and item is copied unchanged.
2. Deploy the Worker: `npm run deploy:worker:staging`.
3. Run `npm run admin -- sources:sync`. This registers the two new GTA reference sources (`rockstar-newswire`, `gtabase`) as unreviewed. No rights are granted.

The old Worker code also runs against the migrated schema, so the order matters only in this direction: migrate first.

The legacy static demo (`data/questions.approved.json`, `scripts/build-daily-schedule.ts`) still uses its own planner. It is retired at the Cloudflare cutover.
