# Migration notes: Node/SQLite → Cloudflare (Pages + Workers + D1 + Workers AI + GitHub Actions)

Date: 2026-11-22. Scope: the full architecture refactor from the "Cloudflare Full Refactor" brief.
Owner runbook (Greek): [README_DEPLOYMENT.md](README_DEPLOYMENT.md).

## 1. Audit of the starting point

- Monorepo (npm workspaces): `packages/core`, `apps/api` (node:http + better-sqlite3), `apps/web` (React 19/Vite/Tailwind 4/TanStack), `scripts`.
- The working tree was uncommitted. It was snapshotted before the refactor, and the snapshots are git-ignored:
  - `backups/pre-cloudflare-tracked.patch`
  - `backups/pre-cloudflare-untracked.tgz`
  - `backups/legacy-gta-or-florida.sqlite`
- Legacy SQLite contents:
  - 54 `source_records`, 54 `incidents` and 54 `questions`, all GTA_CANON candidates (52 Liberty Tree articles and 2 GTA V random events).
  - 0 approved questions, 0 scheduled days, 7 `ingestion_runs`, 1 checkpoint.
- The frontend uses `/api/challenge/today`, `/api/challenge/:date`, `/api/challenge/:date/answer`, `/api/challenge/:date/finish` and `/api/archive`. The previous `/api/v1/challenges/*` public routes were not used by any client.

## 2. What maps to what

| Legacy (apps/api, SQLite) | New |
|---|---|
| `node:http` server, in-process timers | `apps/worker` fetch handler and `scheduled()` cron. No ports or Node I/O. |
| better-sqlite3 file, WAL, `job_locks` | D1 (binding `DB`). Batches are transactions. UNIQUE constraints replace locks. |
| `source_records.rights_state` per record | `sources` table mirrored from the owner-reviewed `packages/config/sources.policy.json` (rights per source). |
| `source_records` + `incident_sources` | `source_references` (one incident, many outlets; `canonical_url` UNIQUE) |
| `questions.status` | `questions.quality_state`, plus a separate `gate_decision` / `gate_reasons` / `confidence_metadata` (the automated trace) |
| `daily_challenges` / `daily_challenge_questions` (positions 0-4) | `daily_rounds` / `daily_round_items` (positions 1-5, `question_id` UNIQUE, `number` UNIQUE) |
| `daily_challenges.status = disabled` + `CHALLENGE_DISABLED` 503 | `daily_rounds.status = withdrawn` + `ROUND_WITHDRAWN` 410 |
| `NO_CHALLENGE` / `CONTENT_UNAVAILABLE` for today | `DAILY_NOT_READY` 503 (`Retry-After: 300`) |
| Review CLI writing SQLite | `npm run admin -- …` calling protected Worker routes (bearer `ADMIN_TOKEN`) |
| `ingest:florida` / `ingest:gta` CLI | `npm run ingest:batch` (GitHub Actions `ingest.yml`). Checkpoints are stored in D1 via the Worker. |
| `AUTO_APPROVE_CANDIDATES` (refused if true) | An explicit state machine, `AUTO_PUBLISH_MODE=off|shadow|trusted_sources`. Default is shadow; unknown values become off. |
| Netlify `_redirects` API proxy (`scripts/build-netlify.ts`) | Removed. Pages calls the Worker via `VITE_API_BASE_URL`, with a CSP `connect-src` for that origin only. |

**Preserved:**
- The public game contract: positional `h1…h5` ids, `ChallengeResponse`, `AnswerResponse`, `FinishResponse` and `ArchiveResponse`.
- UTC-day semantics, 3/2 ↔ 2/3 alternation, shuffle-once-on-persist and never-reuse.
- The source CTA labels ("Read full article" / "View GTA source").
- The rights-gated original title and the giveaway rules.

**Contract changes:**
- `POST …/answer` now accepts `"FLORIDA"`/`"GTA"`, as well as lower-case values.
- `QUESTION_NOT_FOUND` is now a 404, not a 400.
- `/api/health` has a new shape: `status, time, version, runtime, db, todayReady`.
- The unused `/api/v1/challenges/*` public aliases and `/api/v1/stats/public` were dropped. `/api/v1/health` remains as an alias.

