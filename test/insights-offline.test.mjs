#!/usr/bin/env node
// test/insights-offline.test.mjs - a sweep that ran with no network is offline, not broken.
//
// Observed 2026-10-13 on a live client: linkedin/meta/youtube sat in state.insights.unavailable
// with reason "error", detail "fetch failed", since 2026-10-10/11, re-stamped every night, while
// no insights row refreshed. The cause was the Mac sleeping on battery: the nightly sweep ran in
// DarkWake windows with no network. Proven here, network-free, through the REAL sweep with fake
// engines (PENDPOST_<LANE>_ENGINE overrides) and an injected network probe:
//   1. every swept lane failing with a bare "fetch failed" is offline: no unavailable stamp, no
//      per-lane activity row, "last fetched" keeps its date, no digest notification, the
//      summary row says insights_offline and names the lanes.
//   2. one lane whose failure names a local-network cause code (ENOTFOUND, EAI_AGAIN,
//      ENETUNREACH, ENETDOWN, EHOSTUNREACH) is offline even while the others work; its earlier
//      record is left untouched.
//   3. the next tick reruns the sweep only once the network answers, without waiting 24h; a
//      tick where the probe fails spawns nothing.
//   4. a rerun after a successful probe reads nothing as offline: a lane still failing then
//      is stamped like any failure (the network was proven up).
//   5. a lone lane failing with "fetch failed (ECONNRESET ...)" among working lanes is still a
//      real lane failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-insights-offline-'));
process.env.PENDPOST_ROOT = WS;
// mock: the daily sweep's digest notification must never pop a real popup from a test.
process.env.PENDPOST_MODE = 'mock';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const CALLS = path.join(WS, 'calls.log');
const BEHAVIOR = path.join(WS, 'behavior.json');
const LANES = ['linkedin', 'youtube', 'telegram', 'mastodon'];

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
for (const lane of LANES) writeFake(lane);

const setBehavior = (b) => fs.writeFileSync(BEHAVIOR, JSON.stringify(b));
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : []);
const resetCalls = () => fs.rmSync(CALLS, { force: true });

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'local', path: 'data/plans/local.json', active: true }],
}, null, 2));
const recent = new Date(Date.now() - DAY).toISOString();
fs.writeFileSync(path.join(WS, 'data', 'plans', 'local.json'), JSON.stringify({
  campaign: 'local',
  posts: [
    { id: 'li1', platforms: ['linkedin'], status: 'posted', postedAt: recent, liPostId: 'urn:li:share:1', scheduledAt: recent, caption: 'li' },
    { id: 'yt1', platforms: ['youtube'], status: 'posted', postedAt: recent, ytVideoId: 'vid1', scheduledAt: recent, caption: 'yt' },
    { id: 'tg1', platforms: ['telegram'], status: 'posted', postedAt: recent, tgMessageId: '42', scheduledAt: recent, caption: 'tg' },
    { id: 'ma1', platforms: ['mastodon'], status: 'posted', postedAt: recent, mastodonStatusId: '111', scheduledAt: recent, caption: 'ma' },
  ],
}, null, 2));
fs.writeFileSync(path.join(WS, '.env'), 'LINKEDIN_ACCESS_TOKEN=aaaa\nLINKEDIN_REFRESH_TOKEN=rrrr\nYT_REFRESH_TOKEN=yyyy\nTELEGRAM_BOT_TOKEN=tttt\nMASTODON_ACCESS_TOKEN=mmmm\n');

// Per-lane envelopes. `fail(lane, msg)` is the engine's per-post failure row.
const postOf = { linkedin: 'li1', youtube: 'yt1', telegram: 'tg1', mastodon: 'ma1' };
const good = (lane) => ({ insights: { ok: true, results: [{ postId: postOf[lane], platform: lane, action: 'insights', ok: true, metrics: { likes: 3 } }] }, demographics: { ok: true, results: [] } });
const fail = (lane, msg) => ({ insights: { ok: true, results: [{ postId: postOf[lane], platform: lane, action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: msg }] }, demographics: { ok: false, error: msg, results: [] } });
const behaviorWith = (overrides = {}) => Object.fromEntries(LANES.map((lane) => [lane, overrides[lane] || good(lane)]));

