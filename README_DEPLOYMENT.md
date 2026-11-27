# Deployment & λειτουργία — runbook για τον owner

> **Κατάσταση (2026-11-22):** ο κώδικας για Cloudflare Pages + Worker + D1 + Workers AI + GitHub Actions είναι έτοιμος και ελεγμένος **τοπικά** (Wrangler + local D1). **Δεν έχει γίνει κανένα deploy** στο Cloudflare: δεν υπάρχουν ακόμα λογαριασμός/credentials, D1 IDs ή workers.dev URLs. Όλα τα URLs παρακάτω με `<…>` είναι placeholders που θα πάρετε εσείς.

Όλα τα commands τρέχουν από τη ρίζα του repo, εκτός αν γράφει `cd apps/worker`.

---

## 0. Τι στήνουμε

| Κομμάτι | Πού | Τι κάνει |
|---|---|---|
| Frontend | Cloudflare Pages (Git integration, branch `main`) | React app, static. Μιλά με τον Worker μέσω `VITE_API_BASE_URL`. |
| API | Cloudflare Worker `gta-florida-api-staging` / `gta-florida-api-production` | Public game + protected admin routes. Cron 00:05 & 12:05 UTC (ένα trigger) κρατά 30 ημέρες προγραμματισμένες. |
| Βάση | Cloudflare D1 `gta-or-florida-staging` / `gta-or-florida-production` | Η **μόνη** production βάση. Χωριστές για staging/production. |
| Ingestion | Cloudflare Worker `gta-florida-ingest-<env>` + Workflow `gta-florida-ingest-<env>` (cron 05:17 & 17:17 UTC) | Discovery → dedupe → link check → Workers AI → import, σε μικρά βήματα (§8b). Μιλά **μόνο** με τον API Worker του ίδιου env (Service Binding). Το `ingest.yml` (GitHub Actions) αποσύρεται μετά την επικύρωση. |
| AI | Workers AI binding (ingestion Worker)· REST μόνο από το τοπικό CLI | Granite (triage) → Gemma (extraction) για λίγα items. Ποτέ ανά παίκτη. |

Δεν υπάρχει always-on server, VM, GPU, Render/Railway ή Ollama.

---

## 1. Cloudflare λογαριασμός

1. Δημιουργήστε/συνδεθείτε σε λογαριασμό Cloudflare. Workers, Pages, D1 και Workers AI είναι στον ίδιο λογαριασμό (Workers Free plan αρκεί για αρχή).
2. Σημειώστε το **Account ID** (Dashboard → Workers & Pages → δεξιά στήλη).
3. Ρυθμίστε usage notifications (Dashboard → Notifications) για Workers/D1/Workers AI. Αναβάθμιση σε Workers Paid **μόνο** αν ξεπεράσετε τα όρια (βλ. §12).
4. Τοπικά: `cd apps/worker && npx wrangler login` (ανοίγει browser).

## 2. D1 βάσεις (staging πρώτα)

Οι βάσεις **έχουν ήδη δημιουργηθεί** και είναι δηλωμένες στο `apps/worker/wrangler.jsonc` ως binding `DB` — **μην** τρέξετε ξανά `wrangler d1 create` (θα δημιουργούσε διπλότυπες βάσεις):

| Περιβάλλον | `database_name` | `database_id` |
|---|---|---|
| staging | `gta-or-florida-staging` | `beb1f5d9-b4bf-4f46-ab25-28833fc531a1` |
| production | `gta-or-florida-production` | `848c6f92-bd9a-4934-8374-cfa2d6f45fd5` |

Επιβεβαίωση: `npx wrangler d1 list` (από το `apps/worker`).

Τα IDs δεν είναι secrets· κάντε commit. Το `npm run validate` ελέγχει ότι staging/production δεν μοιράζονται βάση, και το deploy workflow αρνείται placeholders.

Migrations — **πάντα local → staging → production**:

```bash
npm run db:migrate:local                                                    # local emulator
npx wrangler d1 migrations apply gta-or-florida-staging --remote --env staging
# … έλεγχοι στο staging (§5) …
npx wrangler d1 export gta-or-florida-production --remote --env production --output backup-before-migrate.sql   # backup (αν έχει ήδη δεδομένα)
npx wrangler d1 migrations apply gta-or-florida-production --remote --env production
```

## 3. Secrets του Worker

Δύο **διαφορετικά** tokens ανά περιβάλλον (staging ≠ production):

```bash
openssl rand -hex 32   # → INGESTION_IMPORT_TOKEN (service: import/known/checkpoints/schedule)
openssl rand -hex 32   # → ADMIN_TOKEN (owner: review/withdraw/stats/…)

cd apps/worker
npx wrangler secret put INGESTION_IMPORT_TOKEN --env staging
npx wrangler secret put ADMIN_TOKEN --env staging
# ίδια για --env production με ΝΕΕΣ τιμές
```

Tokens < 32 χαρακτήρων απενεργοποιούν τον αντίστοιχο ρόλο. Κρατήστε τα σε password manager· ποτέ σε `VITE_*`, ποτέ σε commit.

**Rotation:** `wrangler secret put` με νέα τιμή → ενημέρωση του αντίστοιχου GitHub secret (§6) → το παλιό παύει αμέσως να ισχύει.

## 4. Πρώτο deploy του Worker (staging)

```bash
cd apps/worker
npx wrangler deploy --env staging
```

Το output δίνει το πραγματικό URL, π.χ. `https://gta-florida-api-staging.<subdomain>.workers.dev` (το `<subdomain>` είναι του λογαριασμού σας). Μετά:

1. Στο `wrangler.jsonc` → `env.staging.vars`: `FRONTEND_ORIGIN` = το Pages URL του staging/preview (§5), `PAGES_PREVIEW_PROJECT` = το όνομα του Pages project. Ίδια για `env.production.vars.FRONTEND_ORIGIN`. Ξανά `wrangler deploy --env staging`.
2. Συγχρονίστε το source policy registry στο D1:
   ```bash
   ADMIN_API_URL=https://gta-florida-api-staging.<subdomain>.workers.dev ADMIN_TOKEN=<staging admin token> npm run admin -- sources:sync
   ```
3. `npm run smoke -- https://gta-florida-api-staging.<subdomain>.workers.dev` → αναμένεται `DAILY_NOT_READY` μέχρι να υπάρξει εγκεκριμένο απόθεμα.

## 5. Cloudflare Pages (frontend)

Dashboard → Workers & Pages → Create → **Pages → Connect to Git** → επιλέξτε το repo.

