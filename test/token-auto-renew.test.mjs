#!/usr/bin/env node
// test/token-auto-renew.test.mjs - re-auth never surprises (local side).
//
// The cloud warns about a LinkedIn token 7 days before it expires, but the local engine
// only refreshed with <5 days left, and only when a LinkedIn command happened to run. So
// the owner got a scary "reconnect" email for a token pendpost could have renewed itself.
//
// Proves, credential-free and network-free (fake refresh engines via the
// PENDPOST_<LANE>_ENGINE override):
//   1. linkedin-social.mjs refreshes inside a 14-day window (was 5).
//   2. dailyTokenRefresh: once per 24h per client, refreshes LinkedIn/X only when the lane
//      HAS a refresh token AND expires within 14 days; a quiet ok row on success; on
//      failure ONE row naming the re-auth command, not repeated the next day.
//   3. after a successful refresh of an always-on client the fresh token is re-sealed
//      into the cloud vault (handLocalTokens); a failed re-seal logs a row, never throws.
//   4. accountStatus exposes canAutoRenew (refresh token PRESENCE, never the value).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-token-renew-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const DAY = 24 * 3600 * 1000;
const CALLS = path.join(WS, 'calls.log');
const MODE = path.join(WS, 'mode.json');
for (const lane of ['linkedin', 'x']) {
  const p = path.join(WS, `fake-${lane}.mjs`);
  fs.writeFileSync(p, `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(CALLS)}, ${JSON.stringify(lane)} + ' ' + process.argv.slice(2).join(' ') + '\\n');
let m = {};
try { m = JSON.parse(fs.readFileSync(${JSON.stringify(MODE)}, 'utf8')); } catch {}
if (m[${JSON.stringify(lane)}] === 'fail') { console.log(JSON.stringify({ ok: false, error: 'Refresh failed (invalid_grant). The refresh token is likely expired or revoked', results: [] })); process.exit(1); }
console.log(JSON.stringify({ ok: true, results: [] }));
`);
  process.env[`PENDPOST_${lane.toUpperCase()}_ENGINE`] = p;
}
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : []);
const resetCalls = () => fs.rmSync(CALLS, { force: true });
const ENV = path.join(WS, '.env');
const writeEnv = (vars) => fs.writeFileSync(ENV, `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const { tokenRefresh, dailyTokenRefresh } = await import('../lib/writes.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { accountStatus } = await import('../lib/accounts.mjs');
const li = await import('../scripts/linkedin-social.mjs');

const rows = (platform) => (loadState().activity || []).filter((a) => a.action === 'token-refresh' && a.platform === platform);
const openDay = () => { const st = loadState(); st.tokenRefresh = { lastRunAt: new Date(Date.now() - 2 * DAY).toISOString() }; saveState(); };

try {
  // ---- 1. the engine's own window ---------------------------------------------------
  ok(li.LI_REFRESH_WINDOW_MS === 14 * DAY, 'linkedin-social.mjs refreshes inside a 14-day window (was 5)');

  // ---- 2. daily tick ----------------------------------------------------------------
  writeEnv({
    LINKEDIN_ACCESS_TOKEN: 'a', LINKEDIN_REFRESH_TOKEN: 'r', LINKEDIN_TOKEN_EXPIRES_AT: Date.now() + 10 * DAY,
    X_ACCESS_TOKEN: 'xa', X_REFRESH_TOKEN: 'xr', X_TOKEN_EXPIRES_AT: Date.now() + 30 * DAY,
  });
  resetCalls();
  let res = await dailyTokenRefresh();
  ok(calls().length === 1 && calls()[0].startsWith('linkedin refresh'), 'LinkedIn (refresh token, 10 days left) is refreshed; X (30 days left) is not');
  ok(Array.isArray(res) && res.some((r) => r.platform === 'linkedin' && r.ok), 'the tick reports the refresh');
  ok(rows('linkedin').length === 1 && rows('linkedin')[0].ok === true, 'success logs one quiet ok token-refresh row');

  resetCalls();
  res = await dailyTokenRefresh();
  ok(res === null && calls().length === 0, 'once per 24h per client: a second tick the same day does nothing');

  // A lane that cannot renew itself (no refresh token) is never refreshed by the tick.
  writeEnv({ LINKEDIN_ACCESS_TOKEN: 'a', LINKEDIN_TOKEN_EXPIRES_AT: Date.now() + 3 * DAY });
  openDay();
  resetCalls();
  await dailyTokenRefresh();
  ok(calls().length === 0, 'no refresh token => no refresh attempt (Setup shows the expiry instead)');

  // Failure: one row with the re-auth command, not repeated the next day.
  writeEnv({ LINKEDIN_ACCESS_TOKEN: 'a', LINKEDIN_REFRESH_TOKEN: 'r', LINKEDIN_TOKEN_EXPIRES_AT: Date.now() + 2 * DAY });
  fs.writeFileSync(MODE, JSON.stringify({ linkedin: 'fail' }));
  openDay();
  const before = rows('linkedin').length;
  await dailyTokenRefresh();
  const failRow = rows('linkedin')[0];
  ok(rows('linkedin').length === before + 1 && failRow.ok === false, 'a failed refresh logs one ok:false row');
  ok(/node scripts\/linkedin-social\.mjs auth/.test(failRow.errorMessage || ''), 'the failure row names the exact re-auth command');
  openDay();
  await dailyTokenRefresh();
  ok(rows('linkedin').length === before + 1, 'the same failure the next day adds no second row');
  fs.rmSync(MODE, { force: true });

  // ---- 3. cloud re-seal after a successful refresh ----------------------------------
  const sealed = [];
  res = await tokenRefresh({ platform: 'linkedin' }, { cloudEnabled: () => true, reseal: async (id) => { sealed.push(id); return { handed: [], skipped: [] }; } });
  ok(res.ok === true && sealed.length === 1, 'an always-on client gets the fresh token re-sealed into the cloud vault');
  const sealedNone = [];
  await tokenRefresh({ platform: 'linkedin' }, { cloudEnabled: () => false, reseal: async (id) => { sealedNone.push(id); } });
  ok(sealedNone.length === 0, 'a local-only client is never re-sealed');
  res = await tokenRefresh({ platform: 'linkedin' }, { cloudEnabled: () => true, reseal: async () => { throw new Error('cloud unreachable'); } });
  ok(res.ok === true, 'a failed re-seal never fails the refresh');
  ok(rows('linkedin')[0].ok === false && rows('linkedin')[0].errorCode === 'cloud_reseal_failed', 'a failed re-seal logs one cloud_reseal_failed row');

  // ---- 4. accountStatus canAutoRenew -------------------------------------------------
  writeEnv({ LINKEDIN_CLIENT_ID: 'c', LINKEDIN_CLIENT_SECRET: 's', LINKEDIN_ACCESS_TOKEN: 'a', LINKEDIN_REFRESH_TOKEN: 'secret-refresh-value', LINKEDIN_TOKEN_EXPIRES_AT: Date.now() + 3 * DAY });
  let acc = accountStatus();
  ok(acc.linkedin.canAutoRenew === true, 'canAutoRenew true when a refresh token is stored');
  ok(!JSON.stringify(acc).includes('secret-refresh-value'), 'the refresh token value never leaves accountStatus');
  writeEnv({ LINKEDIN_CLIENT_ID: 'c', LINKEDIN_CLIENT_SECRET: 's', LINKEDIN_ACCESS_TOKEN: 'a', LINKEDIN_TOKEN_EXPIRES_AT: Date.now() + 3 * DAY });
  acc = accountStatus();
  ok(acc.linkedin.canAutoRenew === false, 'canAutoRenew false without a refresh token');
  ok(typeof acc.x.canAutoRenew === 'boolean', 'x carries canAutoRenew too');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[token-auto-renew] OK - 14-day window, daily renew once per client, quiet success, one failure row, cloud re-seal, canAutoRenew (${pass} assertions).`);
} catch (err) {
  console.error(`[token-auto-renew] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
