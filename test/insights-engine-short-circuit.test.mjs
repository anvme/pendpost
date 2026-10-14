#!/usr/bin/env node
// test/insights-engine-short-circuit.test.mjs - the engines stop failing every post the
// same way. A permission or token refusal on a metrics read does not change from one post
// to the next, so the per-post loops used to emit ~110 identical failure rows a night
// (LinkedIn without the Community Management product, Meta without the insights
// permission) and YouTube called the disabled Analytics API once per video.
//
// Proves, IN-PROCESS against a stubbed global.fetch (no network, no credentials):
//   1. LinkedIn cmdInsights: the first 403 ends the loop with ONE needs_scope row.
//   2. Meta cmdInsights: the first #10 permission refusal ends the loop with ONE
//      needs_scope row; a per-post #100 (deleted media) keeps going.
//   3. YouTube cmdInsights: the first watch-time 403 stops the Analytics call for the
//      remaining videos, and every video still gets its base statistics row.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-insights-short-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const realFetch = global.fetch;
const res = (body, { status = 200 } = {}) => Promise.resolve({
  ok: status >= 200 && status < 300, status,
  headers: new Map(),
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  const root = clientRoot('default');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), [
    'LINKEDIN_ACCESS_TOKEN=li-tok', `LINKEDIN_TOKEN_EXPIRES_AT=${Date.now() + 60 * 24 * 3600 * 1000}`, 'LINKEDIN_ORG_URN=urn:li:organization:1',
    'META_PAGE_TOKEN=pg-tok', 'META_PAGE_ID=pg1',
    'YT_REFRESH_TOKEN=yt-r', 'YT_CLIENT_ID=yt-c', 'YT_CLIENT_SECRET=yt-s',
  ].join('\n') + '\n', { mode: 0o600 });
  const planPath = path.join(WS, 'plan.json');
  const posts = [];
  for (let i = 1; i <= 5; i++) {
    posts.push({ id: `li${i}`, platforms: ['linkedin'], liPostId: `urn:li:share:${i}`, status: 'posted' });
    posts.push({ id: `ig${i}`, platforms: ['instagram'], igMediaId: `178${i}`, status: 'posted' });
    posts.push({ id: `yt${i}`, platforms: ['youtube'], ytVideoId: `vid${i}`, status: 'posted' });
  }
  fs.writeFileSync(planPath, JSON.stringify({ campaign: 'c', posts }));

  // ---- 1. LinkedIn ------------------------------------------------------------------
  const li = await import('../scripts/linkedin-social.mjs');
  let liCalls = 0;
  globalThis.fetch = (url) => {
    if (String(url).includes('organizationalEntityShareStatistics')) liCalls += 1;
    return res({ code: 'ACCESS_DENIED', message: 'Not enough permissions to access: organizationalEntityShareStatistics' }, { status: 403 });
  };
  li.RUN.results.length = 0;
  await li.cmdInsights({ plan: planPath });
  ok(liCalls === 1, `LinkedIn: one 403 ends the loop (calls: ${liCalls}, was one per post)`);
  ok(li.RUN.results.length === 1 && li.RUN.results[0].ok === false && li.RUN.results[0].error === 'needs_scope', 'LinkedIn: exactly one needs_scope row for the lane');
  ok(li.liInsightsStopClass(new Error('LinkedIn GET /x: HTTP 401 - expired')) === 'token', 'LinkedIn: a 401 is the token class (also stops)');
  ok(li.liInsightsStopClass(new Error('LinkedIn GET /x: HTTP 500 - oops')) === null, 'LinkedIn: a 500 is per-post (keeps going)');

  // ---- 2. Meta ----------------------------------------------------------------------
  const meta = await import('../scripts/meta-social.mjs');
  let igCalls = 0;
  globalThis.fetch = (url) => {
    igCalls += 1;
    return res({ error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10 } }, { status: 400 });
  };
  meta.RUN.results.length = 0;
  await meta.cmdInsights({ plan: planPath });
  const igRows = meta.RUN.results.filter((r) => r.platform === 'instagram');
  ok(igRows.length === 1 && igRows[0].error === 'needs_scope', `Meta: a #10 permission refusal ends the loop with one needs_scope row (rows: ${igRows.length})`);
  const callsForOne = igCalls;
  // A per-post #100 (media deleted) is NOT a lane problem: every post is still tried.
  globalThis.fetch = () => res({ error: { message: 'Unsupported get request. Object does not exist', type: 'GraphMethodException', code: 100 } }, { status: 400 });
  meta.RUN.results.length = 0;
  await meta.cmdInsights({ plan: planPath });
  ok(meta.RUN.results.filter((r) => r.platform === 'instagram').length === 5, 'Meta: a per-post #100 keeps going (every post still tried)');
  ok(callsForOne <= 4, `Meta: the permission case stops after the first post's attempts (calls: ${callsForOne})`);
  ok(meta.metaInsightsStopClass({ fbCode: 190 }) === 'token' && meta.metaInsightsStopClass({ fbCode: 100 }) === null, 'Meta: #190 is token, #100 is per-post');

  // ---- 3. YouTube -------------------------------------------------------------------
  const yt = await import('../scripts/yt-social.mjs');
  let analyticsCalls = 0;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('oauth2') || u.includes('/token')) return res({ access_token: 'at', expires_in: 3600 });
    if (u.includes('youtubeanalytics')) {
      analyticsCalls += 1;
      return res({ error: { message: 'YouTube Analytics API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }, { status: 403 });
    }
    if (u.includes('/videos')) {
      return res({ items: [1, 2, 3, 4, 5].map((i) => ({ id: `vid${i}`, statistics: { viewCount: '10', likeCount: '1', commentCount: '0' }, status: { privacyStatus: 'public' } })) });
    }
    return res({});
  };
  yt.RUN.results.length = 0;
  await yt.cmdInsights({ plan: planPath });
  const ytRows = yt.RUN.results.filter((r) => r.action === 'insights');
  ok(analyticsCalls === 1, `YouTube: the disabled Analytics API is called once, not once per video (calls: ${analyticsCalls})`);
  ok(ytRows.length === 5 && ytRows.every((r) => r.ok === true && typeof r.metrics.views === 'number'), 'YouTube: every video still gets its base statistics row');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[insights-engine-short-circuit] OK - LinkedIn/Meta stop at the first lane-wide refusal, YouTube stops calling a disabled Analytics API (${pass} assertions).`);
} catch (err) {
  console.error(`[insights-engine-short-circuit] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
