# CI/CD on Cloudflare (Workers Builds + Pages)

GitHub hosts the repository and pull requests. **GitHub Actions no longer runs anything.** Cloudflare builds, checks and deploys:

- **Workers Builds** runs the API Worker (`apps/worker`) for **staging** (branch `integration/redesign-question-bank`) and **production** (branch `main`).
- **Cloudflare Pages** runs the frontend (`apps/web`): production from `main`, and previews for chosen branches.

Settings follow the Cloudflare docs as read on 2026-11-28 (Workers Builds: configuration, build branches, advanced setups, build image, limits; Pages: Git integration, build configuration, branch build controls, build watch paths, preview deployments, limits).

## Before and after

| | Before (GitHub Actions) | After (Cloudflare) |
|---|---|---|
| Checks on push and PR | `ci.yml`: typecheck, tests, validate, `git grep` secret check, web build, Worker bundle, local D1 migrations, legacy static build | Workers Builds runs `npm run ci:worker` (everything, including tests that need workerd). Pages runs `npm run ci:web` (the frontend subset). Both report status checks on the commit or PR. |
| API Worker deploy | `deploy-worker.yml` (disabled on GitHub), on `main` plus manual runs; optional remote migrations | Workers Builds deploy command: `ci:worker && wrangler deploy --env <env> && smoke:ci`. A failing check stops the deploy. **Remote migrations are never automatic.** |
| Frontend deploy | Planned Pages Git integration; `pages.yml` deployed the legacy static demo to GitHub Pages (disabled, failing) | Pages Git integration: build command `npm run ci:web`. A non-zero exit means no assets are uploaded. |
| Ingestion | `ingest.yml` cron (failing twice a day) | Ingest Worker + Workflow (Cloudflare cron), deployed when enabled (see "Ingest Worker" below) |
| Daily heartbeat | `smoke.yml` (00:40 UTC) | Retired. See [Monitoring](#monitoring). |
| Netlify legacy demo | `netlify-daily.yml` build hook (failing) | Retired. The Netlify site keeps its last build until the cutover. |

## npm entry points (all in the repo, all run locally too)

| Script | What it does | Used by |
|---|---|---|
| `npm run check:secrets` | Fails on secret assignments, credential shapes, committed `.env` / `.dev.vars`, and answer-bearing question-bank files. Uses `git ls-files`, or walks the tree when `.git` is missing. Never prints the matched text. | both builds |
| `npm run ci:worker` | `check:secrets` → `typecheck` (all workspaces) → `npm test` (all Vitest projects, including workerd/D1 tests) → `validate` (fixture bank, source registry, wrangler isolation, these entry points) → Worker bundle (`wrangler deploy --dry-run`) → every D1 migration applied to a fresh local database | Workers Builds |
| `npm run ci:web` | `check:secrets` → `typecheck` → Vitest projects `core`, `config`, `web`, `scripts` → `validate` → `build:web` (output `apps/web/dist`) | Pages |
| `npm run deploy:ci:staging -w @gof/worker` / `deploy:ci:production` | `wrangler deploy --env <env> --var APP_VERSION:$WORKERS_CI_COMMIT_SHA` | Workers Builds deploy command |
| `npm run smoke:ci` | Read-only smoke test of the deployed Worker when the build variable `SMOKE_URL` is set; otherwise it skips | after the deploy |
| `npm run ci` | `ci:worker` + `build:web` + the legacy static build: the full local pre-push check | you |

## Cloudflare settings

### API Worker: staging (existing Worker `gta-florida-api-staging`)

Go to Workers & Pages → `gta-florida-api-staging` → Settings → Build → **Connect** (GitHub `nikossakell/gta-or-florida`, through the Cloudflare GitHub App).

| Setting | Value |
|---|---|
| Git branch (production branch for this Worker) | `integration/redesign-question-bank` |
| Enable non-production branch builds | **On** (checks only, see the next row) |
| Non-production branch deploy (preview) command | `npm run ci:worker` (runs the checks and reports a status; uploads nothing) |
| Build command | *(empty)* |
| Deploy command | `npm run ci:worker && npm run deploy:ci:staging -w @gof/worker && npm run smoke:ci` |
| Root directory | `/` *(repo root; npm workspaces install from there)* |
| Build variables | `SMOKE_URL` = `https://gta-florida-api-staging.<subdomain>.workers.dev` *(optional)*. No Node pin needed: `.nvmrc` = 22. |
| Build watch paths | include `*`; exclude `docs/*`, `*.md`, `redesign/*` |
| API token | the default token Cloudflare creates (Workers Scripts edit). If a deploy fails on a missing permission, add only what the error names. |

The checks run inside the deploy command on purpose. The docs do not state that a failed build command skips the deploy, but `a && b` guarantees it.

### API Worker: production (`gta-florida-api-production`)

If the Worker does not exist yet, create it once during the production rollout (step P4 below). Then connect it the same way.

| Setting | Value |
|---|---|
| Git branch | `main` |
| Enable non-production branch builds | **Off** (branch checks come from the staging Worker; no preview versions on production) |
| Deploy command | `npm run ci:worker && npm run deploy:ci:production -w @gof/worker && npm run smoke:ci` |
| Build command / root directory / watch paths / token | as for staging |
| Build variables | `SMOKE_URL` = `https://gta-florida-api-production.<subdomain>.workers.dev` |

Runtime configuration is not a build setting:
- **Vars:** `APP_ENV`, `FRONTEND_ORIGIN`, the D1 binding and the cron trigger come from `apps/worker/wrangler.jsonc` for the env being deployed.
- **Secrets:** `ADMIN_TOKEN` and `INGESTION_IMPORT_TOKEN` are set once per env with `wrangler secret put … --env <env>` and stay in place across deploys.
- **Isolation:** staging and production use different Worker names, different D1 IDs (checked by `validate`) and different secret values.

### Frontend: Pages project `gta-or-florida`

Go to Workers & Pages → Create → Pages → **Connect to Git** (or, if the project exists: Settings → Builds & deployments).

| Setting | Value |
|---|---|
| Production branch | `main`, with "Enable automatic production branch deployments" on |
| Preview branches | **Custom**: include `integration/redesign-question-bank` (add `feat/*`, `chore/*` if you want previews for them) |
| Build command | `npm run ci:web` |
| Build output directory | `apps/web/dist` |
| Root directory | *(empty = repo root)* |
| Build watch paths | include `apps/web/*`, `packages/*`, `scripts/*`, `data/*`, `package.json`, `package-lock.json`, `.nvmrc` |
| Env vars: **Production** | `VITE_API_BASE_URL` = `https://gta-florida-api-production.<subdomain>.workers.dev`; `VITE_PUBLIC_URL` = `https://gta-or-florida.pages.dev` (or your domain) |
| Env vars: **Preview** | `VITE_API_BASE_URL` = `https://gta-florida-api-staging.<subdomain>.workers.dev` |

Preview branch alias: the docs say branch names are lowercased and non-alphanumerics become `-`, so this branch is served at `integration-redesign-question-bank.gta-or-florida.pages.dev`. The staging Worker's CORS accepts `<label>.gta-or-florida.pages.dev` (`PAGES_PREVIEW_PROJECT`), plus its `FRONTEND_ORIGIN` and `EXTRA_ORIGINS`. The production Worker accepts only `https://gta-or-florida.pages.dev`, so previews can never reach production data.

### Ingest Worker (later, when ingestion is switched on)

`apps/ingest-worker` is not deployed yet (`INGEST_ENABLED` is `"false"` in both envs). Deploying it creates new Workers and Workflows. When you decide to:
1. Deploy it once by hand (`npm run deploy:ingest:staging`).
2. Connect `gta-florida-ingest-staging` (and later `-production`) like the API Worker:
   - deploy command `npm run ci:worker && npm run deploy:ci:staging -w @gof/ingest-worker`;
   - watch paths `apps/ingest-worker/*`, `apps/ingest/*`, `packages/*`, `package.json`, `package-lock.json`, `.nvmrc`.

## What could not move into Cloudflare's builds

- **workerd/D1 tests in Pages.** Pages builds run in a gVisor container, and the Worker, ingest and review tests start a local workerd. `ci:web` runs only the frontend and shared-library projects; the full suite runs in Workers Builds. Locally both pass. Their first real run in Cloudflare is the first build after you connect.
- **`.git` in the build.** Cloudflare does not document a `.git` directory, so `check:secrets` falls back to walking the checked-out tree. That walk skips `node_modules`, build output and the always-ignored local secret files.
- **Remote D1 migrations.** These are deliberately not part of any build. A deploy cannot check that the remote database is at the right migration; follow the order below.
- **Post-deploy smoke.** It runs after `wrangler deploy`, so it can mark a build red but cannot undo the deploy.
- **Atomicity.** The Worker and Pages deploy independently: there is no atomic release across them. Keep API changes backward-compatible, deploy the API first, and use the rollback steps below.
- **Required status check names.** The docs do not give them. Pick them in GitHub after the first Cloudflare runs (manual step G3).
- **Fork PRs.** Pages builds previews only for PRs from branches in this repository.
- **Free-plan budgets.** Workers Builds: 3,000 build minutes/month, 1 concurrent build, 20-minute timeout. Pages: 500 builds/month, 1 concurrent build, 20-minute timeout. `ci:worker` takes about 3–4 minutes locally.

## Monitoring

`smoke.yml` emailed you when today had no round. With it gone:
- the Worker cron still logs `no_round_today` and schedule warnings (Workers Logs are enabled);
- `npm run smoke -- <url>` (with `REQUIRE_TODAY=1`) checks it by hand;
- for an alert, point any uptime monitor at `GET /api/health` and alert when `"todayReady":false`.

## Manual steps (dashboards; not done for you)

**GitHub**

- **G1. Now, before the next push:** Settings → Actions → General → Actions permissions → **Disable actions**. Scheduled workflows on `main` (Ingest content, Netlify daily rebuild, Daily heartbeat) keep running from `main` until then, whatever is on other branches.
- **G2.** After Cloudflare is verified, delete the GitHub Actions secrets, variables and environments. Values are never needed again.
  - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_TOKEN`, `INGESTION_IMPORT_TOKEN`, `CF_AI_ACCOUNT_ID`, `CF_AI_API_TOKEN`, `NETLIFY_BUILD_HOOK_URL`.
  - Variables: `WORKER_DEPLOY_ENABLED`, `WORKER_URL`, `INGESTION_API_URL`, `AI_PROVIDER`, `ALLOW_PLACEHOLDER_CONTENT`, `SMOKE_URL`.
  - Environments: `staging`, `production`, `github-pages`.
  - Then revoke, in Cloudflare → My Profile → API Tokens, any token that existed only for GitHub Actions. `ADMIN_TOKEN` / `INGESTION_IMPORT_TOKEN` stay valid in the Workers. Rotate them if you consider their copy in GitHub exposed.
- **G3.** Settings → Branches (or Rules) → the `main` rule:
  - remove the old required check from the CI workflow (job `check`);
  - after the first Cloudflare runs, add the Workers Builds check of `gta-florida-api-staging` and the Pages check.
- **G4.** Optional: Settings → Pages → unpublish the GitHub Pages site (it still serves an old static demo).
- **G5.** Leave Settings → GitHub Apps → **Cloudflare Workers and Pages** installed with access to this repository.

**Cloudflare**

- **C1.** Connect `gta-florida-api-staging` (table above).
- **C2.** Create or connect the Pages project (table above).
- **C3.** Production Worker build, during the production rollout only.

## Safe rollout order

**Staging**
- **S1.** G1 (disable Actions).
- **S2.** Back up, then migrate the staging D1:
  ```bash
  npm run db:backup:staging -w @gof/worker
  npm run db:migrations:list:staging -w @gof/worker
  npm run db:migrate:staging -w @gof/worker
  ```
  The backup goes to `backups/`, which is git-ignored. Migration 0004 rebuilds `daily_rounds` / `daily_round_items` and copies every existing round unchanged.
- **S3.** Push `integration/redesign-question-bank` (needs your go).
- **S4.** C1. The first build deploys integration to staging. Check that the status is green, `smoke:ci` passes, and `/api/health` reports `"version":"<sha>"`.
- **S5.** C2, then check the preview `integration-redesign-question-bank.gta-or-florida.pages.dev` against the staging API.
- **S6.** Content, by hand and outside CI: `bank:import` → `bank:approve` → `admin -- schedule` with the export kept outside Git (README_DEPLOYMENT §9b).

**Production** (a separate, explicit decision)
- **P1.** Back up the production D1 (`db:backup:production`), list its migrations, and apply 0001–0004 **before** any production Worker deploy (`db:migrate:production`).
- **P2.** Set the production secrets with `wrangler secret put ADMIN_TOKEN --env production` (and `INGESTION_IMPORT_TOKEN`), using values different from staging.
- **P3.** In Pages, turn off automatic production deployments for now.
- **P4.** Create and connect the production Worker build (C3). If the Worker does not exist yet, run `npm run deploy:production -w @gof/worker` once, after P1, then connect it.
- **P5.** Merge `integration/redesign-question-bank` into `main` (PR). Workers Builds deploys the API and runs the smoke test.
- **P6.** Content: `bank:import` → `bank:approve --env production --allow-production` → `schedule --days 30`.
- **P7.** Turn Pages automatic production deployments back on and retry the latest `main` deployment. Check the production site.

## Rollback

- **Worker:** Workers & Pages → the Worker → Deployments → roll back to the previous version, or `npx wrangler rollback --env <env>` in `apps/worker`. Then revert the commit on the branch so the next build does not redeploy it.
- **Pages:** Deployments → choose the previous production deployment → **Rollback to this deployment**.
- **Pause automation:**
  - Worker → Settings → Build → change the branch or disconnect;
  - Pages → turn off automatic production deployments, or set preview branches to None.
- **D1:** `npx wrangler d1 time-travel restore <db> --env <env> --timestamp <ISO>` (point in time). The alternative is to restore the `backups/` export into a new database. Migrations are forward-only; restore before re-deploying older Worker code.
- **Content:** `npm run admin -- withdraw --question <q> --reason "…"` or `--day YYYY-MM-DD`.
