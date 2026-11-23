/**
 * `npm run smoke -- <worker-or-site-origin>` — opt-in synthetic check of a
 * deployed (or `wrangler dev`) Worker. Read-only except one answer POST, which
 * does not change any state. Never run against third-party hosts.
 *
 * Checks: health, today (or DAILY_NOT_READY), no answer leakage, answer reveal,
 * CORS rejection of a foreign origin, admin route refuses anonymous calls.
 * REQUIRE_TODAY=1 fails when today's round is missing (daily heartbeat).
 */
export {};

const base = (process.argv[2] ?? process.env.SMOKE_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) {
  console.error('Usage: npm run smoke -- https://<worker-host>');
  process.exit(2);
}
const failures: string[] = [];
const check = (ok: boolean, msg: string) => (ok ? console.log(`ok   ${msg}`) : (failures.push(msg), console.log(`FAIL ${msg}`)));

const health = await fetch(`${base}/api/health`);
const h = (await health.json()) as { status: string; db: string; todayReady: boolean };
check(health.ok && h.db === 'ok', `health ${health.status} db=${h.db} todayReady=${h.todayReady}`);

const today = await fetch(`${base}/api/challenge/today`);
const raw = await today.text();
if (today.status === 200) {
  const body = JSON.parse(raw) as { date: string; questions: { id: string }[] };
  check(body.questions.length === 5, `today has ${body.questions.length} questions`);
  check(!/"answer"|"explanation"|"source|"kind"|"game"|https?:\/\//.test(raw), 'today response leaks no answers/sources');
  const ans = await fetch(`${base}/api/challenge/${body.date}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: 'h1', choice: 'GTA' }) });
  const a = (await ans.json()) as { correct?: boolean; question?: { explanation?: string } };
  check(ans.ok && typeof a.correct === 'boolean' && !!a.question?.explanation, 'answer reveals result + explanation');
} else {
  const code = (JSON.parse(raw) as { error?: { code?: string } }).error?.code;
  // Heartbeat mode (REQUIRE_TODAY=1) treats a missing round as a failure → GitHub notifies the owner.
  if (process.env.REQUIRE_TODAY === '1') check(false, `today is not playable: ${today.status} ${code}`);
  else check(today.status === 503 && code === 'DAILY_NOT_READY', `today not ready → ${today.status} ${code} (expected until stock is approved)`);
}
const cors = await fetch(`${base}/api/challenge/today`, { method: 'OPTIONS', headers: { origin: 'https://not-allowed.example.org' } });
check(cors.status === 403 && !cors.headers.get('access-control-allow-origin'), 'foreign origin is refused by CORS');
const admin = await fetch(`${base}/api/v1/admin/stats`);
check(admin.status === 401, `anonymous admin call → ${admin.status}`);

if (failures.length) process.exit(1);
