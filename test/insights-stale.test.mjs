#!/usr/bin/env node
// test/insights-stale.test.mjs - the nightly summary row stops saying "ok" over a stale lane.
//
// Observed 2026-10-13 on a live client: linkedin/meta/youtube had been unavailable since
// 2026-10-10/11, yet every nightly insights-fetch summary row read ok:true, because lane rows
// are written only on a STATE CHANGE and the same reason the next night logs nothing. Proven
// here through the REAL sweep with fake engines (PENDPOST_<LANE>_ENGINE overrides):
//   1. a lane unavailable for more than 2 days turns the summary row ok:false, errorCode
//      insights_stale, naming the lane and the date it stopped refreshing (lanes[] structured).
//   2. a lane unavailable for less than 2 days leaves the summary row neutral.
//   3. an offline streak longer than 2 days is stale too (reason 'offline').
//   4. getInsights().stale carries the stale lanes for the Studio Insights page.
//   5. the digest names a stale lane every morning it lasts (en and de-CH, no em dash), even
//      after the once-on-change line has already gone out.
//   6. once the lane refreshes again the row is neutral and stale is empty.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-insights-stale-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const DAY = 24 * 3600 * 1000;
const BEHAVIOR = path.join(WS, 'behavior.json');
const LANES = ['linkedin', 'youtube'];
for (const lane of LANES) {
  const p = path.join(WS, `fake-${lane}.mjs`);
  fs.writeFileSync(p, `
import fs from 'node:fs';
const verb = process.argv[2];
let b = {};
try { b = JSON.parse(fs.readFileSync(${JSON.stringify(BEHAVIOR)}, 'utf8')); } catch {}
console.log(JSON.stringify((b[${JSON.stringify(lane)}] || {})[verb] || { ok: true, results: [] }));
`);
  process.env[`PENDPOST_${lane.toUpperCase()}_ENGINE`] = p;
}
const setBehavior = (b) => fs.writeFileSync(BEHAVIOR, JSON.stringify(b));

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'local', path: 'data/plans/local.json', active: true }] }));
const recent = new Date(Date.now() - DAY).toISOString();
fs.writeFileSync(path.join(WS, 'data', 'plans', 'local.json'), JSON.stringify({
  campaign: 'local',
  posts: [
    { id: 'li1', platforms: ['linkedin'], status: 'posted', postedAt: recent, liPostId: 'urn:li:share:1', scheduledAt: recent, caption: 'li' },
    { id: 'yt1', platforms: ['youtube'], status: 'posted', postedAt: recent, ytVideoId: 'vid1', scheduledAt: recent, caption: 'yt' },
  ],
}));
fs.writeFileSync(path.join(WS, '.env'), 'LINKEDIN_ACCESS_TOKEN=aaaa\nLINKEDIN_REFRESH_TOKEN=rrrr\nYT_REFRESH_TOKEN=yyyy\n');

const postOf = { linkedin: 'li1', youtube: 'yt1' };
const good = (lane) => ({ insights: { ok: true, results: [{ postId: postOf[lane], platform: lane, action: 'insights', ok: true, metrics: { likes: 2 } }] } });
const broken = (lane) => ({ insights: { ok: true, results: [{ postId: postOf[lane], platform: lane, action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: 'HTTP 500 internal error' }] } });
const offlineFail = (lane) => ({ insights: { ok: true, results: [{ postId: postOf[lane], platform: lane, action: 'insights', ok: false, errorCode: 'engine_failure', errorMessage: 'fetch failed' }] } });