| Ρύθμιση | Τιμή |
|---|---|
| Project name | π.χ. `gta-or-florida` (γίνεται `gta-or-florida.pages.dev`) |
| Production branch | `main` |
| Framework preset | None |
| Build command | `npm run build:web` |
| Build output directory | `apps/web/dist` |
| Root directory | *(κενό — ρίζα του repo, για τα npm workspaces)* |

Environment variables (Settings → Environment variables), **χωριστά** για Production και Preview:

| Μεταβλητή | Production | Preview |
|---|---|---|
| `VITE_API_BASE_URL` | `https://gta-florida-api-production.<subdomain>.workers.dev` | `https://gta-florida-api-staging.<subdomain>.workers.dev` |
| `VITE_PUBLIC_URL` | `https://gta-or-florida.pages.dev` (ή το domain σας) | *(κενό)* |
| `VITE_DAILY_DRIVE` | *(κενό = νέο UI «Daily Drive», εγκεκριμένο)* · `0` = rollback στο παλιό UI | *(κενό)* |
| `NODE_VERSION` | `22` | `22` |

Το `VITE_DAILY_DRIVE` ελέγχει το redesign «Daily Drive» (μόνο εμφάνιση· ίδια λογική παιχνιδιού, ίδιο API, ίδιο localStorage). Εγκρίθηκε: κενό = **ενεργό** στο `vite dev` και στο Cloudflare Pages build (`npm run build:web`). Μένει ανενεργό μόνο στα tests και στο legacy στατικό demo (`--mode pages`, Netlify μέχρι το cutover). Rollback: `VITE_DAILY_DRIVE=0` και rebuild — τότε το build δεν περιέχει καθόλου κώδικα, CSS ή fonts του redesign. Λεπτομέρειες: `docs/daily-drive-redesign-plan.md`.

Έτσι τα previews **δεν** αγγίζουν ποτέ το production D1. Το build παράγει `_headers` με CSP που επιτρέπει `connect-src` μόνο προς το συγκεκριμένο Worker origin. Χωρίς `404.html`, το Pages σερβίρει το SPA για deep links.

Το Pages κάνει deploy μόνο του μέσω Git integration· **μην** στήσετε και GitHub workflow για Pages. Αντίστροφα, ο Worker κάνει deploy **μόνο** από το `deploy-worker.yml` (ή χειροκίνητα με wrangler) — μη συνδέσετε τον Worker και στο dashboard Git integration (διπλά deploys).

## 6. GitHub: environments, secrets, variables

Settings → Environments → δημιουργήστε `staging` και `production`. Στο `production` ενεργοποιήστε **Required reviewers** (χειροκίνητη έγκριση για deploy/migrations/ingest).

| Όνομα | Τύπος | Πού | Σημείωση |
|---|---|---|---|
| `INGESTION_IMPORT_TOKEN` | secret | staging, production | ίδια τιμή με το αντίστοιχο Worker secret |
| `CF_AI_ACCOUNT_ID` | secret (ή variable) | staging, production | Account ID |
| `CF_AI_API_TOKEN` | secret | staging, production | Workers AI token (§7) |
| `CLOUDFLARE_API_TOKEN` | secret | staging, production | **ξεχωριστό** deploy token (§7) |
| `CLOUDFLARE_ACCOUNT_ID` | secret | staging, production | Account ID |
| `ADMIN_TOKEN` | secret (προαιρετικό) | staging, production | μόνο για αυτόματο `sources/sync` μετά το deploy |
| `INGESTION_API_URL` | variable | staging, production | Worker URL του env |
| `WORKER_URL` | variable | staging, production | ίδιο URL (smoke/sync μετά το deploy) |
| `SMOKE_URL` | variable | production | για το daily heartbeat |
| `WORKER_DEPLOY_ENABLED` | variable | staging | `true` → auto deploy staging σε push στο `main` |
| `AI_PROVIDER` | variable (προαιρετικό) | staging, production | `auto` (default) / `workers-ai` / `mock` / `off` |

Τα scheduled workflows μένουν **αδρανή** όσο λείπουν τα variables (`INGESTION_API_URL`, `SMOKE_URL`), άρα δεν αποτυγχάνουν πριν το setup. Σε public repo τα GitHub-hosted minutes είναι δωρεάν· σε private ισχύει το allowance του plan σας.

## 7. Cloudflare API tokens (ελάχιστα δικαιώματα)

Dashboard → My Profile → API Tokens → Create Token:

1. **Workers AI (ingestion):** template «Workers AI» (δικαιώματα *Workers AI – Read* και *Workers AI – Edit*). Μόνο στο `CF_AI_API_TOKEN`. Δεν χρειάζεται τίποτα άλλο.
2. **Deploy (GitHub Actions):** custom token με *Account → Workers Scripts – Edit* και *Account → D1 – Edit* (για migrations/export), περιορισμένο στον λογαριασμό σας. Αν το `wrangler deploy` ζητήσει επιπλέον scope (μπορεί να αλλάξει με εκδόσεις wrangler), προσθέστε μόνο ό,τι αναφέρει το μήνυμα λάθους. Μόνο στο `CLOUDFLARE_API_TOKEN`.

Τρία ανεξάρτητα secrets: AI token ≠ deploy token ≠ ingestion import token.

## 8. Πρώτη ingestion & μεταφορά παλιών δεδομένων (staging)

1. Actions → **Ingest content** → Run workflow → environment `staging`, `dry_run: true`. Ελέγξτε το summary/artifact (discovered, φίλτρα, AI requests, εκτίμηση neurons).
2. Ξανά με `dry_run: false` → τα items μπαίνουν ως **candidates** (shadow mode).
3. Οι 54 GTA candidates της παλιάς SQLite (export ήδη στο `backups/legacy-export/`, git-ignored):
   ```bash
   INGESTION_IMPORT_TOKEN=<staging service token> npm run legacy:import -- --to https://gta-florida-api-staging.<subdomain>.workers.dev
   ```
   Είναι idempotent (ξανατρέξιμο χωρίς διπλότυπα). Τίποτα δεν εγκρίνεται κατά τη μεταφορά.
