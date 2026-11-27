# Daily Drive redesign: investigation and plan

Status: **approved and implemented** on branch `feat/daily-drive-redesign` (uncommitted, not deployed). Section 10 records the decisions and where the build differs from this plan.
Asset source: `redesign/` in this repo. It is identical to the external `daily-drive-assets/` kit, except that the kit also contains `CLAUDE_CODE_PROMPT.md`.

## 1. Codebase map (apps/web)

| Area | Files |
| --- | --- |
| App shell, routing | `src/main.tsx` (fonts, `styles.css`, React Query, router), `src/router.tsx` (`/`, `/play`, `/play/$date?replay`, `/results/$date`, `/archive`, `/about`) |
| Landing | `src/routes/Landing.tsx` (`Landing`, `TodayCta`, `Pitch`) |
| Round container | `src/routes/Play.tsx` (`PlayScreen`: loading, error, withdrawn, not-ready, already-played redirect) |
| Game state and logic | `src/features/game/session.ts` (`sessionReducer`, `initialSession`, `toProgress`), `src/features/game/GameSession.tsx` (clock, persistence, answer/finish mutations, view switch) |
| Question | `src/features/game/QuestionView.tsx` (headline, G/F keys, answer buttons) |
| Reveal | `src/features/game/RevealView.tsx` (`RevealView`, `AnswerDetails`, `AnswerBadge`) |
| Time's up | `src/features/game/TimeUpView.tsx` |
| HUD | `src/features/game/GameHeader.tsx` (quit, label, timer, bar, progress, SR announcements) |
| Results and share | `src/routes/Results.tsx` (`ResultsView`, `ResultsScreen`, `useCountdown`) |
| Shared UI | `src/components/ui.tsx`, `Icons.tsx`, `Gator.tsx`, `ResultGrid.tsx`, `StateScreens.tsx` |
| Other screens | `src/routes/Archive.tsx`, `src/routes/About.tsx` (incl. `NotFound`) |
| Persistence | `src/lib/storage.ts` (`gof:v1:results`, `gof:v1:progress:<date>`; `computeStats`) |
| Share | `src/lib/share.ts` + `buildShareText` in `packages/core/src/game.ts` |
| API | `src/api/{client,static,queries,index}.ts` |
| Styles | `src/styles.css` (Tailwind v4 + `@theme` tokens, `.card`, `.label-wide`, reduced motion); fonts `@fontsource/shrikhand`, `@fontsource-variable/archivo` |
| Tests | `test/game.test.tsx`, `test/play-states.test.tsx`, `test/session.test.ts`, `test/static-api.test.ts`, `test/storage.test.ts` |

Facts that the redesign depends on:
- The round size is **5**: `DAILY_SIZE = 5` and `TIME_LIMIT_SECONDS = 60` in `packages/config/src/index.ts:187,191`. The worker sends this as `timeLimitSeconds`. So the Q1–Q5 → zone mapping and the 12 × 5 s timer bar fit.
- The game has **no analytics** (see `About.tsx:70`), **no sessionStorage**, and **no OG tags** in `index.html`.
- **There is no lint script** in the repo (`package.json` has `typecheck`, `test`, `validate`, `ci`). "Lint passes" can only mean `npm run ci`. I will not add a linter, because that would be a new dependency.
- The production CSP (`vite.config.ts` → `_headers`, and `netlify.toml`) is `style-src 'self'; img-src 'self' data:; font-src 'self' data:`.
  - Self-hosted fonts work under it.
  - Canvas `toDataURL()` images work under it.
  - Inline `style="..."` attributes in HTML strings and Google Fonts are blocked. The prototype uses both.
  - The engine itself only sets `element.style` through the CSSOM and writes class-only `innerHTML`, so it is CSP-safe.

## 2. Component mapping

