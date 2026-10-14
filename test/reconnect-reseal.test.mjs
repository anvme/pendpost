#!/usr/bin/env node
// test/reconnect-reseal.test.mjs - a reconnect reaches the cloud vault.
//
// After an interactive (re)connect the new token lands in the brand's local .env. For a
// cloud-managed (always-on) brand the cloud kept publishing with the OLD sealed token until
// someone pressed re-sync, so a reconnect looked done locally while the cloud kept failing.
// Proves, network-free (mocked global.fetch, fake probe engine):
//   1. resealAfterReconnect: reseals only for a cloud-managed brand; a failed reseal is one
//      activity row, never a throw.
//   2. Studio path: a connect run that exits 0 reseals (PUT /v1/vault/...); exit 1 does not;
//      a brand that is not always-on is never resealed.
//   3. CLI path: a FORCED single-lane health recheck that passes reseals (the step the owner
//      or agent runs after `node scripts/<lane>-social.mjs auth`); a failing one does not.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reconnect-reseal-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
fs.writeFileSync(path.join(WS, '.env'), [
  'PENDPOST_CLOUD_API_KEY=ppc_key_reconnect_reseal_0001',
  'LINKEDIN_ACCESS_TOKEN=fake-new-access',
  'LINKEDIN_ORG_URN=urn:li:organization:1234567',
  'LINKEDIN_REFRESH_TOKEN=fake-new-refresh',
  'LINKEDIN_CLIENT_ID=fakeclient',
].join('\n') + '\n');
const CLOUD_JSON = path.join(WS, 'data', 'cloud.json');
const setAlwaysOn = (on) => fs.writeFileSync(CLOUD_JSON, JSON.stringify({
  baseUrl: 'https://cloud.test', workspaceId: 'ws_reconnect', brands: { default: { alwaysOn: on } },
}));
setAlwaysOn(true);

// Fake probe engine: passes or fails per a mode file.
const MODE = path.join(WS, 'probe-mode.txt');
const FAKE = path.join(WS, 'fake-linkedin.mjs');
fs.writeFileSync(FAKE, `
import fs from 'node:fs';
const pass = fs.existsSync(${JSON.stringify(MODE)}) && fs.readFileSync(${JSON.stringify(MODE)}, 'utf8').trim() === 'pass';
console.log(JSON.stringify({ ok: true, results: [{ action: 'probe', ok: pass, detail: pass ? 'token live' : 'token expired' }] }));
`);
process.env.PENDPOST_LINKEDIN_ENGINE = FAKE;

const { resealAfterReconnect } = await import('../lib/writes.mjs');
const { noteConnectStart, noteConnectExit } = await import('../lib/api.mjs');
const { probeAll } = await import('../lib/health.mjs');
const { loadState } = await import('../lib/state.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const calls = [];
global.fetch = async (input, opts = {}) => {
  const url = String(input);
  const method = opts.method || 'GET';
  calls.push({ url, method, body: typeof opts.body === 'string' ? opts.body : undefined });
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (/\/v1\/vault\/[a-z]+$/.test(url) && method === 'PUT') return json({ stored: true, refreshStored: true });
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};
const liPuts = () => calls.filter((c) => c.url.endsWith('/v1/vault/linkedin') && c.method === 'PUT');

try {
  // ---- (1) the helper ---------------------------------------------------------------
  let sealed = [];
  const r0 = await resealAfterReconnect('linkedin', 'default', { cloudEnabled: () => false, reseal: async (id) => { sealed.push(id); } });
  ok(r0.resealed === false && sealed.length === 0, 'not cloud-managed: nothing is resealed');
  const r1 = await resealAfterReconnect('linkedin', 'default', { cloudEnabled: () => true, reseal: async (id) => { sealed.push(id); } });
  ok(r1.resealed === true && sealed[0] === 'default', 'cloud-managed: the brand is resealed');
  const r2 = await resealAfterReconnect('linkedin', 'default', { cloudEnabled: () => true, reseal: async () => { throw new Error('cloud down'); } });
  ok(r2.resealed === false, 'a failed reseal resolves, never throws');
  const row = (loadState().activity || []).find((a) => a.action === 'token-refresh' && a.platform === 'linkedin' && a.ok === false);
  ok(row && row.errorCode === 'cloud_reseal_failed_reconnect' && /reconnect/i.test(row.errorMessage), 'a failed reseal leaves one activity row with the reconnect code (not the renewal one)');
  ok(/Re-sync now/.test(row.errorMessage), 'the row names the manual fix (Re-sync now), not a renewal that will never come');

  // ---- (2) Studio connect run -------------------------------------------------------
  calls.length = 0;
  noteConnectStart('linkedin');
  await noteConnectExit('linkedin', 0);
  ok(liPuts().length === 1, 'a connect run that exits 0 reseals the brand into the cloud vault');
  ok(JSON.parse(liPuts()[0].body).token === 'fake-new-access', 'the reseal carries the freshly connected token');

  calls.length = 0;
  noteConnectStart('linkedin');
  await noteConnectExit('linkedin', 1);
  ok(liPuts().length === 0, 'a failed connect run reseals nothing');

  setAlwaysOn(false);
  calls.length = 0;
  noteConnectStart('linkedin');
  await noteConnectExit('linkedin', 0);
  ok(liPuts().length === 0, 'a brand that is not always-on is never resealed');
  setAlwaysOn(true);

  // ---- (3) forced single-lane recheck (the step after a CLI ceremony) ---------------
  calls.length = 0;
  fs.writeFileSync(MODE, 'pass');
  await probeAll({ force: true, platform: 'linkedin' });
  ok(liPuts().length === 1, 'a passing forced recheck of the lane reseals the brand');

  calls.length = 0;
  fs.writeFileSync(MODE, 'fail');
  await probeAll({ force: true, platform: 'linkedin' });
  ok(liPuts().length === 0, 'a failing forced recheck reseals nothing');

  console.log(`[reconnect-reseal] OK - a reconnect (Studio run or forced recheck) reseals a cloud-managed brand (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
