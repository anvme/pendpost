#!/usr/bin/env node
// test/cloud-backstop-fail-closed.test.mjs - "fail closed for acked jobs" (owner
// decision 2026-10-13; lib/scheduler.mjs backstop claim gate).
//
// The incident (2026-10-12): the cloud published li-art-of-happiness at 07:01Z, the
// Mac slept on battery, reconcile never learned it, and the backstop tried to re-fire
// it 14 times because a claim call that THROWS used to fail OPEN. It only failed
// because the Mac had no network at all; with the cloud unreachable but LinkedIn
// reachable it would have published a DUPLICATE.
//
// Contract pinned here:
//   1. A job the cloud ACKNOWLEDGED (state.cloudAccepted / state.cloudRetriggered
//      for that lane) + the claim acquire throws a network_error CloudError -> HOLD:
//      no engine spawn, no publish-hold strike, ONE 'cloud-claim-wait' activity row
//      on the transition (a second tick in the same state adds no second row).
//   2. Same job, next tick the claim is GRANTED -> the backstop fires as before
//      (and consumes the claim).
//   3. Same shape, next tick the claim returns CONSUMED -> marked posted from the
//      claim, never fired locally.
//   4. A job the cloud NEVER acknowledged + claim network_error -> still fires
//      locally (today's fail-open preserved: the cloud cannot fire a job it never
//      received).
//   5. An acked job whose claim call reaches the cloud but gets no verdict (HTTP 503)
//      also holds: the cloud could not answer the claim, and it holds the job.
//   6. A stale-held RETRIGGER record (state.cloudRetriggered) is acceptance evidence
//      too: the cloud reported that job back, so it provably has it.
// Mock mode + a mocked global.fetch; no network, no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-failclosed-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive, getActivity } = await import('../lib/scheduler.mjs');

const CAMP = 'failclosed-2026-10';
const CLIENT = activeClientId();

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// cloudDown=true: EVERY cloud call throws (the incident's `fetch failed` shape, so
// cloudFetch raises CloudError('network_error')). Otherwise the claim answers per
// post: postId -> 'granted' | 'consumed' | 'http503'; unlisted posts are 'denied' so
// an older still-due post never fires mid-test and pollutes a later case.
let cloudDown = false;
const claimModes = new Map();
const claimCalls = [];
function claimModeOf(claimKey) {
  for (const [postId, mode] of claimModes) if (claimKey.includes(`:${postId}:`)) return mode;
  return 'denied';
}
function installFetch() {
  global.fetch = async (input, init) => {
    if (cloudDown) throw new TypeError('fetch failed');
    const url = String(input);
    const method = (init && init.method) || 'GET';
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/publish-claim') && method === 'POST') {
      const body = JSON.parse(init.body);
      const mode = claimModeOf(body.claimKey);
      claimCalls.push(body);
      if (mode === 'http503') return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'unavailable' }) };
      if (body.action === 'acquire') {
        if (mode === 'denied') return json({ granted: false, consumed: false, externalId: null, holder: 'cloud' });
        if (mode === 'consumed') return json({ granted: false, consumed: true, externalId: 'IG_FROM_CLOUD_CLAIM', holder: 'cloud' });
        return json({ granted: true, consumed: false, externalId: null, holder: 'local' });
      }
      return json({ ok: true }); // consume / release
    }
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
    if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
    if (url.endsWith('/v1/sync/push') && method === 'POST') {
      const body = JSON.parse(init.body);
      return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
    }
    if (url.includes('/v1/sync/results')) return json({ results: [] });
    if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
    if (url.endsWith('/v1/sync/retrigger') && method === 'POST') return json({ requeued: [], skipped: [] });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);
const waitRows = (postId) => getActivity(200).filter((e) => e.postId === postId && e.action === 'cloud-claim-wait');
const noStrike = (p) => !p.publishHold && !p.publishRetry && !(Array.isArray(p.attempts) && p.attempts.length);