const { fetchInsights, dailyInsightsSweep } = await import('../lib/insights.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const summaryRows = () => (loadState().activity || []).filter((a) => a.action === 'insights-fetch' && !a.platform);
const laneRows = () => (loadState().activity || []).filter((a) => a.action === 'insights-fetch' && a.platform);
const setInsights = (patch) => { const st = loadState(); st.insights = { ...(st.insights || {}), ...patch }; saveState(); };
const probe = (answer) => { const seen = []; const fn = async (lanes) => { seen.push(lanes); return answer; }; fn.seen = seen; return fn; };

try {
  // ---- 1. every lane "fetch failed" (the 2026-10-10 night) ------------------------------
  const lastFetch0 = new Date(Date.now() - 2 * DAY).toISOString();
  setInsights({ data: {}, unavailable: {}, lastFetch: lastFetch0 });
  const notifyBefore = loadState().notify?.lastDigestAt || null;
  setBehavior(Object.fromEntries(LANES.map((lane) => [lane, fail(lane, 'fetch failed')])));
  resetCalls();
  const r1 = await dailyInsightsSweep({ netProbe: probe(true) });
  let st = loadState();
  ok(calls().length > 0, 'the nightly sweep ran (its 24h guard was open)');
  ok(Object.keys(st.insights.unavailable || {}).length === 0, `no lane is stamped unavailable on an offline night (got ${JSON.stringify(st.insights.unavailable)})`);
  ok(laneRows().length === 0, 'no per-lane "could not refresh" activity row on an offline night');
  ok(st.insights.lastFetch === lastFetch0, '"last fetched" keeps its real date when no lane was reached');
  ok(st.insights.offline && JSON.stringify(st.insights.offline.lanes) === JSON.stringify([...LANES].sort()), `state.insights.offline names every offline lane (got ${JSON.stringify(st.insights.offline)})`);
  ok(JSON.stringify(r1?.offlineLanes) === JSON.stringify([...LANES].sort()), 'the envelope returns offlineLanes');
  const s1 = summaryRows()[0];
  ok(s1 && s1.ok === true && s1.errorCode === 'insights_offline', `the summary row says insights_offline (got ${JSON.stringify(s1)})`);
  ok(s1 && /No network/.test(s1.errorMessage) && /LinkedIn/.test(s1.errorMessage) && !/—/.test(s1.errorMessage), 'the summary row names the offline lanes in plain words, no em dash');
  ok((loadState().notify?.lastDigestAt || null) === notifyBefore, 'no digest notification after an offline run');

  // ---- 3. the next tick: probe down -> nothing spawns; probe up -> rerun now ---------------
  resetCalls();
  const down = probe(false);
  const r2 = await dailyInsightsSweep({ netProbe: down });
  ok(r2 === null && calls().length === 0, 'a tick where the network does not answer spawns nothing');
  ok(down.seen.length === 1 && down.seen[0].includes('linkedin'), 'the probe is asked about the offline lanes');

  setBehavior(behaviorWith());
  resetCalls();
  const r3 = await dailyInsightsSweep({ netProbe: probe(true) });
  st = loadState();
  ok(r3 && calls().some((l) => l === 'linkedin insights'), 'the first tick where the network answers reruns the sweep, without waiting 24h');
  ok(!st.insights.offline, 'a clean rerun clears the offline record');
  ok(st.insights.lastFetch && st.insights.lastFetch !== lastFetch0, '"last fetched" advances on the rerun');
  ok(st.insights.data['local/li1/linkedin']?.metrics?.likes === 3, 'the rerun stored fresh metrics');
  ok((st.notify?.lastDigestAt || null) !== notifyBefore, 'the rerun sends the digest notification the offline run held back');

  // ---- 2. one lane with a local-network cause code, the rest fine -------------------------
  const oldRecord = { reason: 'needs_scope', at: new Date(Date.now() - 8 * DAY).toISOString(), since: new Date(Date.now() - 20 * DAY).toISOString(), detail: 'old', fp: null };
  setInsights({ unavailable: { linkedin: oldRecord }, lastFetch: new Date(Date.now() - 2 * DAY).toISOString() });
  setBehavior(behaviorWith({ linkedin: fail('linkedin', 'fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND api.linkedin.com)') }));
  const rowsBefore = laneRows().length;
  const r4 = await dailyInsightsSweep({ netProbe: probe(true) });
  st = loadState();
  ok(JSON.stringify(st.insights.unavailable.linkedin) === JSON.stringify(oldRecord), 'an offline lane keeps its earlier record untouched (no re-stamp)');
  ok(laneRows().length === rowsBefore, 'no per-lane row for the offline lane');
  ok(JSON.stringify(r4?.offlineLanes) === '["linkedin"]' && JSON.stringify(st.insights.offline?.lanes) === '["linkedin"]', 'only the ENOTFOUND lane is offline');
  ok(st.insights.data['local/yt1/youtube']?.fetchedAt === st.insights.lastFetch, 'the working lanes still refreshed and "last fetched" advanced');

  for (const code of ['EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH']) {
    setBehavior(behaviorWith({ youtube: fail('youtube', `fetch failed (${code}: connect ${code} 1.2.3.4:443)`) }));
    const r = await fetchInsights({});
    ok((r.offlineLanes || []).includes('youtube') && !loadState().insights.unavailable.youtube, `${code} reads offline, not a lane failure`);
  }

  // ---- 4. a rerun after a successful probe stamps what still fails --------------------------
  setInsights({ offline: { since: new Date().toISOString(), at: new Date().toISOString(), lanes: ['youtube'] }, unavailable: {} });
  setBehavior(behaviorWith({ youtube: fail('youtube', 'fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND www.googleapis.com)') }));
  const r5 = await dailyInsightsSweep({ netProbe: probe(true) });
  st = loadState();
  ok((r5?.offlineLanes || []).length === 0, 'with the network proven up, nothing reads offline');
  ok(st.insights.unavailable.youtube?.reason === 'error', `the still-failing lane is stamped like any failure (got ${JSON.stringify(st.insights.unavailable.youtube)})`);
  ok(!st.insights.offline, 'the offline record is cleared');

  // ---- 5. a lone ECONNRESET among working lanes is a real failure -------------------------
  setInsights({ unavailable: {} });
  setBehavior(behaviorWith({ telegram: fail('telegram', 'fetch failed (ECONNRESET: read ECONNRESET)') }));
  const r6 = await fetchInsights({});
  ok((r6.offlineLanes || []).length === 0 && loadState().insights.unavailable.telegram?.reason === 'error', 'a lone ECONNRESET is a lane failure, not offline');
} finally {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures) { console.error(`[insights-offline] FAIL - ${failures} failure(s), ${pass} passed.`); process.exit(1); }
console.log(`[insights-offline] OK - an offline sweep stamps nothing and reruns once the network answers (${pass} assertions).`);
