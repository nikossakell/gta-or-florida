# GTA or Florida? 🐊

Ένα γρήγορο, mobile-first daily trivia game: διαβάζεις έναν παράλογο τίτλο και αποφασίζεις αν είναι **πραγματικό, επαληθευμένο περιστατικό από τη Florida** ή **φανταστικό GTA-style σενάριο**. Πέντε τίτλοι, 60 δευτερόλεπτα, spoiler-free share.

> Unofficial, fan-made parody. Δεν σχετίζεται με τη Rockstar Games ή την Take-Two Interactive. Δεν χρησιμοποιείται κανένα artwork, logo, font ή asset από παιχνίδια GTA· το mascot (αλιγάτορας με γυαλιά ηλίου) είναι πρωτότυπο SVG.
>
> Το **«GTA»** στο παιχνίδι σημαίνει *fictional GTA-style scenario* γραμμένο για αυτό το project, όχι γεγονός από πραγματικό GTA game και σε καμία περίπτωση GTA VI canon.

---

## Γρήγορη εκκίνηση

Απαιτείται **Node.js ≥ 22.12** (βλ. `.nvmrc`).

```bash
npm install
npm run dev          # API στο :8787 + Vite στο :5173 (με proxy /api → API)
```

Production-like εκτέλεση (ένα process, το API σερβίρει και το built SPA):

```bash
npm run build
npm start            # http://127.0.0.1:8787
```

Έλεγχοι:

```bash
npm test             # Vitest σε όλα τα workspaces (core, api, web, scripts)
npm run typecheck    # tsc --noEmit σε κάθε workspace
npm run validate     # επικύρωση question bank + schedule (το ίδιο τρέχει στο CI)
npm run ci           # όλα τα παραπάνω
```

Προαιρετικά: `cp .env.example .env` για ρυθμίσεις. Το MVP **δεν χρειάζεται κανένα secret** (το GDELT DOC 2.0 δεν θέλει API key). Μόνο μεταβλητές `VITE_*` φτάνουν στο browser bundle — ποτέ secrets εκεί.

---

## Deployment στο GitHub Pages

**Δεν χρειάζεται `index.html` στη ρίζα του repo.** Αυτό απαιτείται μόνο στο «Deploy from a branch» (που σερβίρει αυτούσιο το `/` ή το `/docs`). Εδώ χρησιμοποιείται το workflow `.github/workflows/pages.yml`, που κάνει build και ανεβάζει τον φάκελο `apps/web/dist-pages` ως Pages artifact.

Ρύθμιση (μία φορά): **Settings → Pages → Build and deployment → Source: GitHub Actions**. Μετά από κάθε push στο `main` γίνεται deploy στο `https://<user>.github.io/<repo>/`.

Πώς λειτουργεί χωρίς server:

- `vite build --mode pages` → ο client διαβάζει pre-generated JSON αντί για `/api` (`apps/web/src/api/static.ts`, ίδιο interface με τον HTTP client).
- `scripts/build-pages.ts` κάνει validate το content και γράφει:
  - `data/challenge/<date>.json`: μόνο public questions (χωρίς answers/explanations/sources, positional IDs)
  - `data/reveal/<date>/h1..h5.json`: ένα αρχείο ανά ερώτηση, που φορτώνεται **μόνο αφού απαντηθεί**
  - `data/archive.json`, `404.html` (αντίγραφο του `index.html` για deep links όπως `/archive`) και `.nojekyll`
- Το base path (`/<repo>/`) έρχεται αυτόματα από το `actions/configure-pages` (`BASE_PATH`), και το share URL από το `base_url`.
- **Daily rebuild (cron 00:07 UTC):** δημοσιεύονται μόνο οι ημέρες ≤ σήμερα (μέσα στο archive window). Οι μελλοντικοί γύροι δεν υπάρχουν καν στο site μέχρι να έρθει η μέρα τους. Αν το cron καθυστερήσει, οι παίκτες βλέπουν «No headlines today».

Trade-offs του static mode:

