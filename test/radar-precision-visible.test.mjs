// radar-precision-visible.test.mjs - per-search `shown` counts only what the owner can see.
//
// Proofs: an unjudged capped signal does not raise shown; a below-minScore signal does not; a
// visible one does; watched rows are exempt (as in listRadar); a signal that becomes visible on
// a later merge counts once; radar_ingest respects the query's minScore; the tuner's disable
// rule fires for 20 visible signals with 19 marked not relevant.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-precision-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
const Q1 = { id: 'q1', label: 'strict', keywords: ['scheduler'], sources: ['hackernews'], minScore: 50 };
const Q2 = { id: 'q2', label: 'open', keywords: ['scheduler'], sources: ['hackernews'] };
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [Q1, Q2] } }));
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ radar: { signals: [], seen: [], queryStats: {} } }));

try {
  const T = await import('../lib/radar-tuner.mjs');
  const R = await import('../lib/radar.mjs');
  const { radarIngest } = await import('../lib/writes.mjs');
  const { loadState } = await import('../lib/state.mjs');

  const queryMin = R.radarQueryMinMap([Q1, Q2]);
  const sig = (id, extra) => ({ source: 'hackernews', externalId: id, matchedQuery: 'q1', intentScore: 80, ...extra });
  const vis = (s) => R.isFeedVisible(s, queryMin);
  const shownAfter = (signals) => {
    const stats = {};
    T.bumpShown(stats, new Set(), signals, Date.now(), vis);
    return (stats.q1 || { shown: 0 }).shown;
  };

  ok(shownAfter([sig('a', { intentScore: 25, unjudged: true })]) === 0, 'an unjudged capped signal does not raise shown');
  ok(shownAfter([sig('b', { intentScore: 49 })]) === 0, 'a signal below the query minScore does not raise shown');
  ok(shownAfter([sig('c', { intentScore: 50 })]) === 1, 'a signal at the query minScore raises shown');
  ok(shownAfter([sig('d')]) === 1, 'a visible signal raises shown');
  ok(shownAfter([sig('e', { intentScore: 10, watched: true })]) === 1, 'a watched signal is exempt, as in listRadar');
  ok(shownAfter([{ ...sig('f', { intentScore: 10 }), matchedQuery: 'gone' }]) === 0 && vis({ ...sig('f', { intentScore: 10 }), matchedQuery: 'gone' }), 'an orphan (no threshold) is visible');

  // Becoming visible later: the baseline holds only VISIBLE keys, so a re-judged signal counts once.
  const stats2 = {};
  const capped = sig('g', { intentScore: 25, unjudged: true });
  const before = new Set([capped].filter(vis).map(R.signalKey));
  T.bumpShown(stats2, before, [{ ...capped, intentScore: 70, unjudged: false }], Date.now(), vis);
  ok(stats2.q1 && stats2.q1.shown === 1, 'an unjudged signal that a re-scan judges relevant counts once');
  T.bumpShown(stats2, new Set([R.signalKey(capped)]), [{ ...capped, intentScore: 70 }], Date.now(), vis);
  ok(stats2.q1.shown === 1, 'a signal already visible before the merge is not counted again');

  // Old behaviour is kept when no predicate is passed (stored stats and other callers).
  const legacy = {};
  T.bumpShown(legacy, new Set(), [sig('h', { unjudged: true })]);
  ok(legacy.q1.shown === 1, 'without a predicate every signal still counts');

  // The real seam: radar_ingest into a strict and an open search.
  const text = 'looking for a social media scheduler tool, any recommendations?';
  const mk = (id) => ({ source: 'hackernews', ts: new Date().toISOString(), externalId: id, url: `https://news.example/${id}`, author: `u${id}`, text });
  const r1 = await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [mk('i1')] });
  const r2 = await radarIngest({ actor: 'agent:claude', queryId: 'q2', signals: [mk('i2')] });
  ok(r1.ok && r2.ok, 'ingest ok');
  const st = loadState().radar;
  const stored = new Map(st.signals.map((s) => [s.matchedQuery, s]));
  const expect1 = stored.get('q1') && Number(stored.get('q1').intentScore) >= 50 ? 1 : 0;
  ok(((st.queryStats.q1 || {}).shown || 0) === expect1, `ingest into the strict search counts shown=${expect1} by the stored score`);
  ok(((st.queryStats.q2 || {}).shown || 0) === 1, 'ingest into the open search counts shown=1');

  // The disable rule: 20 visible signals, 19 marked not relevant -> 5% < 10% -> backed.
  const visible = Array.from({ length: 20 }, (_, i) => sig(`v${i}`));
  const dstats = {};
  T.bumpShown(dstats, new Set(), visible, Date.now(), vis);
  T.bumpQueryStat(dstats, 'q1', 'less', 19);
  const noise = Array.from({ length: 40 }, (_, i) => sig(`n${i}`, { intentScore: 25, unjudged: true }));
  T.bumpShown(dstats, new Set(), noise, Date.now(), vis);
  ok(dstats.q1.shown === 20, 'capped noise does not pad the denominator (shown stays 20)');
  const v = T.validateTuneOutput({ changes: [{ queryId: 'q1', kind: 'disable', why: 'noise' }] }, { queries: [Q1], stats: dstats });
  ok(v.ok && v.narrowing.some((c) => c.kind === 'disable'), 'the disable rule fires at 20 visible / 19 less');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack ? err.stack : err);
}

try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
if (failures) {
  console.error(`[radar-precision-visible] FAIL - ${failures} assertion(s) failed, ${pass} passed`);
  assert.fail(`${failures} assertion(s) failed`);
}
console.log(`[radar-precision-visible] OK - shown counts only feed-visible signals (${pass} assertions).`);
