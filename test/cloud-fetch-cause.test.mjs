#!/usr/bin/env node
// test/cloud-fetch-cause.test.mjs - undici's fetch rejects EVERY transport failure with the
// same bare TypeError('fetch failed') and hides the real reason (DNS, refused, reset,
// timeout) on `err.cause`. cloudFetch kept only e.message, so from 2026-10-10 to 2026-10-13
// the daemon logged ~250 identical "cloud request failed: fetch failed" lines (reconcile,
// push, the backstop's publish-claim) whose cause could not be told apart: a Mac asleep in a
// 2-second DarkWake with no network, versus a cloud outage, versus a reset socket. The
// cause code must reach the CloudError message (and the cloudContact.lastError stamp the
// status dot reads), while the message still says "fetch failed" so publish-hold's
// transient-failure regex keeps classifying it. That undici causes never carry a header
// was measured against real undici (critic, 2026-10-13); a mocked fetch cannot prove it.
// Mock mode + a mocked global.fetch; no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fetchcause-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const KEY = 'ppc_test_secret_abcdef0123456789';
fs.writeFileSync(path.join(WS, '.env'), `PENDPOST_CLOUD_API_KEY=${KEY}\n`);

const { writeCloudConfig } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { loadState } = await import('../lib/state.mjs');
const { describeFetchFailure } = await import('../lib/util.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// The exact shapes undici produces (Node 25): a TypeError('fetch failed') whose cause is the
// system error (getaddrinfo / connect) or an undici error with an UND_ERR_* code.
const dnsFail = () => new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND pendpost-cloud-api.fly.dev'), { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: 'pendpost-cloud-api.fly.dev' }) });
const connectTimeout = () => new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error (attempted address: pendpost-cloud-api.fly.dev:443, timeout: 10000ms)'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' }) });
// Happy-eyeballs: every address refused -> an AggregateError cause with an empty message.
const refusedAll = () => new TypeError('fetch failed', { cause: Object.assign(new AggregateError([Object.assign(new Error('connect ECONNREFUSED 66.241.124.1:443'), { code: 'ECONNREFUSED' })], ''), { code: 'ECONNREFUSED' }) });

let nextFailure = dnsFail;
global.fetch = async () => { throw nextFailure(); };

try {
  writeCloudConfig({ baseUrl: 'https://pendpost-cloud-api.fly.dev', workspaceId: 'ws_test' });

  // 1. The pure helper.
  ok(typeof describeFetchFailure === 'function', 'describeFetchFailure is exported from lib/util.mjs');
  const d = describeFetchFailure(dnsFail());
  ok(d.startsWith('fetch failed') && d.includes('ENOTFOUND'), `a DNS failure names its code (${d})`);
  ok(describeFetchFailure(connectTimeout()).includes('UND_ERR_CONNECT_TIMEOUT'), 'an undici connect timeout names its UND_ERR code');
  const agg = describeFetchFailure(refusedAll());
  ok(agg.includes('ECONNREFUSED') && agg.includes('66.241.124.1'), `an AggregateError cause falls back to its first inner error (${agg})`);
  ok(describeFetchFailure(new Error('boom')) === 'boom', 'an error without a cause renders its plain message');
  ok(describeFetchFailure(Object.create(null)) === 'fetch failed', 'a null-prototype rejection falls back to "fetch failed" instead of throwing');
  const evil = new TypeError('fetch failed', { cause: Object.defineProperty(new Error('x'), 'code', { get() { throw new Error('getter'); } }) });
  ok(describeFetchFailure(evil) === 'fetch failed', 'a cause with a throwing getter falls back instead of throwing');

  // 2. cloudFetch (via getCloudResults, the reconcile GET) carries the cause into the CloudError.
  let err = null;
  try { await cloud.getCloudResults({}); } catch (e) { err = e; }
  ok(err && err.code === 'network_error', 'a transport failure is still a network_error CloudError');
  ok(/fetch failed/.test(err.message), 'the message still says "fetch failed" (publish-hold transient regex keeps matching)');
  ok(err.message.includes('ENOTFOUND'), `the CloudError message carries the cause code (${err.message})`);
  ok(cloud.describeCloudError(err).includes('ENOTFOUND'), 'the scheduler log line (describeCloudError) shows the cause');

  // 3. The status-dot contact stamp records the cause too.
  const lastError = (loadState().cloudContact || {}).lastError || '';
  ok(lastError.includes('ENOTFOUND'), `cloudContact.lastError carries the cause (${lastError})`);

  // 4. The backstop's publish-claim (same cloudFetch path) surfaces the cause in its log message.
  nextFailure = connectTimeout;
  let claimErr = null;
  try { await cloud.publishClaim('acquire', 'c:camp:post:linkedin', { leaseMs: 1000 }); } catch (e) { claimErr = e; }
  ok(claimErr && claimErr.message.includes('UND_ERR_CONNECT_TIMEOUT'), `the publish-claim failure names its cause (${claimErr && claimErr.message})`);

  console.log(`[cloud-fetch-cause] OK - a cloud transport failure names its cause instead of a bare "fetch failed" (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
