#!/usr/bin/env node
// test/cloud-claim-wait-needs-you.test.mjs - a fail-closed backstop hold that outlasts
// CLOUD_CLAIM_WAIT_NEEDS_YOU_MS (2 h) reads as needing the owner (critic finding 4).
//
// The hold has no release besides the cloud answering. A permanent cloud-side fault (a
// revoked key answering 401, an endpoint that is gone) would hold forever with nothing
// telling the owner what to do. So once a hold streak (state.cloudClaimWait, ended by
// any claim verdict) is older than the threshold, lib/plans.mjs lastFailureFor reports
// it as a failure with recovery 'cloud': the post reads "Waiting on you" (the existing
// publish-needs-you state) with the action to check the cloud connection. It STILL never
// fires locally. A younger hold stays the plain overdue state.
// Mock mode + a mocked global.fetch; no network, no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-needsyou-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost, reschedulePost } = await import('../lib/writes.mjs');
const { loadPlanStore, CLOUD_CLAIM_WAIT_NEEDS_YOU_MS } = await import('../lib/plans.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');

const CAMP = 'needsyou-2026-10';
const CLIENT = activeClientId();
const KEY = `${CAMP}:p-wait:meta`;

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// cloudDown: every call throws. claim401: the cloud answers the claim with HTTP 401 (a
// revoked key), the permanent fault the escalation exists for. Otherwise: granted.
let cloudDown = false;
let claim401 = false;
function installFetch() {
  global.fetch = async (input, init) => {
    if (cloudDown) throw new TypeError('fetch failed');
    const url = String(input);
    const method = (init && init.method) || 'GET';
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/publish-claim') && method === 'POST') {
      if (claim401) return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'unauthorized' }) };
      const body = JSON.parse(init.body);
      if (body.action === 'acquire') return json({ granted: true, consumed: false, externalId: null, holder: 'local' });
      return json({ ok: true });
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

const derived = () => loadPlanStore().campaigns.find((c) => c.id === CAMP).posts.find((p) => p.id === 'p-wait');
const ageStreak = (ms) => {
  const s = loadState();
  s.cloudClaimWait[KEY].since = new Date(Date.now() - ms).toISOString();
  saveState();
};

try {
  await createCampaign({ id: CAMP, note: 'needs-you escalation', timezone: 'UTC', actor: 'owner' });
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  ok(CLOUD_CLAIM_WAIT_NEEDS_YOU_MS === 2 * 60 * 60_000, 'the escalation threshold is 2 hours');

  await createPost({ campaign: CAMP, post: { id: 'p-wait', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p-wait', actor: 'owner' });
  const s0 = loadState();
  s0.cloudAccepted = { ...(s0.cloudAccepted || {}), [KEY]: { jobId: `${CLIENT}:${KEY}`, at: '2020-01-01T00:10:00.000Z' } };
  saveState();

  // --- a fresh hold: still the plain overdue state, no failure ------------------------
  claim401 = true; // the cloud answers, but with no verdict (revoked key)
  await runDueExclusive('scheduler');
  ok(derived().status !== 'posted', 'the acked post is held (claim answered 401, no verdict)');
  ok(Boolean((loadState().cloudClaimWait || {})[KEY]), 'the hold streak started');
  ok(derived().lastFailure === null && derived().derivedState === 'overdue', 'a hold younger than the threshold reads plain overdue, no needs-you');

  // --- the hold outlasts the threshold: needs you, with the cloud action --------------
  ageStreak(CLOUD_CLAIM_WAIT_NEEDS_YOU_MS + 60_000);
  await runDueExclusive('scheduler');
  ok(derived().status !== 'posted', 'past the threshold the post is STILL never fired locally');
  const f = derived().lastFailure;
  ok(f && f.recovery === 'cloud' && f.code === 'cloud_unanswered' && f.lane === 'meta', 'lastFailure names the cloud as the thing to check (recovery cloud)');
  ok(f && f.terminal === true && f.halted === false, 'it is terminal (no retry lands it on its own) and not a lane halt');
  ok(derived().derivedState === 'publish-failed', 'the post reads publish-failed, which the Studio shows as Waiting on you (recovery set)');
  ok(f && !/ - |\u2014/.test(f.message || ''), 'the message carries no dash glyphs');

  // --- the cloud answers: the streak ends and the escalation goes away -----------------
  claim401 = false;
  await runDueExclusive('scheduler');
  ok(derived().status === 'posted', 'once the cloud grants the claim the backstop fires as before');
  ok(!((loadState().cloudClaimWait || {})[KEY]), 'the verdict ended the hold streak');

  // --- a reschedule restarts the escalation clock, never the hold itself -------------
  // Round-2 critic LOW 2: reschedule did not clear state.cloudClaimWait, so a streak older
  // than 2 h made the post read cloud_unanswered (publish-now hidden) right after the owner
  // rescheduled it while the cloud was healthy again. The streak must reset; the hold
  // evidence (cloudEverAcked) must survive, so the round-1 duplicate stays impossible.
  const K2 = `${CAMP}:p-move:meta`;
  const derived2 = () => loadPlanStore().campaigns.find((c) => c.id === CAMP).posts.find((p) => p.id === 'p-move');
  await createPost({ campaign: CAMP, post: { id: 'p-move', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'another quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p-move', actor: 'owner' });
  const s2 = loadState();
  s2.cloudAccepted = { ...(s2.cloudAccepted || {}), [K2]: { jobId: `${CLIENT}:${K2}`, at: '2020-01-01T00:10:00.000Z' } };
  saveState();
  claim401 = true;
  await runDueExclusive('scheduler');
  const s3 = loadState();
  s3.cloudClaimWait[K2].since = new Date(Date.now() - CLOUD_CLAIM_WAIT_NEEDS_YOU_MS - 60_000).toISOString();
  saveState();
  ok(derived2().lastFailure && derived2().lastFailure.code === 'cloud_unanswered', 'p-move: a streak past 2 h reads cloud_unanswered');
  const moved = await reschedulePost({ campaign: CAMP, postId: 'p-move', scheduledAt: new Date().toISOString(), confirm: true, actor: 'owner' });
  ok(moved && moved.ok === true, 'the owner rescheduled the post to now');
  ok(!((loadState().cloudClaimWait || {})[K2]), 'the reschedule ended the hold streak (escalation clock reset)');
  ok(Boolean((loadState().cloudEverAcked || {})[K2]), 'the hold evidence (cloudEverAcked) survives the reschedule');
  claim401 = false; // the cloud is healthy again
  await runDueExclusive('scheduler'); // one tick inside the fresh grace window
  ok(!(derived2().lastFailure && derived2().lastFailure.code === 'cloud_unanswered'), 'right after the reschedule, with the cloud healthy, the post does NOT read cloud_unanswered');
  ok(derived2().status !== 'posted', 'and inside the grace it is still the cloud\'s to fire (no local fire)');

  console.log(`[cloud-claim-wait-needs-you] OK: a hold past 2 h reads as needing the owner, never fires, clears on the cloud's answer (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
