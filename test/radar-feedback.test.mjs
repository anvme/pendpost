// radar-feedback.test.mjs - per-signal steering (2026-09-25). The owner marks a signal "less like
// this" (dismiss + remember it) or "more like this" (remember it, keep the row). The examples are
// STATE (state.radar.feedback[queryId] = { less:[...], more:[...] }, capped 10 per side, newest
// wins), the Undo path removes the example it added, and the next agent scan brief lists them under
// the query they belong to, so the scanning agent steers away from / toward similar threads.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT with a pre-seeded state.json, set BEFORE
// importing lib (lib/state.mjs caches per root on first read).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-feedback-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const nowIso = new Date().toISOString();
const Q1 = { id: 'q1', label: 'self-hosted switchers', keywords: ['self-hosted social scheduler'], sources: ['mastodon'] };
const Q2 = { id: 'q2', label: 'agent posting', keywords: ['MCP social'], sources: ['hackernews'] };
const sig = (id, q, text, extra = {}) => ({ source: 'mastodon', externalId: id, url: `https://m.example/@a/${id}`, author: 'a', text, matchedQuery: q, community: null, ts: nowIso, intentScore: 40, intentTags: [], suggestedAction: 'reply', scoredBy: 'agent', ...extra });
const longText = `Organic cotton mesh bags: build a plastic-free grocery routine. ${'Discover simple swaps for the market. '.repeat(20)}`;
const signals = [
  sig('junk1', 'q1', longText),
  sig('good1', 'q1', 'Is there a self-hosted social scheduler that can post to Mastodon and Bluesky?'),
  sig('orph1', 'gone_query', 'A signal whose query was deleted.'),
];
for (let i = 0; i < 12; i++) signals.push(sig(`bulk${i}`, 'q2', `Noise example number ${i}`));
// The auto-mute cases (relevance plan 1d): a relay author, two strangers on one big instance, an
// author the owner only ever marks done, and a Hacker News user (no home domain at all).
signals.push(
  sig('m1', 'q1', 'Relay post one', { author: 'Spam@relay.example', authorDomain: 'relay.example' }),
  sig('m2', 'q1', 'Relay post two', { author: 'spam@relay.example', authorDomain: 'relay.example' }),
  sig('big1', 'q1', 'Stranger one', { author: 'one@mastodon.social', authorDomain: 'mastodon.social' }),
  sig('big2', 'q1', 'Stranger two', { author: 'two@mastodon.social', authorDomain: 'mastodon.social' }),
  sig('eve1', 'q1', 'Handled one', { author: 'eve' }),
  sig('eve2', 'q1', 'Handled two', { author: 'eve' }),
  sig('hn1', 'q2', 'HN comment one', { source: 'hackernews', author: 'zed', url: 'https://news.ycombinator.com/item?id=1' }),
  sig('hn2', 'q2', 'HN comment two', { source: 'hackernews', author: 'zed', url: 'https://news.ycombinator.com/item?id=2' }),
);
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [Q1, Q2] } }));
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ radar: { seen: [], signals } }));