// An OLD acceptance record for the post's meta lane, so the backstop grace (anchored
// on max(scheduledAt, first-ack, retrigger)) is exhausted and the tick reaches the
// claim gate. `map` picks the acceptance record: the push ack or a stale-held retrigger.
function seedOldAcceptance(postId, map = 'cloudAccepted') {
  const s = loadState();
  if (!s[map] || typeof s[map] !== 'object') s[map] = {};
  s[map][`${CAMP}:${postId}:meta`] = { jobId: `${CLIENT}:${CAMP}:${postId}:meta`, at: '2020-01-01T00:10:00.000Z' };
  saveState();
}
async function addApprovedReel(postId) {
  await createPost({ campaign: CAMP, post: { id: postId, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: `a quiet clip ${postId}` }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId, actor: 'owner' });
  if (!planAbs) planAbs = path.resolve(WS, loadPlanStore().campaigns.find((cc) => cc.id === CAMP).path);
}

try {
  await createCampaign({ id: CAMP, note: 'fail-closed backstop contract', timezone: 'UTC', actor: 'owner' });
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true); // cloud-managed

  // --- (1) ACKED job + claim network_error -> HOLD, one row, no strike -------------
  cloudDown = true;
  await addApprovedReel('p-acked');
  seedOldAcceptance('p-acked');
  claimModes.set('p-acked', 'granted'); // only relevant once the cloud is back (case 2)
  const t1 = await runDueExclusive('scheduler');
  ok(t1.code === 'cloud_managed', 'the tick stays cloud-managed while the cloud is unreachable');
  ok(readPost('p-acked').status !== 'posted' && !readPost('p-acked').igMediaId, 'the ACKED job was NOT re-fired locally while the cloud cannot answer the claim');
  ok(!t1.ran.some((r) => r.postId === 'p-acked' && r.ok), 'no engine ran for the acked job (no successful dispatch row)');
  ok(t1.ran.filter((r) => r.postId === 'p-acked').length >= 1 && t1.ran.filter((r) => r.postId === 'p-acked').every((r) => r.errorCode === 'cloud_claim_wait'), 'the run-now truth for the held lane is its own cloud_claim_wait marker (not cloud_held, whose copy promises a 20-minute backstop)');
  ok(noStrike(readPost('p-acked')), 'no publish-hold strike: no attempt, no publishRetry, no publishHold (not the post\'s fault)');
  ok(!getActivity(200).some((e) => e.postId === 'p-acked' && e.action === 'cloud-backstop'), 'no cloud-backstop row: the backstop did not fire');
  ok(waitRows('p-acked').length === 1, 'exactly ONE cloud-claim-wait activity row surfaced the hold');
  const row = waitRows('p-acked')[0];
  ok(row.platform === 'meta' && row.ok === true, 'the wait row names the lane and reads as a hold, not a failure');
  ok(/already has this post/i.test(row.errorMessage || '') && !/ - /.test(row.errorMessage || '') && !/\u2014/.test(row.errorMessage || ''), 'the wait row says plainly that the cloud already has the post (no dash glyphs)');

  const t1b = await runDueExclusive('scheduler');
  ok(readPost('p-acked').status !== 'posted' && !t1b.ran.some((r) => r.postId === 'p-acked' && r.ok), 'a second unreachable tick still holds the acked job');
  ok(waitRows('p-acked').length === 1, 'a second tick in the same state adds NO second wait row (standing de-dupe)');
  ok(noStrike(readPost('p-acked')), 'still no publish-hold strike after the second held tick');

  // --- (2) same job, the cloud answers: claim GRANTED -> the backstop fires ----------
  cloudDown = false;
  const t2 = await runDueExclusive('scheduler');
  ok(readPost('p-acked').status === 'posted', 'once the cloud grants the claim the backstop fires as before');
  ok(t2.ran.some((r) => r.postId === 'p-acked' && r.lane === 'meta' && r.ok), 'the granted fire went through the normal local dispatch');
  ok(claimCalls.some((cl) => cl.action === 'consume' && cl.claimKey === `${CLIENT}:${CAMP}:p-acked:meta`), 'the granted fire consumed its claim');

  // --- (3) acked job held, then the cloud answers CONSUMED -> marked posted ----------
  cloudDown = true;
  await addApprovedReel('p-consumed');
  seedOldAcceptance('p-consumed');
  claimModes.set('p-consumed', 'consumed');
  await runDueExclusive('scheduler');
  ok(readPost('p-consumed').status !== 'posted' && waitRows('p-consumed').length === 1, 'the acked job is held with one wait row while the cloud is unreachable');
  cloudDown = false;
  const t3 = await runDueExclusive('scheduler');
  ok(readPost('p-consumed').status === 'posted' && readPost('p-consumed').igMediaId === 'IG_FROM_CLOUD_CLAIM', 'the consumed claim marked the post posted with the cloud-minted id');
  ok(!t3.ran.some((r) => r.postId === 'p-consumed'), 'the consumed post was never dispatched locally (no duplicate)');
  ok(noStrike(readPost('p-consumed')), 'no publish-hold strike on the consumed post');

  // --- (4) NEVER-acked job + claim network_error -> fail-open preserved -------------
  cloudDown = true;
  await addApprovedReel('p-never');
  ok(!((loadState().cloudAccepted || {})[`${CAMP}:p-never:meta`]) && !((loadState().cloudRetriggered || {})[`${CAMP}:p-never:meta`]), 'the never-acked job has no acceptance record (the push never landed)');
  const t4 = await runDueExclusive('scheduler');
  ok(readPost('p-never').status === 'posted', 'the never-acked job STILL fires locally while the cloud is down (fail-open preserved)');
  ok(t4.ran.some((r) => r.postId === 'p-never' && r.lane === 'meta' && r.ok), 'the fail-open fire went through the normal local dispatch');
  ok(getActivity(200).some((e) => e.postId === 'p-never' && e.action === 'cloud-backstop'), 'the fail-open fire left its cloud-backstop row');
  ok(waitRows('p-never').length === 0, 'no cloud-claim-wait row for a job the cloud never had');

  // --- (5) acked job + the claim reaches the cloud but gets no verdict (HTTP 503) ----
  cloudDown = false;
  await addApprovedReel('p-503');
  seedOldAcceptance('p-503');
  claimModes.set('p-503', 'http503');
  const t5 = await runDueExclusive('scheduler');
  ok(readPost('p-503').status !== 'posted' && !t5.ran.some((r) => r.postId === 'p-503' && r.ok), 'an acked job whose claim gets an HTTP 503 is held, not fired');
  ok(waitRows('p-503').length === 1, 'the 503 hold surfaced one wait row');

  // --- (6) a stale-held RETRIGGER record is acceptance evidence too -----------------
  cloudDown = true;
  await addApprovedReel('p-retr');
  seedOldAcceptance('p-retr', 'cloudRetriggered');
  ok(!((loadState().cloudAccepted || {})[`${CAMP}:p-retr:meta`]), 'p-retr carries only a retrigger record, no push ack');
  const t6 = await runDueExclusive('scheduler');
  ok(readPost('p-retr').status !== 'posted' && !t6.ran.some((r) => r.postId === 'p-retr' && r.ok), 'a job the cloud reported back (retriggered) is held while the claim cannot be answered');
  ok(waitRows('p-retr').length === 1, 'the retrigger-evidence hold surfaced one wait row');

  // --- (7) a second outage after a claim VERDICT re-arms the wait row ---------------
  // Down -> one row; the cloud answers with a live lease (denied, stand down: no row of
  // its own); down again -> a NEW hold streak, so a second row. Before the fix the
  // de-dupe compared only the latest row for the lane and logged nothing.
  cloudDown = true;
  await addApprovedReel('p-rearm');
  seedOldAcceptance('p-rearm');
  claimModes.set('p-rearm', 'denied');
  await runDueExclusive('scheduler');
  ok(waitRows('p-rearm').length === 1, 'first outage: one wait row');
  ok(Boolean((loadState().cloudClaimWait || {})[`${CAMP}:p-rearm:meta`]), 'the hold streak is recorded (state.cloudClaimWait)');
  cloudDown = false;
  const t7 = await runDueExclusive('scheduler');
  ok(readPost('p-rearm').status !== 'posted' && !t7.ran.some((r) => r.postId === 'p-rearm' && r.ok), 'the live-lease denial stands the backstop down');
  ok(waitRows('p-rearm').length === 1, 'the denial itself adds no wait row');
  ok(!((loadState().cloudClaimWait || {})[`${CAMP}:p-rearm:meta`]), 'a claim verdict ends the hold streak');
  cloudDown = true;
  await runDueExclusive('scheduler');
  ok(waitRows('p-rearm').length === 2, 'a second outage after a verdict logs a NEW wait row (re-armed)');
  await runDueExclusive('scheduler');
  ok(waitRows('p-rearm').length === 2, 'and still only one row per streak');
  claimModes.set('p-rearm', 'denied');

  console.log(`[cloud-backstop-fail-closed] OK: acked jobs hold while the claim cannot be answered, resume on grant/consume, never-acked jobs still fail open (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