## 3. Removed

- `apps/api` entirely: the server, SQLite, migrations, CLI, timers and the static file serving.
- The better-sqlite3 dependency and native build, and esbuild for the API.
- `scripts/build-netlify.ts`, its test, and the `API_ORIGIN` proxy mode.
- The CI smoke test of the Node server.

**Kept until the Cloudflare cutover**, because they serve the current live static demo:
- `netlify.toml`, now static-only.
- `.github/workflows/netlify-daily.yml` and `pages.yml`.
- `npm run build:pages`.

**Kept as a one-off utility:** `npm run legacy:export` / `legacy:import`, using `node:sqlite` with no native dependency.

## 4. Legacy data

- `npm run legacy:export` writes `backups/legacy-export/*.ndjson` plus a manifest (git-ignored). This has been done.
- `npm run legacy:import -- --to <worker>` converts the candidates into import items.
  - Approvals, rights and fixtures are not carried over.
  - It was verified against the local Worker: 54 inserted, and an idempotent re-run was replayed with no duplicates.
  - **Staging and production imports have not been done** (no credentials).
- A live wiki ingest afterwards recognized all 54 as known items (cross-system dedupe works).

## 5. Verification performed (local only)

- `npm run ci`: typecheck in every workspace (including the Worker tests), Vitest across all projects, and `validate` (fixtures + registry + wrangler isolation + workflow YAML + `.env.example` coverage).
- The Worker tests run against a real local D1 (workerd, via `wrangler`'s `getPlatformProxy`) with the real migration. They cover:
  - no-leak GET;
  - reveal and finish;
  - validation, 405/415/413;
  - CORS (including look-alike origins);
  - auth (401/403, weak secrets);
  - idempotency (replay/conflict);
  - URL/provider-key dedupe and multi-outlet attach;
  - unsafe URLs, fixtures outside local and player events;
  - the policy gate (shadow/trusted/off, benchmark and threshold, human sample, a perfect model verdict versus deterministic failures, unknown-source fail-closed);
  - review, withdraw (including future-day refill), merge/unmerge, stats;
  - concurrent scheduling;
  - shortage with no partial days;
  - a full import → review → schedule → play → withdraw round over HTTP.
- `wrangler dev --env local` end to end:
  - migrations applied;
  - placeholder seed;
  - 7 days scheduled;
  - `npm run smoke` passed;
  - answer reveal;
  - CLI withdrawal → 410;
  - legacy import;
  - approval correctly refused (`SOURCE_UNREVIEWED`) after a live SSRF-safe link check returned 200;
  - live `ingest:batch` with the mock AI. The run and checkpoints were stored in D1. GDELT returned 429s; one wiki category timed out once and kept its old cursor.
- Builds: `npm run build:web` (Pages output with `_headers`), `wrangler deploy --dry-run` (Worker bundle about 115 KiB, 30 KiB gzipped) and `npm run build:pages` (legacy).

## 6. Not done / needs the owner

- The Cloudflare account, D1 creation (real `database_id`s), secrets, the Pages project, GitHub environments and secrets, and the first deploys. Steps are in README_DEPLOYMENT.md §1–7.
- No live Workers AI call was made (no credentials).
  - The REST request and response shapes follow the model pages as of 2026-11-22: Granite uses `max_tokens` and returns `result.response`; Gemma uses `max_completion_tokens` and returns `choices`.
  - Neither model is listed for JSON Mode, so output is parsed and grounded by us.
  - Verify on the first staging run.
- Source rights: every source is `unreviewed`. Nothing can be published until the owner approves sources in the registry.
- Publisher RSS feeds: the adapter is implemented, but `data/sources.json` has no feeds. A feed is fetched only after its source is approved.
- The GitHub action versions follow the repo's existing pins (`checkout@v7`, `setup-node@v7`); `upload-artifact@v4` is used for reports. Confirm them on the first run.