try {
  const { RADAR_FEEDBACK_CAP, RADAR_FEEDBACK_EXCERPT } = await import('../lib/radar.mjs');
  const { triageSignal, restoreSignals, listRadar } = await import('../lib/writes.mjs');
  const { radarScanPrompt } = await import('../lib/radar-prompt.mjs');
  const { loadState } = await import('../lib/state.mjs');
  const fb = () => (loadState().radar.feedback || {});

  // ---- validation --------------------------------------------------------
  const bad = await triageSignal({ source: 'mastodon', externalId: 'junk1', feedback: 'sideways', actor: 'test' });
  ok(bad.code === 'invalid_input', 'an unknown feedback value is refused');
  const badCombo = await triageSignal({ source: 'mastodon', externalId: 'junk1', action: 'watch', feedback: 'less', actor: 'test' });
  ok(badCombo.code === 'invalid_input', 'feedback:"less" with a non-dismiss action is refused (less always dismisses)');

  // ---- less = dismiss + remember -------------------------------------------
  const less = await triageSignal({ source: 'mastodon', externalId: 'junk1', feedback: 'less', actor: 'test' });
  ok(less.ok === true && less.action === 'dismiss' && less.feedback === 'less' && less.queryId === 'q1', `feedback:"less" dismisses and reports the query it steered (${JSON.stringify({ a: less.action, f: less.feedback, q: less.queryId })})`);
  ok(!(await listRadar({})).items.some((s) => s.externalId === 'junk1'), '"less" removes the signal from the feed like a dismiss');
  const ex = fb().q1 && fb().q1.less && fb().q1.less[0];
  ok(ex && ex.source === 'mastodon' && ex.externalId === 'junk1' && ex.url === 'https://m.example/@a/junk1' && typeof ex.at === 'string', 'the example stores source, externalId, url and a timestamp');
  ok(ex && ex.excerpt.length <= RADAR_FEEDBACK_EXCERPT && ex.excerpt.startsWith('Organic cotton mesh bags'), `the excerpt is the opening, capped at ${RADAR_FEEDBACK_EXCERPT} chars (${ex && ex.excerpt.length})`);
  ok(!('feedback' in (JSON.parse(fs.readFileSync(path.join(WS, 'config.json'), 'utf8')).radar)), 'feedback lives in STATE, never in config');

  // ---- more = remember, keep the row ---------------------------------------
  const more = await triageSignal({ source: 'mastodon', externalId: 'good1', feedback: 'more', actor: 'test' });
  ok(more.ok === true && more.feedback === 'more' && more.queryId === 'q1', '"more" is accepted without an action');
  ok((await listRadar({})).items.some((s) => s.externalId === 'good1'), '"more" keeps the signal in the feed (no dismiss)');
  ok(fb().q1.more.length === 1 && fb().q1.more[0].externalId === 'good1', 'the "more" example is stored under its query');
  const moreAgain = await triageSignal({ source: 'mastodon', externalId: 'good1', feedback: 'more', actor: 'test' });
  ok(moreAgain.ok === true && fb().q1.more.length === 1, 'repeating "more" on the same signal is idempotent (no duplicate example)');

  // ---- cap: 10 per side, newest wins ---------------------------------------
  for (let i = 0; i < 12; i++) await triageSignal({ source: 'mastodon', externalId: `bulk${i}`, feedback: 'less', actor: 'test' });
  const q2less = fb().q2.less;
  ok(q2less.length === RADAR_FEEDBACK_CAP && RADAR_FEEDBACK_CAP === 10, `each side is capped at ${RADAR_FEEDBACK_CAP} (${q2less.length})`);
  ok(q2less[0].externalId === 'bulk2' && q2less[q2less.length - 1].externalId === 'bulk11', 'the newest examples win (bulk0/bulk1 aged out)');

  // ---- Undo removes the example it added ------------------------------------
  const junkObj = signals.find((s) => s.externalId === 'junk1');
  const undo = await restoreSignals({ signals: [junkObj], actor: 'test' });
  ok(undo.ok === true && undo.restored === 1, 'Undo restores the dismissed signal');
  ok(!(fb().q1.less || []).some((e) => e.externalId === 'junk1'), 'Undo also removes the "less" example the dismiss added');
  ok(fb().q1.more.length === 1, 'Undo leaves the other examples alone');

  // ---- orphan queries -------------------------------------------------------
  const orph = await triageSignal({ source: 'mastodon', externalId: 'orph1', feedback: 'less', actor: 'test' });
  ok(orph.ok === true && orph.action === 'dismiss', 'a signal of a deleted query still dismisses');
  ok(!('gone_query' in fb()), 'no feedback is stored under a query that no longer exists');
  // A query deleted AFTER it collected feedback: the next feedback write prunes it.
  loadState().radar.feedback.stale_q = { less: [{ excerpt: 'old', url: 'https://x.example', source: 'reddit', externalId: 'o', at: nowIso }], more: [] };
  await triageSignal({ source: 'mastodon', externalId: 'good1', feedback: 'more', actor: 'test' });
  ok(!('stale_q' in fb()), 'feedback for a deleted query is pruned on the next feedback write');

  // ---- the scan brief lists the examples per query --------------------------
  const queries = [Q1, Q2].map((q) => ({ ...q, feedback: fb()[q.id] }));
  const brief = radarScanPrompt(queries, 20, 'default', ['mastodon', 'hackernews']);
  ok(brief.includes('The owner marked these as NOT relevant - avoid similar results:'), 'the brief carries the NOT-relevant heading');
  ok(brief.includes('The owner wants MORE like these:'), 'the brief carries the MORE heading');
  ok(brief.includes('Is there a self-hosted social scheduler that can post to Mastodon'), 'a "more" excerpt reaches the brief');
  ok(brief.includes('Noise example number 11'), 'a "less" excerpt reaches the brief');
  const q1Block = brief.slice(brief.indexOf('queryId: q1'), brief.indexOf('queryId: q2'));
  ok(q1Block.includes('The owner wants MORE like these:') && !q1Block.includes('Noise example'), 'examples are listed under the query they belong to');
  const plain = radarScanPrompt([Q1, Q2], 20, 'default', ['mastodon', 'hackernews']);
  ok(!plain.includes('NOT relevant') && !plain.includes('MORE like these'), 'a query with no feedback gets no feedback lines (brief unchanged)');
  ok(!/[—–]/.test(brief.slice(brief.indexOf('The owner'))), 'the feedback lines carry no em or en dashes');
  const tooLong = { ...Q1, feedback: { less: [{ excerpt: 'y'.repeat(900) }], more: [] } };
  const longBrief = radarScanPrompt([tooLong], 20, 'default', ['mastodon']);
  ok(!longBrief.includes('y'.repeat(RADAR_FEEDBACK_EXCERPT + 1)), 'an oversized stored excerpt is clipped in the brief');

  // ---- instant learning: two "not relevant" taps mute the author (plan 1d) -------------------
  const { isMuted } = await import('../lib/radar-prefilter.mjs');
  const st = () => loadState().radar;
  const stat = (q, f) => ((st().queryStats || {})[q] || {})[f] || 0;
  const obj = (id) => signals.find((s) => s.externalId === id);
  const lessBefore = stat('q1', 'less');
  const r1 = await triageSignal({ source: 'mastodon', externalId: 'm1', feedback: 'less', actor: 'test' });
  ok(r1.ok === true && !r1.muted && !st().muted.authors.some((a) => a.value === 'spam@relay.example'), 'one "not relevant" tap mutes nothing yet');
  const r2 = await triageSignal({ source: 'mastodon', externalId: 'm2', feedback: 'less', actor: 'test' });
  const authorMute = st().muted.authors.find((a) => a.value === 'spam@relay.example');
  ok(authorMute && authorMute.by === 'feedback' && authorMute.source === 'mastodon' && typeof authorMute.at === 'string', `the second tap on the same author mutes them, per lane, logged by feedback (${JSON.stringify(authorMute)})`);
  const domainMute = st().muted.domains.find((d) => d.value === 'relay.example');
  ok(domainMute && domainMute.by === 'feedback', 'two taps on the same author home domain mute the domain too');
  ok(Array.isArray(r2.muted) && r2.muted.some((m) => m.kind === 'author') && r2.muted.some((m) => m.kind === 'domain'), 'the triage result names what it muted');
  ok(isMuted({ source: 'mastodon', author: 'spam@relay.example' }, st().muted), 'the engine pre-filter drops the muted author');
  ok(stat('q1', 'less') === lessBefore + 2, `each tap counts as "less" on its search (${lessBefore} -> ${stat('q1', 'less')})`);
  ok(st().lessLog.some((e) => e.externalId === 'm2' && e.author === 'spam@relay.example' && e.domain === 'relay.example'), 'the tap is kept in the 60-day less log with author and domain');

  // Undo of the tap that created the mute lifts exactly that mute.
  const undoMute = await restoreSignals({ signals: [obj('m2')], actor: 'test' });
  ok(undoMute.ok === true, 'Undo of the muting tap succeeds');
  ok(!st().muted.authors.some((a) => a.value === 'spam@relay.example') && !st().muted.domains.some((d) => d.value === 'relay.example'), 'Undo removes the mutes that tap created');
  ok(!st().lessLog.some((e) => e.externalId === 'm2') && st().lessLog.some((e) => e.externalId === 'm1'), 'Undo takes only that tap out of the less log');
  ok(stat('q1', 'less') === lessBefore + 1, 'Undo takes the "less" count back');

  // Two strangers on one big instance never mute the instance.
  await triageSignal({ source: 'mastodon', externalId: 'big1', feedback: 'less', actor: 'test' });
  await triageSignal({ source: 'mastodon', externalId: 'big2', feedback: 'less', actor: 'test' });
  ok(!st().muted.domains.some((d) => d.value === 'mastodon.social'), 'a shared host (mastodon.social) is never auto-muted as a domain');

  // "Erledigt" is not "not relevant": dismissing the same author twice mutes nothing.
  const doneBefore = stat('q1', 'done');
  await triageSignal({ source: 'mastodon', externalId: 'eve1', action: 'dismiss', actor: 'test' });
  await triageSignal({ source: 'mastodon', externalId: 'eve2', action: 'dismiss', actor: 'test' });
  ok(!st().muted.authors.some((a) => a.value === 'eve'), 'dismiss (Erledigt) never mutes, however often');
  ok(!st().lessLog.some((e) => e.author === 'eve'), 'dismiss never enters the less log');
  ok(stat('q1', 'done') === doneBefore + 2, 'dismiss counts as "done" on its search');
  const undoDone = await restoreSignals({ signals: [obj('eve1')], actor: 'test' });
  ok(undoDone.ok === true && stat('q1', 'done') === doneBefore + 1, 'Undo of a dismiss takes the "done" count back');

  // A lane-scoped author mute: "zed" on Hacker News is not "zed" on Reddit. HN is not a home domain.
  await triageSignal({ source: 'hackernews', externalId: 'hn1', feedback: 'less', actor: 'test' });
  await triageSignal({ source: 'hackernews', externalId: 'hn2', feedback: 'less', actor: 'test' });
  ok(isMuted({ source: 'hackernews', author: 'zed' }, st().muted), 'two taps mute the Hacker News author');
  ok(!isMuted({ source: 'reddit', author: 'zed' }, st().muted), 'the mute is scoped to its lane');
  ok(!st().muted.domains.some((d) => d.value === 'news.ycombinator.com'), 'a forum permalink host is never an author home domain');
} catch (err) {
  failures += 1;
  console.error(`  FAIL - threw: ${err && err.stack}`);
}

console.log(`\n${pass} passed, ${failures} failed`);
if (failures) { console.error(`[radar-feedback] FAIL - ${failures} assertion(s) failed`); process.exitCode = 1; }
assert.ok(true);
