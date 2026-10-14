#!/usr/bin/env node
// test/cloud-backstop-prune-unreadable.test.mjs - a paused-brand prune must never reap
// the fail-closed hold evidence because the plan store could not be read (round-2 critic,
// LOW 1, 2026-10-14).
//
// pruneCloudMarkers keys every reap on loadPlanStore. With active-plans.json (or a plan
// file) unreadable the store has no posts, so before the fix the prune treated EVERY post
// as gone and deleted cloudEverAcked, cloudClaimWait and the round-trip markers. Repro:
// acked + held post, brand paused, manifest unreadable for one paused tick, file restored,
// brand back on, cloud down: the resume tick failed open and fired. The prune now skips
// entirely while the manifest or any plan file is unreadable.
// Mock mode + a mocked global.fetch; no network, no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-pruneunreadable-'));
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

const CAMP = 'pruneunreadable-2026-10';
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
  await createCampaign({ id: CAMP, note: 'prune must not reap on an unreadable store', timezone: 'UTC', actor: 'owner' });
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);

  // --- (1) unreadable MANIFEST for one paused tick ------------------------------------
  await addAckedReel('p-manifest');
  await holdOnce('p-manifest', 'held');
  const manifest = path.join(WS, 'data', 'plans', 'active-plans.json');
  const good = fs.readFileSync(manifest, 'utf8');
  setBrandAlwaysOn(CLIENT, false);
  fs.writeFileSync(manifest, '{ not json');
  await runDueExclusive('scheduler'); // paused tick: the prune runs against an unreadable store
  fs.writeFileSync(manifest, good);
  const s1 = loadState();
  ok(Boolean((s1.cloudEverAcked || {})[`${CAMP}:p-manifest:meta`]), 'the unreadable-manifest tick did NOT reap the ever-acked evidence');
  ok(Boolean((s1.cloudClaimWait || {})[`${CAMP}:p-manifest:meta`]), 'nor the hold streak');
  setBrandAlwaysOn(CLIENT, true);
  cloudDown = true;
  const t1 = await runDueExclusive('scheduler');
  ok(!fired('p-manifest', t1), 'after the file is back and the brand resumes, the acked post is STILL held (no fail-open fire)');

  // --- (2) unreadable PLAN FILE for one paused tick -----------------------------------
  await addAckedReel('p-planfile');
  await holdOnce('p-planfile', 'held');
  const good2 = fs.readFileSync(planAbs, 'utf8');
  setBrandAlwaysOn(CLIENT, false);
  fs.writeFileSync(planAbs, '{ not json');
  await runDueExclusive('scheduler');
  fs.writeFileSync(planAbs, good2);
  ok(Boolean((loadState().cloudEverAcked || {})[`${CAMP}:p-planfile:meta`]), 'the unreadable-plan-file tick did NOT reap the ever-acked evidence');
  setBrandAlwaysOn(CLIENT, true);
  cloudDown = true;
  const t2 = await runDueExclusive('scheduler');
  ok(!fired('p-planfile', t2), 'after the plan file is back the acked post is STILL held');

  console.log(`[cloud-backstop-prune-unreadable] OK: an unreadable store never reaps the hold evidence (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
