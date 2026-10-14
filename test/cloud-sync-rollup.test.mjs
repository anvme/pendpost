#!/usr/bin/env node
// test/cloud-sync-rollup.test.mjs - cloudSyncStatus() rolls the header-dot guarantee up
// ACROSS every always-on project, not just the one being viewed. The cloud is one
// workspace: a failed post in a project the owner is not looking at is still the cloud
// failing them, and the popover must be able to say which project, which post and why.
//
// Contract:
//   - each always-on project is read under its OWN client binding; a paused project
//     (not always-on) never contributes, even with a failure on record
//   - state/reason = the worst project; counts are summed; issues carry clientId +
//     clientName; `clients` lists each project's own state
//   - clientSyncStatus() stays scoped to the bound project (the scheduler's per-brand
//     Neon gate must never see another brand's backlog)
// Same harness as test/clients-overview.test.mjs: one PENDPOST_ROOT set BEFORE importing
// lib/, mock mode, a mocked fetch, manual asserts.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-sync-rollup-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient } = await import('../lib/context.mjs');
const { createClient, setActiveClient } = await import('../lib/clients.mjs');
const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');

global.fetch = async (input) => {
  const url = String(input);
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

const RECENT = new Date(Date.now() - 2 * 60_000).toISOString(); // due, inside the overdue grace

// One approved LinkedIn text post (a CLOUD lane, no media needed) per project, plus an
// optional cached cloud failure for it, all under that project's own binding.
async function seed(id, { failure = null } = {}) {
  await withClient(clientRoot(id), async () => {
    const c = await createCampaign({ id: `${id}-camp`, timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `${id} createCampaign: ${JSON.stringify(c)}`);
    const p = await createPost({ campaign: `${id}-camp`, post: { id: `${id}-1`, type: 'text', platforms: ['linkedin'], caption: `${id} launch note\nsecond line`, scheduledAt: RECENT }, actor: 'agent:claude' });
    assert.ok(p.ok, `${id} createPost: ${JSON.stringify(p)}`);
    const a = await approvePost({ campaign: `${id}-camp`, postId: `${id}-1`, actor: 'owner' });
    assert.ok(a.ok, `${id} approvePost: ${JSON.stringify(a)}`);
    const s = loadState();
    s.cloudContact = { okAt: new Date().toISOString() };
    s.cloudAccepted = { [`${id}-camp:${id}-1:linkedin`]: { at: new Date().toISOString() } };
    if (failure) s.cloudFailures = { [`${id}-camp:${id}-1`]: { lane: 'linkedin', jobId: `${id}:j`, message: failure, at: new Date().toISOString() } };
    saveState();
  });
}

try {
  initMultiClient();
  // The cloud api key is install-global (WORKSPACE_ROOT/.env), written after the migration.
  fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');
  ok(createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' }).ok, 'createClient acme');
  ok(createClient({ id: 'globex', displayName: 'Globex Inc', actor: 'owner' }).ok, 'createClient globex');
  ok(createClient({ id: 'initech', displayName: 'Initech', actor: 'owner' }).ok, 'createClient initech');
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });

  await seed('acme');
  await seed('globex', { failure: 'LinkedIn refused the post: token expired' });
  await seed('initech', { failure: 'paused project failure' });

  ok(cloud.cloudSyncStatus() === null, 'no always-on project -> null');

  setBrandAlwaysOn('acme', true);
  setBrandAlwaysOn('globex', true);
  // initech stays paused: its failure must never colour the cloud dot.

  // View the PAUSED project (initech): the roll-up must still see the always-on others.
  ok(setActiveClient({ id: 'initech', actor: 'owner' }).ok, 'the owner views the paused project');
  const r = cloud.cloudSyncStatus();
  ok(r && r.state === 'red' && r.reason === 'cloud_failures', `worst project wins: globex's failure turns the roll-up red (${r && r.state}/${r && r.reason})`);
  ok(r.failedCount === 1, `counts are summed across projects, paused ones excluded (failedCount=${r.failedCount})`);
  const issue = r.issues.find((i) => i.kind === 'post');
  ok(issue && issue.clientId === 'globex' && issue.clientName === 'Globex Inc' && issue.title === 'globex launch note' && issue.message === 'LinkedIn refused the post: token expired',
    `the issue names the project, the post title and the real message (${JSON.stringify(issue)})`);
  ok(!r.issues.some((i) => i.clientId === 'initech'), 'a paused project contributes no issue rows');
  const byId = Object.fromEntries((r.clients || []).map((c) => [c.clientId, c]));
  ok(byId.acme && byId.acme.state === 'green' && byId.globex && byId.globex.state === 'red' && !byId.initech,
    `clients[] carries each always-on project's own state (${JSON.stringify(r.clients)})`);

  // The scheduler's per-brand gate stays scoped to the bound project.
  ok(cloud.clientSyncStatus() === null, 'clientSyncStatus for the (paused) active project is null');
  const acmeOnly = withClient(clientRoot('acme'), () => cloud.clientSyncStatus());
  ok(acmeOnly && acmeOnly.state === 'green' && acmeOnly.failedCount === 0, 'clientSyncStatus under acme never sees globex\'s failure');

  // Bound to acme (the view the owner is on), the roll-up is still red from globex.
  const fromAcme = withClient(clientRoot('acme'), () => cloud.cloudSyncStatus());
  ok(fromAcme && fromAcme.state === 'red' && fromAcme.issues.some((i) => i.clientId === 'globex'), 'the roll-up is the same whichever project is bound');

  console.log(`[cloud-sync-rollup] OK - cross-project worst-state roll-up, summed counts, named issues, paused excluded, per-brand gate unchanged (${pass} assertions).`);
} catch (err) {
  console.error(`\nFAIL - ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
