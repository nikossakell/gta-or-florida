# GTA or Florida? 🐊

Ένα γρήγορο, mobile-first daily trivia game: διαβάζεις έναν παράλογο τίτλο και αποφασίζεις αν είναι **πραγματικό, επαληθευμένο περιστατικό από τη Florida** ή **τεκμηριωμένο γεγονός μέσα σε παιχνίδι GTA** (εφημερίδες του παιχνιδιού, αποστολές, random events). Πέντε τίτλοι, 60 δευτερόλεπτα, spoiler-free share.

> Unofficial, fan-made parody. Δεν σχετίζεται με τη Rockstar Games ή την Take-Two Interactive. Δεν χρησιμοποιείται κανένα artwork, logo, font ή asset από παιχνίδια GTA· το mascot (αλιγάτορας με γυαλιά ηλίου) είναι πρωτότυπο SVG.
>
> Το **«GTA»** σημαίνει γεγονός που τεκμηριώνεται σε πραγματικό GTA game (π.χ. άρθρο της εφημερίδας *Liberty Tree* του GTA III), με link στην πηγή μετά την απάντηση. Ποτέ AI-generated ή επινοημένα «GTA events». Τα παλιά fictional σενάρια του prototype είναι μόνο development fixtures.

**Αρχιτεκτονική (Cloudflare, χωρίς always-on server):**

```text
Παίκτες → Cloudflare Pages (React/Vite/Tailwind/TanStack, static)
            │ HTTPS → VITE_API_BASE_URL
            ▼
          Cloudflare Worker (apps/worker) ── D1 (η μόνη production βάση)
            ▲  protected /api/v1/admin/* (bearer tokens)
Cloudflare Cron → Workflow (apps/ingest-worker): εγκεκριμένα RSS (+ GDELT fallback) + Grand Theft Wiki
  → dedupe → φίλτρα → SSRF-safe link check → Workers AI (Granite → Gemma, binding, budget)
  → authenticated, idempotent import → scheduling 30 ημέρες μπροστά
```

- **Deployment / λογαριασμοί / κόστος:** **[README_DEPLOYMENT.md](README_DEPLOYMENT.md)** (runbook για τον owner).
- **Τι άλλαξε από το Node/SQLite backend:** [migration-notes.md](migration-notes.md).
- **Δεν έχει γίνει ακόμα deploy στο Cloudflare.** Το live site μέχρι το cutover είναι το static demo (Netlify / GitHub Pages).

---

## Γρήγορη εκκίνηση (local, χωρίς λογαριασμούς)

Απαιτείται **Node.js ≥ 22.12** (βλ. `.nvmrc`).

```bash
npm install
npm run dev             # apps/worker/.dev.vars (τοπικά random tokens) + D1 migrations + wrangler dev :8787 + Vite :5173
npm run dev:seed        # σε 2ο terminal: εισάγει τα 50 placeholder items (μόνο local) και προγραμματίζει 7 ημέρες
```

Το local D1 ζει στο `apps/worker/.wrangler/` (git-ignored). Τα fixtures σερβίρονται **μόνο** με `APP_ENV=local`· σε staging/production ο Worker αρνείται και να τα εισάγει και να τα σερβίρει.

Έλεγχοι:

```bash
npm test             # Vitest: core, config, worker (πραγματικό local D1 μέσω workerd), ingest (mocked HTTP/AI), web, scripts
npm run typecheck    # tsc --noEmit σε κάθε workspace (και στα Worker tests)
npm run validate     # fixtures + source policy registry + wrangler env isolation + workflow YAML + .env.example
npm run ci           # όλα τα παραπάνω
npm run smoke -- http://127.0.0.1:8787     # synthetic έλεγχος ενός Worker (local ή deployed)
```

Ingestion & review (local ή απέναντι σε staging):

```bash
npm run ingest:batch -- --dry-run --source gta --ai mock     # discovery + φίλτρα + AI, χωρίς import
npm run ingest:batch -- --source all                         # import στο INGESTION_API_URL (service token)
npm run ingest:url -- --env staging --dry-run "<https-article-url>"   # ένα άρθρο Florida χειροκίνητα, χωρίς import
npm run ingest:url -- --env staging "<https-article-url>"             # import ως candidate για review (ποτέ auto-approve)
npm run admin -- candidates:list --kind GTA_CANON
npm run admin -- questions:approve --id <q> --play-title "…" --explanation "…" --game GTA_III
npm run admin -- withdraw --day 2026-11-22 --reason "…"
npm run admin -- schedule --days 30
npm run legacy:export && npm run legacy:import -- --to <worker-url>   # μεταφορά της παλιάς SQLite
```

