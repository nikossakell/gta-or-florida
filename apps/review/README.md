# Editorial review dashboard (local only)

A browser workflow for reviewing the curated question bank. It replaces running `npm run admin -- questions:approve` by hand for each question. It runs entirely on your machine and never talks to staging or production.

```bash
npm run review
# → Open http://127.0.0.1:4317/
```

## What it uses

| | Default | Override |
|---|---|---|
| Master batch (read only, never written) | `~/Desktop/personal/gta_or_florida/question-bank-master.json` | `REVIEW_MASTER` |
| Editorial audit suggestions (optional) | `editorial-audit.json` next to the master | `REVIEW_AUDIT` |
| Review state (local D1 + decisions) | `review-state/` next to the master | `REVIEW_STATE_DIR` |
| Port (always bound to 127.0.0.1) | `4317` | `REVIEW_PORT` |
| Name in the audit trail | your OS user name | `REVIEWER` |

The state stays outside the repo because it contains the answers.

## How it works

- **First start.**
  - The master is validated with the existing bank validators. If any entry is invalid, nothing is imported.
  - It is imported as local candidates into a persisted local D1 (the API Worker runs in-process via wrangler `getPlatformProxy`, the same conversion as `bank:import`).
  - The master's SHA-256 is recorded. If the file changes later, the dashboard shows a warning and keeps reviewing the imported version.
- **One click per question.** Read the headline (and the short explanation under it), then click **Approve**, **Investigate** or **Reject**, or press `A`, `I` or `R`. The decision is saved immediately and the next unreviewed question opens.
  - To change a decision, click another button. Every change is kept in the append-only history.
  - The source link and the audit's suggestion, if there is one, are shown under the headline.
- **These are editorial decisions, not Worker approvals.**
  - A click never submits the Worker's formal factual-summary attestations (authorship, source verification, privacy), so nothing in the audit trail claims checks that were not made.
  - The questions stay Worker candidates.
  - For a deployed environment, import the **Approved** export there and use the existing `npm run admin -- questions:approve`.
- **List view** shows all 200 at a glance. Filters cover origin, decision, difficulty, source and audit warnings. Search covers headline, event ID and source. Use ← and → to move between questions.
- **Exports** (header buttons):
  - Approved, Investigate and Rejected use the question-bank batch schema, with the decision noted in `notes`.
  - **History** contains every decision change.

## Security

- The server binds to `127.0.0.1` only. Requests whose `Host` is not that loopback address are refused, which blocks DNS rebinding.
- Each API call needs a session token generated at startup. The token is embedded in the page and sent as a custom header. Cross-site and cross-origin requests are refused.
- Static files come from a fixed allowlist; no part of the URL is ever used as a file path.
- There is a strict Content Security Policy, and responses use `no-store`.
- Every request body is size-limited and schema-validated on the server.
- There are no child processes, no outbound requests and no analytics. Wrangler telemetry is disabled.

## Resetting

Stop the server and delete the `review-state/` folder. On the next start, the master is imported fresh. This discards every local decision, so export **History** first.

## Tests

`npx vitest run --project review` (also part of `npm run ci`). The tests use fictional fixtures only.
