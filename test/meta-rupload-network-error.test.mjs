#!/usr/bin/env node
// test/meta-rupload-network-error.test.mjs - an Instagram upload-step network error says so.
//
// A bare fetch() throw inside igResumableUpload surfaced as "fetch failed", which reads the
// same as a media_publish network error. The wrapped message names the step and container
// (`rupload <id>: fetch failed (<cause>)`) and stays classified transient by
// lib/publish-hold.mjs isTransientFailure. The HTTP-error branch keeps its fields.
// In-process, stubbed global.fetch, no network, fake values.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-meta-rupload-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
const MEDIA = path.join(WS, 'clip.mp4');
fs.writeFileSync(MEDIA, Buffer.from('fake-bytes'));

const meta = await import('../scripts/meta-social.mjs');
const { isTransientFailure } = await import('../lib/publish-hold.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

try {
  // ---- (1) a network throw is wrapped with the step + container id -------------------
  global.fetch = async () => {
    const e = new TypeError('fetch failed');
    e.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    throw e;
  };
  let err = null;
  try { await meta.igResumableUpload('17890000000000001', MEDIA, 'fake-token'); } catch (e) { err = e; }
  ok(err instanceof Error, 'igResumableUpload rethrows a network error');
  ok(/^rupload 17890000000000001: fetch failed \(.+\)$/.test(err.message), `the message names the upload step and container (${err?.message})`);
  ok(/ECONNRESET/.test(err.message), 'the cause is carried into the message');
  ok(err.cause instanceof Error, 'the original error is kept as err.cause');
  ok(isTransientFailure({ ok: false, errorCode: null, errorMessage: err.message }), 'publish-hold still classifies it transient');

  // ---- (2) the HTTP error branch is unchanged (message + retriable) -------------------
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ debug_info: { retriable: false, message: 'ProcessingFailedError' } }) });
  err = null;
  try { await meta.igResumableUpload('17890000000000002', MEDIA, 'fake-token'); } catch (e) { err = e; }
  ok(/^rupload 17890000000000002: HTTP 400 /.test(err.message), 'an HTTP rejection keeps its rupload HTTP message');
  ok(err.retriable === false, 'an HTTP rejection keeps retriable from debug_info');

  console.log(`[meta-rupload-network-error] OK - upload-step network errors are named and stay transient (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