4. Αν το GDELT απαντά `429` (συνέβη επανειλημμένα από το dev IP μας): είναι αναμενόμενο· ο κώδικας κάνει backoff και σταματά, και ο cursor δεν προχωρά. Το wiki λειτουργεί κανονικά.
5. **Χειροκίνητη εισαγωγή ενός άρθρου Florida** (όταν το GDELT δίνει `429` ή τα Actions είναι μπλοκαρισμένα). Τρέχει τοπικά με το `.env` (`INGESTION_API_URL`, `INGESTION_IMPORT_TOKEN`, προαιρετικά `REVIEWER`, `CF_AI_*`):
   ```bash
   npm run ingest:url -- --env staging --dry-run "https://www.example-publisher.com/news/article"   # πρώτα έλεγχος
   npm run ingest:url -- --env staging "https://www.example-publisher.com/news/article"             # import
   ```
   - Ίδιο pipeline με το batch: εξαγωγή μεταδεδομένων (τίτλος, canonical, ημερομηνία· **όχι** κείμενο άρθρου), dedupe απέναντι στο D1, deterministic prefilter, Workers AI, import. Το αποτέλεσμα είναι πάντα **candidate**: ο Worker δίνει στο gate τον λόγο `MANUAL_SUBMISSION` (provider `manual`), άρα ποτέ auto-approve, σε κανένα mode.
   - Άγνωστος publisher → καταχωρείται στο D1 ως `unreviewed`. Τα δικαιώματα αλλάζουν μόνο στο `packages/config/sources.policy.json` από τον owner.
   - Ελέγχει: μόνο `https`, port 443, όχι credentials/IP/local hostnames, όχι aggregators (Google News κ.λπ.), όχι blocked (satire) domains, όχι πηγές `blocked` ή μη-publisher (π.χ. wiki). Κάθε DNS απάντηση πρέπει να είναι public IP (μέσα στο socket lookup), κάθε redirect ξαναελέγχεται, και redirect σε άλλη πηγή απορρίπτεται (δώστε απευθείας το τελικό URL).
   - Item που απορρίπτει το prefilter (π.χ. `SENSITIVE_TERMS`, `NO_FLORIDA_SIGNAL`) **δεν** στέλνεται, για να μην καταγραφεί μόνιμα ως rejected.
   - `--env` (default `staging`) πρέπει να ταιριάζει με το Worker URL· production θέλει ρητά `--env production --allow-production`. `--to <url>` αντί για `INGESTION_API_URL`. `--ai mock|off` για μηδενικό κόστος AI. `--json` τυπώνει το item.
   - Exit codes: `0` εισήχθη / υπάρχει ήδη / dry run, `1` σφάλμα, `2` άρνηση πολιτικής ή φίλτρου.
   - Η εγγύηση `MANUAL_SUBMISSION` ισχύει όταν ο staging Worker έχει γίνει deploy με αυτή την αλλαγή· μέχρι τότε το CLI αρνείται μόνο του πηγές με `autoPublishAllowed` (σήμερα καμία).

## 8b. Ingestion στο Cloudflare (Cron Trigger → Workflow) — αντικαθιστά το GitHub Actions

**Τι τρέχει:** ο Worker `apps/ingest-worker` (`gta-florida-ingest-<env>`) δεν έχει public URL. Το cron (05:17 & 17:17 UTC, ένα trigger) δημιουργεί ένα Workflow instance ανά εκτέλεση (`cron-<env>-<YYYYMMDDHH>`, άρα διπλό fire δεν ξεκινά δεύτερο run). Το Workflow:

1. διαβάζει τους cursors (checkpoints) από τον API Worker,
2. discovery σε ξεχωριστά βήματα: ένα ανά **εγκεκριμένο** RSS feed· **GDELT μόνο ως fallback** όταν τα feeds δώσουν < `GDELT_MIN_RSS_ITEMS` (ένα query, 429 = καταγραφή και συνέχεια)· Grand Theft Wiki: ένα βήμα για τα members + ένα ανά σελίδα (έως `MAX_WIKI_PAGES`, σελίδες που ήδη υπάρχουν παραλείπονται πριν το fetch, συνέχεια από offset στο επόμενο run, round-robin στις κατηγορίες),
3. exact dedupe απέναντι στο D1, **paged fuzzy dedupe** (σελίδες `SCAN_PAGE_SIZE` × `SCAN_CANDIDATES` υποψήφιοι ανά βήμα — ίδια αποτελέσματα με το CLI, ελεγμένο), plan,
4. link check + Workers AI ανά `PROCESS_BATCH` items, με κοινό neuron budget ανά run,
5. import σε chunks των 20 (idempotency keys)· run report + cursors μόνο με το τελευταίο chunk,
6. inventory check (`schedule` dry run) → log `ingest.inventory_low` όταν runway < `LOW_INVENTORY_DAYS`.

Ο API Worker μένει ο **μόνος** που γράφει στο D1 και εφαρμόζει source policy + gate. Τίποτα δεν εγκρίνεται αυτόματα: με `AUTO_PUBLISH_MODE=shadow` κάθε import είναι candidate· αν κάποτε επιστρέψει `approved`, γράφεται `ingest.unexpected_approval`.

**Όρια Workers Free (docs 2026-11-23) και πώς τα σεβόμαστε:** 10 ms CPU ανά βήμα (μετρημένο: ~3–9 ms για scan 25×10, ~1–10 ms για μία σελίδα wiki), ≤ 50 subrequests ανά βήμα (process batch 4 → ≤ 4×6 hops + 8 AI calls), `MAX_STEPS=900` < 1.024, 3.000 steps/ημέρα (2 runs × ≤ 900). Το fuzzy dedupe μεγαλώνει γραμμικά με το απόθεμα: ~ (incidents/25) × (νέα/10) βήματα — πάνω από ~5.000 incidents ανά είδος χρειάζεται Workers Paid (τότε `SCAN_PAGE_SIZE=500`, `SCAN_CANDIDATES=200`, `PROCESS_BATCH=20`).

**Observability:** Workers Logs (dashboard → Workers → `gta-florida-ingest-staging` → Logs, φίλτρο `event`): `ingest.discovered|planned|processed|imported|run|inventory_low|unexpected_approval|cron_skipped`. Instances: `npx wrangler workflows instances list gta-florida-ingest-staging` / `… describe gta-florida-ingest-staging <id>` (output = περίληψη run: steps, AI requests, neurons, errors, inventory). Ιστορικό runs + AI χρήση: `npm run admin -- stats` (`recentRuns`, `usage`).

**Πρώτο deploy στο staging (με τη σειρά):**

```bash
npm run ci                                             # typecheck + tests + validate
npm run deploy:worker:staging                          # API: /titles?limit=…, MANUAL_SUBMISSION gate, approval host check, cron "5 0,12 * * *"
cd apps/ingest-worker
npx wrangler secret put INGESTION_IMPORT_TOKEN --env staging   # ΙΔΙΑ τιμή με το secret του gta-florida-api-staging
npx wrangler deploy --env staging                      # INGEST_ENABLED=false: το cron ακόμα δεν ξεκινά runs
npx wrangler workflows trigger gta-florida-ingest-staging '{"dryRun":true,"sources":"gta"}'
npx wrangler workflows instances describe gta-florida-ingest-staging latest
```

