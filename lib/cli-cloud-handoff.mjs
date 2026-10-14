// lib/cli-cloud-handoff.mjs - the step after a hand-run credential ceremony.
//
// THE GAP. `node scripts/<lane>-social.mjs auth --client X` run from a terminal writes the
// new token to X's local .env and exits. The running pendpost never sees that exit (the
// Studio's own connect run does: lib/api.mjs noteConnectExit), so a cloud-managed brand's
// vault kept the OLD token until someone forced a health recheck.
//
// THE SEAM. At the end of a successful ceremony the engine calls handOffAfterCeremony(). It
// asks the local pendpost for the same forced single-lane recheck Setup runs after a
// reconnect (POST /api/health/recheck). A passing recheck releases the lane's credential
// holds and, for a cloud-managed brand, reseals the new token into the cloud vault
// (lib/health.mjs probeAll -> resealAfterReconnect). The request carries the root whose
// .env the ceremony wrote, and pendpost refuses it when it serves a different workspace,
// so a run against another workspace (a test's temp dir) never touches this daemon's data.
// When pendpost is not running, one line says the cloud copy updates the next time it
// starts (server boot reseals every cloud-managed brand whose .env changed since its last
// seal: lib/cloud-client.mjs resealChangedBrands).
//
// Best effort and quiet: it never throws, never changes the ceremony's exit code, and never
// prints a token value (the request and the lines carry only the lane, the client id and
// the workspace path).
import path from 'node:path';
import { CEREMONY_VERBS } from './cli-client.mjs';
import { activeRoot } from './context.mjs';
import { daemonPort } from './util.mjs';

const LANE_LABEL = { linkedin: 'LinkedIn', x: 'X', meta: 'Meta', telegram: 'Telegram', discord: 'Discord', nostr: 'Nostr' };
const HANDOFF_TIMEOUT_MS = 60_000; // the forced probe alone may take 30s

// The client id of a root shaped data/clients/<id>, else null (a legacy single workspace:
// pendpost then scopes the recheck to its active client, and the root check still applies).
export function clientIdOfRoot(root) {
  const r = path.resolve(root);
  return path.basename(path.dirname(r)) === 'clients' ? path.basename(r) : null;
}

// Returns { skipped } or { status } for tests; prints at most one line through `log`.
export async function handOffAfterCeremony({
  command, lane, results = [],
  env = process.env, root = activeRoot(), port = daemonPort(),
  fetchImpl = globalThis.fetch, log = (line) => process.stderr.write(`${line}\n`), retryDelayMs = 4000,
} = {}) {
  try {
    if (!CEREMONY_VERBS.has(command)) return { skipped: 'not_ceremony' };
    // The Studio's own connect run reseals on the child's exit; asking again would probe twice.
    if (env.PENDPOST_CONNECT_RUN === '1') return { skipped: 'studio_run' };
    if (env.PENDPOST_CLI_HANDOFF === '0') return { skipped: 'disabled' };
    if ((results || []).some((r) => r && r.ok === false)) return { skipped: 'ceremony_failed' };
    const label = LANE_LABEL[lane] || lane;
    const clientId = clientIdOfRoot(root);
    const headers = { 'content-type': 'application/json' };
    if (env.PENDPOST_AUTH_TOKEN) headers.authorization = `Bearer ${env.PENDPOST_AUTH_TOKEN}`;
    // One recheck round-trip. LinkedIn's token introspection can lag a few seconds right after a
    // fresh token is minted, so a not-ok probe is retried once after a short pause before warning.
    const recheck = async () => {
      let res;
      try {
        res = await fetchImpl(`http://127.0.0.1:${port}/api/health/recheck`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ platform: lane, root: path.resolve(root), ...(clientId ? { clientId } : {}) }),
          signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
        });
      } catch {
        log(`[info] pendpost is not running. The cloud copy of the new ${label} sign-in updates the next time pendpost starts.`);
        return { status: 'offline' };
      }
      let body = {};
      try { body = JSON.parse(await res.text()); } catch { body = {}; }
      if (body.reason === 'wrong_workspace') {
        log(`[info] The pendpost on port ${port} runs a different workspace. The cloud copy of the new ${label} sign-in updates the next time this workspace's pendpost starts.`);
        return { status: 'wrong_workspace' };
      }
      if (!res.ok || body.ok !== true) {
        log(`[warn] pendpost could not check the new ${label} sign-in (HTTP ${res.status}). Open Setup and choose Check again so the cloud gets it too.`);
        return { status: 'error' };
      }
      if (body.busy) {
        log(`[info] pendpost is busy with another check. Open Setup and choose Check again so the cloud gets the new ${label} sign-in.`);
        return { status: 'busy' };
      }
      return { res, body };
    };
    let res; let body;
    const first = await recheck();
    if (first.status) return first;
    ({ res, body } = first);
    if (!(body.health && body.health[lane] && body.health[lane].ok === true) && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      const again = await recheck();
      if (again.status) return again;
      ({ res, body } = again);
    }
    const row = body.health && body.health[lane];
    if (!row || row.ok !== true) {
      log(`[warn] pendpost could not confirm the new ${label} sign-in. Open Setup to see why.`);
      return { status: 'probe_failed' };
    }
    const cloud = body.cloud || null;
    if (cloud && cloud.error) {
      log(`[warn] The new ${label} sign-in works here, but pendpost could not update the cloud copy. Open the cloud service and choose Re-sync now.`);
      return { status: 'reseal_failed' };
    }
    log(cloud && cloud.resealed
      ? `[ok] pendpost checked the new ${label} sign-in and updated the cloud copy.`
      : `[ok] pendpost checked the new ${label} sign-in.`);
    return { status: cloud && cloud.resealed ? 'resealed' : 'checked' };
  } catch {
    return { skipped: 'error' };
  }
}
