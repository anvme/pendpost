// radar-feed-quality.test.mjs - the 2026-09-25 Radar relevance fixes that act on the FEED as a
// whole rather than on one scored text (those live in radar.test.mjs):
//   (a) cached engine signals scored by an older scorer are re-scored once on read
//       (rescoreStaleSignals via listRadar); agent scores are never touched; idempotent.
//   (b) the per-query minScore the config promises ("Only signals scoring at least this show in
//       the feed") is actually applied by listRadar.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT (with a pre-seeded state.json) is set BEFORE
// importing lib, because lib/state.mjs caches the state per root on first read.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-feed-quality-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const nowIso = new Date().toISOString();
const essay = 'Wiser than me. Think of this section like a big winter coat, something wonderful in every pocket. '.repeat(40)
  + 'What tool should I use? Is there an alternative to this? I hate the cold. Can anyone recommend a scarf? Later, maybe.'.repeat(30);
const Q_SWITCH = { id: 'q_switch', label: 'incumbent switching', keywords: ['buffer alternative', 'Later alternative'], sources: ['mastodon'] };
const Q_STRICT = { id: 'q_strict', label: 'strict', keywords: ['social media scheduler'], sources: ['reddit'], minScore: 50 };
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, competitorsDefault: ['Buffer', 'Later', 'Hootsuite'], queries: [Q_SWITCH, Q_STRICT] } }));
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({
  radar: {
    seen: [],
    signals: [
      // The live shape: an old engine score on a federated blog post, no scorerVersion.
      { source: 'mastodon', externalId: 'blog1', url: 'https://m.example/@a/1', author: 'a', text: essay, matchedQuery: 'q_switch', community: null, ts: nowIso, intentScore: 75, intentTags: ['buying-question', 'recommendation-request', 'pain-described', 'competitor-mention'], suggestedAction: 'comparison-page', scoredBy: 'engine' },
      // A legacy row with no scoredBy at all is an engine score too.
      { source: 'mastodon', externalId: 'diary1', url: 'https://m.example/@b/2', author: 'b', text: 'My diary. I hate Mondays, better than last week. Which one should we pick? The alternative route, later.', matchedQuery: 'q_switch', community: null, ts: nowIso, intentScore: 65, intentTags: ['alternative-seeking'], suggestedAction: 'comparison-page' },
      // An agent verdict: a model read the thread. Never re-scored, whatever its text says.
      { source: 'hackernews', externalId: 'hn1', url: 'https://news.example/1', author: 'c', text: 'Nice work, does it handle multiple accounts?', matchedQuery: 'q_switch', community: null, ts: nowIso, intentScore: 78, intentTags: [], suggestedAction: 'reply', scoredBy: 'agent', ingested: true },
      // minScore fixtures (b): q_strict hides below 50; an agent 45 on q_strict is hidden too.
      { source: 'reddit', externalId: 'r-hi', url: 'https://r.example/1', author: 'd', text: 'What social media scheduler should I use? Hootsuite is too expensive.', matchedQuery: 'q_strict', community: null, ts: nowIso, intentScore: 80, intentTags: [], suggestedAction: 'reply', scoredBy: 'agent' },
      { source: 'reddit', externalId: 'r-lo', url: 'https://r.example/2', author: 'e', text: 'I use a social media scheduler for my shop.', matchedQuery: 'q_strict', community: null, ts: nowIso, intentScore: 45, intentTags: [], suggestedAction: 'reply', scoredBy: 'agent' },
    ],
  },
}));

try {
  const { rescoreStaleSignals, RADAR_SCORER_VERSION, RADAR_STORED_TEXT_CAP } = await import('../lib/radar.mjs');
  const { listRadar, triageSignal } = await import('../lib/writes.mjs');

  // ---- (a) pure: rescoreStaleSignals --------------------------------------
  const seed = JSON.parse(fs.readFileSync(path.join(WS, 'state.json'), 'utf8')).radar.signals;
  const pure = rescoreStaleSignals(seed, [Q_SWITCH, Q_STRICT], { competitorsDefault: ['Buffer', 'Later', 'Hootsuite'], now: Date.now() });
  ok(pure.changed === 2, `rescoreStaleSignals re-scores exactly the engine/legacy rows (changed ${pure.changed})`);
  const again = rescoreStaleSignals(pure.signals, [Q_SWITCH, Q_STRICT], { competitorsDefault: ['Buffer', 'Later', 'Hootsuite'], now: Date.now() });
  ok(again.changed === 0 && again.signals === pure.signals, 'a second pass is a no-op (idempotent via scorerVersion)');

  // ---- (a) through the read path: listRadar heals + persists -----------------
  const first = await listRadar({});
  const byId = (items, id) => items.find((s) => s.externalId === id);
  const blog = byId(first.items, 'blog1');
  ok(blog && blog.intentScore < 30, `the cached blog post is re-scored below the medium tier on read (75 -> ${blog && blog.intentScore})`);
  ok(blog && blog.scorerVersion === RADAR_SCORER_VERSION && blog.scoredBy === 'engine', 'the re-scored row is stamped with the current scorer version');
  ok(blog && blog.text.length <= RADAR_STORED_TEXT_CAP, `the re-scored row's stored text is capped (${blog && blog.text.length})`);
  const diary = byId(first.items, 'diary1');
  ok(diary && diary.intentScore < 30 && diary.scoredBy === 'engine', `a legacy row without scoredBy is treated as an engine score and re-scored (65 -> ${diary && diary.intentScore})`);
  const agent = byId(first.items, 'hn1');
  ok(agent && agent.intentScore === 78 && agent.scoredBy === 'agent' && agent.scorerVersion === undefined, 'an agent-scored signal is left exactly as the agent scored it');
  const persisted = JSON.parse(fs.readFileSync(path.join(WS, 'state.json'), 'utf8')).radar.signals;
  ok(persisted.find((s) => s.externalId === 'blog1').intentScore < 30, 'the heal is persisted to state.json (no manual data edit needed)');
  const mtime = fs.statSync(path.join(WS, 'state.json')).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await listRadar({});
  ok(fs.statSync(path.join(WS, 'state.json')).mtimeMs === mtime, 'a second read does not rewrite state.json (nothing left to heal)');
  ok(first.items[0].externalId !== 'blog1', 'the feed is re-sorted after the heal (the blog post no longer leads)');

  // ---- (b) per-query minScore ----------------------------------------------
  const feed = (await listRadar({})).items;
  ok(byId(feed, 'r-hi'), 'a q_strict signal at/above its minScore (80 >= 50) shows');
  ok(!byId(feed, 'r-lo'), 'a q_strict signal below its minScore (45 < 50) is hidden from the feed');
  ok(byId(feed, 'blog1'), 'a query WITHOUT minScore hides nothing (low scores still show, in the low tier)');
  const narrowed = (await listRadar({ queryId: 'q_strict' })).items;
  ok(narrowed.length === 1 && narrowed[0].externalId === 'r-hi', 'the minScore also holds on a query-filtered read');
  await triageSignal({ source: 'reddit', externalId: 'r-lo', action: 'watch', actor: 'test' });
  ok(byId((await listRadar({})).items, 'r-lo'), 'a WATCHED signal below its query minScore still shows (the operator pinned it)');
} catch (err) {
  failures += 1;
  console.error(`  FAIL - threw: ${err && err.stack}`);
}

console.log(`\n${pass} passed, ${failures} failed`);
if (failures) { console.error(`[radar-feed-quality] FAIL - ${failures} assertion(s) failed`); process.exitCode = 1; }
assert.ok(true);
