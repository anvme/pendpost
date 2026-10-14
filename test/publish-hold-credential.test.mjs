#!/usr/bin/env node
// test/publish-hold-credential.test.mjs - a LOCAL credential failure is reconnect-first.
//
// Owner decision (2026-09-25): a failure caused by the lane's own credential (a revoked or
// expired token the engine's own refresh could not renew, a missing scope, a missing .env
// credential) is TERMINAL on the FIRST failure with recovery 'reconnect'. A retry cannot fix
// a revoked token, so the 3-strike cap only burned two more calls and kept the post reading
// "Wird wiederholt" while the operator was the only one who could act.
//
// The classifier keys off what the engines ACTUALLY record (every engine's api() formats
// "<Lane> <METHOD> <path>: HTTP <status> - ...", the OAuth token exchange "OAuth
// refresh_token: HTTP 400 invalid_grant - ...", requireEnv "<VAR> missing in .env", the
// ensureFreshToken throws, reddit's "Reddit credentials missing in .env", Meta's
// OAuthException 190). Transient failures (network during a refresh, 429, 5xx) keep their
// existing backoff / cap, and X's reply restriction (recorded as needs_scope) stays 'manual'.
//
// (a) classifier: positives from real engine message shapes, negatives that must not park.
// (b) recordAttempt parks a credential failure on the FIRST strike; transient ones do not.
// (c) failureRecovery -> 'reconnect' (X reply restriction still 'manual').
// (d) a FORCED passing recheck of the lane (Setup polls it after a reconnect) releases the
//     credential holds on that lane - and only those - so the reconnected post goes out
//     instead of waiting on a reconnect that already happened. A background sweep does not.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-hold-cred-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_FAIL;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

// A probe stub for the X lane: prints the engines' last-line envelope with a passing probe.
const PROBE_STUB = path.join(WS, 'x-probe-stub.mjs');
fs.writeFileSync(PROBE_STUB, "console.log(JSON.stringify({ ok: true, results: [{ platform: 'x', action: 'probe', ok: true, detail: 'stub account' }] }));\n");
process.env.PENDPOST_X_ENGINE = PROBE_STUB;