- Οι απαντήσεις των ήδη δημοσιευμένων ημερών είναι δημόσια αρχεία· κάποιος που επιμένει μπορεί να τις ανοίξει. Είναι ισοδύναμο με το per-question reveal endpoint του API, και το brief θεωρεί το cheating resistance εκτός scope. Αν χρειαστεί περισσότερη προστασία, χρησιμοποιήστε το Node API (`npm run build && npm start`) σε host με server.
- Τα deep links (π.χ. reload στο `/archive`) σερβίρονται μέσω `404.html`, άρα με HTTP status 404, ενώ η εφαρμογή φορτώνει κανονικά. Αυτός είναι γνωστός περιορισμός του GitHub Pages.
- Δεν υπάρχουν custom headers (CSP, rate limiting): αυτά ισχύουν μόνο στο Node API.
- Τα scheduled workflows απενεργοποιούνται από το GitHub μετά από 60 ημέρες χωρίς activity στο repo· τότε χρειάζεται re-enable στο tab Actions.
- Τα sample data είναι placeholders, και το workflow τα επιτρέπει με default `ALLOW_PLACEHOLDER_CONTENT=true`. Όταν μπουν πραγματικές ερωτήσεις, ορίστε το repository variable `ALLOW_PLACEHOLDER_CONTENT=false`.

Τοπικά:

```bash
npm run build:pages          # → apps/web/dist-pages (base "/")
npm run preview:pages        # vite preview του static build
BASE_PATH=/gta-or-florida npm run build:pages   # όπως στο GitHub Pages
```

Το Pages build πηγαίνει στο `dist-pages/`, ξεχωριστά από το `dist/`, ώστε ο Node server να μη σερβίρει ποτέ κατά λάθος τα static answer files.

---

## Δομή (TypeScript monorepo, npm workspaces)

```text
packages/core/        Shared domain logic (καθαρές συναρτήσεις, χωρίς I/O)
  src/types.ts          Question, ScheduleFile, Candidate, …
  src/dedupe.ts         canonical URL, title fingerprint, similarity, deduper
  src/validate.ts       validation του bank και του schedule
  src/schedule.ts       deterministic UTC daily scheduler
  src/game.ts           public/revealed projections, scoring, share text
  src/api-contract.ts   τύποι request/response του δικού μας API
apps/api/             Minimal node:http server (χωρίς Express)
  src/server.ts         entry point, graceful shutdown
  src/app.ts            routing, JSON body limits, rate limiting, security headers
  src/services/challenge.ts   today / archive / answer / finish
  src/services/questions.ts   file-backed content store με hot reload + last-good fallback
apps/web/             React 19 + Vite + Tailwind CSS v4 + TanStack Query + TanStack Router
  src/routes/           Landing, Play, Results, Archive, About
  src/features/game/    session state machine, timer, question/reveal/time-up views
  src/components/       UI primitives, εικονίδια, πρωτότυπο gator SVG
  src/lib/              localStorage, share/copy, formatting
  src/api/              HTTP client (Node API) + static client (GitHub Pages)
scripts/              Τοπικά CLI εργαλεία (ingestion/validation/scheduling)
  import-gdelt.ts       GDELT DOC 2.0 → questions.candidates.json (ποτέ auto-publish)
  validate-questions.ts CI gate
  build-daily-schedule.ts
  build-pages.ts        static data + 404.html για GitHub Pages
data/
  questions.approved.json   approved question bank (μόνο αυτό είναι playable)
  questions.candidates.json candidate queue από ingestion (μη playable)
  daily-schedule.json       persisted ημερήσια sets
  sources.json              GDELT query batches, blocked/hint domains, place names
```

Τα scripts είναι TypeScript (τρέχουν με `tsx`) αντί για `.mjs`, ώστε να μοιράζονται τον ίδιο κώδικα dedupe/validation/scheduling με το API μέσω `@gof/core`.

---

## API (δικό μας, όχι third-party)

| Method | Path | Περιγραφή |
| --- | --- | --- |
| `GET` | `/api/health` | Status, πλήθος ερωτήσεων, αν υπάρχει σημερινό challenge. `503` αν τα data είναι degraded. |
| `GET` | `/api/challenge/today` | `date`, `challengeId`, `number`, `timeLimitSeconds`, `sample` και 5 public questions **χωρίς** answer, explanation ή source. |
| `GET` | `/api/challenge/:date` | Παρελθόν challenge μέσα στο archive window (default 7 ημέρες). Μελλοντικές ημερομηνίες → `404 FUTURE_CHALLENGE`. |
| `POST` | `/api/challenge/:id/answer` | `{ questionId, choice }` → correctness, explanation, source (μόνο για τη συγκεκριμένη ερώτηση, αφού απαντηθεί). |
| `POST` | `/api/challenge/:id/finish` | `{ answers: [{ questionId, choice \| null }] }` → server-side score, cells, όλες οι explanations. |
| `GET` | `/api/archive` | Λίστα πρόσφατων challenges (μόνο ≤ σήμερα). |

