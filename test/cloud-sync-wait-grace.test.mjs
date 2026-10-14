#!/usr/bin/env node
// test/cloud-sync-wait-grace.test.mjs - the two SELF-RESOLVING cloud waits read neutral
// (yellow) only for a bounded grace, then escalate to amber.
//
//  push_pending -> push_stuck: yellow means "the cloud confirms shortly". With contact
//    fresh but acks never landing (the cloud refuses the push, or a job is skipped before
//    it is sent) it stayed yellow forever. pushApprovedJobs now stamps when each owed,
//    unacked lane was first seen (state.cloudPendingSince); past SYNC_WAIT_GRACE_MS the
//    reason becomes the amber push_stuck.
//  flag_divergence: the cloud reports the brand paused while it is ON locally. It heals
//    itself (the scheduler re-asserts the flag with force:true on the tick that reads the
//    drift, and the cloud's PUT /v1/brands writes the brand row directly), so it is a wait:
//    yellow. A confirmed ON after that read means healed (no reason at all). Only a
//    re-assert that keeps failing past the grace makes it amber.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-waitgrace-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'wait-2026-09';
const CLIENT = activeClientId();
const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString();
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// The fake cloud: `acceptPush` decides whether /v1/sync/push acks; `brandPut` whether the
// on-flag re-assert succeeds.
let acceptPush = false;
let brandPut = true;
global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
  if (url.endsWith('/v1/sync/push') && method === 'POST') {
    const body = JSON.parse(init.body);
    return acceptPush
      ? json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] })
      : json({ accepted: [], refused: (body.jobs || []).map((j) => ({ jobId: j.jobId, reason: 'brand_paused' })) });
  }
  if (url.includes('/v1/brands/') && method === 'PUT') {
    return brandPut ? json({ ok: true }) : { ok: false, status: 503, text: async () => JSON.stringify({ error: 'unavailable' }) };
  }
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

const freshContact = () => { const s = loadState(); s.cloudContact = { okAt: new Date().toISOString() }; saveState(); };
const status = () => cloud.cloudSyncStatus();

try {
  ok(cloud.SYNC_REASONS.includes('push_stuck'), 'push_stuck is part of the single-sourced reason vocabulary');
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  await createCampaign({ id: CAMP, note: 'wait grace', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: 'p1', type: 'reel', platforms: ['instagram'], scheduledAt: FUTURE, path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  const KEY = `${CAMP}:p1:meta`;

  // ===== push_pending -> push_stuck ============================================
  await cloud.pushApprovedJobs(); // refused: no ack
  freshContact();
  let s1 = status();
  ok(s1.state === 'yellow' && s1.reason === 'push_pending', `a fresh unacked push is the neutral wait (got ${s1.state}/${s1.reason})`);
  const since = loadState().cloudPendingSince?.[KEY];
  ok(typeof since === 'string' && Number.isFinite(Date.parse(since)), 'the push stamps when the unacked lane was first seen');
  await cloud.pushApprovedJobs();
  ok(loadState().cloudPendingSince?.[KEY] === since, 'a later push keeps the FIRST-seen stamp (the wait clock never resets)');

  { const s = loadState(); s.cloudPendingSince[KEY] = ago(11); saveState(); }
  freshContact();
  s1 = status();
  ok(s1.state === 'amber' && s1.reason === 'push_stuck', `an ack missing for over the grace with fresh contact -> amber push_stuck (got ${s1.state}/${s1.reason})`);
  ok(s1.pendingCount === 1, 'pendingCount still counts the stuck lane');
  { const s = loadState(); s.cloudPendingSince[KEY] = ago(9); saveState(); }
  ok(status().reason === 'push_pending', 'inside the grace it is still the neutral wait');

  // A stale contact with the same stuck push is the unreachable alarm, which outranks it.
  { const s = loadState(); s.cloudPendingSince[KEY] = ago(30); s.cloudContact = { okAt: '2020-01-01T00:00:00.000Z' }; saveState(); }
  ok(status().reason === 'cloud_unreachable', 'a stale contact outranks push_stuck (cloud_unreachable is the truer cause)');

  // The ack lands: green, and the next push prunes the stamp.
  acceptPush = true;
  await cloud.pushApprovedJobs();
  freshContact();
  const g = status();
  ok(g.state === 'green' && g.reason === 'all_confirmed', `the ack clears the wait (got ${g.state}/${g.reason})`);
  await cloud.pushApprovedJobs();
  ok(!loadState().cloudPendingSince?.[KEY], 'a push after the ack prunes the pending stamp');

  // ===== flag_divergence: a self-healing wait ===================================
  { const s = loadState(); s.cloudSubView = { alwaysOn: false, syncStopped: false, stopReason: null, at: new Date().toISOString() }; delete s.cloudFlagSync; saveState(); }
  let f = status();
  ok(f.state === 'yellow' && f.reason === 'flag_divergence', `a fresh on-flag drift is a neutral wait (got ${f.state}/${f.reason})`);

  // The re-assert fails: still a wait inside the grace, amber after it.
  brandPut = false;
  await cloud.syncBrandFlags({ force: true });
  const failedSince = loadState().cloudFlagSync?.[CLIENT]?.failedSince;
  ok(typeof failedSince === 'string', 'a failed re-assert stamps failedSince on the brand flag record');
  await cloud.syncBrandFlags({ force: true });
  ok(loadState().cloudFlagSync[CLIENT].failedSince === failedSince, 'a second failure keeps the first stamp');
  ok(status().state === 'yellow', 'a failing re-assert inside the grace is still the wait');
  { const s = loadState(); s.cloudFlagSync[CLIENT].failedSince = ago(11); saveState(); }
  f = status();
  ok(f.state === 'amber' && f.reason === 'flag_divergence', `a re-assert failing past the grace -> amber (got ${f.state}/${f.reason})`);

  // The re-assert lands: the cached OFF view is older than the confirmed ON -> healed.
  brandPut = true;
  await new Promise((r) => setTimeout(r, 5));
  await cloud.syncBrandFlags({ force: true });
  ok(!loadState().cloudFlagSync[CLIENT].failedSince, 'a confirmed re-assert clears failedSince');
  f = status();
  ok(f.state === 'green' && f.reason === 'all_confirmed', `a confirmed ON after the OFF read is healed (got ${f.state}/${f.reason})`);

  // ===== precedence between the waits ==========================================
  // A stuck push (amber) outranks a fresh flag drift (yellow).
  acceptPush = false;
  await createPost({ campaign: CAMP, post: { id: 'p2', type: 'reel', platforms: ['instagram'], scheduledAt: FUTURE, path: 'data/media/clip.mp4', caption: 'a second clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p2', actor: 'owner' });
  await cloud.pushApprovedJobs();
  { const s = loadState(); s.cloudPendingSince[`${CAMP}:p2:meta`] = ago(11); s.cloudSubView = { alwaysOn: false, syncStopped: false, stopReason: null, at: new Date(Date.now() + 1000).toISOString() }; saveState(); }
  freshContact();
  f = status();
  ok(f.state === 'amber' && f.reason === 'push_stuck', `a stuck push outranks a fresh flag drift (got ${f.state}/${f.reason})`);

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
