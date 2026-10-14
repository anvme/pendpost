#!/usr/bin/env node
// test/linkedin-refresh-resilience.test.mjs - the LinkedIn engine's refresh path.
//
// The cloud runs this engine to publish. Two things it needs:
//   1. persistTokens records LINKEDIN_REFRESH_TOKEN_EXPIRES_AT (epoch ms) from
//      refresh_token_expires_in, so the cloud reseal can carry the refresh expiry
//      (both the auth ceremony and the refresh path go through persistTokens).
//   2. ensureFreshToken: a FAILED refresh while the current access token is still valid
//      warns and returns that token instead of aborting the post. It only gives up when
//      the token is really expired. An explicit `refresh` (force) still fails loudly, so
//      the daily renew keeps writing its one failure row.
// In-process, stubbed global.fetch, process.exit trapped. No network, fake values.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-li-refresh-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
const ENV = path.join(WS, '.env');
const writeEnv = (vars) => fs.writeFileSync(ENV, `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
const envVar = (name) => { const m = fs.readFileSync(ENV, 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm')); return m ? m[1].trim() : null; };

const li = await import('../scripts/linkedin-social.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const DAY = 24 * 3600 * 1000;

const realExit = process.exit;
const realError = console.error;
const realLog = console.log;
let exited = null;
const errLines = [];
process.exit = (code) => { exited = code; throw new Error(`__exit_${code}`); };
console.error = (...a) => { errLines.push(a.join(' ')); };
console.log = () => {};

const failingFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'fake refresh failure' }) });
const goodFetch = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });
const baseEnv = (expiresAt) => ({
  LINKEDIN_ACCESS_TOKEN: 'fake-current-access',
  LINKEDIN_TOKEN_EXPIRES_AT: String(expiresAt),
  LINKEDIN_REFRESH_TOKEN: 'fake-refresh',
  LINKEDIN_CLIENT_ID: 'fakeclient',
  LINKEDIN_CLIENT_SECRET: 'fakesecret',
});

try {
  // ---- (1) persistTokens writes the refresh expiry when LinkedIn returns it ---------
  writeEnv({});
  const before = Date.now();
  li.persistTokens({ access_token: 'fake-a1', expires_in: 5184000, refresh_token: 'fake-r1', refresh_token_expires_in: 31536000 });
  const refreshExp = Number(envVar('LINKEDIN_REFRESH_TOKEN_EXPIRES_AT'));
  ok(refreshExp >= before + 31536000 * 1000 && refreshExp <= Date.now() + 31536000 * 1000, 'persistTokens writes LINKEDIN_REFRESH_TOKEN_EXPIRES_AT as epoch ms from refresh_token_expires_in');

  writeEnv({ LINKEDIN_REFRESH_TOKEN_EXPIRES_AT: '123' });
  li.persistTokens({ access_token: 'fake-a2', expires_in: 5184000 });
  ok(envVar('LINKEDIN_REFRESH_TOKEN_EXPIRES_AT') === '123', 'persistTokens leaves the stored refresh expiry alone when LinkedIn does not return one');

  // The refresh path persists it too.
  writeEnv(baseEnv(Date.now() + 3 * DAY));
  global.fetch = goodFetch({ access_token: 'fake-renewed', expires_in: 5184000, refresh_token: 'fake-r2', refresh_token_expires_in: 30000000 });
  const renewed = await li.ensureFreshToken();
  ok(renewed === 'fake-renewed', 'a successful refresh returns the new access token');
  ok(Number(envVar('LINKEDIN_REFRESH_TOKEN_EXPIRES_AT')) > Date.now() + 29000000 * 1000, 'the refresh path also records LINKEDIN_REFRESH_TOKEN_EXPIRES_AT');

  // ---- (2) failed refresh + still-valid token -> warn and return the current token --
  writeEnv(baseEnv(Date.now() + 3 * DAY));
  global.fetch = failingFetch;
  exited = null; errLines.length = 0;
  const kept = await li.ensureFreshToken();
  ok(kept === 'fake-current-access', 'a failed refresh with a still-valid token returns the current token');
  ok(exited === null, 'it does not exit the process (the post goes ahead)');
  ok(errLines.some((l) => /warn/i.test(l) && /refresh/i.test(l)), 'it logs a warning about the failed refresh');
  ok(envVar('LINKEDIN_ACCESS_TOKEN') === 'fake-current-access', 'the stored token is unchanged');

  // ---- (3) failed refresh + expired token -> exit 1 --------------------------------
  writeEnv(baseEnv(Date.now() - DAY));
  global.fetch = failingFetch;
  exited = null;
  await li.ensureFreshToken().catch(() => {});
  ok(exited === 1, 'a failed refresh with an EXPIRED token still exits 1');

  // ---- (4) explicit `refresh` (force) still fails loudly, even with a valid token ---
  writeEnv(baseEnv(Date.now() + 30 * DAY));
  global.fetch = failingFetch;
  exited = null;
  await li.ensureFreshToken({ force: true }).catch(() => {});
  ok(exited === 1, 'a forced refresh that fails still exits 1 (the daily renew records the failure)');
} finally {
  process.exit = realExit;
  console.error = realError;
  console.log = realLog;
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
console.log(`[linkedin-refresh-resilience] OK - refresh expiry persisted, a failed refresh keeps a still-valid token (${pass} assertions).`);
