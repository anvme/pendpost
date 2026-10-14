#!/usr/bin/env node
// test/plans-lastfailure-newest.test.mjs - the NEWER failure speaks.
//
// lastFailureFor (surfaced as post.lastFailure by normalizePost) has two sources: the
// cloud's state.cloudFailures entry and the local engine's attempt / publishHold. It used
// to prefer the cloud message unconditionally, so a post the cloud failed at 16:17Z and the
// local engine failed again at 16:30Z showed the stale 16:17 cloud message in the post
// detail. Contract:
//   1. Cloud at T, local attempt at T+13min -> the local message, code and `at` win.
//   2. Local attempt at T, cloud at T+13min -> the cloud message, code and `at` win.
//   3. Cloud at T, a local publishHold stamped at T+13min (no attempt row) -> the hold wins.
//   4. lane / terminal are unchanged by which message is displayed.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-lastfail-newest-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { normalizePost } = await import('../lib/plans.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const planEntry = { id: 'camp' };
const plan = { timezone: 'UTC' };
const PAST = '2026-09-29T16:00:00Z';
const EARLY = '2026-09-29T16:17:00Z';
const LATE = '2026-09-29T16:30:00Z';
const CLOUD_MSG = 'instagram: HTTP 500 - internal error';
const LOCAL_MSG = 'HTTP 400 {"debug_info":{"retriable":false,"type":"ProcessingFailedError","message":"Request processing failed"}}';
const post = (id, extra = {}) => ({
  id, type: 'reel', platforms: ['instagram'], approval: 'approved', scheduledAt: PAST, caption: 'a short honest note', ...extra,
});
const attempt = (ts) => ({ ok: false, platform: 'instagram', action: 'publish', errorCode: 'engine_failure', errorMessage: LOCAL_MSG, ts });

try {
  const st = loadState();
  st.cloudFailures = {
    'camp:local-newer': { lane: 'instagram', message: CLOUD_MSG, at: EARLY, terminal: false },
    'camp:cloud-newer': { lane: 'instagram', message: CLOUD_MSG, at: LATE, terminal: false, refusedCode: 'account_unresolved' },
    'camp:hold-newer': { lane: 'instagram', message: CLOUD_MSG, at: EARLY, terminal: false },
  };
  saveState();

  let n = normalizePost(planEntry, plan, post('local-newer', { attempts: [attempt(LATE)] }));
  ok(n.lastFailure && n.lastFailure.message === LOCAL_MSG, `a local attempt newer than the cloud failure supplies the message (got ${n.lastFailure && n.lastFailure.message})`);
  ok(n.lastFailure.code === 'engine_failure', 'the newer local attempt supplies the code');
  ok(n.lastFailure.at === LATE, 'lastFailure.at is the newer local timestamp');
  ok(n.lastFailure.lane === 'instagram', 'lane unchanged');
  ok(n.lastFailure.terminal === false, 'terminal unchanged (no hold, no cloud cap)');

  n = normalizePost(planEntry, plan, post('cloud-newer', { attempts: [attempt(EARLY)] }));
  ok(n.lastFailure && n.lastFailure.message === CLOUD_MSG, `a cloud failure newer than the local attempt supplies the message (got ${n.lastFailure && n.lastFailure.message})`);
  ok(n.lastFailure.code === 'account_unresolved', `the newer cloud failure supplies the code (got ${n.lastFailure.code})`);
  ok(n.lastFailure.at === LATE, 'lastFailure.at is the newer cloud timestamp');

  n = normalizePost(planEntry, plan, post('hold-newer', { publishHold: { at: LATE, lane: 'instagram', code: 'engine_failure', message: LOCAL_MSG } }));
  ok(n.lastFailure && n.lastFailure.message === LOCAL_MSG, `a publishHold newer than the cloud failure supplies the message (got ${n.lastFailure && n.lastFailure.message})`);
  ok(n.lastFailure.code === 'engine_failure', 'the newer hold supplies the code');
  ok(n.lastFailure.terminal === true, 'a held post stays terminal');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
