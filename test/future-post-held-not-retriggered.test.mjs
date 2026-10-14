#!/usr/bin/env node
// test/future-post-held-not-retriggered.test.mjs - the held-job twin of
// future-post-cloud-failure-dropped. The cloud parks a job 'stale_held' when it comes up
// >15 min past due, and fires it ONLY when retriggerHeldJobs asks it to. A retrigger
// re-sends the job the cloud already holds, i.e. the delivery for its OLD time. Incident
// 2026-09-24: a post was rescheduled into the future and re-approved, the held job for
// the old time stayed parked, and this driver retriggered it because it only checked
// whether the post was posted - the old delivery fired early.
//
// Contract:
//   1. retriggerHeldJobs never retriggers a held job whose post is now scheduled in the
//      future (the same future test reconcile applies to failures: futurePostKeys), and
//      writes no cloudRetriggered anchor for it (which would suppress the backstop).
//   2. A held job whose post IS past due and unposted is still retriggered (no regression).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT + mock mode set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-future-held-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost, reschedulePost } = await import('../lib/writes.mjs');
const { loadState } = await import('../lib/state.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'growth';
const CLIENT = activeClientId();
const PAST = new Date(Date.now() - 30 * 60_000).toISOString();
const FUTURE = new Date(Date.now() + 9 * 24 * 3600_000).toISOString();

const retriggered = [];
global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/sync/retrigger') && method === 'POST') {
    const ids = JSON.parse(init.body).jobIds || [];
    retriggered.push(...ids);
    return json({ requeued: ids, skipped: [] });
  }
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

const held = (postId) => ({ jobId: `${CLIENT}:${CAMP}:${postId}:linkedin`, campaign: CAMP, postId, lane: 'linkedin' });

try {
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  await createCampaign({ id: CAMP, note: 'growth', timezone: 'UTC', actor: 'owner' });
  for (const id of ['moved', 'late']) {
    const cp = await createPost({ campaign: CAMP, post: { id, type: 'text', platforms: ['linkedin'], scheduledAt: PAST, caption: `a quiet note ${id}` }, actor: 'agent:a' });
    assert.ok(cp.ok, `createPost ${id}: ${JSON.stringify(cp)}`);
    const ap = await approvePost({ campaign: CAMP, postId: id, actor: 'owner' });
    assert.ok(ap.ok, `approvePost ${id}: ${JSON.stringify(ap)}`);
  }
  // The operator moves 'moved' into the future; its old-time job is still parked in the cloud.
  const rs = await reschedulePost({ campaign: CAMP, postId: 'moved', scheduledAt: FUTURE, actor: 'owner' });
  assert.ok(rs.ok, `reschedulePost: ${JSON.stringify(rs)}`);

  const r = await cloud.retriggerHeldJobs([held('moved'), held('late')]);
  const anchors = loadState().cloudRetriggered || {};

  // --- (1) the future post's held job is left parked -----------------------------------
  ok(!retriggered.includes(held('moved').jobId), 'a held job whose post is now scheduled in the FUTURE is not retriggered');
  ok(!(r.retriggered || []).includes(held('moved').jobId), 'and is not reported as retriggered');
  ok(!anchors[`${CAMP}:moved:linkedin`], 'and gets no cloudRetriggered anchor (the backstop stays free)');

  // --- (2) the past-due unposted post's held job is still retriggered ------------------
  ok(retriggered.includes(held('late').jobId), 'a held job whose post is past due and unposted IS still retriggered');
  ok(Boolean(anchors[`${CAMP}:late:linkedin`]), 'and its handoff anchor is written');

  console.log(`\nPASS - ${pass} assertions`);
} catch (err) {
  console.error(`\nFAIL - ${err.message}`);
  console.error(err.stack);
  process.exit(1);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
