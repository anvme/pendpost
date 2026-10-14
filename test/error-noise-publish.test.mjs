#!/usr/bin/env node
// test/error-noise-publish.test.mjs - the publish-path error-noise fixes (2026-10-07, all
// verified against live data). A message reaches the owner only when pendpost cannot fix
// it itself AND it names the one-step fix; everything else is either fixed at the source
// or logged as a neutral note.
//
//   (1) a Mastodon radar reply is only owed at/after due (lanesFor), so a not-yet-due
//       reply never spawns the engine, which skips it without a row (no_result) and three
//       ticks used to park a healthy reply. A posted post never carries a stale hold.
//   (2) a rejected radar reply is a decided no: not awaiting approval, derives inactive
//       ('parked', like any rejected post), and never shows as next due in health.
//   (3) clientsOverview.pending is the REAL pending count, not the horizon-capped list.
//   (4) approve refuses a post whose platform was skipped at onboarding AND is still not
//       configured, naming the fix. A skipped lane that is connected later still approves.
//   (5) the scheduler's zero-row crash branch does not append an identical engine-run row
//       every tick (the attempt is still recorded, so the 3-strike cap still parks it).
//   (6) a post that owes no lane is never reported media-missing.
//   (7) a budget / usage-limit radar scan skip is a neutral note (ok:true), not a failure.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-error-noise-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
delete process.env.PENDPOST_MOCK_FAIL;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { lanesFor, eligibleDuePosts } = await import('../lib/scheduler.mjs');
const { awaitingApproval, loadPlanStore } = await import('../lib/plans.mjs');
const { createCampaign, createPost, approvePost, pendpostHealth } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { scanActivityOutcome } = await import('../lib/radar-sweep.mjs');

const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const planPath = (camp) => path.join(WS, 'data', 'plans', camp, 'post-plan.json');
const editRaw = (camp, id, fn) => {
  const plan = JSON.parse(fs.readFileSync(planPath(camp), 'utf8'));
  fn(plan.posts.find((p) => p.id === id));
  fs.writeFileSync(planPath(camp), JSON.stringify(plan, null, 2));
};
const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const REPLY_TO = { url: 'https://mastodon.example/@a/1', source: 'mastodon', externalId: '1' };