Σημεία ασφάλειας:

- **Κανένα answer key στο αρχικό payload.** Ακόμα και τα question IDs είναι positional (`h1`…`h5`): τα εσωτερικά IDs δεν φεύγουν ποτέ από τον server, γιατί ένα ID όπως `fl-0042` θα πρόδιδε την απάντηση.
- Ο per-question reveal endpoint υπάρχει για το UX «απάντησε → δες εξήγηση». Δεν είναι cheat-proof (κάποιος μπορεί να το καλέσει απευθείας) — για ένα μικρό ανώνυμο game αυτό είναι αποδεκτό και δηλωμένο.
- JSON-only bodies (`415` αλλιώς), όριο 4 KB (`413`), validation όλων των inputs, in-memory rate limiting ανά IP (`429` + `Retry-After`), `Cache-Control: no-store`, CSP / `nosniff` / `frame-ancestors 'none'`, path-traversal-safe static serving.
- Αν ένα manual edit σπάσει τα JSON, ο server **συνεχίζει να σερβίρει το τελευταίο έγκυρο content** και το `/api/health` αναφέρει `degraded`.
- Placeholder (sample) content σερβίρεται μόνο αν `ALLOW_PLACEHOLDER_CONTENT=true` (default εκτός production).

---

## Gameplay & client

- 5 τίτλοι/ημέρα, ίδιο set και σειρά για όλους, ανά **UTC date**. Το μέγεθος ορίζεται από το schedule (`--size`), οπότε το UI προσαρμόζεται (π.χ. 8 τίτλοι όπως στα mockups).
- 60" clock (`TIME_LIMIT_SECONDS`, `0` = χωρίς χρόνο) που **παγώνει όσο φαίνεται το reveal**. Όταν λήξει: «Time's up!», οι αναπάντητοι μετράνε ως λάθη.
- Reveal: σωστό/λάθος με διαφορετικό εικονίδιο (όχι μόνο χρώμα), explanation, «Read original report» για πραγματικά Florida items, ρητή ετικέτα «Fictional GTA-style scenario» για fiction.
- Results: score card, spoiler-free emoji grid, **Share** (native share sheet → fallback σε clipboard → fallback σε επιλέξιμο κείμενο), **Copy**, stats (Played / Day streak / Best), countdown για τον επόμενο γύρο, review όλων των απαντήσεων.
- Share format:

  ```text
  GTA or Florida? 🐊 #2026-11-19
  🟩🟩🟥🟩🟩
  4/5 in 41s — Can you beat me?
  https://example.com
  ```

- **localStorage μόνο** (`gof:v1:*`): ολοκληρωμένα αποτελέσματα, in-progress γύρος (reload = resume, όχι restart), streak. Είναι casual anti-repeat, **όχι tamper-proof** — αναφέρεται και στη σελίδα About, που έχει και κουμπί «Clear my local data».
- Archive: τελευταίες 7 ημέρες, φίλτρα All/Played/Not played. Τα archive plays δεν αλλάζουν το streak· τα replays δεν αποθηκεύονται.
- Fallbacks: loading skeletons, «No headlines today» όταν δεν υπάρχει schedule (ποτέ σιωπηλό recycle ή invented content), «Stuck in traffic» error με error code και retry, offline detection.
- Accessibility: πραγματικά `<button>`/`<a>`, ≥ 44px targets, ορατό focus, focus management σε κάθε νέο τίτλο/reveal, `aria-live` για timer thresholds και αποτελέσματα, keyboard shortcuts (G / F / Enter), `prefers-reduced-motion`, AA contrast, skip link, max-width ~520px στο gameplay.
- Fonts (Shrikhand, Archivo) είναι self-hosted μέσω `@fontsource` — κανένα request σε Google.

