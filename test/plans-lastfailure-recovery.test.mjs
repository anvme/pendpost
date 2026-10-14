#!/usr/bin/env node
// test/plans-lastfailure-recovery.test.mjs - retry honesty.
//
// A failure that no retry can fix must never read as "Wird wiederholt" (retrying), and
// the post detail must never offer a publish that will be refused again. The engine owns
// that classification (lib/publish-hold.mjs failureRecovery) and exposes it on
// post.lastFailure, so the Studio reads it instead of re-deriving it:
//   - recovery: 'reconnect' | 'edit' | 'manual' | null - the ONE thing that recovers it
//   - terminal: true whenever recovery is set (nothing will succeed on its own)
//
// Contract:
//   1. A cloud CREDENTIAL refusal (refusedCode) -> recovery 'reconnect', terminal true,
//      even before any re-fire cap is spent.
//   2. An X reply-restriction refusal (either phrasing, cloud or local) -> 'manual'.
//   3. A content block (CONTENT_BLOCK_CODES) or an X duplicate -> 'edit'.
//   4. A transient platform failure -> recovery null, terminal false (still retrying).
//   5. A confirmed-dead media URL keeps recovery null (re-mirror, then retry works).
//   6. A LOCAL credential failure (needs_scope, HTTP 401, invalid_grant, a missing .env
//      credential) -> 'reconnect', terminal on the FIRST attempt (owner decision
//      2026-09-25: a retry cannot fix a revoked token). X's reply restriction, recorded
//      as needs_scope, still maps to 'manual' (test/publish-hold-credential.test.mjs has
//      the full classifier matrix).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-lastfail-recovery-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { normalizePost } = await import('../lib/plans.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { failureRecovery, isTerminalRefusal } = await import('../lib/publish-hold.mjs');
const { MEDIA_URL_DEAD_MARK } = await import('../lib/public-media.mjs');

const planEntry = { id: 'camp' };
const plan = { timezone: 'UTC' };
const PAST = '2020-01-01T00:00:00Z';
const post = (id, extra = {}) => ({
  id, type: 'text', platforms: ['linkedin'], approval: 'approved', scheduledAt: PAST, caption: 'a short honest note', ...extra,
});
const attempt = (platform, errorCode, errorMessage) => ({ ok: false, platform, action: 'publish', errorCode, errorMessage, ts: '2020-01-01T00:02:00Z' });

const X_REPLY_A = 'X POST /tweets: HTTP 403 - You can only reply to or quote posts where you are mentioned or are the author.';
const X_REPLY_B = 'x: POST /2/tweets: HTTP 403 - Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged by the author.';

