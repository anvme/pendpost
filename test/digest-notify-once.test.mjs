#!/usr/bin/env node
// test/digest-notify-once.test.mjs - the daily digest notification is ONE popup for every
// client, once a day, and only when there is something new to say.
//
// Before: every active client's daily sweep popped its own "Your daily digest is ready"
// (five clients, five popups), every morning, even when nothing had happened.
// Proves:
//   1. notifyDailyDigest({ collect }) queues instead of popping, and still stamps the
//      window anchor (lastDigestAt) plus the previous one (prevDigestAt).
//   2. news:false stamps but never queues (nothing new to say => no popup).
//   3. flushDigestBatch pops exactly once for a batch of several clients, with one
//      combined sentence (outliers summed, else "N projects are ready").
//   4. a second flush within 20h is refused (already_today); an empty batch never pops.
//   5. copy: en + de-CH, no em dash, no eszett.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-digest-once-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const { notifyDailyDigest, flushDigestBatch } = await import('../lib/notify.mjs');
const { loadState } = await import('../lib/state.mjs');
const { makeT } = await import('../lib/i18n.mjs');

try {
  const batch = [];
  let res = await notifyDailyDigest({ collect: batch });
  ok(res.delivered === true && res.queued === true && batch.length === 1, 'collect: the client line is queued, not popped');
  const firstStamp = loadState().notify?.lastDigestAt;
  ok(typeof firstStamp === 'string', 'queueing still stamps lastDigestAt');

  res = await notifyDailyDigest({ collect: batch, news: false });
  ok(res.delivered === false && res.reason === 'nothing_new' && batch.length === 1, 'news:false => nothing queued, no popup');
  ok(loadState().notify?.prevDigestAt === firstStamp, 'the stamp keeps the previous anchor as prevDigestAt');

  await notifyDailyDigest({ collect: batch, outliers: { breakout: [{}], slump: [] } });
  ok(batch.length === 2, 'a second client queues into the same batch');

  const popped = [];
  const exec = (title, body) => popped.push(body);
  const now = Date.now();
  res = flushDigestBatch(batch, { now, execImpl: exec });
  ok(res.delivered === true && popped.length === 1, 'one flush => exactly one notification for every client');
  ok(/1 post is breaking out/.test(popped[0]), 'the combined sentence sums the clients\' outliers');

  res = flushDigestBatch(batch, { now: now + 3600 * 1000, execImpl: exec });
  ok(res.delivered === false && res.reason === 'already_today' && popped.length === 1, 'a second flush the same day is refused');
  res = flushDigestBatch([], { now: now + 2 * 24 * 3600 * 1000, execImpl: exec });
  ok(res.delivered === false && res.reason === 'nothing_new' && popped.length === 1, 'an empty batch never pops');

  res = flushDigestBatch([{ locale: 'en', up: 0, down: 0, body: 'x' }, { locale: 'en', up: 0, down: 0, body: 'y' }], { now: now + 2 * 24 * 3600 * 1000, execImpl: exec });
  ok(res.delivered && /2 projects/.test(popped[1]), 'several clients with no outliers => "N projects are ready"');

  for (const loc of ['en', 'de-CH']) {
    const s = makeT(loc)('notify.digest.ready.many', { n: 3 });
    ok(s !== 'notify.digest.ready.many' && !s.includes('\u2014') && !/ß/.test(s), `${loc}: notify.digest.ready.many is real copy, no em dash, no eszett`);
  }

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[digest-notify-once] OK - one digest notification for all clients, once a day, only with news (${pass} assertions).`);
} catch (err) {
  console.error(`[digest-notify-once] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
