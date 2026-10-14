#!/usr/bin/env node
// test/insights-engine-fetch-cause.test.mjs - an engine's insights rows say WHY a fetch failed.
//
// undici rejects every transport failure with a bare TypeError('fetch failed') and keeps the
// real reason (getaddrinfo ENOTFOUND, ENETUNREACH, ...) on err.cause. The engines' insights
// verbs used to write err.message only, so a Mac waking on battery with no network (DarkWake)
// left "fetch failed" on every lane, re-stamped nightly, with nothing to tell "we were offline"
// from "the platform is broken". lib/insights.mjs can only classify offline when the cause
// reaches it, so every engine now renders its failure rows (and its --json failure envelope)
// through lib/util.mjs describeFetchFailure, the way meta-social's rupload already did.
//
// Proven by spawning the REAL engines in live mode with fake credentials and a preloaded fetch
// that rejects exactly like undici offline. No network, no real credential.
//   1. every insights failure row / envelope error that says "fetch failed" carries ENOTFOUND.
//   2. an offline token refresh (GBP) says it could not reach Google, never that the refresh
//      token "likely expired": the old wording read as a sign-in problem and opened a 7-day
//      token circuit on a lane that was only offline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-insights-cause-'));
const STUB = path.join(WS, 'offline-fetch.mjs');
fs.writeFileSync(STUB, `globalThis.fetch = async () => {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.example'), { code: 'ENOTFOUND', hostname: 'api.example' });
  throw e;
};\n`);

const now = new Date().toISOString();
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
const PLAN = path.join(WS, 'data', 'plans', 'p.json');
fs.writeFileSync(PLAN, JSON.stringify({
  campaign: 'c',
  posts: [{
    id: 'p1', status: 'posted', postedAt: now, scheduledAt: now, caption: 'x',
    platforms: ['linkedin', 'instagram', 'facebook', 'youtube', 'x', 'mastodon', 'ghost', 'telegram'],
    liPostId: 'urn:li:share:1', igMediaId: '1789', fbReelId: '55', ytVideoId: 'vid1', xPostId: '123',
    mastodonStatusId: '111', ghostPostId: 'g1', tgMessageId: '42',
  }],
}));
const FAR = String(Date.UTC(2100, 0, 1));
fs.writeFileSync(path.join(WS, '.env'), [
  'LINKEDIN_ACCESS_TOKEN=aaaa', 'LINKEDIN_REFRESH_TOKEN=rrrr', `LINKEDIN_TOKEN_EXPIRES_AT=${FAR}`, 'LINKEDIN_ORG_URN=urn:li:organization:1',
  'LINKEDIN_CLIENT_ID=c', 'LINKEDIN_CLIENT_SECRET=s',
  'META_PAGE_TOKEN=pppp', 'META_PAGE_ID=1', 'META_IG_USER_ID=2',
  'YT_CLIENT_ID=c', 'YT_CLIENT_SECRET=s', 'YT_REFRESH_TOKEN=r',
  'X_CLIENT_ID=c', 'X_ACCESS_TOKEN=a', `X_TOKEN_EXPIRES_AT=${FAR}`,
  'MASTODON_INSTANCE=https://m.example', 'MASTODON_ACCESS_TOKEN=t',
  'GHOST_SITE_URL=https://ghost.example', 'GHOST_ADMIN_API_KEY=507f191e810c19729de860ea:5ffec8ccd8db22b478bcb9d15ffec8ccd8db22b478bcb9d15ffec8ccd8db22b',
  'TELEGRAM_BOT_TOKEN=1:abc', 'TELEGRAM_CHANNEL_ID=@c',
  'GBP_CLIENT_ID=c', 'GBP_CLIENT_SECRET=s', 'GBP_REFRESH_TOKEN=r', 'GBP_LOCATION_ID=locations/1', 'GBP_ACCOUNT_ID=accounts/1',
  '',
].join('\n'), { mode: 0o600 });

function runEngine(engine, verb) {
  const env = { ...process.env, PENDPOST_ROOT: WS };
  delete env.PENDPOST_MODE;
  const r = spawnSync(process.execPath, ['--import', STUB, path.join(REPO, 'scripts', `${engine}-social.mjs`), verb, '--plan', PLAN, '--json', '--actor', 'pendpost'], {
    cwd: WS, env, encoding: 'utf8', timeout: 60000,
  });
  const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  try { return JSON.parse(line); } catch { return null; }
}

// The texts an envelope hands lib/insights.mjs: the envelope error, then each failed row.
const failureTexts = (env) => [
  ...(env && env.ok === false && env.error ? [env.error] : []),
  ...((env && env.results) || []).filter((r) => r && r.ok === false).map((r) => String(r.errorMessage || r.error || '')),
];

try {
  const cases = [
    ['linkedin', 'insights'], ['linkedin', 'demographics'],
    ['meta', 'insights'], ['meta', 'demographics'],
    ['yt', 'insights'], ['yt', 'demographics'],
    ['x', 'insights'], ['mastodon', 'insights'], ['ghost', 'insights'],
    ['telegram', 'insights'], ['gbp', 'performance'],
  ];
  let seen = 0;
  for (const [engine, verb] of cases) {
    const env = runEngine(engine, verb);
    const texts = failureTexts(env);
    const fetchTexts = texts.filter((t) => /fetch failed|could not reach/i.test(t));
    if (!fetchTexts.length) {
      ok(false, `${engine} ${verb}: an offline fetch produced a failure row (got ${JSON.stringify(env).slice(0, 240)})`);
      continue;
    }
    seen += 1;
    ok(fetchTexts.every((t) => /ENOTFOUND/.test(t)), `${engine} ${verb}: the failure carries the cause code (got ${JSON.stringify(fetchTexts[0])})`);
  }
  ok(seen === cases.length, `every engine verb reported its offline failure (${seen}/${cases.length})`);

  const gbp = failureTexts(runEngine('gbp', 'performance')).join(' ');
  ok(/could not reach Google/.test(gbp), `gbp: an offline token refresh says it could not reach Google (got ${JSON.stringify(gbp)})`);
  ok(!/likely expired|token refresh failed/i.test(gbp), 'gbp: an offline token refresh never reads as an expired refresh token');
} finally {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures) { console.error(`[insights-engine-fetch-cause] FAIL - ${failures} failure(s), ${pass} passed.`); process.exit(1); }
console.log(`[insights-engine-fetch-cause] OK - engine insights rows carry the fetch cause (${pass} assertions).`);