try {
  // --- the classifier itself -------------------------------------------------------------
  ok(failureRecovery({ refusedCode: 'account_unresolved' }) === 'reconnect', 'account_unresolved -> reconnect');
  ok(failureRecovery({ refusedCode: 'account_mismatch' }) === 'reconnect', 'account_mismatch -> reconnect');
  ok(failureRecovery({ code: 'needs_scope', message: X_REPLY_A }) === 'manual', 'X reply restriction (mentioned phrasing) -> manual, even under needs_scope');
  ok(failureRecovery({ message: X_REPLY_B }) === 'manual', 'X reply restriction (conversation phrasing) -> manual');
  ok(failureRecovery({ code: 'invalid_input', message: 'tweet is 300 chars' }) === 'edit', 'a content block code -> edit');
  ok(failureRecovery({ code: 'engine_failure', message: 'X POST /tweets: HTTP 403 - duplicate content' }) === 'edit', 'an X duplicate -> edit');
  ok(failureRecovery({ code: 'engine_failure', message: 'linkedin: HTTP 503' }) === null, 'a transient failure has no operator recovery');
  ok(failureRecovery({ code: 9004, message: `media fetch failed ${MEDIA_URL_DEAD_MARK}` }) === null, 'a dead media URL keeps the retry path (re-mirror, then retry)');
  ok(failureRecovery(null) === null, 'no failure -> null');
  // The second X phrasing parks on the first strike too (same permanent refusal).
  ok(isTerminalRefusal({ ok: false, errorCode: 'engine_failure', errorMessage: X_REPLY_B }) === true, 'the conversation phrasing of the X reply restriction is a terminal refusal');

  // --- surfaced on post.lastFailure ------------------------------------------------------
  const st = loadState();
  st.cloudFailures = {
    'camp:cred': { lane: 'linkedin', message: 'Nothing was published: ...', refusedCode: 'account_unresolved', at: '2020-01-01T00:01:00Z' },
    'camp:xreply-cloud': { lane: 'x', message: X_REPLY_B, at: '2020-01-01T00:01:00Z', terminal: false },
    'camp:transient': { lane: 'linkedin', message: 'linkedin: POST /rest/posts: HTTP 500', at: '2020-01-01T00:01:00Z', terminal: false },
  };
  saveState();

  let n = normalizePost(planEntry, plan, post('cred'));
  ok(n.lastFailure.recovery === 'reconnect', `a cloud credential refusal asks for a reconnect (got ${n.lastFailure.recovery})`);
  ok(n.lastFailure.terminal === true, 'a cloud credential refusal is terminal: nothing succeeds until the operator reconnects');

  n = normalizePost(planEntry, plan, post('xreply-cloud', { platforms: ['x'] }));
  ok(n.lastFailure.recovery === 'manual' && n.lastFailure.terminal === true, 'a cloud-fired X reply refusal is terminal with a manual recovery');

  n = normalizePost(planEntry, plan, post('transient'));
  ok(n.lastFailure.recovery === null && n.lastFailure.terminal === false, 'a transient cloud failure still reads as retrying (recovery null, terminal false)');

  n = normalizePost(planEntry, plan, post('xreply-local', { platforms: ['x'], attempts: [attempt('x', 'needs_scope', X_REPLY_A)] }));
  ok(n.lastFailure.recovery === 'manual' && n.lastFailure.terminal === true, 'a local X reply refusal is terminal with a manual recovery');

  n = normalizePost(planEntry, plan, post('block-local', { platforms: ['x'], attempts: [attempt('x', 'invalid_input', 'tweet is 300 chars')] }));
  ok(n.lastFailure.recovery === 'edit' && n.lastFailure.terminal === true, 'a local content block is terminal with an edit recovery');

  // --- local credential failures: reconnect-first ---------------------------------------
  n = normalizePost(planEntry, plan, post('scope-local', { attempts: [attempt('linkedin', 'needs_scope', 'LinkedIn POST /rest/posts: HTTP 403 ACCESS_DENIED - missing w_organization_social')] }));
  ok(n.lastFailure.recovery === 'reconnect' && n.lastFailure.terminal === true, `a local needs_scope failure asks for a reconnect on the first attempt (got ${n.lastFailure.recovery}, terminal ${n.lastFailure.terminal})`);
  ok(n.derivedState === 'publish-failed', `a local credential failure derives publish-failed (got ${n.derivedState})`);

  n = normalizePost(planEntry, plan, post('revoked-local', { platforms: ['x'], attempts: [attempt('x', 'engine_failure', 'X POST /tweets: HTTP 401 - Unauthorized')] }));
  ok(n.lastFailure.recovery === 'reconnect' && n.lastFailure.terminal === true, 'a local revoked token (HTTP 401) asks for a reconnect');

  n = normalizePost(planEntry, plan, post('missing-local', { platforms: ['reddit'], attempts: [attempt('reddit', 'engine_failure', 'Reddit credentials missing in .env: REDDIT_CLIENT_ID')] }));
  ok(n.lastFailure.recovery === 'reconnect', 'missing local credentials ask for a reconnect');

  n = normalizePost(planEntry, plan, post('server-local', { attempts: [attempt('linkedin', 'engine_failure', 'LinkedIn POST /rest/posts: HTTP 500 - internal error')] }));
  ok(n.lastFailure.recovery === null && n.lastFailure.terminal === false, 'a local 5xx still reads as retrying (recovery null, terminal false)');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
