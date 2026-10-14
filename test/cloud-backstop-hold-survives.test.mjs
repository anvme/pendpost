#!/usr/bin/env node
// test/cloud-backstop-hold-survives.test.mjs - the fail-closed backstop hold must
// survive the owner's own reactions to a late post (critic finding 1, 2026-10-14).
//
// reschedulePost wipes state.cloudAccepted / cloudRetriggered for the post but never
// tells the cloud, so the cloud keeps the job at its old time. Before the fix the
// critic reproduced: acked post + cloud unreachable -> tick 1 holds (one wait row) ->
// reschedule to the same slot -> tick 2 "the cloud never acknowledged this job ...
// backstop proceeds unclaimed" -> fires locally = the 2026-10-12 duplicate.
// The evidence "the cloud may still fire this" now lives in state.cloudEverAcked,
// which only reconcile (post seen posted / terminal refusal) clears.
//
// Cases:
//   1. the critic's exact repro (reschedule to the same scheduledAt) -> still held.
//   2. edit + re-approve on an always-on brand -> still held.
//   3. edit while the brand is paused (pruneCloudMarkers reaps the non-open post's
//      ack), re-approve, brand back on -> still held.
// Mock mode + a mocked global.fetch; no network, no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-holdsurvives-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost, reschedulePost, updatePost } = await import('../lib/writes.mjs');
const { loadPlanStore, postRev } = await import('../lib/plans.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive, getActivity } = await import('../lib/scheduler.mjs');

const CAMP = 'holdsurvives-2026-10';
const CLIENT = activeClientId();
const SLOT = '2020-01-01T00:00:00.000Z';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// cloudDown=true: every cloud call throws (CloudError network_error). While up, the
// push acks every job and the claim is denied (live cloud lease), so nothing fires
// locally during setup.
let cloudDown = false;
function installFetch() {
  global.fetch = async (input, init) => {
    if (cloudDown) throw new TypeError('fetch failed');
    const url = String(input);
    const method = (init && init.method) || 'GET';
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/publish-claim') && method === 'POST') return json({ granted: false, consumed: false, externalId: null, holder: 'cloud' });
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
    if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
    if (url.endsWith('/v1/sync/push') && method === 'POST') {
      const body = JSON.parse(init.body);
      return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
    }
    if (url.includes('/v1/sync/results')) return json({ results: [] });
    if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
    if (url.includes('/v1/brands') && method === 'PUT') return json({ ok: true });
    if (url.endsWith('/v1/sync/retrigger') && method === 'POST') return json({ requeued: [], skipped: [] });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);
const waitRows = (postId) => getActivity(300).filter((e) => e.postId === postId && e.action === 'cloud-claim-wait');
const fired = (postId, res) => readPost(postId).status === 'posted' || res.ran.some((r) => r.postId === postId && r.ok);

// A due post the cloud ACKNOWLEDGED: pushed while the cloud is up (the real ack path,
// not a seeded record), then its ack is aged past the grace so the backstop reaches
// the claim gate on the next tick.
async function addAckedReel(postId) {
  cloudDown = false;
  await createPost({ campaign: CAMP, post: { id: postId, type: 'reel', platforms: ['instagram'], scheduledAt: SLOT, path: 'data/media/clip.mp4', caption: `a quiet clip ${postId}` }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId, actor: 'owner' });
  if (!planAbs) planAbs = path.resolve(WS, loadPlanStore().campaigns.find((cc) => cc.id === CAMP).path);
  await cloud.pushApprovedJobs();
  const { saveState } = await import('../lib/state.mjs');
  const s = loadState();
  ok(Boolean(s.cloudAccepted && s.cloudAccepted[`${CAMP}:${postId}:meta`]), `${postId}: the cloud acknowledged the push (real ack path)`);
  s.cloudAccepted[`${CAMP}:${postId}:meta`].at = '2020-01-01T00:10:00.000Z';
  saveState();
}

async function holdOnce(postId, label) {
  cloudDown = true;
  const t = await runDueExclusive('scheduler');
  ok(!fired(postId, t), `${label}: the acked post is held while the cloud cannot answer the claim`);
  ok(waitRows(postId).length >= 1, `${label}: the hold is surfaced as a cloud-claim-wait row`);
}

try {
  await createCampaign({ id: CAMP, note: 'hold survives owner reactions', timezone: 'UTC', actor: 'owner' });
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);

  // --- (1) the critic's exact repro: reschedule to the SAME slot ----------------------
  await addAckedReel('p-resched');
  await holdOnce('p-resched', 'tick 1');
  ok(waitRows('p-resched').length === 1, 'tick 1 wrote exactly one wait row');
  const r = await reschedulePost({ campaign: CAMP, postId: 'p-resched', scheduledAt: SLOT, confirm: true, actor: 'owner' });
  ok(r && r.ok === true, 'reschedulePost to the same slot succeeded');
  ok(!((loadState().cloudAccepted || {})[`${CAMP}:p-resched:meta`]), 'reschedule wiped the push-ack (the cloud was not told; it still holds the old job)');
  const t2 = await runDueExclusive('scheduler');
  ok(!fired('p-resched', t2), 'tick 2 after the reschedule STILL holds: no local fire while the cloud may still publish the old job');

  // --- (2) edit + re-approve on an always-on brand ------------------------------------
  await addAckedReel('p-edit');
  await holdOnce('p-edit', 'edit variant');
  const u = await updatePost({ campaign: CAMP, postId: 'p-edit', ifRev: postRev(readPost('p-edit')), fields: { caption: 'a quiet clip, edited' }, actor: 'owner' });
  ok(u && u.ok === true, 'the owner edited the held post');
  await approvePost({ campaign: CAMP, postId: 'p-edit', actor: 'owner' });
  const t3 = await runDueExclusive('scheduler');
  ok(!fired('p-edit', t3), 'after edit + re-approve the post is STILL held (the cloud still has a job for it)');

  // --- (3) edit while paused (prune reaps the ack), re-approve, brand back on ---------
  await addAckedReel('p-paused');
  await holdOnce('p-paused', 'paused variant');
  const u2 = await updatePost({ campaign: CAMP, postId: 'p-paused', ifRev: postRev(readPost('p-paused')), fields: { caption: 'a quiet clip, edited while paused' }, actor: 'owner' });
  ok(u2 && u2.ok === true, 'the owner edited the held post');
  setBrandAlwaysOn(CLIENT, false);
  await runDueExclusive('scheduler'); // paused tick: pruneCloudMarkers reaps the non-open post's markers
  ok(!((loadState().cloudAccepted || {})[`${CAMP}:p-paused:meta`]), 'the paused tick pruned the edited (non-open) post\'s push-ack');
  await approvePost({ campaign: CAMP, postId: 'p-paused', actor: 'owner' });
  setBrandAlwaysOn(CLIENT, true);
  const t4 = await runDueExclusive('scheduler');
  ok(!fired('p-paused', t4), 'after the prune, re-approve and resume the post is STILL held');

  console.log(`[cloud-backstop-hold-survives] OK: the hold survives reschedule, edit + re-approve and a paused prune (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
