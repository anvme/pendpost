#!/usr/bin/env node
// test/plans-lastfailure-superseded.test.mjs - a failure the operator already acted on
// no longer reads as the post's current failure.
//
// lastFailureFor (lib/plans.mjs) read the post.attempts tail with no notion of time, so
// a failed X post the owner rescheduled to 2099 read "waiting-due" and still carried
// the old lastFailure: the card and the detail kept painting a failure for a post that
// was already re-armed. The operator's remediation verbs are reschedule (the "retry now"
// verb), an edit (updatePost clears the hold) and a re-approve. A LOCAL failure recorded
// before the newest of those no longer yields lastFailure. A failure recorded AFTER it
// (the post failed again) does, and the publish-hold cap + failureRecovery semantics for
// that new failure are unchanged. A post still held/backing off keeps its failure: the
// hold is the live proof the failure still stands (a re-approve does not clear it).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const tick = () => new Promise((r) => setTimeout(r, 5));

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-lastfail-sup-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, createPost, approvePost, reschedulePost, updatePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { recordAttempt, MAX_PUBLISH_ATTEMPTS } = await import('../lib/publish-hold.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const CAMP = 'sup';
const planAbs = () => path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
// Record a failed attempt through the REAL write path (recordAttempt maintains the hold).
const fail = (id, message, errorCode = 'engine_failure') => {
  const plan = JSON.parse(fs.readFileSync(planAbs(), 'utf8'));
  const raw = plan.posts.find((p) => p.id === id);
  recordAttempt(raw, { ts: new Date().toISOString(), platform: 'x', action: 'publish', ok: false, errorCode, errorMessage: message });
  fs.writeFileSync(planAbs(), `${JSON.stringify(plan, null, 2)}\n`);
};
const newPost = async (id) => {
  const cp = await createPost({
    campaign: CAMP,
    post: { id, type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: `a quiet note ${id}` },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost(${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: CAMP, postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${id}): ${JSON.stringify(ap)}`);
  await tick();
};

try {
  const cc = await createCampaign({ id: CAMP, note: CAMP, timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);

  // ===== reschedule supersedes the old failure ================================
  await newPost('r1');
  fail('r1', 'X POST /2/tweets: HTTP 503 overloaded');
  let p = getPost('r1');
  ok(p.lastFailure?.message === 'X POST /2/tweets: HTTP 503 overloaded', 'setup: the failed attempt surfaces lastFailure');
  await tick();
  const rs = await reschedulePost({ campaign: CAMP, postId: 'r1', scheduledAt: '2099-01-01T00:00:00Z', actor: 'owner' });
  assert.ok(rs.ok, `reschedulePost: ${JSON.stringify(rs)}`);
  p = getPost('r1');
  ok(p.lastFailure === null, `a reschedule supersedes the older failure (got ${JSON.stringify(p.lastFailure)})`);
  ok(p.derivedState !== 'publish-failed', `the rescheduled post no longer derives publish-failed (got '${p.derivedState}')`);
  ok(p.attempts.length === 1, 'the attempt row itself is kept (audit trail untouched, only the read supersedes it)');

  // ===== a NEW failure after the reschedule shows (the new one) ===============
  await tick();
  fail('r1', 'X POST /2/tweets: HTTP 500 second try');
  p = getPost('r1');
  ok(p.lastFailure?.message === 'X POST /2/tweets: HTTP 500 second try', 'a failure recorded after the reschedule is the current failure');

  // ===== re-approve supersedes a failure that is not held =====================
  await newPost('a1');
  fail('a1', 'X POST /2/tweets: HTTP 400 once'); // non-transient: a 5xx now backs off, and a backoff keeps its failure visible
  ok(getPost('a1').lastFailure, 'setup: a single failure (below the cap, no hold) surfaces');
  await tick();
  const ra = await approvePost({ campaign: CAMP, postId: 'a1', actor: 'owner' });
  assert.ok(ra.ok, `re-approve: ${JSON.stringify(ra)}`);
  ok(getPost('a1').lastFailure === null, 're-approving supersedes the older failure');

  // ===== an edit supersedes the old failure ===================================
  await newPost('e1');
  fail('e1', 'X POST /2/tweets: HTTP 500 before edit');
  ok(getPost('e1').lastFailure, 'setup: the failure surfaces before the edit');
  await tick();
  const up = await updatePost({ campaign: CAMP, postId: 'e1', ifRev: getPost('e1').rev, fields: { caption: 'a quiet note, reworded' }, actor: 'owner' });
  assert.ok(up.ok, `updatePost: ${JSON.stringify(up)}`);
  ok(getPost('e1').lastFailure === null, 'an operator edit supersedes the older failure');

  // ===== a held post keeps its failure through a re-approve ===================
  // A re-approve does not clear publishHold (only reschedule/edit do), so the post is
  // still parked: hiding its failure would leave a stuck post with no reason.
  await newPost('h1');
  for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i++) fail('h1', 'X POST /2/tweets: HTTP 403 forbidden');
  ok(Boolean(getPost('h1').publishHold), 'setup: the cap stamped publishHold');
  await tick();
  const rh = await approvePost({ campaign: CAMP, postId: 'h1', actor: 'owner' });
  assert.ok(rh.ok, `re-approve held: ${JSON.stringify(rh)}`);
  p = getPost('h1');
  ok(p.lastFailure?.terminal === true, 'a still-held post keeps its failure (terminal) through a re-approve');

  // ===== cap + recovery semantics unchanged for a post that fails AGAIN ========
  // Reschedule clears the hold; the trailing failure streak still counts the pre-
  // reschedule rows (recordAttempt is untouched), so the next failure re-parks at once
  // and the NEW failure is what the card shows, terminal, with its recovery.
  await tick();
  const rs2 = await reschedulePost({ campaign: CAMP, postId: 'h1', scheduledAt: '2020-01-01T00:00:00Z', actor: 'owner' });
  assert.ok(rs2.ok, `reschedule held: ${JSON.stringify(rs2)}`);
  p = getPost('h1');
  ok(!p.publishHold && p.lastFailure === null, 'reschedule clears the hold and supersedes the failure');
  await tick();
  fail('h1', 'X POST /2/tweets: HTTP 401 Unauthorized');
  p = getPost('h1');
  ok(Boolean(p.publishHold), 'the failure after the reschedule parks the post again (cap unchanged)');
  ok(p.lastFailure?.message === 'X POST /2/tweets: HTTP 401 Unauthorized', 'the NEW failure is the current one');
  ok(p.lastFailure?.terminal === true, 'the new failure is terminal');
  ok(p.lastFailure?.recovery === 'reconnect', `failureRecovery still names the recovery for the new failure (got '${p.lastFailure?.recovery}')`);

  // ===== activity-feed skip rows are superseded the same way =================
  // (the fallback source when no attempt row exists)
  await newPost('s1');
  const st = loadState();
  st.activity = [
    { ts: new Date().toISOString(), campaign: CAMP, postId: 's1', platform: 'x', action: 'engine-run', ok: false, errorCode: 'invalid_input', errorMessage: 'caption over the X limit' },
    ...(st.activity || []),
  ];
  saveState();
  ok(getPost('s1').lastFailure?.code === 'invalid_input', 'setup: a feed-only skip surfaces lastFailure');
  await tick();
  const rs3 = await reschedulePost({ campaign: CAMP, postId: 's1', scheduledAt: '2099-01-01T00:00:00Z', actor: 'owner' });
  assert.ok(rs3.ok, `reschedule s1: ${JSON.stringify(rs3)}`);
  ok(getPost('s1').lastFailure === null, 'a reschedule supersedes an older feed-only skip too');

  // ===== the durable post.failureResetAt stamp supersedes on its own ==========
  // (the reschedule/edit activity row ages out of ACTIVITY_CAP; the stamp does not)
  await newPost('d1');
  fail('d1', 'X POST /2/tweets: HTTP 400 long ago'); // non-transient, see a1
  await tick();
  const dPlan = JSON.parse(fs.readFileSync(planAbs(), 'utf8'));
  dPlan.posts.find((x) => x.id === 'd1').failureResetAt = new Date().toISOString();
  fs.writeFileSync(planAbs(), `${JSON.stringify(dPlan, null, 2)}\n`);
  ok(getPost('d1').lastFailure === null, 'post.failureResetAt supersedes an older failure without any activity row');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
