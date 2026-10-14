#!/usr/bin/env node
// test/future-post-cloud-failure-dropped.test.mjs - the defensive twin of
// reschedule-clears-cloud-failure. Reschedule clears a cloud failure that already
// EXISTS, but /v1/sync/results is a history the cloud replays on every poll: a stale
// job the cloud fired for the OLD time can report `failed` AFTER the operator moved the
// post into the future. Before this fix reconcile recorded it again, and the header dot
// went red for a post that could not have failed to publish on time (it is not due).
//
// Contract:
//   1. reconcileCloudResults never records a cloud failure (fire failure OR credential
//      refusal) for a post whose scheduledAt is still in the future, and does not hand
//      it to the self-healer (retriggering a stale job early could publish it early).
//   2. cloudSyncStatus ignores any EXISTING cloudFailures entry whose post is scheduled
//      in the future (a relic written before this fix must not hold the dot red).
//   3. A failure for a post that IS past due is still recorded (no regression).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT + mock mode set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-future-fail-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost, reschedulePost } = await import('../lib/writes.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'growth';
const CLIENT = activeClientId();
const FUTURE = new Date(Date.now() + 9 * 24 * 3600_000).toISOString();

let resultsPayload = [];
global.fetch = async (input) => {
  const url = String(input);
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.includes('/v1/sync/results')) return json({ results: resultsPayload });
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

const failed = (postId) => ({
  jobId: `${CLIENT}:${CAMP}:${postId}:meta`, clientId: CLIENT, campaign: CAMP, postId, lane: 'meta', state: 'failed',
  firedAt: '2026-08-16T10:16:00.000Z', refusedCode: null, results: [], failureMessage: 'engine reported no successful publish',
});
const refusedCred = (postId) => ({
  jobId: `${CLIENT}:${CAMP}:${postId}:meta`, clientId: CLIENT, campaign: CAMP, postId, lane: 'meta', state: 'refused',
  firedAt: null, refusedCode: 'account_unresolved', results: [],
});

try {
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  await createCampaign({ id: CAMP, note: 'growth', timezone: 'UTC', actor: 'owner' });
  for (const id of ['moved', 'moved2', 'late']) {
    const cp = await createPost({ campaign: CAMP, post: { id, type: 'reel', platforms: ['instagram'], scheduledAt: '2026-08-16T10:00:00Z', path: 'data/media/clip.mp4', caption: `a quiet clip ${id}` }, actor: 'agent:a' });
    assert.ok(cp.ok, `createPost ${id}: ${JSON.stringify(cp)}`);
    const ap = await approvePost({ campaign: CAMP, postId: id, actor: 'owner' });
    assert.ok(ap.ok, `approvePost ${id}: ${JSON.stringify(ap)}`);
  }
  // The operator moves two posts into the future (the "retry later" verb).
  for (const id of ['moved', 'moved2']) {
    const rs = await reschedulePost({ campaign: CAMP, postId: id, scheduledAt: FUTURE, actor: 'owner' });
    assert.ok(rs.ok, `reschedulePost ${id}: ${JSON.stringify(rs)}`);
  }

  // --- (1) a failure that ARRIVES after the reschedule is not recorded ----------------
  resultsPayload = [failed('moved'), refusedCred('moved2'), failed('late')];
  const r = await cloud.reconcileCloudResults();
  const st = loadState();
  ok(!(st.cloudFailures && st.cloudFailures[`${CAMP}:moved`]), 'a fire failure for a future-scheduled post is NOT recorded');
  ok(!(st.cloudFailures && st.cloudFailures[`${CAMP}:moved2`]), 'a credential refusal for a future-scheduled post is NOT recorded');
  ok(!(r.failed || []).some((f) => f.postId === 'moved'), 'the future post is not handed to the self-healer (no early retrigger)');
  // --- (3) a past-due post's failure is still recorded ---------------------------------
  ok(Boolean(st.cloudFailures && st.cloudFailures[`${CAMP}:late`]), 'a failure for a past-due post IS still recorded');
  ok((r.failed || []).some((f) => f.postId === 'late'), 'the past-due failure still reaches the self-healer');

  // --- (2) cloudSyncStatus ignores an existing entry for a future-scheduled post ------
  {
    const s = loadState();
    s.cloudFailures = { [`${CAMP}:moved`]: { lane: 'meta', jobId: 'j-moved', message: 'engine reported no successful publish', at: new Date().toISOString() } };
    s.cloudContact = { okAt: new Date().toISOString() };
    saveState();
  }
  // Mark 'late' posted-free: move it into the future too so only the relic is in play.
  await reschedulePost({ campaign: CAMP, postId: 'late', scheduledAt: FUTURE, actor: 'owner' });
  {
    const s = loadState();
    s.cloudFailures = { [`${CAMP}:moved`]: { lane: 'meta', jobId: 'j-moved', message: 'engine reported no successful publish', at: new Date().toISOString() } };
    saveState();
  }
  const sync = cloud.cloudSyncStatus();
  ok(sync && sync.failedCount === 0, `an existing failure for a future-scheduled post is ignored by cloudSyncStatus (failedCount=${sync && sync.failedCount})`);
  ok(sync && sync.state !== 'red', `and does not paint the dot red (state=${sync && sync.state}, reason=${sync && sync.reason})`);

  console.log(`\nPASS - ${pass} assertions`);
} catch (err) {
  console.error(`\nFAIL - ${err.message}`);
  console.error(err.stack);
  process.exit(1);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