Ελέγξτε στο describe: `status: complete`, κανένα βήμα με `exceeded CPU` / `Too many subrequests`, `steps` < 900, `errors` κενό ή αναμενόμενο (π.χ. GDELT 429). Μετά `{"dryRun":true,"sources":"florida"}`, και μετά ένα πραγματικό run `{"sources":"all"}` και `npm run admin -- candidates:list --state candidate` (νέα items = candidates, `gate_decision` review). Μόνο τότε:

```bash
# apps/ingest-worker/wrangler.jsonc → env.staging.vars.INGEST_ENABLED = "true"
npx wrangler deploy --env staging
```

και μετά από 1–2 επιτυχημένα scheduled runs: διαγραφή του `.github/workflows/ingest.yml` (το τοπικό `npm run ingest:batch` / `ingest:url` μένουν για debugging). **Production:** ίδια βήματα με `--env production`, μόνο όταν το αποφασίσετε· τίποτα δεν γίνεται αυτόματα.

**Τοπικά:** `npm run db:migrate:local && npm run dev:ingest` (και οι δύο Workers στο workerd, local D1, mock AI)· `apps/ingest-worker/.dev.vars` με `INGESTION_IMPORT_TOKEN` (ίδιο με `apps/worker/.dev.vars`) και `INGEST_ENABLED=true`· trigger: `curl "http://localhost:8788/cdn-cgi/local/scheduled?cron=17+5,17+*+*+*"`.

## 8c. Florida RSS (RSS-first, GDELT μόνο fallback)

**Δύο ξεχωριστές αποφάσεις ανά πηγή** στο `packages/config/sources.policy.json`:

| Πεδίο | Τι επιτρέπει | Ποιος/πότε |
|---|---|---|
| `feedAccess.status` (`unreviewed` / `allowed` / `denied`) | **Μόνο** fetch του feed για μεταδεδομένα (τίτλος, link, ημερομηνία, guid). Κανένα κείμενο άρθρου, καμία δημοσίευση. | Ο owner, αφού διαβάσει τους όρους· `allowed` απαιτεί `basis` (επίσημο URL), `reviewedBy`, `reviewedAt` (το `npm run validate` το ελέγχει). |
| `feedAccess.aiClassification` | Αν οι τίτλοι αυτής της πηγής στέλνονται στο Workers AI. Default `false` → μόνο ανθρώπινη αξιολόγηση. | Ο owner (πολλοί όροι απαγορεύουν χρήση σε AI). |
| `licenseStatus` + `can*` | Επαναχρησιμοποίηση/δημοσίευση. **Αμετάβλητο gate** για κάθε ερώτηση. | Ο owner (§9). |

Ρυθμισμένα feeds (`data/sources.json → rss`, επαληθευμένα 2026-11-23, όλα **ανενεργά** μέχρι `feedAccess: allowed`): WKMG (Orlando), WJXT (Jacksonville), WSVN (Miami), WFLA (Tampa Bay), Keys Weekly (Keys). Τα ευρήματα όρων ανά publisher είναι στο `feedAccess.findings`. Tampa Bay Times, FOX 13, NBC 6 **δεν** ρυθμίστηκαν: οι όροι τους απαγορεύουν ρητά αυτοματοποιημένη συλλογή/aggregation.

**Ανά run, ανά feed (ένα βήμα Workflow):** robots.txt (RFC 9309, unreachable → δεν γίνεται fetch) → conditional GET (ETag/Last-Modified, `cache:<feed>` checkpoint) → μόνο items με link στο ίδιο domain του publisher → φίλτρα → dedupe → import ως candidates. Ένα feed που αποτυγχάνει δεν σταματά τα άλλα.

**GDELT:** τρέχει μόνο αν τα feeds δώσουν < `GDELT_MIN_RSS_ITEMS`. Σε 429: κανένα retry, κανένα επόμενο query, και **cooldown 6 h → 12 h → 24 h → 48 h** (checkpoints `gdelt/strikes`, `gdelt/cooldownUntil`), που αποθηκεύεται ακόμα και σε αποτυχημένο ή dry run· μετά από επιτυχία μηδενίζεται.

**Ενεργοποίηση ενός feed (απόφαση owner):**

```jsonc
// packages/config/sources.policy.json → η πηγή, π.χ. "publisher:clickorlando.com"
"feedAccess": {
  "status": "allowed",
  "basis": ["https://www.clickorlando.com/rss/", "https://www.grahammedia.com/terms"],
  "aiClassification": false,
  "reviewedBy": "<όνομα>",
  "reviewedAt": "YYYY-MM-DD",
  "findings": "…"
}
```

Μετά: `npm run ci` → deploy του ingestion Worker (§8b). Ο API Worker **δεν** χρειάζεται redeploy (το feedAccess το διαβάζει μόνο το ingestion).

## 8d. Florida πηγές: DOJ πρώτα, ιστορικό dataset μόνο στο staging

| Πηγή | Δικαιώματα | Τι κάνει ο κώδικας | Απόδοση (μετρημένη 2026-11-23) |
|---|---|---|---|
| **DOJ — U.S. Attorney's Offices SD/MD/ND Florida** (`DOJ_ENABLED`) | Δημόσιος τομέας κατά https://www.justice.gov/legalpolicies (εκτός φωτογραφιών τρίτων, σφραγίδων/λογοτύπων). Πηγή `publisher:justice.gov` = **unreviewed** μέχρι να την εγκρίνει ο owner. | API `justice.gov/api/v1/press_releases.json` (newest-first, ≤ 1 req/s), μόνο URLs `/usao-[smn]dfl/pr/`. Απορρίπτει σοβαρά εγκλήματα/ευάλωτα θύματα, routine ανακοινώσεις και (default) **κατηγορίες χωρίς καταδίκη** (`ALLEGATION_ONLY`). Σημειώνει το στάδιο της υπόθεσης στο review. | ~3,8 Florida releases/ημέρα → ~0,6–1/ημέρα περνούν (μόνο καταδίκες). |
| **Florida Man API dataset** (`FM_DATASET_ENABLED`, **μόνο staging**) | Repo MIT, αλλά dataset «για personal, educational, non-commercial use» και οι τίτλοι ανήκουν στους publishers. **Ποτέ** publishable χωρίς έγκριση του αντίστοιχου publisher. | Ένα αρχείο ημέρας (~18 KB) ανά βήμα, cursor `nextDay`, κρατά το αρχικό URL + provenance, χωρίς AI. Αρνείται production σε 3 επίπεδα (Workflow, importer, `npm run validate`). | 10.000 τίτλοι (2021-04 → 2026-04) → ~5.900 νέοι candidates μετά τα φίλτρα, ~82% ζωντανά links. ~15–30 ανά ημέρα-αρχείο. |
| Florida RSS (§8c) | Όροι publishers δεν δίνουν δικαιώματα | Ανενεργά μέχρι `feedAccess: allowed` | 0 |
| GDELT | Μόνο discovery index | Fallback με cooldown μετά από 429 | 0 (429) |
| r/FloridaMan, news search | Δεν επαληθεύτηκαν οι όροι 2026 (οι σελίδες αρνήθηκαν αυτόματη ανάγνωση) | **Δεν υλοποιήθηκε** | — |