---

## Content pipeline

```text
GDELT DOC 2.0 (scheduled CLI) ──► questions.candidates.json   (metadata μόνο)
                                         │  canonical URL + fingerprint + similarity dedupe
                                         ▼
                              ανθρώπινος έλεγχος (manual JSON review)
                                         │  άνοιγμα πρωτότυπου άρθρου, επιβεβαίωση ότι έγινε στη Florida,
                                         │  πρωτότυπη σύντομη διατύπωση + explanation, attribution
                                         ▼
                              questions.approved.json  (status: "verified")
                                         ▼
                   npm run schedule:build ──► daily-schedule.json ──► Public API
```

### 1. Ανακάλυψη candidates από GDELT

```bash
npm run import:gdelt                         # τα επόμενα 3 query batches (rotation)
npm run import:gdelt -- --batch florida-woman
npm run import:gdelt -- --queries 1 --dry-run
npm run import:gdelt -- --help
```

- Χρησιμοποιεί μόνο τεκμηριωμένες παραμέτρους του [DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/): `query`, `mode=ArtList`, `format=json`, `maxrecords` (≤ 250), `timespan`, `sort`. Το API καλύπτει κυλιόμενο παράθυρο ~3 μηνών, γι' αυτό τρέχει τακτικά και τα approved items αποθηκεύονται μόνιμα.
- **Conservative pacing:** ≥ 5" μεταξύ requests (δεν γίνεται να μειωθεί), έως 6 queries/run, timeout 30", bounded retries με exponential backoff (μεγαλύτερο για `429`, σέβεται `Retry-After`), cache 6 ωρών στο `.cache/gdelt/`.
- **Explicit error handling:** HTTP errors, 429, plain-text μηνύματα του GDELT (επιστρέφει text αντί για JSON για λάθη query), μη αναμενόμενο σχήμα, network/timeout. Αν το rate limit επιμένει, το run σταματά νωρίς. Αν αποτύχουν όλα τα queries, exit code `1` — τα approved questions και το schedule δεν επηρεάζονται.
- Dedupe έναντι υπαρχόντων candidates (και των rejected, ώστε να μην ξαναεμφανίζονται) και approved questions· οι αμφίβολες ομοιότητες σημαίνονται με `possibleDuplicateOf` για ανθρώπινο έλεγχο. Satire domains απορρίπτονται. Το `floridaSignal` (title/domain/none) είναι μόνο heuristic.
- **Ποτέ δεν γράφει στο `questions.approved.json`.** Ούτε LLM ούτε scraper μπορεί να δηλώσει κάτι verified ή να εφεύρει source URL.
- Attribution: data από [The GDELT Project](https://www.gdeltproject.org/). Σεβόμαστε τα δικαιώματα των publishers: link στο πρωτότυπο, όχι αναδημοσίευση κειμένου ή φωτογραφιών. Επιβεβαιώστε τα τρέχοντα όρια του provider πριν το deployment.

### 2. Approve (manual review)

Για κάθε candidate που αξίζει: ανοίξτε το άρθρο, επιβεβαιώστε το γεγονός και ότι συνέβη στη Florida, γράψτε **δική σας** σύντομη διατύπωση, και προσθέστε στο `questions.approved.json`:

```json
{
  "id": "fl-0042",
  "headline": "Deputies say a man rode a motorized cooler along a highway shoulder",
  "answer": "florida",
  "explanation": "Deputies stopped him near the exit; he said he was late for a boat show.",
  "status": "verified",
  "category": "vehicles",
  "difficulty": 2,
  "canonicalEventId": "2026-10-cooler-highway",
  "sourceUrl": "https://publisher.example/article",
  "sourceName": "Publisher Name",
  "publishedAt": "2026-10-03",
  "reviewedAt": "2026-10-05",
  "approvedAt": "2026-10-05"
}
```

Στο candidate βάλτε `"status": "promoted"` ή `"rejected"`. Για fiction: `"answer": "gta"`, `"gtaSubtype": "fiction"`, **χωρίς** source. Το `gta_lore` (επαληθευμένα γεγονότα από πραγματικά GTA games) είναι reserved για μελλοντική χρήση και απαιτεί source.

### 3. Validation (CI gate)

`npm run validate` αποτυγχάνει σε: duplicate IDs, Florida answers χωρίς source/sourceName/publishedAt, invalid status/category/difficulty, markup σε headlines, ίδιο `canonicalEventId` ή ίδιο άρθρο δύο φορές, near-duplicate headlines (π.χ. ίδιο fictional plot με επιφανειακές αλλαγές), unknown/unverified references στο schedule, λάθος μέγεθος ημέρας, answer imbalance, repeats μέσα στο cooldown. Flags: `--production` (απαγορεύει placeholders), `--min-runway 14` (απαιτεί schedule τουλάχιστον 14 ημέρες μπροστά), `--strict` (και τα warnings αποτυγχάνουν).

### 4. Deterministic scheduling

```bash
npm run schedule:build                       # επόμενες 30 ημέρες από σήμερα (UTC)
npm run schedule:build -- --days 60 --strict
npm run schedule:build -- --help
```

- Seed ανά ημερομηνία (`${seed}:${date}`) → ίδια input = ίδιο output.
- **Υπάρχουσες ημέρες δεν αλλάζουν ποτέ** (no reshuffle αφού ξεκινήσουν οι παίκτες).
- Answer balance 2/3 ή 3/2 (γενικά 40–60%), με κλίση προς την πλευρά με περισσότερο απόθεμα ώστε το bank να αδειάζει ισόρροπα. Προτίμηση σε category diversity και difficulty mix, ποτέ δύο ερωτήσεις του ίδιου canonical event.
- Προτιμά never-used ερωτήσεις· επαναχρησιμοποίηση μόνο μετά το cooldown (default **180 ημέρες**) και με warning.
- **Exhaustion:** όταν δεν γεμίζει μια ημέρα, ο scheduler σταματά εκεί και αναφέρει shortage (exit `2` με `--strict`). Το UI δείχνει «No headlines today» — ποτέ σιωπηλό recycle.
- Τα `usage` metadata (`lastPublishedAt`, `timesPublished`, `canonicalEventId`, `approvedAt`) ξαναϋπολογίζονται σε κάθε build.

Υπενθύμιση από το brief: 180 ημέρες cooldown × 5/ημέρα απαιτεί ~900 μοναδικές ερωτήσεις σε steady state· με 300 στο launch χρειάζεται ~35 νέες approved/εβδομάδα.

---

## Sample data

Το repo περιέχει **50 sample ερωτήσεις** (25/25) και schedule για 2026-11-12 → 2026-11-21:

- Τα **Florida items είναι placeholders** (`"placeholder": true`): επινοημένα κείμενα, **όχι** πραγματικές ειδήσεις, χωρίς source URL (ο validator απαγορεύει source σε placeholder, για να μην υπάρξει ψευδής απόδοση). Στο UI εμφανίζονται ως «Real-report slot» με ένδειξη «Sample data».
- Τα **GTA-style items είναι πρωτότυπη fiction** γραμμένη για το project.
- Μετά τις 2026-11-21 το bank έχει εξαντληθεί με cooldown 180 ημερών — αυτό είναι σκόπιμο demo του shortage handling. Για local development:

  ```bash
  npm run schedule:build -- --allow-placeholders --cooldown 10 --days 30
  ```

Για production: αντικαταστήστε τα placeholders με verified items, `NODE_ENV=production` (ή `ALLOW_PLACEHOLDER_CONTENT=false`) και `npm run validate -- --production --min-runway 14` στο CI.

---

## Configuration

Δείτε το `.env.example`. Κύριες μεταβλητές: `PORT`, `HOST`, `DATA_DIR`, `ALLOW_PLACEHOLDER_CONTENT`, `ARCHIVE_DAYS`, `TIME_LIMIT_SECONDS`, `RATE_LIMIT_PER_MINUTE`, `TRUST_PROXY`, `VITE_PUBLIC_URL` (URL στο share text). Τα `npm start` / `npm run dev` διαβάζουν αυτόματα το `.env` της ρίζας αν υπάρχει.

## Privacy

Κανένας λογαριασμός, κανένα tracking cookie, κανένα analytics. Η πρόοδος μένει στο localStorage του browser. Ο server ελέγχει τις απαντήσεις αλλά δεν τις αποθηκεύει.
