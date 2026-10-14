#!/usr/bin/env node
// test/clients-overview-pending.test.mjs - clientsOverview.pending is the REAL count.
//
// clientsOverview used to set pending = health.nextDue.length, and nextDue is the
// horizon-capped preview list (max 20), so a client with 25 due posts read "20" and a
// client with 200 read "20" too. The counts are now taken over every due post; the
// nextDue preview stays capped. Rejected posts are a decided no and never count.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-overview-pending-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createCampaign, createPost, approvePost, rejectPost, clientsOverview } = await import('../lib/writes.mjs');

const HOUR = 3_600_000;
const FUTURE = 3;
const PAST = 22; // more than the 20-row horizon on its own

try {
  initMultiClient();
  withClient(clientRoot('default'), () => {
    const plans = path.join(activeRoot(), 'data', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  });

  await withClient(clientRoot('default'), async () => {
    const c = await createCampaign({ id: 'many', timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `createCampaign: ${JSON.stringify(c)}`);
    const make = async (id, whenMs, verdict = 'approve') => {
      const p = await createPost({ campaign: 'many', post: { id, type: 'text', platforms: ['linkedin'], caption: `note ${id}`, scheduledAt: new Date(whenMs).toISOString() }, actor: 'agent:claude' });
      assert.ok(p.ok, `createPost ${id}: ${JSON.stringify(p)}`);
      const a = verdict === 'approve'
        ? await approvePost({ campaign: 'many', postId: id, actor: 'owner' })
        : await rejectPost({ campaign: 'many', postId: id, actor: 'owner' });
      assert.ok(a.ok, `${verdict} ${id}: ${JSON.stringify(a)}`);
    };
    for (let i = 0; i < FUTURE; i += 1) await make(`f${i}`, Date.now() + (i + 1) * HOUR);
    for (let i = 0; i < PAST; i += 1) await make(`p${i}`, Date.now() - (i + 1) * HOUR);
    // A rejected post in the past is a decided no: never pending, never overdue.
    await make('rejected', Date.now() - 30 * HOUR, 'reject');
  });

  const row = clientsOverview().clients.find((c) => c.id === 'default');
  ok(row && row.error == null, 'the default client row resolves');
  ok(row.pending === FUTURE + PAST, `pending is the real count (${FUTURE + PAST}), not the 20-row horizon (got ${row.pending})`);
  ok(row.overdue === PAST, `overdue is the real count (${PAST}), not capped by the horizon (got ${row.overdue})`);
  ok(typeof row.nextDue === 'string', 'nextDue is still the soonest due post');

  console.log(`[clients-overview-pending] OK - pending/overdue are real counts, rejected posts never count (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