| Current | New (Daily Drive) | Files touched |
| --- | --- | --- |
| `Landing` (`SunsetGator`, `Wordmark`, `Pitch`, `TodayCta`, steps, `Disclaimer`) | `DriveLanding`: pixel "DAILY / DRIVE" logo, pitch, attract `<DriveMap attract>`, `<Gus>` + bubble, Start CTA (same states as `TodayCta`: play / resume / see result / not ready / withdrawn / error + retry), 3 steps, stats (`computeStats`, read-only), disclaimer | new `src/daily-drive/screens/DriveLanding.tsx`; `routes/Landing.tsx` gets a 2-line flag switch |
| `GameHeader` | `DriveHud` (quit, "DAILY DRIVE #N" or "ARCHIVE #N" / "REPLAY #N" + zone name, `<HudTimer>`) + `<DriveMap>` + `<CheckpointRoute>` | new `src/daily-drive/components/*` |
| `QuestionView` | `DriveQuestion`: headline card + `<Gus>` buddy + two `<ArcadeButton>`s | new |
| `RevealView` / `AnswerDetails` | `<RevealPanel>` in the button slot. It reuses the **same data fields** as `AnswerDetails`: badge, GTA-lore/fiction line, `originalTitle` only when the server sent it, explanation, source link, placeholder note | new |
| `TimeUpView` | `DriveTimeUp`: "TIME'S UP!" banner over the play screen plus the **existing** "See my results" button and error | new |
| (none) | `<StreakBanner>`, turbo flames | new |
| `ResultsView` | `DriveResults`: `<ScoreReveal>` → `<Postcard>` → share block (same `buildShareText` / `shareText` / `copyText` / textarea fallback / status messages) → stats → countdown (existing `useCountdown`) → "Your route" list (reuses the `AnswerDetails` content) → archive link and replay-back link | new; `routes/Results.tsx` gets a flag switch and exports `useCountdown` |
| `GameSession` render block | `DriveSession` (presentational) receives `state`, `challenge`, `remainingMs`, `choose`, `next`, `finish` and the busy/error flags | `GameSession.tsx`: **only the JSX return (lines 116–151)** gains `if (dailyDrive) return <DriveSession … />`. The reducer, effects and mutations are untouched |
| `PlayScreen` loading / error / empty states, `Archive`, `About`, `NotFound` | Not in the prototype. **Decision needed (Q4).** | — |
| (none) | `DevPanel` (only when `import.meta.env.DEV`) | new `src/daily-drive/dev/*` |

## 3. State signals the UI reads (all existing, read-only)

