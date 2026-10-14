#!/usr/bin/env node
// test/insights-error-noise.test.mjs - the insights sweep stops crying wolf.
//
// Owner principle: a message reaches the owner only if pendpost cannot fix it itself AND it
// names the exact one-step fix. Before this, every nightly sweep spawned every lane with
// evidence, failed ~110 per-post reads on lanes that could never succeed (LinkedIn without
// the Community Management product, YouTube with the Analytics API off, Meta without a page
// token) and logged ONE aggregated red row "110 fetch(es) failed" every single day.
//
// Proven here, credential-free and network-free, through the REAL sweep with fake engines
// (PENDPOST_<LANE>_ENGINE overrides):
//   1. failureClass: "<VAR> missing in .env" / "not configured" read not_configured, never
//      "not authenticated".
//   2. a lane whose stored health says "not configured" is never spawned and never fails.
//   3. needs_scope / api_disabled / token open a per-lane circuit: remembered with
//      {reason, at, since, detail (sanitized, <=200 chars)}; the automatic sweep skips the
//      lane until 7 days passed, its credentials changed, or a manual fetch probes it.
//   4. activity: one row per lane, only on a state change (new reason, or recovery), no
//      aggregated "N fetch(es) failed" row.
//   5. the return envelope names the lanes that could not refresh (failedLanes).
//   6. digest: distinct reasons, and a remembered lane is mentioned once, not daily.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-insights-noise-'));
process.env.PENDPOST_ROOT = WS;
// mock: the daily sweep's digest notification must never pop a real popup from a test.
process.env.PENDPOST_MODE = 'mock';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const DAY = 24 * 3600 * 1000;
const CALLS = path.join(WS, 'calls.log');
const BEHAVIOR = path.join(WS, 'behavior.json');

// One fake engine per lane. It appends "<lane> <verb>" to calls.log and answers with the
// envelope behavior.json holds for that lane+verb (default: an empty ok envelope).
function writeFake(lane) {
  const p = path.join(WS, `fake-${lane}.mjs`);
  fs.writeFileSync(p, `
import fs from 'node:fs';
const verb = process.argv[2];
fs.appendFileSync(${JSON.stringify(CALLS)}, ${JSON.stringify(lane)} + ' ' + verb + '\\n');
let b = {};
try { b = JSON.parse(fs.readFileSync(${JSON.stringify(BEHAVIOR)}, 'utf8')); } catch {}
const env = (b[${JSON.stringify(lane)}] || {})[verb] || { ok: true, results: [] };
console.log(JSON.stringify(env));
`);
  process.env[`PENDPOST_${lane.toUpperCase()}_ENGINE`] = p;
}
for (const lane of ['meta', 'linkedin', 'youtube', 'telegram', 'mastodon']) writeFake(lane);

const setBehavior = (b) => fs.writeFileSync(BEHAVIOR, JSON.stringify(b));
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : []);
const resetCalls = () => fs.rmSync(CALLS, { force: true });

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'local', path: 'data/plans/local.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'local.json'), JSON.stringify({
  campaign: 'local',
  posts: [
    { id: 'li1', platforms: ['linkedin'], status: 'posted', postedAt: '2026-09-01T00:00:00Z', liPostId: 'urn:li:share:1', scheduledAt: '2026-09-01T00:00:00Z', caption: 'li' },
    { id: 'li2', platforms: ['linkedin'], status: 'posted', postedAt: '2026-09-02T00:00:00Z', liPostId: 'urn:li:share:2', scheduledAt: '2026-09-02T00:00:00Z', caption: 'li' },
    { id: 'yt1', platforms: ['youtube'], status: 'posted', postedAt: '2026-09-01T00:00:00Z', ytVideoId: 'vid1', scheduledAt: '2026-09-01T00:00:00Z', caption: 'yt' },
    { id: 'ig1', platforms: ['instagram'], status: 'posted', postedAt: '2026-09-01T00:00:00Z', igMediaId: '1789', scheduledAt: '2026-09-01T00:00:00Z', caption: 'ig' },
    { id: 'tg1', platforms: ['telegram'], status: 'posted', postedAt: '2026-09-01T00:00:00Z', tgMessageId: '42', scheduledAt: '2026-09-01T00:00:00Z', caption: 'tg' },
    { id: 'ma1', platforms: ['mastodon'], status: 'posted', postedAt: '2026-09-01T00:00:00Z', mastodonStatusId: '111', scheduledAt: '2026-09-01T00:00:00Z', caption: 'ma' },
  ],
}, null, 2));
const ENV = path.join(WS, '.env');
fs.writeFileSync(ENV, 'LINKEDIN_ACCESS_TOKEN=aaaa1111\nLINKEDIN_REFRESH_TOKEN=rrrr1111\nYT_REFRESH_TOKEN=yyyy1111\nTELEGRAM_BOT_TOKEN=tttt\nMASTODON_ACCESS_TOKEN=mmmm\n');