**Για να δημοσιευτούν DOJ ερωτήσεις** (απόφαση owner): στο `sources.policy.json`, `publisher:justice.gov` → `licenseStatus: "approved"`, `canUseEditorialSummary: true` (προαιρετικά `canDisplayOriginalTitle: true`), `reviewedBy`, `reviewedAt` → deploy API + ingestion, `npm run admin -- sources:sync`. Κάθε ερώτηση εγκρίνεται και πάλι από άνθρωπο.

## 8e. DOJ backfill + «unusualness» (για ενδιαφέρουσες Florida ερωτήσεις)

- **Unusualness score** (`apps/ingest/src/filters.ts`, ντετερμινιστικό): +2 ανά ομάδα «παράξενων» ενδείξεων (ζώα, παράδοξα αντικείμενα/οχήματα, απάτες-μεταμφιέσεις, κρύψιμο σε απίθανα σημεία, wildlife crime, «strange»), −1 ανά ομάδα ρουτίνας (τυπική οικονομική απάτη, βραβεία, διορισμοί, διακανονισμοί). Γράφεται σε κάθε Florida candidate (`Unusualness: N (…)`) για το review. Για DOJ: κάτω από `DOJ_MIN_UNUSUAL` (default 2) → `NOT_UNUSUAL` (καταγράφεται ως rejected, δεν γεμίζει την ουρά). Μπορεί μόνο να απορρίψει, ποτέ να εγκρίνει· οι κανόνες ασφαλείας (βία, θάνατοι, σεξουαλικά, ανήλικοι, ευάλωτα θύματα) υπερισχύουν πάντα.
- **Backfill** (`DOJ_BACKFILL_ENABLED`, staging): τρέχει σε **ξεχωριστά Workflow instances** (`{"mode":"backfill"}`), όχι μέσα στα κανονικά runs. Μία σελίδα DOJ ανά βήμα, cursor `doj/backfillPage`, lease `doj/backfillLease` (ένα instance τη φορά, λήγει μόνο του σε 60′), και κάθε instance που τελειώνει με σελίδες που απομένουν ξεκινά τον διάδοχο (`backfill-<env>-p<cursor>`). Αποτυχία ή dry run δεν μετακινεί ποτέ τον cursor. Το cron το ξαναξεκινά αν σταματήσει· όταν φτάσει τις 365 ημέρες γίνεται `done`.
- **Subrequests ανά instance (Workers Free: 50 ανά invocation, τα steps δεν τα μηδενίζουν, οι Service Binding κλήσεις μετράνε):** κάθε βήμα κρατά πρώτα το worst case του (redirects, retries, link checks, AI, API) από `SUBREQUEST_BUDGET` (45)· το «tail» (dedupe, import, checkpoints, inventory) μένει πάντα δεσμευμένο. Ό,τι δεν χωρά αναβάλλεται (`deferred`) χωρίς να προχωρήσει cursor. Κανένα βήμα με αιτήματα δεν κάνει retry· «Too many subrequests» = NonRetryable. `wrangler workflows instances describe … latest` → `subrequests.reserved/actual/deferred`.
- **Μέτρηση 12 μηνών (2025-11-24 → 2026-11-23, 407 σελίδες, 20.350 releases):** 1.398 από τα τρία Florida USAO → 1.032 σοβαρά/ευάλωτα θύματα, 386 κατηγορίες χωρίς καταδίκη, 101 μετανάστευση/εκλογές, 16 routine → **9 candidates** με `DOJ_MIN_UNUSUAL=2` (15 με κατηγορίες)· ~5 πραγματικά «παιχνιδιάρικα». Το DOJ είναι νομικά καθαρό αλλά δεν αρκεί για 30 ημέρες Florida.
- **Coast Guard / FWC:** (FWC: βλ. §8g — μόνο owner-supplied GovDelivery bulletins, όχι το myfwc.com.) news.uscg.mil και uscg.mil αρνούνται αυτόματη πρόσβαση (Akamai «Access Denied», ακόμα και robots.txt)· το DVIDS feed υπάρχει αλλά το robots.txt επιστρέφει 502 → fail closed· το myfwc.com απαντά με Cloudflare challenge (403). Οι όροι επαναχρησιμοποίησης δεν μπορούσαν να επαληθευτούν, και το κρατικό περιεχόμενο της Florida δεν θεωρείται αυτόματα public domain.

## 8f. Δύο τρόποι έγκρισης: licensed και Independent Factual Summary

| | **licensed** (default, αμετάβλητο) | **factual_summary** (`--factual-summary`) |
|---|---|---|
| Τι δημοσιεύεται | Editorial summary με δικαιώματα της πηγής (π.χ. DOJ public domain) | Δικά σας λόγια για **ανεξάρτητα επαληθευμένα γεγονότα** + link· καμία επαναχρησιμοποίηση της διατύπωσης του publisher |
| Gate δικαιωμάτων | `licenseStatus: approved` + `canUseEditorialSummary` | Δεν απαιτεί έγκριση δικαιωμάτων· **ποτέ** για `blocked` πηγές, items από μη επιτρεπτό feed (`UNAUTHORIZED_COLLECTION`), ή dataset σε production |
| Ανθρώπινη επαλήθευση | link check, location/date/publisher | + δηλώσεις: `--attest-human-written --attest-incident --attest-claims --attest-privacy`, `--verified-date`, `--verified-location` (Florida για news), `--evidence-url` (τουλάχιστον ένα στην ίδια την πηγή) |
| Αντιγραφή | exact-match τίτλου | + near-copy (ομοιότητα ≥ 0,6) και ≥ 5 συνεχόμενες κοινές λέξεις σε τίτλο/εξήγηση — δικλίδες, όχι απόδειξη πρωτοτυπίας |
| Εμφάνιση | ο αρχικός τίτλος μόνο με `canDisplayOriginalTitle` | ποτέ αρχικός τίτλος/κείμενο/εικόνες χωρίς δικαιώματα· link + όνομα πηγής πάντα |
| Audit | `review_log: approved` | `review_log: approved:factual_summary` με όλες τις δηλώσεις και τα evidence URLs |