| Signal | Exact source |
| --- | --- |
| Question index | `state.index` (`GameSession`, `useReducer(sessionReducer)`) |
| Phase | `state.phase`: `'question' \| 'answering' \| 'reveal' \| 'timeup' \| 'finishing'`, plus `state.finishFrom` |
| Per-question result | `state.answers[i].correct`, `.choice` and `.question` (`RevealedQuestion` from `POST /answer`, which arrives only after answering) |
| Last answer | `lastAnswer = state.answers[state.index]` |
| Time left | `remainingMs = max(0, limitMs - state.elapsedMs)`; `limitMs = challenge.timeLimitSeconds * 1000` |
| Paused | `state.phase !== 'question'` (same expression as `GameHeader`'s `paused` prop) |
| Low time | `Math.ceil(remainingMs/1000) <= 10` (same as `GameHeader`'s `low`) |
| Busy / errors | `state.phase === 'answering'`, `state.phase === 'finishing'`, `state.answerError`, `state.finishError` |
| Total | `challenge.questions.length` |
| Round label / number | `practice`, `mode` (`'daily' \| 'archive'`), `challenge.number` |
| Final score | `StoredResult.score` / `.total` (server `FinishResponse`) |
| Elapsed time | `StoredResult.seconds`, `StoredResult.timedOut` |
| Answer history | `StoredResult.cells` (`true / false / null`), `.choices`, `.questions` |
| Share text | `buildShareText({date, cells, seconds, url: publicUrl()})` (unchanged) |
| Next round | `msUntilNextUtcDay()` via `useCountdown` (unchanged) |
| Stats | `computeStats(getResults(), utcDate())` (unchanged) |

Nothing computes or shows the correct answer before `POST /answer` resolves. The map's `drive()` and the `<Gus>` reaction both trigger on `state.answers.length` growing.

## 4. Current timer behaviour (frozen)

- One **round-wide** 60 s clock, not a per-question clock: `GameSession.tsx:38-47`.
- The clock ticks every 200 ms **only while `state.phase === 'question'`**. Everywhere else (answering, reveal, timeup, finishing) it is paused: `session.ts:66-71` ignores ticks outside `question`.
- It also pauses while the answer request is in flight (`answering`), not only during the reveal.
- **At 0**, the reducer sets `phase = 'timeup'` and clamps `elapsedMs` to the limit (`session.ts:69`). The player then presses **"See my results"** (`TimeUpView` → `finish()`). There is **no** auto-advance; the prototype's 1.5 s auto-advance will not be ported.
- Elapsed time is persisted every whole second (`GameSession.tsx:50-54`). On reload, a round that had run out resumes as `timeup` (`session.ts:43-46`).
- Screen-reader announcements fire at 30, 10 and 5 s, once each (`GameHeader.tsx:6,35-43`), plus `role="timer"` with an aria-label that includes "paused". **These will be kept as they are**; the brief's "announce Ten seconds left once" is already a subset of them.

**Existing keyboard shortcuts:**
- **G** / **F** during the question phase, ignored while busy or with Meta/Ctrl/Alt held (`QuestionView.tsx:26-35`).
- **Enter** / **→** during the reveal, ignored when focus is on a link, button, input, textarea or summary (`RevealView.tsx:78-90`).

The new shortcuts are additive: **N**, plus ignoring keys in inputs or contenteditable elements and while Shift is held. They live in a new `useDriveKeys` hook used only by the new UI.

## 5. Files I will NOT modify

- `apps/web/src/features/game/session.ts`
- `apps/web/src/features/game/GameSession.tsx` (except for the single render-switch line described in §2. The diff will be shown, and no logic lines will change.)
- `apps/web/src/lib/storage.ts`, `apps/web/src/lib/share.ts`, `apps/web/src/lib/format.ts`, `apps/web/src/lib/useUtcDay.ts`
- `apps/web/src/api/**`
- `apps/web/src/router.tsx`
- `apps/web/index.html` (meta tags)
- `packages/**`, `apps/worker/**`, `apps/ingest*/**`, `scripts/**`
- The legacy view components (`QuestionView`, `RevealView`, `TimeUpView`, `GameHeader`, `Landing` body, `ResultsView` body). They stay as the flag-off fallback.
- The existing tests in `apps/web/test/*`, which will stay unchanged.

## 6. Setup (after approval)

- Branch: `feat/daily-drive-redesign`. No commits to `main`, no push and no deploy without asking.
- Copy `redesign/css/{tokens,animations,components}.css`, `js/pixel-engine.js`, and `data/{copy,motion,tokens}.json` into `apps/web/src/daily-drive/`.
  - `sample-questions.json` is copied **only** into `src/daily-drive/dev/`. It is imported only behind `import.meta.env.DEV`, and nothing in production imports it.
- **Images:** I propose using the engine's own output instead of the PNGs: `SPR` data URLs for Gus, `CARU` for the car, and `drawArt()` canvases for postcards. This creates **zero new image requests** and matches the brief's "no new network requests beyond fonts". The PNGs stay in `redesign/` for OG or marketing use later. (Q5)
- **Fonts:** add `@fontsource/press-start-2p`, `@fontsource/silkscreen` (400 and 700) and `@fontsource/rubik` (400, 500, 600, 700). They are self-hosted; `fonts.css`'s Google `@import` is dropped, since the CSP would block it anyway.
- **CSS scoping:** `components.css` has global rules (`*`, `html`, `body`, `body::after`, `[hidden]`, `button`, `a`, `:focus-visible`, `kbd`, `table`, `th/td`). It also has class clashes with the current app: `.card`, `.headline`, `.hero`, `.stats`, `.steps`.
  - I will rewrite the selectors under a `.dd` root, using CSS nesting with `html` and `body` rules moved to `.dd`.
  - Import order: tokens → animations → components.
  - The design-system page rules (`.ds`, `.sw`, `.sheet`, `.typerow`…) are not shipped. The dev-panel rules go into a DEV-only stylesheet.
  - The reduced-motion block stays and is scoped to `.dd`.
- **Engine:** plain JS plus `pixel-engine.d.ts` covering the exports used (`DriveMap`, `SPR`, `STATES`, `drawArt`, `endingFor`, `ZONES`, `setReducedMotion`).
  - It builds sprites when the module loads, so it is only imported from `src/daily-drive/` modules.
  - All `DriveMap` and `drawArt` calls happen inside `useEffect`.
  - Tests mock it with `vi.mock`.
- **Flag:** `VITE_DAILY_DRIVE`, resolved once in `src/daily-drive/flag.ts`:
  - `'1'` / `'0'` set explicitly always wins.
  - When unset, it is **on** in `vite dev` and in the Cloudflare Pages build (approved for release on 2026-11-28). It stays **off** in Vitest (`MODE === 'test'`), so the existing tests keep exercising the legacy UI unchanged and the new tests opt in, and in the legacy static demo build (`--mode pages`).
  - Rollback: set `VITE_DAILY_DRIVE=0` in the Cloudflare Pages environment and rebuild.
  - Because the flag is a build-time constant, the Daily Drive code, CSS and fonts drop out of the bundle when it is off. I will measure that.

## 7. Testing plan

New tests in `apps/web/test/daily-drive/`:
- Score → ending mapping, `endingFor` for scores 0–5.
- The keyboard hook:
  - G/F only in the question phase.
  - Enter/N/→ only in the reveal.
  - Ignored in inputs, with modifiers, and while busy.
- `<DriveMap>` mount and unmount with the engine mocked: `new DriveMap`, `drive(i+1, !correct, cb)` on a new answer, `setMark` + `jump` with no animation on resume, `destroy()` on unmount.
- A full round through `GameSession` with the flag forced on, against the same fetch mock as `game.test.tsx`, to show the same score and saved result.
- The dev panel being absent from a production build: grep `dist` for a marker string.

Acceptance runs:
- `npm run ci` and `npm run build -w @gof/web`, with and without the flag, recording the bundle size delta.
- Manual checks against the staging API (`npm run dev:web` with `VITE_API_BASE_URL` set to staging, flag on and off):
  - Same score and timer behaviour.
  - Widths 360, 390, 768 and 1280.
  - Reduced motion.
  - A keyboard-only round.
  - The network tab.

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Kit CSS leaks into legacy screens (`.card`, `button`, `body` rules, Tailwind preflight interplay) | Everything is scoped under `.dd`. The legacy UI is only rendered outside `.dd`. Both flag states get a visual check |
| A logic regression from touching `GameSession` | Only one render-switch line changes. The reducer and effects are untouched. Existing tests run unchanged, plus a flag-on full-round test |
| Map and Gus drift out of sync with state after a reload or resume | The map is rebuilt from `state.answers` (`setMark` + `jump`, no animation) on mount. Animations only trigger on `answers.length` increasing in-session |
| Animation blocks input | Animations never gate state. Next and the answer buttons depend only on the existing `phase`/`busy`. The drive runs alongside the reveal |
| CSP breakage in production | No inline style attributes in HTML strings and no Google Fonts. Images are canvas data URLs (`img-src data:` is allowed). Checked with `vite preview` plus the generated `_headers` |
| Engine touches `document` during tests | The engine is only imported from `src/daily-drive/`, the flag is off in tests by default, and new tests mock it |
| Screen-reader regression | The `role="timer"` label, the 30/10/5 s announcements, the "Headline N of 5" live text, `ResultGrid`-style text for every checkpoint, and verdict announcements are all kept. Focus handling is in Q3 |
| Bundle growth | Fonts load only when Daily Drive CSS uses them (`@font-face` is lazy), and the code is tree-shaken when the flag is off. I will report the delta |

## 9. Decisions needed before I start

1. **In-round streak.** The app has **no in-round streak** today; the existing `streak` is consecutive *days* (`computeStats`). I propose deriving a display-only count: consecutive `correct` values at the end of `state.answers`. This affects only the banner, flames and Gus, never the score or storage. OK?
2. **Ending title.** The current results card shows `scoreTitle()` from core (e.g. "Swamp savant"). The postcard would show the kit's ending title (e.g. "FLORIDA VETERAN") instead. Share text has no title, so it is unchanged. Should I replace `scoreTitle` on the Daily Drive results, or show both?
3. **Reveal focus.** Today focus moves to the verdict heading, so screen readers read it. The brief asks for focus on the Next button. I propose focusing Next and announcing "Correct! It was Florida." through an `aria-live` region, so the verdict is still read. OK?
4. **Screens not in the prototype:** loading, error, withdrawn and not-ready states in `PlayScreen`, plus Archive, About and 404. Options:
   - (a) Leave them on the legacy look in this pass.
   - (b) Recommended: re-skin them under `.dd` using only kit primitives (`panel`, `btn2`, `topbar`, `chip`), with the same structure and copy and no new layouts.
5. **Images.** Can I use engine-generated art (no new requests) instead of copying the PNGs into `src/assets`?
6. **Unanswered questions after time's up.** In the prototype these become "bad" detours. Results already count them as misses but show them as *unanswered* (⬜ in share text). I propose the dashed "pending" checkpoint shape with the label "Unanswered" rather than the orange cone. OK?

## 10. Decisions (approved 2026-11-24) and implementation notes

Decisions:
1. **In-round streak:** a display-only count of correct answers in a row at the end of `state.answers` (`src/daily-drive/lib/streak.ts`). Not stored, not scored.
2. **Results title:** the postcard shows the ending title for the level reached (5 Vice Legend … 0–1 Certified Florida Man), in place of `scoreTitle()`. Share text is unchanged.
3. **Reveal focus:** focus goes to Next. The verdict ("Correct. It was Florida.") is announced in a polite live region.
4. **Other screens:** light re-skin. Under `.dd`, the legacy Tailwind theme variables point to the Daily Drive palette and fonts, cards get pixel corners, rounding is removed, and Gus replaces the SVG gators in the empty and error states. No markup or copy changes on Archive, About or 404.
5. **Images:** engine-generated (`SPR` data URLs, `drawArt` canvases). No PNG requests.
6. **Unanswered after time's up:** dashed "pending" checkpoint shape, labelled "unanswered".

Where the build differs from the plan:
- **Flag-off bundle.** A dynamic `import()` of the boot module still produced extra chunks in flag-off builds. Instead, `main.tsx` imports `daily-drive/boot.ts` statically, and `vite.config.ts` aliases it to the empty `boot-off.ts` when the flag is off. A flag-off build has the same files as before (one JS, one CSS, no new fonts), plus about 0.6 kB of JS.
- **`routes/Play.tsx`:** with the flag on, the round renders without the legacy 520px `Column`. Its 48px bottom padding stopped the question screen fitting on 390×844.
- **`lib/useCountdown.ts`:** the existing results countdown hook was moved here unchanged, so both results views use it.
- **Fonts:** the Shrikhand and Archivo imports stay for the legacy UI. With the flag on they are never used, so the browser doesn't download them.
