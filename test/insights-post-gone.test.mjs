#!/usr/bin/env node
// test/insights-post-gone.test.mjs - a deleted post is not a broken lane.
//
// Live finding: a Meta media deleted on the platform but still in a plan made every nightly
// insights read answer Graph #100 "Unsupported get request. Object with ID '...' does not
// exist", and the sweep recorded the whole Meta lane as reason "error". That is a per-post
// fact, not a lane failure.
//
// Proves, credential-free and network-free:
//   1. Engine (scripts/meta-social.mjs cmdInsights, in-process, stubbed fetch): a #100
//      "does not exist" on an IG media or an FB reel is a per-post `post_gone` row; posts
//      named in --skip-gone are not read at all.
//   2. Sweep (lib/insights.mjs fetchInsights, fake meta engine): a post_gone row is recorded
//      on that post's insights entry (gone.at), never counts toward the lane's failure class
//      (the lane reads healthy when every other post succeeds), is passed back as
//      --skip-gone on the next sweep, and the plan file is never touched.
//   3. A #100 on EVERY post of a lane with nothing succeeding is not read as "all deleted"
//      (the same #100 text also covers missing permissions): it stays a lane error.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-insights-gone-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const GONE_MSG = "Unsupported get request. Object with ID '17890000000000009' does not exist, cannot be loaded due to missing permissions, or does not support this operation.";
const realFetch = global.fetch;
const res = (body, { status = 200 } = {}) => Promise.resolve({
  ok: status >= 200 && status < 300, status, headers: new Map(),
  json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)),
});
const goneBody = () => res({ error: { message: GONE_MSG, type: 'GraphMethodException', code: 100 } }, { status: 400 });

// Fake meta engine for the sweep half: logs its argv, answers with behavior.json.
const CALLS = path.join(WS, 'calls.log');
const BEHAVIOR = path.join(WS, 'behavior.json');
const FAKE = path.join(WS, 'fake-meta.mjs');
fs.writeFileSync(FAKE, `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(process.argv.slice(2)) + '\\n');
let b = {};
try { b = JSON.parse(fs.readFileSync(${JSON.stringify(BEHAVIOR)}, 'utf8')); } catch {}
console.log(JSON.stringify(b[process.argv[2]] || { ok: true, results: [] }));
`);
const setBehavior = (b) => fs.writeFileSync(BEHAVIOR, JSON.stringify(b));
const insightsCalls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((a) => a[0] === 'insights');

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'local', path: 'data/plans/local.json', active: true }],
}, null, 2));
const PLAN = path.join(WS, 'data', 'plans', 'local.json');
const post = (id, extra) => ({ id, platforms: ['instagram'], status: 'posted', postedAt: '2026-09-01T00:00:00Z', scheduledAt: '2026-09-01T00:00:00Z', caption: id, ...extra });
fs.writeFileSync(PLAN, JSON.stringify({
  campaign: 'local',
  posts: [
    post('ig1', { igMediaId: '17890000000000001' }),
    post('ig2', { igMediaId: '17890000000000009' }),
    post('ig3', { igMediaId: '17890000000000003' }),
    post('fb1', { platforms: ['facebook'], fbReelId: '99990000000000009' }),
  ],
}, null, 2));
fs.writeFileSync(path.join(WS, '.env'), 'META_PAGE_TOKEN=fake-page-token\nMETA_PAGE_ID=pg1\n');