Μόνο μεταβλητές `VITE_*` φτάνουν στο browser bundle — ποτέ secrets εκεί. Όλες οι ρυθμίσεις: `.env.example`.

---

## Δομή (TypeScript monorepo, npm workspaces)

```text
packages/core/        Καθαρή domain λογική (χωρίς I/O): types, dedupe, game projections, round planner (3/2 ↔ 2/3),
                      editorial rules (giveaways), source policy + auto-publish gate, AI output schema/grounding,
                      admin/import contract, lean runtime validator
packages/config/      sources.policy.json (owner-reviewed δικαιώματα ανά πηγή) + σταθερές (models, budgets, ημέρες)
apps/worker/          Cloudflare Worker (Wrangler) + D1
  migrations/           0001_init.sql
  src/routes/           public.ts (/api/health, /api/challenge/*, /api/archive), admin.ts (/api/v1/admin/*)
  src/services/         challenge, scheduling, importer (gate), review/withdraw/merge/stats, sources (registry → D1)
  src/security/         auth (constant-time bearer), CORS allowlist, idempotency, URL safety
apps/ingest-worker/   Cloudflare ingestion Worker: Cron Trigger → Workflow (bounded steps) → API Worker (Service Binding)
apps/ingest/          Κοινή λογική ingestion (runtime-neutral) + τοπικά CLI: adapters (gdelt, grandtheftwiki, rss, http), filters, deduplicate,
                      verify (SSRF-safe link check), classify (Workers AI REST), import (Worker client), run, admin CLI, legacy
apps/web/             React 19 + Vite + Tailwind CSS v4 + TanStack Query + TanStack Router (Cloudflare Pages)
scripts/              static demo (validate/build-pages/schedule), check-config, seed-local, smoke
data/                 sources.json (discovery config), questions.approved.json (dev fixtures), daily-schedule.json (static demo)
```

---

## API (δικό μας)

Public (CORS allowlist, χωρίς auth):

| Method | Path | Περιγραφή |
| --- | --- | --- |
| `GET` | `/api/health` | status, version, runtime, `db`, `todayReady` — χωρίς secrets/internals. |
| `GET` | `/api/challenge/today` | 5 public questions (`h1`…`h5`, μόνο `headline`) — **χωρίς** answer, kind, source, game, original title. `503 DAILY_NOT_READY` αν δεν υπάρχει γύρος, `410 ROUND_WITHDRAWN` αν αποσύρθηκε. |
| `GET` | `/api/challenge/:date` | Παρελθόν γύρος (archive 7 ημερών). Μελλοντικός → `404 FUTURE_CHALLENGE`. |
| `POST` | `/api/challenge/:date/answer` | `{ questionId, choice: "FLORIDA"\|"GTA" }` → σωστό/λάθος, explanation, πηγή με CTA (`Read full article` / `View GTA source`), ακριβής τίτλος μόνο αν το επιτρέπει η πολιτική της πηγής. |
| `POST` | `/api/challenge/:date/finish` | Server-side score + όλα τα reveals. |
| `GET` | `/api/archive` | Πρόσφατοι γύροι ≤ σήμερα. |

Protected (`Authorization: Bearer …`, χωρίς CORS): `import`, `known`, `titles`, `checkpoints`, `schedule` (service ή admin token)· `review`, `withdraw`, `merge`, `stats`, `candidates`, `sources/sync`, `benchmark`, `ensure-schedule` (μόνο admin token). Λεπτομέρειες στο [README_DEPLOYMENT.md](README_DEPLOYMENT.md).

Το παιχνίδι είναι **casual, όχι cheat-proof**: χωρίς λογαριασμούς, κάποιος μπορεί να καλέσει απευθείας το answer endpoint. Δεν υποσχόμαστε δίκαιο leaderboard.

---

## Gameplay & client

