#!/usr/bin/env node
// test/writes-failure-reset-stamp.test.mjs - the operator's remediation verbs stamp the
// durable post.failureResetAt, so a superseded failure stays superseded after the
// activity feed has rolled over.
//
// lastFailureFor (lib/plans.mjs) hides a LOCAL failure older than the operator's last
// reschedule / edit / re-approve. It found that moment in the reschedule / post-update
// activity row, and state.activity is capped at ACTIVITY_CAP (500) rows: once a busy
// feed pushed the row out, the old failure came back on the card. The writers now stamp
// post.failureResetAt, which lives on the post and never ages out. The automatic
// slot-slip move is not the operator acting and does not stamp; a reject does not
// either. A post still under publishHold keeps its failure (the hold is the proof).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const tick = () => new Promise((r) => setTimeout(r, 5));

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reset-stamp-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, createPost, approvePost, rejectPost, reschedulePost, updatePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { recordAttempt, MAX_PUBLISH_ATTEMPTS } = await import('../lib/publish-hold.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const CAMP = 'stamp';
const planAbs = () => path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
const rawPost = (id) => JSON.parse(fs.readFileSync(planAbs(), 'utf8')).posts.find((p) => p.id === id);
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
const fail = (id, message, errorCode = 'engine_failure') => {
  const plan = JSON.parse(fs.readFileSync(planAbs(), 'utf8'));
  const raw = plan.posts.find((p) => p.id === id);
  recordAttempt(raw, { ts: new Date().toISOString(), platform: 'x', action: 'publish', ok: false, errorCode, errorMessage: message });
  fs.writeFileSync(planAbs(), `${JSON.stringify(plan, null, 2)}\n`);
};
// Simulate a feed that has rolled past ACTIVITY_CAP: every reschedule / post-update /
// approve row is gone, only the post itself remains.
const truncateFeed = () => {
  const st = loadState();
  st.activity = [];
  saveState();
};
const newPost = async (id, { approve = true } = {}) => {
  const cp = await createPost({
    campaign: CAMP,
    post: { id, type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: `a quiet note ${id}` },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost(${id}): ${JSON.stringify(cp)}`);
  if (approve) {
    const ap = await approvePost({ campaign: CAMP, postId: id, actor: 'owner' });
    assert.ok(ap.ok, `approvePost(${id}): ${JSON.stringify(ap)}`);
  }
  await tick();
};

try {
  const cc = await createCampaign({ id: CAMP, note: CAMP, timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);

  // ===== owner reschedule stamps; the failure stays gone after the feed rolls ====
  await newPost('r1');
  fail('r1', 'X POST /2/tweets: HTTP 503 overloaded');
  ok(getPost('r1').lastFailure, 'setup: the failure surfaces');
  await tick();
  const rs = await reschedulePost({ campaign: CAMP, postId: 'r1', scheduledAt: '2099-01-01T00:00:00Z', actor: 'owner' });
  assert.ok(rs.ok, `reschedulePost: ${JSON.stringify(rs)}`);
  ok(Number.isFinite(Date.parse(rawPost('r1').failureResetAt || '')), 'an owner reschedule stamps post.failureResetAt');
  truncateFeed();
  ok(getPost('r1').lastFailure === null, 'with the activity feed truncated, the rescheduled post still shows no old failure');

  // ===== an edit stamps too ======================================================
  await newPost('e1');
  fail('e1', 'X POST /2/tweets: HTTP 500 before edit');
  await tick();
  const up = await updatePost({ campaign: CAMP, postId: 'e1', ifRev: getPost('e1').rev, fields: { caption: 'a quiet note, reworded' }, actor: 'owner' });
  assert.ok(up.ok, `updatePost: ${JSON.stringify(up)}`);
  ok(Number.isFinite(Date.parse(rawPost('e1').failureResetAt || '')), 'an edit stamps post.failureResetAt');
  truncateFeed();
  ok(getPost('e1').lastFailure === null, 'with the activity feed truncated, the edited post still shows no old failure');

  // ===== a re-approve stamps; a reject does not ==================================
  await newPost('a1');
  fail('a1', 'X POST /2/tweets: HTTP 400 once'); // non-transient: a 5xx now backs off, and a backoff keeps its failure visible
  await tick();
  const before = rawPost('a1').failureResetAt;
  const ra = await approvePost({ campaign: CAMP, postId: 'a1', actor: 'owner' });
  assert.ok(ra.ok, `re-approve: ${JSON.stringify(ra)}`);
  const stamped = rawPost('a1').failureResetAt;
  ok(Number.isFinite(Date.parse(stamped || '')) && stamped !== before, 'an approve stamps post.failureResetAt');
  truncateFeed();
  ok(getPost('a1').lastFailure === null, 'with the activity feed truncated, the re-approved post shows no old failure');

  await newPost('j1', { approve: false });
  const rj = await rejectPost({ campaign: CAMP, postId: 'j1', actor: 'owner' });
  assert.ok(rj.ok, `reject: ${JSON.stringify(rj)}`);
  ok(rawPost('j1').failureResetAt === undefined, 'a reject does not stamp post.failureResetAt');

  // ===== the automatic slot-slip move is not the operator: no stamp ==============
  await newPost('s1', { approve: false });
  fail('s1', 'X POST /2/tweets: HTTP 500 draft');
  await tick();
  const sl = await reschedulePost({ campaign: CAMP, postId: 's1', scheduledAt: '2099-01-01T00:00:00Z', actor: 'pendpost', slotSlip: true });
  assert.ok(sl.ok, `slot slip: ${JSON.stringify(sl)}`);
  ok(rawPost('s1').failureResetAt === undefined, 'a slot-slip move does not stamp post.failureResetAt');
  truncateFeed();
  ok(getPost('s1').lastFailure?.message === 'X POST /2/tweets: HTTP 500 draft', 'a slot-slipped post keeps its failure');

  // ===== a held post keeps its failure through a stamped re-approve ==============
  await newPost('h1');
  for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i++) fail('h1', 'X POST /2/tweets: HTTP 403 forbidden');
  ok(Boolean(rawPost('h1').publishHold), 'setup: the cap stamped publishHold');
  await tick();
  const rh = await approvePost({ campaign: CAMP, postId: 'h1', actor: 'owner' });
  assert.ok(rh.ok, `re-approve held: ${JSON.stringify(rh)}`);
  ok(Boolean(rawPost('h1').failureResetAt), 'the re-approve stamped the held post');
  truncateFeed();
  ok(getPost('h1').lastFailure?.terminal === true, 'a post still under publishHold keeps its failure despite the stamp');

  // ===== a failure AFTER the stamp is the current failure ========================
  await tick();
  fail('r1', 'X POST /2/tweets: HTTP 500 after');
  ok(getPost('r1').lastFailure?.message === 'X POST /2/tweets: HTTP 500 after', 'a failure recorded after the stamp still shows');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