try {
  // ---- 1. engine ---------------------------------------------------------------------
  const meta = await import('../scripts/meta-social.mjs');
  const fetched = [];
  globalThis.fetch = (url) => {
    const u = String(url);
    fetched.push(u);
    if (u.includes('17890000000000009') || u.includes('99990000000000009')) return goneBody();
    if (u.includes('/insights')) return res({ data: [{ name: 'reach', values: [{ value: 7 }] }] });
    return res({});
  };
  meta.RUN.results.length = 0;
  await meta.cmdInsights({ plan: PLAN });
  const row = (id) => meta.RUN.results.find((r) => r.postId === id);
  ok(row('ig1').ok === true && row('ig3').ok === true, 'engine: the live IG posts still return metrics');
  ok(row('ig2').ok === false && row('ig2').error === 'post_gone', 'engine: an IG #100 "does not exist" is a per-post post_gone row');
  ok(row('fb1').ok === false && row('fb1').error === 'post_gone', 'engine: an FB reel #100 "does not exist" is a post_gone row (not the generic metric-set miss)');
  ok(meta.metaPostGone({ fbCode: 100, message: GONE_MSG }) && !meta.metaPostGone({ fbCode: 100, message: 'Invalid parameter' }) && !meta.metaPostGone({ fbCode: 10, message: 'does not exist' }), 'engine: only #100 with "does not exist" is post_gone');

  fetched.length = 0;
  meta.RUN.results.length = 0;
  await meta.cmdInsights({ plan: PLAN, 'skip-gone': 'ig2/instagram,fb1/facebook' });
  ok(!fetched.some((u) => u.includes('17890000000000009') || u.includes('99990000000000009')), 'engine: --skip-gone posts are not read at all');
  ok(!row('ig2') && !row('fb1') && row('ig1').ok === true, 'engine: skipped posts emit no row; the rest are read as usual');
  globalThis.fetch = realFetch;

  // ---- 2. sweep ----------------------------------------------------------------------
  process.env.PENDPOST_META_ENGINE = FAKE;
  const { fetchInsights, getInsights } = await import('../lib/insights.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const planBefore = fs.readFileSync(PLAN, 'utf8');

  // ig3 was measured before it disappeared: its metrics stay, it gains `gone`.
  const st0 = loadState();
  st0.insights = { data: { 'local/ig3/instagram': { campaign: 'local', postId: 'ig3', platform: 'instagram', metrics: { reach: 3 }, fetchedAt: '2026-09-02T00:00:00Z', history: [{ fetchedAt: '2026-09-02T00:00:00Z', metrics: { reach: 3 } }] } } };
  saveState();

  const goneRow = (id, platform = 'instagram') => ({ postId: id, platform, action: 'insights', ok: false, error: 'post_gone', errorCode: 100, errorMessage: `Graph GET /x/insights: HTTP 400 GraphMethodException 100 - ${GONE_MSG}` });
  setBehavior({ insights: { ok: true, results: [
    { postId: 'ig1', platform: 'instagram', action: 'insights', ok: true, metrics: { reach: 7 } },
    goneRow('ig2'), goneRow('ig3'),
  ] } });
  const r1 = await fetchInsights({ campaign: 'local' });
  const st1 = loadState();
  ok(!st1.insights.unavailable?.meta, 'sweep: the Meta lane is NOT recorded unavailable when the only failures are gone posts');
  ok(Array.isArray(r1.failedLanes) && r1.failedLanes.length === 0, 'sweep: failedLanes is empty');
  ok(!(st1.activity || []).some((a) => a.action === 'insights-fetch' && a.ok === false), 'sweep: no failed insights activity row');
  ok(typeof st1.insights.data['local/ig2/instagram']?.gone?.at === 'string', 'sweep: the gone post carries insights.data[key].gone.at');
  ok(st1.insights.data['local/ig3/instagram'].metrics.reach === 3 && st1.insights.data['local/ig3/instagram'].gone, 'sweep: a previously measured post keeps its last metrics and is marked gone');
  ok(st1.insights.data['local/ig1/instagram'].metrics.reach === 7 && !st1.insights.data['local/ig1/instagram'].gone, 'sweep: the live post is stored as usual');
  const items = getInsights().items;
  ok(!items.some((i) => i.postId === 'ig2'), 'getInsights: a never-measured gone post is not shown as a zero-engagement item');
  ok(items.some((i) => i.postId === 'ig3'), 'getInsights: a measured-then-gone post keeps its historical row');
  ok(fs.readFileSync(PLAN, 'utf8') === planBefore, 'the plan file is untouched');

  // Next sweep: the gone posts are handed to the engine as --skip-gone.
  fs.rmSync(CALLS, { force: true });
  setBehavior({ insights: { ok: true, results: [{ postId: 'ig1', platform: 'instagram', action: 'insights', ok: true, metrics: { reach: 8 } }] } });
  await fetchInsights({ campaign: 'local' });
  const argv = insightsCalls()[0] || [];
  const i = argv.indexOf('--skip-gone');
  const skipList = i >= 0 ? argv[i + 1].split(',') : [];
  ok(skipList.includes('ig2/instagram') && skipList.includes('ig3/instagram') && !skipList.includes('ig1/instagram'), `sweep: the next run passes --skip-gone for the gone posts only (${skipList.join(',')})`);
  ok(loadState().insights.data['local/ig2/instagram'].gone, 'sweep: a skipped gone post stays marked gone');

  // ---- 3. lane-wide #100 is not "everything was deleted" -----------------------------
  const st2 = loadState();
  st2.insights = { data: {} };
  saveState();
  setBehavior({ insights: { ok: true, results: [goneRow('ig1'), goneRow('ig2'), goneRow('ig3')] } });
  await fetchInsights({ campaign: 'local' });
  const st3 = loadState();
  ok(st3.insights.unavailable?.meta?.reason === 'error', 'a #100 on every post with nothing succeeding stays a lane error');
  ok(!Object.values(st3.insights.data || {}).some((d) => d.gone), 'and no post is marked gone (nothing gets skipped forever)');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[insights-post-gone] OK - a deleted post is a per-post post_gone, skipped later, and never fails the lane (${pass} assertions).`);
} catch (err) {
  console.error(`[insights-post-gone] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