const SECRETISH = 'EAAGm0PX4ZCpsBAKZBZAqZCZCZBZCabcdefghijklmnopqrstuvwxyz0123456789';
const ytDisabled = {
  ok: true,
  results: [{ postId: null, platform: 'youtube', action: 'demographics', scope: 'account', ok: false, error: 'api_disabled', errorMessage: 'YouTube Analytics GET /reports: HTTP 403 accessNotConfigured - YouTube Analytics API has not been used in project 449370365247 before or it is disabled.', helpUrl: 'https://console.developers.google.com/apis/api/youtubeanalytics.googleapis.com/overview?project=449370365247' }],
};
const baseBehavior = () => ({
  linkedin: {
    insights: { ok: true, results: [{ postId: 'li1', platform: 'linkedin', action: 'insights', ok: false, error: 'needs_scope', scope: 'r_organization_social', errorMessage: `LinkedIn GET /organizationalEntityShareStatistics: HTTP 403 ACCESS_DENIED - Not enough permissions access_token=${SECRETISH}` }] },
    demographics: { ok: true, results: [{ postId: null, platform: 'linkedin', action: 'demographics', scope: 'account', ok: false, error: 'needs_scope' }] },
  },
  youtube: {
    insights: { ok: true, results: [{ postId: 'yt1', platform: 'youtube', action: 'insights', ok: true, metrics: { views: 10, likes: 1, comments: 0 } }] },
    demographics: ytDisabled,
  },
  telegram: { insights: { ok: true, results: [{ postId: 'tg1', platform: 'telegram', action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: 'fetch failed ECONNRESET' }] } },
  mastodon: { insights: { ok: true, results: [{ postId: 'ma1', platform: 'mastodon', action: 'insights', ok: true, metrics: { favourites: 2 } }] } },
  meta: { insights: { ok: true, results: [{ postId: 'ig1', platform: 'instagram', action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: 'META_PAGE_TOKEN missing in .env - run the setup command first.' }] } },
});