AI: απενεργοποιημένο για κάθε item από publisher με `feedAccess.aiClassification: false` (ανεξάρτητα από το κανάλι: RSS, GDELT, manual) και για το dataset.

**Πιλοτικός γύρος (staging, 3 Florida DOJ + 2 GTA):** βλ. την απάντηση της 2026-11-24 στο ιστορικό· σύνοψη: deploy API + ingestion → `sources:sync` → DOJ backfill (χειροκίνητα runs) → έγκριση 3 DOJ (licensed) + 2 GTA (factual_summary) με δικά σας κείμενα → `schedule --days 1` → `GET /api/challenge/today`.

## 8g. Επίσημες αναφορές (FWC, Flagler County Sheriff) — facts-first pilot

**Τι είναι:** `npm run ingest:official` αξιολογεί **μόνο URLs που δίνει ο owner** (καμία ανίχνευση/crawling): FWC weekly reports (GovDelivery, `content.govdelivery.com/accounts/FLFFWCC/bulletins/…`) και Flagler County Sheriff releases (`flaglersheriff.com/news/…`). Ένα weekly report = **πολλά ανεξάρτητα περιστατικά** (ένα passage ανά `<li>` κάτω από county heading) → ξεχωριστά candidates.

**Ροή:** registry (path-aware: μόνο το `/accounts/FLFFWCC/` του GovDelivery ανήκει στο FWC) → access verdict → fetch (5″ ανά πηγή, backoff σε 429/5xx με Retry-After, **σταματά αμέσως σε 401/403 — ποτέ παράκαμψη**) → passages → **facts** (ρόλοι αντί για ονόματα, objects, legal stage, τοποθεσία/ημερομηνία με «basis», claims με αναφορά passage/sentence/sha-256 — *κανένα κείμενο πηγής δεν αποθηκεύεται*) → safety (ανήλικοι, σεξουαλικά, θάνατος/τραυματισμός, βία, κακοποίηση ζώων = reject· σοβαρή απειλή π.χ. ληστεία με «όπλο» = `safety_review`) → quality score → **draft από τα facts** (frames, όχι από το headline) → `draftProblems` (copy ≥ 7 λέξεων από την πηγή, synonym-swap του headline, λέξεις/αριθμοί/τόποι που δεν στηρίζονται, quotes, προσωπικά δεδομένα, «guilty» για κατηγορία, giveaways/τοποθεσία/υπηρεσία στον τίτλο, placeholders, near-copy). Χωρίς έγκυρο draft → `DRAFT_REQUIRED` (γράφει άνθρωπος). Κανένα AI (το `aiProcessing` δεν έχει εγκριθεί).

**Δικαιώματα ανά λειτουργία** (`access.operations` στο registry: `discover, fetch, store, extractFacts, aiProcessing, publishSummary, reproduceOriginal, useMedia` → `unknown|allowed|denied`). FWC και Flagler: **όλα `unknown`**, `licenseStatus: unreviewed`. Συνέπειες:
- Pilot με ρητά URLs: επιτρέπεται (όχι για `blocked` ή `fetch: denied`)· τα candidates **μένουν σε review**.
- Unattended (cron/Workflow): **δεν τα αγγίζει**· το summary γράφει `official: [{status: "skipped", reasons: […]}]` + event `ingest.official_skipped` (όχι σιωπηλό «Completed»).
- Έγκριση & δημοσίευση: απαιτούν `fetch + extractFacts + publishSummary = allowed` (με `reviewedBy/reviewedAt/basis`) **και** ανθρώπινη έγκριση, και στους δύο τρόπους (licensed/factual). Αλλαγή αργότερα σε `denied` → το scheduler/το public API την αποσύρουν (`SOURCE_ACCESS`).
- Εικόνες/logos/mugshots/αρχικοί τίτλοι/κείμενο: ποτέ.

**Έγκριση machine draft (αληθινή δήλωση συγγραφής):** `questions:approve --factual-summary --attest-machine-draft --use-draft …` (αντί για `--attest-human-written`) → `textOrigin: machine_draft_reviewed`, `humanWritten: false`. Αν αλλάξετε το κείμενο ή γράψετε δικό σας: `--attest-human-written` με `--play-title/--explanation`.

```bash
npm run admin -- sources:show --id publisher:myfwc.com        # τι επιτρέπεται / τι λείπει (offline)
npm run ingest:official -- --url <FWC bulletin> --url <Flagler release> --dry-run --report /tmp/official.json
npm run ingest:official -- --urls-file pilot-urls.txt --env staging --state pilot-state.json   # import → candidates
npm run admin -- candidates:show --id <q>                      # facts, scores, draft problems
npm run admin -- sources:yield
```
Migration: `0003_incident_facts.sql` (`incidents.facts`, JSON, internal) — `npm run db:migrate:staging -w @gof/worker` πριν το deploy.

## 9. Editorial review (ο κύκλος που γεμίζει το παιχνίδι)

```bash
export ADMIN_API_URL=https://gta-florida-api-staging.<subdomain>.workers.dev ADMIN_TOKEN=<admin token> REVIEWER=<όνομα>
npm run admin -- stats
npm run admin -- candidates:list --kind GTA_CANON --limit 20
npm run admin -- candidates:show --id <question id>
```

**Βήμα 1 — δικαιώματα ανά πηγή (μία φορά ανά πηγή, όχι ανά ερώτηση):** διαβάστε τους όρους της πηγής και επεξεργαστείτε το `packages/config/sources.policy.json`:

```json
{ "id": "publisher:tampabay.com", "licenseStatus": "approved", "canUseEditorialSummary": true,
  "canDisplayOriginalTitle": false, "autoPublishAllowed": false,
  "reviewedBy": "<εσείς>", "reviewedAt": "2026-12-01", "termsUrl": "https://…", "notes": "τι ελέγξατε" }
```

Αυξήστε το `policyVersion`, κάντε PR/merge, deploy τον Worker, και `npm run admin -- sources:sync`. Το CI απορρίπτει permissions χωρίς `approved` + reviewer/ημερομηνία. Για το Grand Theft Wiki: η άδεια του wiki **δεν** καλύπτει κείμενα/εικόνες της Rockstar που παρατίθενται εκεί — εμείς γράφουμε δική μας περίληψη και κάνουμε link.

