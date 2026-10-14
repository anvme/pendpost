#!/usr/bin/env node
// test/receipts-numeric-errorcode.test.mjs - spec 51 failure receipts for engines that
// report a NUMERIC errorCode. scripts/meta-social.mjs pushes Graph API codes as numbers
// (errorCode: 9004 literal; err.fbCode = Number(e.code), e.g. 190 / 368), while the
// receipt canonical form (lib/attest.mjs canonicalOutcome) accepts only a string or null
// outcome.errorCode. recordReceipts passed the number through, signStatement threw
// invalid_input, and NO receipt was written for the whole lane - including the sibling
// platform's successful publish in the same tick. The fix normalises the code to a string
// where result rows enter the receipt pipeline (recordReceipts), leaving the strict
// schema and the canonical form of string codes untouched, and leaving the engines'
// numeric attempt rows alone (lib/publish-hold.mjs compares 368 / 190 numerically).
// Mock mode, the receipts.test.mjs harness (pure construction, never the scheduler).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-rc-num-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const CLIP = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), CLIP);

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { mutatePlan } = await import('../lib/planWrite.mjs');
const { mintAuthorizations, recordReceipts, verifyReceipt } = await import('../lib/receipts.mjs');
const { canonicalBytes, signStatement, verifyStatement } = await import('../lib/attest.mjs');
const { isCredentialFailure, isTransientFailure } = await import('../lib/publish-hold.mjs');