const { dailyInsightsSweep, getInsights, generateDigest } = await import('../lib/insights.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const summary = () => (loadState().activity || []).find((a) => a.action === 'insights-fetch' && !a.platform);
const setInsights = (patch) => { const st = loadState(); st.insights = { ...(st.insights || {}), ...patch }; saveState(); };
const openGuard = () => setInsights({ lastFetch: new Date(Date.now() - 2 * DAY).toISOString() });
const sweep = () => { openGuard(); return dailyInsightsSweep({ netProbe: async () => true }); };

try {
  // ---- 1. unavailable for 3 days, still failing the same way ---------------------------------
  const since3 = new Date(Date.now() - 3 * DAY).toISOString();
  setInsights({ data: {}, unavailable: { linkedin: { reason: 'error', at: new Date(Date.now() - DAY).toISOString(), since: since3, detail: 'HTTP 500 internal error', fp: null } } });
  setBehavior({ linkedin: broken('linkedin'), youtube: good('youtube') });
  const r1 = await sweep();
  let row = summary();
  ok(row && row.ok === false && row.errorCode === 'insights_stale', `the summary row reads failed while a lane is stale (got ${JSON.stringify(row)})`);
  ok(row && /LinkedIn since/.test(row.errorMessage) && /more than 2 days/.test(row.errorMessage), `the summary row names the stale lane and how long (got ${JSON.stringify(row?.errorMessage)})`);
  ok(row && Array.isArray(row.lanes) && row.lanes[0]?.lane === 'linkedin' && row.lanes[0]?.since === since3 && row.lanes[0]?.reason === 'error', 'the summary row carries lanes[] { lane, reason, since } for the Studio');
  ok(row && !/—/.test(row.errorMessage), 'no em dash in the summary row');
  ok(loadState().insights.unavailable.linkedin.since === since3, 'the same reason keeps its since (the stale clock is not reset by the nightly re-stamp)');
  ok(Array.isArray(r1?.staleLanes) && r1.staleLanes.length === 1, 'the envelope returns staleLanes');

  // ---- 4. getInsights carries it for the Studio ---------------------------------------------
  const g = getInsights();
  ok(Array.isArray(g.stale) && g.stale.length === 1 && g.stale[0].lane === 'linkedin' && g.stale[0].since === since3, `getInsights().stale names the stale lane (got ${JSON.stringify(g.stale)})`);

  // ---- 5. digest: named every morning, both locales ------------------------------------------
  const st = loadState();
  st.notify = { ...(st.notify || {}), prevDigestAt: new Date().toISOString() };
  saveState();
  const en = generateDigest({ locale: 'en' }).digest;
  ok(/Statistics have not refreshed for more than 2 days: LinkedIn since /.test(en), 'the en digest names the stale lane even after the once-on-change line went out');
  ok(!/Metrics unavailable:.*LinkedIn/.test(en), 'a stale lane is not also in the once-on-change line');
  const de = generateDigest({ locale: 'de-CH' }).digest;
  ok(/Statistiken seit mehr als 2 Tagen nicht aktualisiert: LinkedIn seit /.test(de), 'the de-CH digest names the stale lane');
  ok(!/—/.test(en) && !/—/.test(de), 'no em dash in either digest');

  // ---- 2. less than 2 days is not stale -------------------------------------------------------
  setInsights({ unavailable: { linkedin: { reason: 'error', at: new Date().toISOString(), since: new Date(Date.now() - DAY).toISOString(), detail: 'x', fp: null } } });
  await sweep();
  row = summary();
  ok(row && row.ok === true && row.errorCode === null, `a lane unavailable for 1 day leaves the summary neutral (got ${JSON.stringify(row)})`);

  // ---- 3. an offline streak longer than 2 days ------------------------------------------------
  setInsights({ unavailable: {}, offline: { since: new Date(Date.now() - 3 * DAY).toISOString(), at: new Date(Date.now() - 2 * DAY).toISOString(), lanes: ['linkedin', 'youtube'] } });
  setBehavior({ linkedin: offlineFail('linkedin'), youtube: offlineFail('youtube') });
  await sweep();
  row = summary();
  ok(row && row.ok === false && row.errorCode === 'insights_stale' && row.lanes.every((l) => l.reason === 'offline'), `a 3-day offline streak is stale (got ${JSON.stringify(row)})`);

  // ---- 6. recovery ----------------------------------------------------------------------------
  setInsights({ offline: undefined, unavailable: { linkedin: { reason: 'error', at: new Date().toISOString(), since: since3, detail: 'x', fp: null } } });
  setBehavior({ linkedin: good('linkedin'), youtube: good('youtube') });
  await sweep();
  row = summary();
  ok(row && row.ok === true && row.errorCode === null, 'once the lane refreshes the summary row is neutral again');
  ok(getInsights().stale.length === 0, 'and getInsights().stale is empty');
} finally {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures) { console.error(`[insights-stale] FAIL - ${failures} failure(s), ${pass} passed.`); process.exit(1); }
console.log(`[insights-stale] OK - a lane stale for more than 2 days is named by the summary row, the digest and getInsights (${pass} assertions).`);