const { recordAttempt, isTerminalRefusal, isCredentialFailure, failureRecovery } = await import('../lib/publish-hold.mjs');
const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { mutatePlan, resolvePlanPath } = await import('../lib/planWrite.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { probeAll } = await import('../lib/health.mjs');

const row = (errorCode, errorMessage, platform = 'x') => ({ ts: new Date().toISOString(), platform, action: 'publish', ok: false, errorCode, errorMessage });

const X_REPLY = 'X POST /tweets: HTTP 403 - You can only reply to or quote posts where you are mentioned or are the author.';

// Positives: the shapes the engines record for a credential the operator has to renew.
const CREDENTIAL = [
  // bluesky-social.mjs:227 createRecord 401/403 -> needs_scope
  ['needs_scope', 'bluesky createRecord HTTP 401'],
  // bluesky-social.mjs:204 / nostr-social.mjs:1958 not configured -> needs_scope
  ['needs_scope', 'BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set'],
  // reddit-social.mjs:759 token mint refused -> needs_scope
  ['needs_scope', 'Reddit token mint failed: HTTP 401 - invalid_grant'],
  // linkedin-social.mjs:784 member author without the member scope -> needs_scope
  ['needs_scope', 'liAuthor=member requires LINKEDIN_PERSON_URN - reconnect LinkedIn with the member scope (node scripts/linkedin-social.mjs auth)'],
  // x-social.mjs:267 api() on a revoked token -> engine_failure with HTTP 401
  ['engine_failure', 'X POST /tweets: HTTP 401 - Unauthorized'],
  // telegram-social.mjs:104 a revoked bot token
  ['engine_failure', 'Telegram sendMessage: HTTP 401 - Unauthorized'],
  // mastodon-social.mjs:181 a revoked app token
  ['engine_failure', 'Mastodon POST /api/v1/statuses: HTTP 401 - The access token was revoked'],
  // meta-social.mjs:147 + :149 fbCode 190 (expired / invalidated session)
  [190, 'Graph POST /123/feed: HTTP 400 OAuthException 190 - Error validating access token: Session has expired on Friday.'],
  // pinterest-social.mjs:184 / yt-social.mjs:128 refresh refused inside ensureFreshToken
  ['engine_failure', "OAuth refresh_token: HTTP 400 invalid_grant - Token has been expired or revoked. - the refresh token is expired/revoked. Re-run 'node scripts/pinterest-social.mjs auth'."],
  // x-social.mjs:237 refresh failed for a non-network reason
  ['engine_failure', "X token refresh failed (OAuth refresh_token: HTTP 400 invalid_request - Value passed for the token was invalid.). The refresh token likely expired or was rotated out - re-run 'node scripts/x-social.mjs auth'."],
  // x-social.mjs:226 expired with no refresh token stored
  ['engine_failure', "X access token expired and no refresh token is stored - re-run 'node scripts/x-social.mjs auth'."],
  // linkedin-social.mjs:171 nothing stored
  ['engine_failure', "No LINKEDIN_ACCESS_TOKEN - run 'node scripts/linkedin-social.mjs auth' first."],
  // reddit-social.mjs:128 via the scheduler's zero-row branch (lib/scheduler.mjs engine_failure)
  ['engine_failure', 'Reddit credentials missing in .env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET'],
  // requireEnv (x-social.mjs:140 etc.) process.exit, stderr tail via the zero-row branch
  ['engine_failure', "[err] X_CLIENT_ID missing in .env - run 'node scripts/x-social.mjs auth' first."],
  // linkedin-social.mjs:193 refresh refused, process.exit, stderr tail
  ['engine_failure', "[err] Refresh failed (OAuth refresh_token: HTTP 400 invalid_grant - The provided authorization grant is invalid). The refresh token is likely expired or revoked - re-run 'node scripts/linkedin-social.mjs auth'."],
  // nostr-social.mjs parsePrivateKey / bech32Decode: a malformed signing key fails identically
  // on every retry (the key is client-side, so this is the nostr lane's credential failure)
  ['engine_failure', 'NOSTR_PRIVATE_KEY must be nsec1... (bech32) or 64-char hex'],
  ['engine_failure', 'NOSTR_PRIVATE_KEY decodes to 31 bytes (expected 32)'],
  ['engine_failure', 'NOSTR_PRIVATE_KEY is out of the secp256k1 range'],
  ['engine_failure', 'bech32: bad checksum'],
  ['engine_failure', '[err] bech32: expected nsec1..., got npub1...'],
  ['engine_failure', 'NOSTR_PRIVATE_KEY is not set - cannot publish.'],
];

// Negatives: transient, content or platform-policy failures a reconnect never fixes.
const NOT_CREDENTIAL = [
  ['needs_scope', X_REPLY, 'X reply restriction (recorded as needs_scope) is manual, not reconnect'],
  ['engine_failure', "X token refresh failed (fetch failed). The refresh token likely expired or was rotated out - re-run 'node scripts/x-social.mjs auth'.", 'a refresh that failed on the NETWORK is transient'],
  ['engine_failure', 'LinkedIn POST /rest/posts: HTTP 503 - service unavailable', 'a 5xx is a platform hiccup'],
  ['needs_scope', 'bluesky session HTTP 502', 'a 5xx under needs_scope is still a platform hiccup'],
  ['needs_scope', 'Reddit token mint failed: HTTP 429 - too many requests', 'a rate limit under needs_scope rides the cap'],
  ['engine_failure', "[err] Refresh failed (OAuth refresh_token: HTTP 500 server_error - try later). The refresh token is likely expired or revoked - re-run 'node scripts/linkedin-social.mjs auth'.", 'a refresh refused with a 5xx is a platform hiccup'],
  ['engine_failure', 'X POST /tweets: HTTP 403 - You are not allowed to create a Tweet with duplicate content.', 'a duplicate is an edit, not a reconnect'],
  ['engine_failure', 'X POST /tweets: HTTP 403 - Forbidden', 'a bare 403 (tier/policy) is not proven to be the credential'],
  ['engine_failure', 'connect ETIMEDOUT 104.244.42.1:443', 'a timeout is transient'],
  ['invalid_input', 'tweet is 300 chars', 'a content block is an edit'],
  ['engine_failure', 'no relay accepted the event (0/3)', 'nostr relays refusing a note is not the key (relays may reject while up)'],
  ['engine_failure', 'no relay accepted the reply (0/2)', 'a nostr reply no relay took is not the key either'],
];

try {
  // ===== (a) classifier =====================================================================
  for (const [code, msg] of CREDENTIAL) {
    ok(isCredentialFailure(row(code, msg)) === true, `credential: [${code}] ${msg.slice(0, 70)}`);
  }
  for (const [code, msg, why] of NOT_CREDENTIAL) {
    ok(isCredentialFailure(row(code, msg)) === false, `not credential: ${why}`);
  }
  ok(isCredentialFailure({ ok: true, platform: 'x', errorCode: null, errorMessage: null }) === false, 'a success is never a credential failure');
  ok(isCredentialFailure({ code: 'needs_scope', message: 'x' }) === true, 'the { code, message } failure shape (lastFailure / hold) classifies too');

  // ===== (b) first-strike park ==============================================================
  for (const [code, msg] of CREDENTIAL) {
    ok(isTerminalRefusal(row(code, msg)) === true, `terminal on the first strike: [${code}] ${msg.slice(0, 50)}`);
  }
  const cp1 = { attempts: [] };
  recordAttempt(cp1, row('engine_failure', 'X POST /tweets: HTTP 401 - Unauthorized'));
  ok(cp1.attempts.length === 1 && cp1.publishHold?.lane === 'x', `one revoked-token failure parks the post immediately (${JSON.stringify(cp1.publishHold)})`);
  ok(!cp1.publishRetry, 'a credential hold leaves no transient retry schedule');

  const cp2 = { attempts: [] };
  recordAttempt(cp2, row('needs_scope', 'bluesky createRecord HTTP 401', 'bluesky'));
  ok(Boolean(cp2.publishHold) && cp2.publishHold.code === 'needs_scope', 'a needs_scope failure parks on the first strike');

  const tp = { attempts: [] };
  recordAttempt(tp, row('engine_failure', "X token refresh failed (fetch failed). The refresh token likely expired or was rotated out - re-run 'node scripts/x-social.mjs auth'."));
  ok(!tp.publishHold && Boolean(tp.publishRetry), 'a refresh that failed on the network rides the transient backoff, no hold');

  const sp = { attempts: [] };
  recordAttempt(sp, row('engine_failure', 'LinkedIn POST /rest/posts: HTTP 503 - service unavailable', 'linkedin'));
  ok(!sp.publishHold, 'a 5xx does not park on the first strike (3-strike cap unchanged)');

  // ===== (c) recovery =======================================================================
  for (const [code, msg] of CREDENTIAL) {
    ok(failureRecovery({ code, message: msg }) === 'reconnect', `recovery reconnect: [${code}] ${msg.slice(0, 50)}`);
  }
  ok(failureRecovery({ code: 'needs_scope', message: X_REPLY }) === 'manual', 'X reply restriction under needs_scope stays manual (the message wins over the code)');
  ok(failureRecovery({ code: 'engine_failure', message: 'LinkedIn POST /rest/posts: HTTP 503 - service unavailable' }) === null, 'a 5xx keeps recovery null (retrying)');

  // ===== (d) a forced passing recheck releases the lane's credential holds ==================
  const cc = await createCampaign({ id: 'cred', note: 'credential holds', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  const seed = async (id, platforms) => {
    const r = await createPost({ campaign: 'cred', post: { id, type: 'text', platforms, scheduledAt: '2020-01-01T00:00:00Z', caption: 'a short honest note' }, actor: 'agent:claude' });
    assert.ok(r.ok, `createPost(${id}): ${JSON.stringify(r)}`);
    const a = await approvePost({ campaign: 'cred', postId: id, actor: 'owner' });
    assert.ok(a.ok, `approvePost(${id}): ${JSON.stringify(a)}`);
  };
  await seed('x-cred', ['x']);
  await seed('x-dup', ['x']);
  await seed('li-cred', ['linkedin']);
  const planPath = resolvePlanPath(loadPlanStore().campaigns.find((c) => c.id === 'cred').path);
  await mutatePlan(planPath, (plan) => {
    const by = (id) => plan.posts.find((p) => p.id === id);
    recordAttempt(by('x-cred'), row('engine_failure', 'X POST /tweets: HTTP 401 - Unauthorized'));
    recordAttempt(by('x-dup'), row('engine_failure', 'X POST /tweets: HTTP 403 - You are not allowed to create a Tweet with duplicate content.'));
    recordAttempt(by('li-cred'), row('needs_scope', 'LinkedIn POST /rest/posts: HTTP 401 - EXPIRED_ACCESS_TOKEN', 'linkedin'));
  });
  const getPost = (id) => loadPlanStore().campaigns.find((c) => c.id === 'cred').posts.find((p) => p.id === id);
  ok(Boolean(getPost('x-cred').publishHold) && Boolean(getPost('x-dup').publishHold) && Boolean(getPost('li-cred').publishHold), 'all three posts start held');
  ok(getPost('x-cred').lastFailure?.recovery === 'reconnect', 'the held X post asks for a reconnect');

  await probeAll({ platform: 'x' }); // background-style (not forced): never releases
  ok(Boolean(getPost('x-cred').publishHold), 'an unforced (background) probe does not release a credential hold');

  const res = await probeAll({ force: true, platform: 'x' });
  ok(res.health?.x?.ok === true, `the forced X recheck passed via the stub (${JSON.stringify(res.health?.x)})`);
  ok(!getPost('x-cred').publishHold, 'the passing recheck released the X credential hold');
  ok(Boolean(getPost('x-dup').publishHold), 'an unrelated X hold (duplicate content) stays parked');
  ok(Boolean(getPost('li-cred').publishHold), 'a credential hold on ANOTHER lane stays parked');

  console.log(`[publish-hold-credential] OK - a local credential failure parks on the first strike with recovery reconnect, and a passing recheck releases it (${pass} assertions).`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exitCode = 1;
} finally {
  delete process.env.PENDPOST_X_ENGINE;
  fs.rmSync(WS, { recursive: true, force: true });
}