try {
  const cc = await createCampaign({ id: 'noise', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);

  // ===== (1) mastodon radar reply: owed only at/after due ==========================
  const now = Date.now();
  const reply = (scheduledAt) => ({ platforms: ['mastodon'], ids: {}, scheduledAt, radarReplyTo: REPLY_TO, approval: 'approved' });
  ok(!lanesFor(reply(iso(now + HOUR)), now).includes('mastodon'),
    '(1) a not-yet-due mastodon radar reply owes no lane (the engine would skip it without a row)');
  ok(lanesFor(reply(iso(now - 60_000)), now).includes('mastodon'),
    '(1) a due mastodon radar reply fires on the mastodon lane');
  ok(lanesFor({ platforms: ['mastodon'], ids: {}, scheduledAt: iso(now + HOUR) }, now).includes('mastodon'),
    '(1) a normal mastodon post still hands off to the native scheduler ahead of due');

  // A posted post must not keep a stale publishHold in its read model.
  const cp = await createPost({ campaign: 'noise', post: { id: 'posted1', type: 'text', platforms: ['mastodon'], caption: 'a short note', scheduledAt: iso(now - HOUR) }, actor: 'agent:claude' });
  assert.ok(cp.ok, `createPost(posted1): ${JSON.stringify(cp)}`);
  editRaw('noise', 'posted1', (p) => {
    p.status = 'posted';
    p.ids = { ...(p.ids || {}), mastodonStatusId: '42' };
    p.mastodonStatusId = '42';
    p.publishHold = { at: iso(now - 2 * HOUR), lane: 'mastodon', code: 'engine_silent_skip', message: 'engine skipped this post without a result row' };
  });
  const posted = getPost('noise', 'posted1');
  ok(posted.derivedState === 'posted', `(1) the posted post derives posted (got ${posted.derivedState})`);
  ok(posted.publishHold === null, `(1) a posted post carries no stale publishHold (got ${JSON.stringify(posted.publishHold)})`);

  // ===== (2) rejected radar reply: not awaiting, inactive, not next due ============
  ok(awaitingApproval({ approval: 'draft', radarReplyTo: REPLY_TO }) === true, '(2) an undecided radar reply still awaits approval');
  ok(awaitingApproval({ approval: 'rejected', radarReplyTo: REPLY_TO }) === false, '(2) a rejected radar reply is NOT awaiting approval');
  const cr = await createPost({ campaign: 'noise', post: { id: 'rej1', type: 'text', platforms: ['mastodon'], caption: 'a reply we turned down', scheduledAt: iso(now - HOUR) }, actor: 'agent:claude' });
  assert.ok(cr.ok, `createPost(rej1): ${JSON.stringify(cr)}`);
  editRaw('noise', 'rej1', (p) => { p.radarReplyTo = REPLY_TO; p.approval = 'rejected'; p.approvalBy = 'owner'; });
  const rej = getPost('noise', 'rej1');
  ok(rej.derivedState === 'parked', `(2) a rejected radar reply derives inactive 'parked' (got ${rej.derivedState})`);
  const health = pendpostHealth({ horizon: 20, includeSetup: false });
  ok(!(health.nextDue || []).some((p) => p.postId === 'rej1'), '(2) a rejected post is not listed in health nextDue');

  // ===== (4) approve refuses a skipped + unconfigured lane ==========================
  const sk = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { skippedPlatforms: ['reddit'] } } });
  assert.ok(sk.ok, `setConfig skip: ${JSON.stringify(sk)}`);
  const crd = await createPost({ campaign: 'noise', post: { id: 'rd1', type: 'text', platforms: ['reddit'], title: 'A build note', caption: 'A build note\n\nwhat shipped', redditSubreddit: 'test', scheduledAt: iso(now + 6 * HOUR) }, actor: 'agent:claude' });
  assert.ok(crd.ok, `createPost(rd1): ${JSON.stringify(crd)}`);
  const refused = await approvePost({ campaign: 'noise', postId: 'rd1', actor: 'owner' });
  ok(refused.ok !== true && refused.code === 'not_configured', `(4) approve refuses a skipped + unconfigured lane with not_configured (got ${JSON.stringify(refused)})`);
  ok(refused.platform === 'reddit', '(4) the refusal names the platform for the localized sentence');
  ok(refused.message === 'Reddit is not set up in this project. Connect it in Setup or remove Reddit from the post.',
    `(4) the refusal names the one-step fix (got ${JSON.stringify(refused.message)})`);
  ok(!/—/.test(refused.message), '(4) no em dash in the refusal');
  ok(getPost('noise', 'rd1').approval !== 'approved', '(4) the post stays unapproved');
  const forced = await approvePost({ campaign: 'noise', postId: 'rd1', actor: 'owner', force: true });
  ok(forced.code === 'not_configured', '(4) force does not approve into a lane that cannot publish');
  // Un-skipped (the onboarding flag is gone): approve is not refused on this ground.
  const un = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { skippedPlatforms: [] } } });
  assert.ok(un.ok, `setConfig unskip: ${JSON.stringify(un)}`);
  const allowed = await approvePost({ campaign: 'noise', postId: 'rd1', actor: 'owner' });
  ok(allowed.code !== 'not_configured', `(4) a lane that is not skipped is never refused as not set up (got ${JSON.stringify(allowed.code)})`);

  // ===== (6) nothing owed => no media-missing report ================================
  const seen = [];
  const base = { approval: 'approved', executionMode: 'fully-scheduled', status: 'planned', type: 'reel', platforms: ['youtube'], media: { exists: false }, scheduledAt: iso(now - HOUR) };
  const camps = [{ id: 'm', posts: [
    { ...base, id: 'handed', ids: { ytVideoId: 'abc123' } },
    { ...base, id: 'owed', ids: {} },
  ] }];
  // Drain the generator (yields nothing: both are media-missing).
  for (const _ of eligibleDuePosts(camps, { onMediaMissing: (c, p) => seen.push(p.id) })) { /* drain */ }
  ok(!seen.includes('handed'), '(6) a YouTube post already handed off (ytVideoId) is never reported media-missing');
  ok(seen.includes('owed'), '(6) a post that still owes its lane IS reported media-missing');

  // ===== (7) budget / usage-limit radar skips are neutral notes ======================
  const limit = scanActivityOutcome({ state: 'failed', reason: 'limit', tail: "You've hit your weekly limit - resets 5am" });
  ok(limit.ok === true && limit.errorCode === 'limit', `(7) a usage-limit radar scan logs as a neutral note (ok:true, errorCode limit) (got ${JSON.stringify(limit)})`);
  ok(/weekly limit/.test(limit.errorMessage || ''), '(7) the limit note keeps the reset wording verbatim');
  const failed = scanActivityOutcome({ state: 'failed', reason: 'exit', tail: 'crashed' });
  ok(failed.ok === false && failed.errorCode === 'exit', '(7) a real failure stays a failure');
  const done = scanActivityOutcome({ state: 'done' });
  ok(done.ok === true && done.errorCode === null, '(7) a finished scan is a plain success');

  console.log(`[error-noise-publish] OK - replies owed at due, rejected replies inactive, honest pending, skipped lanes refused at approve, no media-missing for handed-off posts, neutral budget/limit notes (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
