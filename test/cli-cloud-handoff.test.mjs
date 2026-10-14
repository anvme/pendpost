#!/usr/bin/env node
// test/cli-cloud-handoff.test.mjs - a hand-run CLI ceremony reaches the cloud vault.
//
// `node scripts/<lane>-social.mjs auth --client X` writes the new token to X's .env and
// exits; the running pendpost never saw it, so a cloud-managed brand's vault kept the old
// token until a forced recheck. Proves, network-free (mocked fetch):
//   1. handOffAfterCeremony (lib/cli-cloud-handoff.mjs): only a successful ceremony verb,
//      never inside the Studio's own connect run; it asks pendpost for the forced recheck of
//      that lane with the root it wrote; one plain line per outcome (checked + resealed,
//      reseal failed, not running, other workspace); never a token value.
//   2. POST /api/health/recheck refuses a root this pendpost does not serve (reason wrong_workspace)
//      before any probe, and runs the probe for its own root.
//   3. The boot catch-up (lib/cloud-client.mjs resealChangedBrands): a cloud-managed brand
//      whose .env changed after its last seal is resealed once; an unchanged one, a paused
//      one, are not; a real seal stamps state.cloudSeal.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cli-handoff-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
// A migrated workspace: the registry, one client 'default' under data/clients/default (its
// own .env holds the platform tokens), the install-global .env holds the cloud api key.
const CLIENT = path.join(WS, 'data', 'clients', 'default');
fs.mkdirSync(path.join(CLIENT, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(CLIENT, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
fs.writeFileSync(path.join(WS, 'data', 'clients.json'), JSON.stringify({ activeClientId: 'default', clients: [{ id: 'default', displayName: 'Default', status: 'active' }] }));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_key_cli_handoff_0001\n');
const SECRET = 'fake-secret-access-token-0042';
const ENV = path.join(CLIENT, '.env');
fs.writeFileSync(ENV, [
  `LINKEDIN_ACCESS_TOKEN=${SECRET}`,
  'LINKEDIN_ORG_URN=urn:li:organization:1234567',
].join('\n') + '\n');
const CLOUD_JSON = path.join(WS, 'data', 'cloud.json');
const setAlwaysOn = (on) => fs.writeFileSync(CLOUD_JSON, JSON.stringify({
  baseUrl: 'https://cloud.test', workspaceId: 'ws_cli_handoff', brands: { default: { alwaysOn: on } },
}));
setAlwaysOn(true);

// Fake probe engine for the route test: always passes.
const FAKE = path.join(WS, 'fake-linkedin.mjs');
fs.writeFileSync(FAKE, "console.log(JSON.stringify({ ok: true, results: [{ action: 'probe', ok: true, detail: 'token live' }] }));\n");
process.env.PENDPOST_LINKEDIN_ENGINE = FAKE;

const { handOffAfterCeremony, clientIdOfRoot } = await import('../lib/cli-cloud-handoff.mjs');
const { handleApi } = await import('../lib/api.mjs');
const { resealChangedBrands, handLocalTokens } = await import('../lib/cloud-client.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// A fake fetch for the helper: records the request, answers with `reply` (or throws).
function fakeDaemon(reply) {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    // An array answers in order (the last one repeats): a probe that passes on the retry.
    const next = Array.isArray(reply) ? reply[Math.min(seen.length - 1, reply.length - 1)] : reply;
    if (next instanceof Error) throw next;
    reply = Array.isArray(reply) ? reply : next;
    return { ok: next.status === 200, status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { seen, fetchImpl };
}
const run = async (reply, extra = {}) => {
  const d = fakeDaemon(reply);
  const lines = [];
  const out = await handOffAfterCeremony({
    command: 'auth', lane: 'linkedin', results: [{ action: 'auth', ok: true }],
    env: {}, root: path.join(WS, 'data', 'clients', 'acme'), port: 9123,
    fetchImpl: d.fetchImpl, log: (l) => lines.push(l), ...extra,
  });
  return { out, lines, seen: d.seen };
};
const UP = (body) => ({ status: 200, body: { ok: true, ...body } });

try {
  // ---- (1) the CLI helper ---------------------------------------------------------
  ok(clientIdOfRoot('/w/data/clients/acme') === 'acme' && clientIdOfRoot('/w') === null, 'the client id comes from a data/clients/<id> root, else none');

  let r = await run(UP({}), { command: 'publish-due' });
  ok(r.out.skipped === 'not_ceremony' && r.seen.length === 0 && r.lines.length === 0, 'a non-ceremony verb never calls pendpost');
  r = await run(UP({}), { env: { PENDPOST_CONNECT_RUN: '1' } });
  ok(r.out.skipped === 'studio_run' && r.seen.length === 0, 'the Studio connect run is skipped (its exit already reseals)');
  r = await run(UP({}), { results: [{ action: 'auth', ok: false }] });
  ok(r.out.skipped === 'ceremony_failed' && r.seen.length === 0, 'a failed ceremony hands nothing off');

  r = await run(UP({ health: { linkedin: { ok: true } }, cloud: { resealed: true, managed: true } }), { env: { PENDPOST_AUTH_TOKEN: 'gate-token' } });
  const req = r.seen[0];
  const sent = JSON.parse(req.opts.body);
  ok(req.url === 'http://127.0.0.1:9123/api/health/recheck' && req.opts.method === 'POST', 'it asks the local pendpost for the forced recheck');
  ok(sent.platform === 'linkedin' && sent.clientId === 'acme' && sent.root === path.join(WS, 'data', 'clients', 'acme'), 'the request names the lane, the client and the root the ceremony wrote');
  ok(req.opts.headers.authorization === 'Bearer gate-token', 'the optional auth gate token rides as a bearer header');
  ok(r.out.status === 'resealed' && /checked the new LinkedIn sign-in and updated the cloud copy/.test(r.lines[0]), 'a passing recheck that resealed says so in one line');

  r = await run(UP({ health: { linkedin: { ok: true } }, cloud: { resealed: false, managed: false } }));
  ok(r.out.status === 'checked' && r.lines.length === 1 && !/cloud/.test(r.lines[0]), 'a brand that is not cloud-managed: checked, no cloud claim');
  r = await run(UP({ health: { linkedin: { ok: true } }, cloud: { resealed: false, managed: true, error: 'cloud down' } }));
  ok(r.out.status === 'reseal_failed' && /Re-sync now/.test(r.lines[0]), 'a failed reseal names the one fix (Re-sync now)');
  r = await run(UP({ health: { linkedin: { ok: false, detail: 'token expired' } } }), { retryDelayMs: 1 });
  ok(r.out.status === 'probe_failed' && /Open Setup/.test(r.lines[0]) && r.seen.length === 2, 'a failing recheck is retried once, then points to Setup');
  r = await run([UP({ health: { linkedin: { ok: false, detail: 'introspection lag' } } }), UP({ health: { linkedin: { ok: true } }, cloud: { resealed: true, managed: true } })], { retryDelayMs: 1 });
  ok(r.out.status === 'resealed' && r.seen.length === 2 && r.lines.length === 1, 'a probe that lags right after the sign-in passes on the retry, no warning');
  r = await run(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9123'), { code: 'ECONNREFUSED' }));
  ok(r.out.status === 'offline' && /not running.*next time pendpost starts/.test(r.lines[0]), 'pendpost not running: one line, the cloud copy updates at the next start');
  r = await run({ status: 400, body: { ok: false, code: 'invalid_input', reason: 'wrong_workspace' } });
  ok(r.out.status === 'wrong_workspace' && /different workspace/.test(r.lines[0]), 'a pendpost on another workspace: one line, nothing touched');
  ok(![...r.lines].join('\n').includes(SECRET), 'no line ever carries a token value');

  // ---- (2) the route's root guard -------------------------------------------------
  const callRecheck = async (body) => {
    const reqStream = Readable.from([Buffer.from(JSON.stringify(body))]);
    reqStream.method = 'POST';
    reqStream.headers = { 'content-type': 'application/json' };
    let status = 0; let text = '';
    const res = { writeHead: (s) => { status = s; }, end: (b) => { text = String(b || ''); }, setHeader: () => {} };
    await handleApi(reqStream, res, new URL('http://127.0.0.1/api/health/recheck'));
    return { status, body: JSON.parse(text || '{}') };
  };
  const before = (loadState().health || {}).linkedin?.checkedAt || null;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cli-handoff-other-'));
  let res = await callRecheck({ platform: 'linkedin', root: other });
  ok(res.status === 400 && res.body.reason === 'wrong_workspace', 'a root this pendpost does not serve is refused (wrong_workspace)');
  ok(((loadState().health || {}).linkedin?.checkedAt || null) === before, 'the refused request probed nothing');
  setAlwaysOn(false); // the passing probe would otherwise reseal over the network
  res = await callRecheck({ platform: 'linkedin', root: CLIENT, clientId: 'default' });
  ok(res.status === 200 && res.body.health?.linkedin?.ok === true && res.body.cloud?.managed === false, 'its own root runs the forced recheck and reports the cloud outcome');
  fs.rmSync(other, { recursive: true, force: true });

  // ---- (3) the boot catch-up ------------------------------------------------------
  const sealed = [];
  const seal = async (id) => { sealed.push(id); };
  ok((await resealChangedBrands({ seal })).length === 0 && sealed.length === 0, 'a paused brand is never resealed at boot');
  setAlwaysOn(true);
  const st = loadState(); delete st.cloudSeal; saveState();
  let rows = await resealChangedBrands({ seal });
  ok(rows.length === 1 && rows[0].ok && sealed[0] === 'default', 'a cloud-managed brand never stamped is resealed once');
  st.cloudSeal = { at: new Date(Date.now() + 60_000).toISOString() }; saveState();
  sealed.length = 0;
  rows = await resealChangedBrands({ seal });
  ok(rows.length === 0 && sealed.length === 0, 'an .env unchanged since the last seal is left alone');
  st.cloudSeal = { at: new Date(Date.now() - 60_000).toISOString() }; saveState();
  fs.appendFileSync(ENV, 'LINKEDIN_REFRESH_TOKEN=fake-refresh\n');
  rows = await resealChangedBrands({ seal });
  ok(rows.length === 1 && sealed[0] === 'default', 'an .env written after the last seal (a CLI auth while pendpost was down) is resealed');
  rows = await resealChangedBrands({ seal: async () => { throw Object.assign(new Error('cloud down'), { code: 'network_error' }); } });
  ok(rows.length === 1 && rows[0].ok === false && rows[0].reason === 'network_error', 'a failed boot reseal is reported, never thrown');

  // A real seal stamps the brand (mocked vault PUT).
  global.fetch = async (url, opts = {}) => {
    const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (/\/v1\/vault\/[a-z]+$/.test(String(url)) && opts.method === 'PUT') return json({ stored: true });
    return { ok: false, status: 404, text: async () => '{}' };
  };
  delete loadState().cloudSeal; saveState();
  const t0 = Date.now();
  await handLocalTokens('default');
  ok(Date.parse(loadState().cloudSeal?.at || '') >= t0 - 5, 'a successful seal stamps state.cloudSeal');
  sealed.length = 0;
  ok((await resealChangedBrands({ seal })).length === 0, 'right after a seal the boot catch-up has nothing to do');

  // A refusal on a lane the cloud never fires (youtube is local-only) must not leave the
  // brand unstamped, or it would be resealed at every boot (a client brand on 2026-10-07: the cloud
  // answers youtube with http_error). A refusal on a CLOUD lane still blocks the stamp.
  fs.appendFileSync(ENV, 'YT_REFRESH_TOKEN=fake-yt-refresh\nYT_CHANNEL_ID=UCfake\n');
  const refuse = (re) => async (url, opts = {}) => {
    const u = String(url);
    if (/\/v1\/vault\/[a-z]+$/.test(u) && opts.method === 'PUT') {
      if (re.test(u)) return { ok: false, status: 400, text: async () => '{"error":"invalid_input"}' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ stored: true }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  global.fetch = refuse(/\/vault\/youtube$/);
  delete loadState().cloudSeal; saveState();
  await handLocalTokens('default');
  ok(Boolean(loadState().cloudSeal?.at), 'a refused local-only lane (youtube) still stamps the seal');
  global.fetch = refuse(/\/vault\/linkedin$/);
  delete loadState().cloudSeal; saveState();
  await handLocalTokens('default');
  ok(!loadState().cloudSeal, 'a refused cloud lane (linkedin) leaves the brand unstamped for the next boot');

  console.log(`[cli-cloud-handoff] OK - a hand-run ceremony reaches the cloud vault, now or at the next start (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
