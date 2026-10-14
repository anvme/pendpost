#!/usr/bin/env node
// test/cloud-subview-idle-expiry.test.mjs - the scheduler caches the cloud subscription view
// (state.cloudSubView: alwaysOn / syncStopped) for the header cloud dot, but re-reads it only
// on a tick with cloud work (Neon economy: an idle daemon makes ZERO cloud calls so the
// compute can suspend). While idle the cache never refreshed, so a spend cap the owner has
// since raised kept the dot amber "sync stopped" indefinitely.
//
// The fix never polls: an idle tick drops a cached view older than SUB_VIEW_IDLE_MAX_AGE_MS
// (a local state write, no network). Idle means nothing is owed to the cloud (no pending
// push, no in-flight job, no failure), so the view gates nothing; the first tick with work
// reads it fresh BEFORE it pushes. A view younger than the bound stays, so the dot does not
// flicker between a work tick and the next idle one.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-subview-idle-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

let calls = 0;
global.fetch = async (input) => {
  calls += 1;
  const url = String(input);
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { expireIdleSubView, SUB_VIEW_IDLE_MAX_AGE_MS, runDueExclusive } = await import('../lib/scheduler.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const seedView = (at) => {
  const s = loadState();
  s.cloudSubView = { alwaysOn: true, syncStopped: true, stopReason: 'spend_cap_reached', at };
  s.cloudContact = { okAt: new Date().toISOString() };
  saveState();
};

try {
  // --- the pure rule ------------------------------------------------------------------
  const now = Date.now();
  ok(SUB_VIEW_IDLE_MAX_AGE_MS > 10 * 60_000, 'the bound outlives the 10 min wait grace (no flicker between ticks)');
  ok(expireIdleSubView({}, now) === false, 'no cached view -> nothing to drop');
  const fresh = { cloudSubView: { syncStopped: true, at: new Date(now - 60_000).toISOString() } };
  ok(expireIdleSubView(fresh, now) === false && fresh.cloudSubView, 'a view younger than the bound is kept');
  const old = { cloudSubView: { syncStopped: true, at: new Date(now - SUB_VIEW_IDLE_MAX_AGE_MS - 1).toISOString() } };
  ok(expireIdleSubView(old, now) === true && !('cloudSubView' in old), 'a view older than the bound is dropped');
  const undated = { cloudSubView: { syncStopped: true } };
  ok(expireIdleSubView(undated, now) === true && !('cloudSubView' in undated), 'a view with no readable age is dropped (its age is unknown)');

  // --- the idle tick, end to end ------------------------------------------------------
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(activeClientId(), true);

  seedView(ago(SUB_VIEW_IDLE_MAX_AGE_MS + 60_000));
  ok(cloud.cloudSyncStatus().reason === 'sync_stopped', 'precondition: the stale cached view paints the dot amber "sync stopped"');
  calls = 0;
  await runDueExclusive('test');
  ok(calls === 0, 'the idle tick made ZERO cloud calls (Neon economy kept)');
  ok(!loadState().cloudSubView, 'the idle tick dropped the stale view');
  const g = cloud.cloudSyncStatus();
  ok(g.state === 'green' && g.reason === 'all_confirmed', 'nothing owed to the cloud + no stale view -> green');

  seedView(ago(60_000));
  calls = 0;
  await runDueExclusive('test');
  ok(calls === 0, 'still zero cloud calls with a fresh view');
  ok(loadState().cloudSubView?.syncStopped === true, 'a fresh view survives the idle tick');
  ok(cloud.cloudSyncStatus().reason === 'sync_stopped', 'and the dot still reports it');

  console.log(`[cloud-subview-idle-expiry] OK - an idle tick expires a stale subscription view without a cloud call (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
