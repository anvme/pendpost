#!/usr/bin/env node
// test/plans-lastfailure-future-cloud.test.mjs - data honesty D1.
//
// cloudSyncStatus (lib/cloud-client.mjs) already treats a cloudFailures entry for a post
// scheduled in the FUTURE as a stale job's echo, not a failure: the post is not due, so it
// cannot have failed to publish on time. lastFailureFor (surfaced as post.lastFailure by
// normalizePost) must apply the SAME rule, else the planner card and the post detail paint
// a red "telegram: sendMessage ..." on a future, approved post while the header popover
// says "all delivered" (judge pass 2, C4 / screenshot 21).
//
// Contract:
//   1. A cloud failure for a post whose scheduledAt is in the future -> lastFailure null.
//   2. The same cloud failure for a past-due post still surfaces (no regression).
//   3. A LOCAL failed attempt on a future post is untouched by this rule (only the cloud
//      half is a replayed history that can arrive after a reschedule).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-lastfail-future-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { normalizePost } = await import('../lib/plans.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const planEntry = { id: 'camp' };
const plan = { timezone: 'UTC' };
const FUTURE = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
const PAST = '2020-01-01T00:00:00Z';
const post = (id, scheduledAt, extra = {}) => ({
  id, type: 'text', platforms: ['telegram'], approval: 'approved', scheduledAt, caption: 'a short honest note', ...extra,
});

try {
  const st = loadState();
  st.cloudFailures = {
    'camp:future': { lane: 'telegram', message: 'telegram: sendMessage: HTTP 500', at: '2026-09-20T10:00:00Z', terminal: false },
    'camp:past': { lane: 'telegram', message: 'telegram: sendMessage: HTTP 500', at: '2020-01-01T00:01:00Z', terminal: false },
  };
  saveState();

  let n = normalizePost(planEntry, plan, post('future', FUTURE));
  ok(n.lastFailure === null, `a cloud failure on a FUTURE post is stale, not a failure (got ${JSON.stringify(n.lastFailure)})`);

  n = normalizePost(planEntry, plan, post('past', PAST));
  ok(n.lastFailure && n.lastFailure.lane === 'telegram', 'the same cloud failure on a PAST-DUE post still surfaces');
  ok(n.lastFailure && /sendMessage/.test(n.lastFailure.message), 'the past-due failure keeps its platform message');

  // A past-due cloud CREDENTIAL refusal carries its refusedCode as lastFailure.code, so the
  // card can name the cause ("no connected LinkedIn account") instead of a generic refusal.
  { const s = loadState(); s.cloudFailures['camp:cred'] = { lane: 'linkedin', message: 'Nothing was published: ...', refusedCode: 'account_unresolved', at: '2020-01-01T00:01:00Z' }; saveState(); }
  n = normalizePost(planEntry, plan, post('cred', PAST, { platforms: ['linkedin'] }));
  ok(n.lastFailure && n.lastFailure.code === 'account_unresolved', `a cloud credential refusal surfaces its refusedCode as lastFailure.code (got ${n.lastFailure && n.lastFailure.code})`);

  const localFailing = post('future-local', FUTURE, {
    attempts: [{ ok: false, platform: 'telegram', errorCode: 'invalid_input', errorMessage: 'caption too long', ts: '2026-09-20T10:00:00Z' }],
  });
  n = normalizePost(planEntry, plan, localFailing);
  ok(n.lastFailure && n.lastFailure.code === 'invalid_input', 'a LOCAL failed attempt on a future post still surfaces (rule is cloud-only)');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