- 5 τίτλοι/ημέρα, ίδιο set και σειρά για όλους, ανά **UTC date** (η σειρά κληρώνεται μία φορά, όταν δημιουργείται η ημέρα στο D1).
- 60" clock (`TIME_LIMIT_SECONDS`, `0` = χωρίς χρόνο) που **παγώνει όσο φαίνεται το reveal**. Όταν λήξει: «Time's up!», οι αναπάντητοι μετράνε ως λάθη.
- Reveal: σωστό/λάθος με διαφορετικό εικονίδιο (όχι μόνο χρώμα), explanation, «Read full article» (Florida) / «View GTA source» (GTA, με το όνομα του game), και τον ακριβή αρχικό τίτλο **μόνο** αν το rights review το επιτρέπει. Πριν την απάντηση φαίνεται μόνο ο ουδέτερος `play_title`.
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
- Fallbacks: loading skeletons, «No headlines today» (`DAILY_NOT_READY`, ποτέ σιωπηλό recycle ή invented content), «Round withdrawn» (`ROUND_WITHDRAWN`, ίδιο μήνυμα για όλους), «Stuck in traffic» error με error code και retry, offline detection.
- Accessibility: πραγματικά `<button>`/`<a>`, ≥ 44px targets, ορατό focus, focus management σε κάθε νέο τίτλο/reveal, `aria-live` για timer thresholds και αποτελέσματα, keyboard shortcuts (G / F / Enter), `prefers-reduced-motion`, AA contrast, skip link, max-width ~520px στο gameplay.
- Fonts (Shrikhand, Archivo) είναι self-hosted μέσω `@fontsource` — κανένα request σε Google.

---

---

## Περιεχόμενο & δικαιώματα

- **Δικαιώματα ανά πηγή, από τον owner:** `packages/config/sources.policy.json`. Όλες οι πηγές ξεκινούν `unreviewed` → τίποτα δεν δημοσιεύεται μέχρι να διαβάσετε τους όρους κάθε πηγής. Κανένα AI και κανένα API δεν «δίνει» δικαιώματα. Το Grand Theft Wiki είναι τεκμήριο για in-game γεγονότα, όχι άδεια αναδημοσίευσης κειμένων της Rockstar.
- **Κάθε ερώτηση** έχει ουδέτερο `play_title` χωρίς giveaways (Florida/πόλεις/GTA/τοποθεσίες παιχνιδιών)· ο αρχικός τίτλος μένει εσωτερικός και εμφανίζεται μετά την απάντηση μόνο αν η πολιτική της πηγής το επιτρέπει.
- **Αυτόματη δημοσίευση:** default `AUTO_PUBLISH_MODE=shadow` (οι αποφάσεις του gate καταγράφονται, δημοσιεύεται μόνο ό,τι εγκρίνει άνθρωπος). Το `trusted_sources` απαιτεί εγκεκριμένη πηγή με `autoPublishAllowed`, όλα τα deterministic gates, benchmark για την τρέχουσα policy version και όριο λάθους που ορίζει ο owner· 10% τυχαίο δείγμα πάει πάντα σε άνθρωπο. Βλ. README_DEPLOYMENT.md.
- **Scheduling:** 30 ημέρες μπροστά, μόνο από εγκεκριμένο απόθεμα· 3/2 ↔ 2/3 εναλλάξ· καμία ερώτηση δεν ξαναχρησιμοποιείται (`UNIQUE(question_id)`)· έλλειψη → `DAILY_NOT_READY`, ποτέ fake ερωτήσεις. Χρειάζονται ~75 Florida + ~75 GTA εγκεκριμένες για 30 ημέρες.

## Legacy static demo

Το `npm run build:pages` (GitHub Pages / Netlify, pre-generated JSON από `data/*.json`) παραμένει μόνο για να σερβίρει το τρέχον live demo μέχρι το cutover· μετά διαγράφονται `netlify.toml`, `.github/workflows/netlify-daily.yml` και `pages.yml`. Τα Florida items του demo είναι placeholders και τα GTA-style items πρωτότυπη fiction — ποτέ στο production bank.

## Privacy

Κανένας λογαριασμός, κανένα tracking cookie, κανένα analytics. Η πρόοδος μένει στο localStorage του browser. Ο Worker ελέγχει τις απαντήσεις αλλά δεν τις αποθηκεύει, και δεν κρατά IP ή user IDs. Το «ένα scored attempt ανά ημέρα» επιβάλλεται μόνο τοπικά (localStorage) — δεν υπάρχει server-side anti-cheat χωρίς λογαριασμούς.
