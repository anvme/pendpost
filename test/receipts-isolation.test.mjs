#!/usr/bin/env node
// test/receipts-isolation.test.mjs - spec 51 per-platform receipt isolation. recordReceipts
// signs one receipt per authorized platform. When signing ONE platform's receipt threw
// (lib/attest.mjs canonicalBytes / canonicalOutcome refusing a value), the catch
// returned from inside the per-platform loop BEFORE the plan write, so every sibling
// platform's receipt in that run was dropped too (7fa80487 fixed the numeric Meta
// errorCode trigger, not the fragility). The fix isolates each platform: an unsignable
// platform is skipped with the existing warn line and reported on the return value, and
// the plan write always runs for the platforms that did sign. The unsignable platform
// stays visible the way a missing receipt already is: verifyReceipt reports
// missing_receipt (authorization present, receipt absent). No new feed row or UI.
// Mock mode, the receipts.test.mjs harness (pure construction, never the scheduler).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-rc-iso-'));
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
const { verifyStatement } = await import('../lib/attest.mjs');

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
// Capture logLine output (lib/util.mjs logLine writes through console.log).
const captureLogs = async (fn) => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { return { value: await fn(), lines }; } finally { console.log = orig; }
};

try {
  const cc = await createCampaign({ id: 'm', note: 'm', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, JSON.stringify(cc));

  // --- (1) One platform unsignable, the sibling must still land. -----------------
  // The instagram authorization handed to recordReceipts carries a non-string `sig`
  // (a corrupted in-memory statement): the receipt's authSig field then fails the
  // canonical schema ("field authSig must be string, boolean or null") and
  // signStatement throws for instagram only. facebook's receipt is perfectly signable.
  await approvedMetaReel('m', 'iso1');
  {
    const { planAbs, statements } = await mintFor('m', 'iso1');
    const authorizations = { instagram: { ...statements.instagram, sig: { corrupt: true } }, facebook: statements.facebook };
    const { value: rec, lines } = await captureLogs(() => recordReceipts({
      campaign: 'm', post: getRawPost('m', 'iso1').post, lane: 'meta', planAbs, clientId: 'm', authorizations,
      results: [
        { postId: 'iso1', platform: 'instagram', action: 'publish-reel', ok: true, id: 'ig-1' },
        { postId: 'iso1', platform: 'facebook', action: 'publish-reel', ok: true, id: 'fb-1' },
      ],
    }));
    ok(rec && typeof rec === 'object', 'recordReceipts resolves (does not throw) when one platform is unsignable');
    ok(rec.receipts.facebook && rec.receipts.facebook.payload.outcome.ok === true, 'the signable facebook receipt is returned');
    ok(!rec.receipts.instagram, 'no receipt is fabricated for the unsignable instagram platform');
    ok(rec.ok === false, 'ok:false honestly signals that not every authorized platform got a receipt');
    ok(rec.unsigned && typeof rec.unsigned.instagram === 'string' && /authSig/.test(rec.unsigned.instagram), 'the unsignable platform is reported on the return value with its reason');
    ok(!rec.unsigned.facebook, 'the signed platform is not reported as unsigned');
    ok(lines.some((l) => l.includes('[warn]') && l.includes('[attest] receipt sign failed for m/iso1 instagram:')), 'the existing warn line format is logged for the unsignable platform');
    const disk = getRawPost('m', 'iso1').post;
    ok(disk.receipt && disk.receipt.facebook, 'the facebook receipt was persisted to the raw post on disk');
    ok(!disk.receipt.instagram, 'nothing was persisted for instagram');
    ok(verifyStatement(disk.receipt.facebook).ok, 'the persisted facebook receipt verifies');
    const v = await verifyReceipt({ campaign: 'm', postId: 'iso1', actor: 'owner' });
    ok(v.receipts.facebook.signatureValid && v.receipts.facebook.chainValid, 'verifyReceipt passes signature + chain for the surviving facebook receipt');
    ok(v.reason === 'missing_receipt', 'verifyReceipt surfaces the unsignable instagram platform as missing_receipt');
  }

  // --- (2) Every platform unsignable: no write, no throw, both reported. ----------
  await approvedMetaReel('m', 'iso2');
  {
    const { planAbs, statements } = await mintFor('m', 'iso2');
    const authorizations = { instagram: { ...statements.instagram, sig: 42 }, facebook: { ...statements.facebook, sig: ['x'] } };
    const { value: rec } = await captureLogs(() => recordReceipts({
      campaign: 'm', post: getRawPost('m', 'iso2').post, lane: 'meta', planAbs, clientId: 'm', authorizations,
      results: [{ postId: 'iso2', platform: 'instagram', action: 'publish-reel', ok: true }, { postId: 'iso2', platform: 'facebook', action: 'publish-reel', ok: true }],
    }));
    ok(rec.ok === false && !Object.keys(rec.receipts).length, 'all-unsignable resolves ok:false with no receipts');
    ok(rec.unsigned.instagram && rec.unsigned.facebook, 'both unsignable platforms are reported');
    ok(!getRawPost('m', 'iso2').post.receipt, 'no receipt map is written when nothing signed');
  }

  // --- (3) The happy path is unchanged: ok:true, no unsigned map. -----------------
  await approvedMetaReel('m', 'iso3');
  {
    const { planAbs, statements } = await mintFor('m', 'iso3');
    const { value: rec } = await captureLogs(() => recordReceipts({
      campaign: 'm', post: getRawPost('m', 'iso3').post, lane: 'meta', planAbs, clientId: 'm', authorizations: statements,
      results: [{ postId: 'iso3', platform: 'instagram', action: 'publish-reel', ok: true }, { postId: 'iso3', platform: 'facebook', action: 'publish-reel', ok: true }],
    }));
    ok(rec.ok === true && rec.receipts.instagram && rec.receipts.facebook, 'all-signable still returns ok:true with both receipts');
    ok(rec.unsigned === undefined, 'the happy-path return shape is unchanged (no unsigned key)');
    const v = await verifyReceipt({ campaign: 'm', postId: 'iso3', actor: 'owner' });
    ok(!v.reason && v.receipts.instagram.chainValid && v.receipts.facebook.chainValid, 'both receipts verify with no missing_receipt');
  }

  console.log(`[receipts-isolation] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