const { fetchInsights, dailyInsightsSweep, failureClass, sanitizeInsightsDetail, generateDigest } = await import('../lib/insights.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const insightsRows = () => (loadState().activity || []).filter((a) => a.action === 'insights-fetch');
const laneRows = (lane) => insightsRows().filter((a) => a.platform === lane);
// The automatic (daily) path: force the 24h guard open, then run the real daily sweep.
async function autoSweep() {
  const st = loadState();
  st.insights = st.insights || {};
  st.insights.lastFetch = new Date(Date.now() - 2 * DAY).toISOString();
  saveState();
  return dailyInsightsSweep();
}

try {
  // ---- 1. failureClass -------------------------------------------------------------
  ok(failureClass({ errorMessage: 'META_PAGE_TOKEN missing in .env - run the setup command first.' }) === 'not_configured', 'failureClass: "<VAR> missing in .env" -> not_configured (was: token / "not authenticated")');
  ok(failureClass({ errorMessage: 'not configured (Page token/Page ID missing)' }) === 'not_configured', 'failureClass: "not configured (...)" -> not_configured');
  ok(failureClass({ errorCode: 'not_configured', errorMessage: 'META_IG_USER_ID / META_PAGE_TOKEN are not set' }) === 'not_configured', 'failureClass: errorCode not_configured -> not_configured');
  ok(failureClass({ errorMessage: 'invalid_grant: token expired' }) === 'token', 'failureClass: an expired token still -> token');
  ok(failureClass({ error: 'needs_scope' }) === 'needs_scope', 'failureClass: needs_scope unchanged');
  ok(failureClass({ error: 'api_disabled' }) === 'api_disabled', 'failureClass: api_disabled unchanged');

  // ---- sanitizer --------------------------------------------------------------------
  const clean = sanitizeInsightsDetail(`HTTP 403 Bearer ${SECRETISH} access_token=${SECRETISH}&x=1 ${'x'.repeat(400)}`);
  ok(!clean.includes(SECRETISH) && !/EAAG/.test(clean), 'sanitizer strips token-like strings (Bearer, access_token=, long opaque runs)');
  ok(clean.length <= 200, 'sanitizer caps the detail at 200 chars');

  // ---- 2+3+4. first automatic sweep --------------------------------------------------
  const st0 = loadState();
  st0.health = {
    meta: { ok: false, detail: 'not configured (Page token/Page ID missing)', checkedAt: new Date().toISOString() },
    linkedin: { ok: true, detail: 'Token active', checkedAt: new Date().toISOString() },
  };
  // A stale record from before the fix (the "default" client's live state) must be cleared.
  st0.insights = { data: {}, unavailable: { meta: { reason: 'token', at: new Date(Date.now() - DAY).toISOString() } } };
  saveState();
  setBehavior(baseBehavior());
  resetCalls();
  await autoSweep();
  let c = calls();
  ok(!c.some((l) => l.startsWith('meta ')), 'a lane whose health says "not configured" is never spawned');
  ok(!loadState().insights.unavailable.meta, 'a not-configured lane carries no unavailable record (stale token record cleared)');
  ok(laneRows('meta').length === 0, 'a not-configured lane never produces an insights failure row');
  ok(c.includes('linkedin insights') && c.includes('youtube demographics') && c.includes('telegram insights'), 'configured lanes with evidence are swept');
  let un = loadState().insights.unavailable;
  ok(un.linkedin?.reason === 'needs_scope', 'linkedin remembered as needs_scope');
  ok(un.youtube?.reason === 'api_disabled', 'youtube remembered as api_disabled');
  ok(un.telegram?.reason === 'error', 'telegram remembered as error');
  ok(typeof un.linkedin.since === 'string' && typeof un.linkedin.at === 'string', 'the record carries since + at');
  ok(typeof un.linkedin.detail === 'string' && un.linkedin.detail.length <= 200 && !un.linkedin.detail.includes(SECRETISH), 'the record keeps a sanitized raw detail (<=200 chars, no token)');
  ok(/accessNotConfigured|has not been used/.test(un.youtube.detail || ''), 'the youtube record keeps the real Google reason');
  ok(!insightsRows().some((a) => /fetch\(es\) failed/.test(a.errorMessage || '')), 'no aggregated "N fetch(es) failed" row any more');
  ok(laneRows('linkedin').filter((a) => a.ok === false).length === 1 && laneRows('linkedin')[0].errorCode === 'needs_scope', 'exactly one linkedin row, errorCode needs_scope');
  ok(laneRows('youtube').filter((a) => a.ok === false).length === 1 && laneRows('youtube')[0].errorCode === 'api_disabled', 'exactly one youtube row, errorCode api_disabled');
  ok(/^https:\/\/console\.developers\.google\.com/.test(laneRows('youtube')[0].helpUrl || ''), 'the youtube row carries the Cloud-console activation URL');
  ok(laneRows('telegram').filter((a) => a.ok === false).length === 1, 'exactly one telegram row');

  // ---- second automatic sweep: circuit holds, no new rows ---------------------------
  resetCalls();
  const before = insightsRows().filter((a) => a.ok === false).length;
  await autoSweep();
  c = calls();
  ok(!c.some((l) => l.startsWith('linkedin ')), 'circuit: needs_scope lane is NOT spawned by the next automatic sweep');
  ok(!c.some((l) => l.startsWith('youtube ')), 'circuit: api_disabled lane is NOT spawned by the next automatic sweep');
  ok(c.includes('telegram insights'), 'a plain error is not a circuit: telegram is retried');
  ok(insightsRows().filter((a) => a.ok === false).length === before, 'same reasons on the next night => zero new failure rows');
  ok(loadState().insights.unavailable.linkedin?.reason === 'needs_scope', 'a skipped lane keeps its remembered reason');

  // ---- manual fetch always probes --------------------------------------------------
  resetCalls();
  const manual = await fetchInsights();
  c = calls();
  ok(c.includes('linkedin insights') && c.includes('youtube demographics'), 'a manual fetch probes circuit lanes');
  ok(Array.isArray(manual.failedLanes) && manual.failedLanes.some((f) => f.lane === 'linkedin' && f.reason === 'needs_scope'), 'the envelope names the lanes that could not refresh (failedLanes)');
  ok(!manual.failedLanes.some((f) => f.lane === 'mastodon'), 'a lane that refreshed is not in failedLanes');
  ok(insightsRows().filter((a) => a.ok === false).length === before, 'a manual probe with unchanged reasons logs nothing new');

  // ---- credentials changed => the circuit re-opens ----------------------------------
  fs.writeFileSync(ENV, fs.readFileSync(ENV, 'utf8').replace('LINKEDIN_REFRESH_TOKEN=rrrr1111', 'LINKEDIN_REFRESH_TOKEN=rrrr2222'));
  resetCalls();
  await autoSweep();
  c = calls();
  ok(c.includes('linkedin insights'), 'a reconnect (credential fingerprint changed) re-probes the lane on the automatic sweep');
  ok(!c.some((l) => l.startsWith('youtube ')), 'youtube (credentials unchanged) stays skipped');

  // ---- 7 days later the circuit re-probes ------------------------------------------
  let st = loadState();
  st.insights.unavailable.youtube.at = new Date(Date.now() - 8 * DAY).toISOString();
  saveState();
  resetCalls();
  await autoSweep();
  ok(calls().includes('youtube demographics'), 'after 7 days the automatic sweep re-probes a circuit lane');
  ok(loadState().insights.unavailable.youtube?.since === un.youtube.since, 'a re-probe with the same reason keeps the original since');

  // ---- recovery: one neutral ok row -------------------------------------------------
  const b = baseBehavior();
  b.linkedin = {
    insights: { ok: true, results: [{ postId: 'li1', platform: 'linkedin', action: 'insights', ok: true, metrics: { impressions: 5 } }] },
    demographics: { ok: true, results: [{ postId: null, platform: 'linkedin', action: 'demographics', scope: 'account', ok: true, demographics: {} }] },
  };
  setBehavior(b);
  await fetchInsights();
  ok(!loadState().insights.unavailable.linkedin, 'recovery clears the lane record');
  const back = laneRows('linkedin').find((a) => a.ok === true);
  ok(back && back.errorCode === 'insights_recovered' && /LinkedIn statistics are back/.test(back.errorMessage || ''), 'recovery logs one ok row "LinkedIn statistics are back"');
  await fetchInsights();
  ok(laneRows('linkedin').filter((a) => a.ok === true).length === 1, 'a second healthy fetch logs no further recovery row');

  // ---- 6. digest: distinct reasons, mentioned once ----------------------------------
  st = loadState();
  st.notify = { ...(st.notify || {}) };
  delete st.notify.prevDigestAt;
  saveState();
  let d = generateDigest({ locale: 'en' }).digest;
  ok(/Metrics unavailable/.test(d), 'digest names unavailable lanes');
  ok(/YouTube \([^)]*Google Cloud[^)]*\)/.test(d), 'digest: api_disabled reads as its own reason (not "fetch failed")');
  ok(/Telegram \(fetch failed\)/.test(d), 'digest: a plain error still reads "fetch failed"');
  const dDe = generateDigest({ locale: 'de-CH' }).digest;
  ok(/YouTube \([^)]*Google Cloud[^)]*\)/.test(dDe) && !/ß/.test(dDe), 'de-CH digest: api_disabled reason localized, no eszett');
  ok(!d.includes('\u2014') && !dDe.includes('\u2014'), 'no em dashes in the digest');
  // After a digest went out (prevDigestAt is newer than the change), the standing lane is not repeated.
  st = loadState();
  st.notify = { ...(st.notify || {}), prevDigestAt: new Date(Date.now() + 1000).toISOString() };
  saveState();
  d = generateDigest({ locale: 'en' }).digest;
  ok(!/YouTube \(/.test(d), 'a lane whose reason did not change since the last digest is not mentioned again');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[insights-error-noise] OK - not-configured lanes skipped, circuits remembered, one row per lane change (${pass} assertions).`);
} catch (err) {
  console.error(`[insights-error-noise] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