**Βήμα 2 — έγκριση ερώτησης:**

```bash
# GTA
npm run admin -- questions:approve --id <q> --play-title "Ουδέτερος τίτλος στα αγγλικά χωρίς giveaways" \
  --explanation "Τι λέει η πηγή, με δικά σας λόγια." --game GTA_III
# Florida
npm run admin -- questions:approve --id <q> --play-title "…" --explanation "…" \
  --location-verified --published-at 2026-11-20 --publisher "Tampa Bay Times"
```

Το CLI κάνει πρώτα SSRF-safe έλεγχο του link από τον υπολογιστή σας. Ο Worker αρνείται (και τα λέει όλα μαζί) αν: η πηγή δεν είναι εγκεκριμένη, ο τίτλος δίνει την απάντηση ή είναι ο αυτούσιος τίτλος, λείπει explanation/τοποθεσία/ημερομηνία/game, το game διαφέρει από αυτό της σελίδας του wiki, υπάρχει πιθανό duplicate (`--not-duplicate` αφού ελέγξετε, ή `incidents:merge`). Επίσης: `questions:reject`, `questions:edit`, `incidents:merge|unmerge` (αναστρέψιμο, με audit log).

Λάθος έγκριση (π.χ. placeholder κείμενο) που **δεν** έχει μπει ακόμη σε γύρο: `npm run admin -- questions:revoke --id <q> --reason "…"` (μόνο admin token). Η ερώτηση γυρίζει σε `candidate`, το explanation και το «reviewed» του τίτλου μηδενίζονται, η πηγή/προέλευση μένουν ίδιες και το παλιό κείμενο κρατιέται στο audit log (`approval_revoked`). Μετά χρειάζεται νέο `questions:approve` με νέο κείμενο και νέες δηλώσεις (`--attest-*`). Placeholder/γενικά κείμενα απορρίπτονται πάντα κατά την έγκριση. Για ερώτηση που έχει ήδη προγραμματιστεί: `withdraw`.

Προγραμματισμός και δημόσιο endpoint ελέγχουν **την ίδια** επιλεξιμότητα (`apps/worker/src/services/eligibility.ts`): κάθε εγκεκριμένη ερώτηση έχει `approval_mode` και `approval_log_id` (η εγγραφή audit της έγκρισης που ισχύει, migration `0002`). `licensed` → οι ίδιοι κανόνες δικαιωμάτων πηγής όπως πριν. `factual_summary` → ανθρώπινη έγκριση με πλήρεις δηλώσεις, χωρίς μεταγενέστερη ανάκληση, και χωρίς blocked πηγή / μη επιτρεπτό feed / dataset σε production. Πριν το deploy του API Worker: `npm run db:migrate:staging -w @gof/worker`.

**Απόσυρση:** `npm run admin -- withdraw --question <q> --reason "…"` → ο σημερινός/παλιός γύρος που την περιέχει γίνεται `ROUND_WITHDRAWN` για όλους· οι μελλοντικοί γύροι που την περιέχουν σβήνονται και ξαναγεμίζουν από το scheduler. `withdraw --day YYYY-MM-DD` αποσύρει ολόκληρη ημέρα. Ό,τι γίνεται καταγράφεται στο `review_log`.

## 10. Scheduling

Πλήρης περιγραφή (στα αγγλικά): **`docs/question-bank.md`** — τράπεζα επαληθευμένων ερωτήσεων, μορφή batch, `bank:import`, έγκριση, κανόνες προγραμματισμού.

- **Migration `0004_question_bank_scheduling.sql` πριν το deploy του Worker** (`npm run db:migrate:staging -w @gof/worker`): προσθέτει `questions.event_id` / `questions.spoiler` και ξαναχτίζει τα `daily_rounds` / `daily_round_items` ώστε μια ερώτηση να ξαναχρησιμοποιείται (μετά το cooldown) και να επιτρέπεται οποιοσδήποτε συνδυασμός 0–5 Florida. Όλοι οι υπάρχοντες γύροι αντιγράφονται αμετάβλητοι.
- Κάθε θέση του γύρου είναι ανεξάρτητα Florida ή GTA (50/50)· όχι πια σταθερό 3/2. Χωρίς διπλή ερώτηση ή γεγονός (`eventId`) στην ίδια μέρα, και κανένα γεγονός ξανά μέσα σε **30 ημέρες** (`EVENT_COOLDOWN_DAYS`). Οι εγκεκριμένες ερωτήσεις με σήμανση spoiler προγραμματίζονται κανονικά (επιτρέπονται μικρά spoilers· τα μεγάλα αποκλείονται στον editorial έλεγχο, βλ. `docs/question-bank.md`)· το `--exclude-spoilers` τις εξαιρεί σε ένα run.
- Ο Worker (cron 00:05 & 12:05 UTC) και κάθε ingest run του CLI με `--schedule` κρατούν `SCHEDULE_AHEAD_DAYS` (30, έως 90) ημέρες μπροστά, μόνο από εγκεκριμένο απόθεμα· γράφουν ό,τι μπορεί να γεμίσει, ώστε η σημερινή μέρα να έχει γύρο. Οι υπάρχουσες ημέρες δεν αλλάζουν ποτέ.
- Χειροκίνητα: `npm run admin -- schedule --days 30` ή `--days 90` (`--dry-run` για δοκιμή, `--cooldown N`). Ολόκληρη η περίοδος σχεδιάζεται πρώτα: αν δεν γεμίζει, δεν γράφεται τίποτα και το μήνυμα λέει ποια ημέρα και ποιο απόθεμα/cooldown φταίει. Exit code 2 = έλλειψη/προειδοποιήσεις.
- Απόθεμα-στόχος: ~300 εγκεκριμένες (150 + 150). Με cooldown 30 ημερών χρειάζονται ≥ 150 διαφορετικά γεγονότα για συνεχή περιστροφή.
- Το **Daily heartbeat** (`smoke.yml`, 00:40 UTC) αποτυγχάνει — και το GitHub σας ειδοποιεί — όταν δεν υπάρχει σημερινός γύρος.

## 11. Αυτόματη δημοσίευση (προαιρετικά, αργότερα)

Default `AUTO_PUBLISH_MODE=shadow`: το gate καταγράφει τι **θα** έκανε (`gate_decision` στις ερωτήσεις, `candidates:list --decision auto_approve`), αλλά δημοσιεύεται μόνο ό,τι εγκρίνετε. Για `trusted_sources`:

1. Μαζέψτε ένα αντιπροσωπευτικό δείγμα (≥ 200) με δικές σας ετικέτες: `labels.json` = `[{"questionId":"…","label":"approve"|"reject"}]`.
2. `npm run admin -- benchmark --labels labels.json` → υπολογίζει το false-approval rate των `auto_approve` αποφάσεων. Με `--record` το αποθηκεύει για την τρέχουσα `policyVersion`.
3. Ορίστε `AUTO_PUBLISH_MAX_FALSE_APPROVAL_RATE` (Worker var) **με βάση αυτό που μετρήσατε**, βάλτε `autoPublishAllowed: true` μόνο σε πηγές που εμπιστεύεστε, και `AUTO_PUBLISH_MODE=trusted_sources`. Deploy.
4. Το 10% (`HUMAN_SAMPLE_RATE`, ελάχιστο 5%) των auto-eligible πάει πάντα σε άνθρωπο. Άγνωστα δικαιώματα, αλλαγμένα redirects, αβέβαιο game, χωρίς ημερομηνία/τοποθεσία, `needsReview`, ευαίσθητα θέματα → πάντα review ή reject. Κάθε αλλαγή policy (`policyVersion`) ακυρώνει το benchmark.
5. **Emergency stop:** `AUTO_PUBLISH_MODE=off` (ή `shadow`) + deploy· `withdraw` για ό,τι έχει ήδη προγραμματιστεί.

## 12. Όρια & κόστος (επαληθευμένα 2026-11-22 — ξαναελέγξτε πριν πληρώσετε)

| Υπηρεσία | Free | Σημείωση |
|---|---|---|
| Workers | 100.000 requests/ημέρα, **10 ms CPU/request** (και για Cron), 50 subrequests/invocation, **5 Cron Triggers ανά λογαριασμό** | Κάθε public request = 1 indexed D1 query. Crons: API staging+production 1 το καθένα, ingestion 1 το καθένα = 4. |
| Workflows | 1.024 steps/instance, **3.000 steps/ημέρα**, 10 ms CPU/step, 100 ταυτόχρονα instances, 3 ημέρες retention | Ένα ingestion run ≈ 20–200 steps (§8b). Επαληθευμένα 2026-11-23. |
| D1 | 5 GB, 5M rows read/ημέρα, 100k rows written/ημέρα, 50 queries/invocation | Το import είναι 1 batch (= 1 query) ανά request. |
| Workers AI | **10.000 neurons/ημέρα** ανά λογαριασμό | Granite 4 Micro: 1.542 neurons/M input, 10.158/M output· Gemma 4 26B-A4B: 9.091 / 27.273. Default budget ανά run: 60 requests, 2.500 neurons (≈ 2 runs/ημέρα μέσα στο free). Πάνω από το free: αποτυγχάνει (Free) ή $0,011/1.000 neurons (Paid, από $5/μήνα). |
| Pages | static, Git builds | — |
| GitHub Actions | δωρεάν σε public repo | private: allowance του plan |

Δεν περιλαμβάνονται: news APIs επί πληρωμή, άδειες για αυτούσιους τίτλους, custom domain, analytics.

## 13. Cutover από Netlify

1. Staging: health, γύρος, απάντηση/reveal, links πηγών, withdraw, caching, CORS (`npm run smoke -- <url>`), preview του Pages δείχνει staging.
2. Production: deploy Worker (Actions → Deploy Worker → `production`, `apply_migrations: true` την πρώτη φορά), `sources:sync`, εισαγωγή/έγκριση αποθέματος, `schedule --days 30`, smoke.
3. Επιβεβαιώστε ότι `npm run smoke -- <production worker>` περνά και ότι το Pages production δείχνει σωστά.
4. Μόνο τότε: (custom domain στο Pages, αν θέλετε) → διαγράψτε `netlify.toml`, `.github/workflows/netlify-daily.yml`, `.github/workflows/pages.yml`, και το Netlify site.

## 14. Backups & rollback

- **D1 snapshot:** `npx wrangler d1 export gta-or-florida-production --remote --env production --output prod-YYYYMMDD.sql` (το deploy workflow το κάνει αυτόματα πριν από migrations και το κρατά ως artifact 30 ημέρες). Restore σε νέα βάση: `wrangler d1 execute <db> --remote --file prod-YYYYMMDD.sql`.
- **D1 Time Travel:** `npx wrangler d1 time-travel info gta-or-florida-production` / `… restore` (point-in-time· διαθέσιμο παράθυρο ανά plan — ελέγξτε τα docs).
- **Worker:** `npx wrangler deployments list --env production` και `npx wrangler rollback --env production` (προηγούμενη έκδοση).
- Migrations: μόνο backward-compatible αλλαγές όπου γίνεται (νέες στήλες/πίνακες)· ποτέ destructive χωρίς export.

## 15. Τοπική ανάπτυξη & έλεγχοι

```bash
npm run dev            # wrangler dev (local D1) + Vite
npm run dev:seed       # placeholder fixtures μόνο για local
npm run ci             # typecheck + tests + validate
npm run ingest:batch -- --dry-run --ai mock --source gta    # live discovery, χωρίς import/AI κόστος
npm run ingest:url -- --dry-run --ai off "<https-article-url>"   # ένα άρθρο, χωρίς import/AI κόστος
```

Τα unit/integration tests δεν κάνουν ποτέ live κλήσεις (GDELT/wiki/Workers AI είναι mocked). Live έλεγχοι γίνονται μόνο ρητά (`ingest:batch`, `ingest:url`, `smoke`).

## 16. Συχνά προβλήματα

| Σύμπτωμα | Αιτία / λύση |
|---|---|
| `DAILY_NOT_READY` | Δεν υπάρχει αρκετό εγκεκριμένο απόθεμα ή καμία εγκεκριμένη πηγή. `admin stats`. |
| Approval: `SOURCE_UNREVIEWED` | Η πηγή δεν είναι `approved` στο registry ή δεν έγινε `sources:sync` μετά το deploy. |
| Browser: CORS error | Λάθος `FRONTEND_ORIGIN` / `PAGES_PREVIEW_PROJECT` στο `wrangler.jsonc` ή λάθος `VITE_API_BASE_URL`. |
| `401`/`403` στο admin | Λάθος token, ή service token σε admin-only route. |
| Ingest: `ai: request budget exhausted` | Αναμενόμενο όριο ανά run· τα υπόλοιπα items πάνε σε review χωρίς AI. |
| Deploy: «Set the real database_id» | Δεν αντικαταστάθηκαν τα D1 placeholders (§2). |
| Worker error 1102 / CPU | Μεγάλο import batch· μειώστε (το όριο είναι 20 items/request). |