const getRawPost = (camp, id) => {
  const c = loadPlanStore().campaigns.find((x) => x.id === camp);
  const plan = JSON.parse(fs.readFileSync(path.resolve(WS, c.path), 'utf8'));
  return { planAbs: path.resolve(WS, c.path), post: (plan.posts || []).find((p) => p.id === id) };
};
const writeAttestation = async (planAbs, id, statements) => {
  await mutatePlan(planAbs, (plan) => {
    const p = (plan.posts || []).find((x) => x.id === id);
    if (!p) return null;
    p.attestation = { ...(p.attestation || {}), ...statements };
    return p;
  });
};
const setField = async (planAbs, id, field, value) => {
  await mutatePlan(planAbs, (plan) => {
    const p = (plan.posts || []).find((x) => x.id === id);
    if (!p) return null;
    p[field] = value;
    return p;
  });
};
// A meta reel (instagram + facebook), the scheduler-receipts.test.mjs fixture shape.
const approvedMetaReel = async (camp, id) => {
  const cp = await createPost({ campaign: camp, post: { id, type: 'reel', platforms: ['instagram', 'facebook'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:claude' });
  assert.ok(cp.ok, `createPost(${camp}/${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: camp, postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${camp}/${id}): ${JSON.stringify(ap)}`);
};
const mintFor = async (camp, id) => {
  const { post, planAbs } = getRawPost(camp, id);
  const m = await mintAuthorizations({ campaign: camp, post, lane: 'meta', planAbs, platforms: ['instagram', 'facebook'], clientId: camp, now: Date.now() });
  assert.ok(m.ok && m.statements.instagram && m.statements.facebook, JSON.stringify(m));
  await writeAttestation(planAbs, id, m.statements);
  return { planAbs, statements: m.statements };
};

try {
  const cc = await createCampaign({ id: 'm', note: 'm', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, JSON.stringify(cc));

  // --- (1) Meta partial failure: IG fails with numeric 9004, FB publishes. --------
  // The exact row shapes scripts/meta-social.mjs pushes (publish-reel ok on facebook,
  // publish-image / publish-reel refused on instagram with the Graph code as a number).
  await approvedMetaReel('m', 'r9004');
  {
    const { planAbs, statements } = await mintFor('m', 'r9004');
    await setField(planAbs, 'r9004', 'fbPostId', 'fb-9004');
    const rec = await recordReceipts({
      campaign: 'm', post: getRawPost('m', 'r9004').post, lane: 'meta', planAbs, clientId: 'm', authorizations: statements,
      results: [
        { postId: 'r9004', platform: 'instagram', action: 'publish-reel', ok: false, errorCode: 9004, errorMessage: 'Graph POST /1/media_publish: HTTP 400 OAuthException 9004 - Only photo or video can be accepted as media type.' },
        { postId: 'r9004', platform: 'facebook', action: 'publish-reel', ok: true, id: 'fb-9004' },
      ],
    });
    ok(rec.ok === true, 'recordReceipts succeeds for a Meta failure row carrying a numeric errorCode');
    ok(rec.receipts.instagram && rec.receipts.instagram.payload.outcome.ok === false, 'the failed instagram fire gets a signed failure receipt');
    ok(rec.receipts.instagram.payload.outcome.errorCode === '9004', 'the numeric Graph code is recorded as the string "9004"');
    ok(rec.receipts.facebook && rec.receipts.facebook.payload.outcome.ok === true, 'the sibling facebook success is not lost with the instagram failure');
    const disk = getRawPost('m', 'r9004').post;
    ok(disk.receipt && disk.receipt.instagram && disk.receipt.facebook, 'both receipts were persisted to the raw post on disk');
    ok(verifyStatement(disk.receipt.instagram).ok, 'the persisted failure receipt verifies');
    const v = await verifyReceipt({ campaign: 'm', postId: 'r9004', actor: 'owner' });
    ok(v.receipts.instagram.signatureValid && v.receipts.instagram.chainValid, 'verifyReceipt passes signature + chain for the numeric-code failure');
    ok(v.receipts.facebook.signatureValid && v.receipts.facebook.chainValid && v.receipts.facebook.platformIdMatches, 'verifyReceipt passes every axis for the facebook success');
    ok(!v.reason, 'no missing_receipt reason for a Meta partial failure');
  }

  // --- (2) Graph 190 (expired token) on both platforms. ---------------------------
  await approvedMetaReel('m', 'r190');
  {
    const { planAbs, statements } = await mintFor('m', 'r190');
    const msg = 'Graph POST /1/media: HTTP 400 OAuthException 190 - Error validating access token';
    const rec = await recordReceipts({
      campaign: 'm', post: getRawPost('m', 'r190').post, lane: 'meta', planAbs, clientId: 'm', authorizations: statements,
      results: [
        { postId: 'r190', platform: 'instagram', action: 'publish-reel', ok: false, errorCode: 190, errorMessage: msg },
        { postId: 'r190', platform: 'facebook', action: 'publish-reel', ok: false, errorCode: 190, errorMessage: msg },
      ],
    });
    ok(rec.ok && rec.receipts.instagram.payload.outcome.errorCode === '190' && rec.receipts.facebook.payload.outcome.errorCode === '190', 'a numeric 190 is recorded as "190" on both platforms');
  }

  // --- (3) A numeric lane-level failure (zero-row run) is normalised too. ---------
  await approvedMetaReel('m', 'rlane');
  {
    const { planAbs, statements } = await mintFor('m', 'rlane');
    const rec = await recordReceipts({ campaign: 'm', post: getRawPost('m', 'rlane').post, lane: 'meta', planAbs, clientId: 'm', authorizations: statements, results: [], laneFailure: { errorCode: 368 } });
    ok(rec.ok && rec.receipts.instagram.payload.outcome.errorCode === '368', 'a numeric laneFailure errorCode is recorded as a string');
  }

  // --- (4) A missing / zero / empty code still falls back to engine_failure. ------
  await approvedMetaReel('m', 'rnull');
  {
    const { planAbs, statements } = await mintFor('m', 'rnull');
    const rec = await recordReceipts({
      campaign: 'm', post: getRawPost('m', 'rnull').post, lane: 'meta', planAbs, clientId: 'm', authorizations: statements,
      results: [
        { postId: 'rnull', platform: 'instagram', action: 'publish-reel', ok: false, errorCode: null },
        { postId: 'rnull', platform: 'facebook', action: 'publish-reel', ok: false, errorCode: '' },
      ],
    });
    ok(rec.ok && rec.receipts.instagram.payload.outcome.errorCode === 'engine_failure' && rec.receipts.facebook.payload.outcome.errorCode === 'engine_failure', 'an absent errorCode still falls back to engine_failure');
  }

  // --- (5) The schema is NOT loosened and string codes keep their canonical form. -
  const base = { v: 1, kind: 'receipt', clientId: 'm', campaign: 'm', postId: 'p', platform: 'instagram', authSig: null, recordedAt: '2026-09-25T00:00:00.000Z' };
  assert.throws(() => canonicalBytes('receipt', { ...base, outcome: { ok: false, platformId: null, errorCode: 9004 } }), /errorCode must be a string or null/);
  ok(true, 'canonicalBytes still refuses a non-string outcome.errorCode (schema unchanged)');
  const strBytes = canonicalBytes('receipt', { ...base, outcome: { ok: false, platformId: null, errorCode: 'rate_limited' } }).toString('utf8');
  ok(strBytes.endsWith('"outcome":{"ok":false,"platformId":null,"errorCode":"rate_limited"},"recordedAt":"2026-09-25T00:00:00.000Z"}'), 'a string errorCode canonicalises exactly as before');
  const preexisting = signStatement('receipt', { ...base, outcome: { ok: false, platformId: null, errorCode: 'rate_limited' } });
  ok(verifyStatement(preexisting).ok, 'an already-written string-code receipt still verifies');

  // --- (6) The numeric consumers keep working on the engines' numeric attempt rows. -
  ok(isCredentialFailure({ ok: false, errorCode: 190, errorMessage: 'Graph POST /1/feed: HTTP 400 OAuthException 190 - Error validating access token' }), 'publish-hold still classifies a numeric 190 attempt as a credential failure');
  ok(isTransientFailure({ ok: false, errorCode: 368, errorMessage: 'blocked ProcessingFailedError' }) === false, 'publish-hold still treats a numeric 368 as never transient');

  console.log(`[receipts-numeric-errorcode] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
