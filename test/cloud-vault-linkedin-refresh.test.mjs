#!/usr/bin/env node
// test/cloud-vault-linkedin-refresh.test.mjs - the LinkedIn vault PUT carries the
// refresh contract so the cloud engine can renew LinkedIn itself:
//   - refreshToken     : LINKEDIN_REFRESH_TOKEN
//   - refreshExpiresAt : LINKEDIN_REFRESH_TOKEN_EXPIRES_AT (epoch ms) -> ISO, or null
//   - oauthClientId    : LINKEDIN_CLIENT_ID (public)
// Every PUT replaces the whole row, so a reseal that omitted these would strip the
// refresh token from the cloud. X is the opposite: its refresh tokens rotate single-use,
// so the cloud must NEVER receive one (a cloud refresh would burn the local copy).
// Mock mode + a mocked global.fetch; no network. Values are fake.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-vault-li-refresh-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const API_KEY = 'ppc_key_vault_li_refresh_0001';
const LI_ACCESS = 'fake-linkedin-access-token';
const LI_REFRESH = 'fake-linkedin-refresh-token';
const LI_CLIENT = 'fakeliclientid01';
const LI_ORG = 'urn:li:organization:1234567';
const LI_REFRESH_EXP_MS = Date.UTC(2027, 0, 15, 12, 0, 0);
const X_REFRESH = 'fake-x-refresh-token-single-use';

function writeEnv(extra) {
  fs.writeFileSync(path.join(WS, '.env'), [`PENDPOST_CLOUD_API_KEY=${API_KEY}`, ...extra].join('\n') + '\n');
}

fs.writeFileSync(path.join(WS, 'data', 'cloud.json'), JSON.stringify({
  baseUrl: 'https://cloud.test', workspaceId: 'ws_li_refresh', brands: { default: { alwaysOn: true } },
}));

const cloud = await import('../lib/cloud-client.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const calls = [];
function installFetch() {
  calls.length = 0;
  global.fetch = async (input, opts = {}) => {
    const url = String(input);
    const method = opts.method || 'GET';
    const body = typeof opts.body === 'string' ? opts.body : undefined;
    calls.push({ url, method, body });
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (/\/v1\/vault\/[a-z]+$/.test(url) && method === 'PUT') {
      const b = JSON.parse(body);
      return json({ stored: true, platform: url.split('/').pop(), platformAccountId: b.platformAccountId, refreshStored: !!b.refreshToken });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}
const vaultBody = (platform) => {
  const c = calls.find((x) => x.url.endsWith(`/v1/vault/${platform}`) && x.method === 'PUT');
  return c ? JSON.parse(c.body) : null;
};

try {
  // ---- (A) linkedin seals the refresh token, its expiry and the oauth client id -------
  writeEnv([
    `LINKEDIN_ACCESS_TOKEN=${LI_ACCESS}`,
    `LINKEDIN_ORG_URN=${LI_ORG}`,
    `LINKEDIN_TOKEN_EXPIRES_AT=${Date.now() + 30 * 86400000}`,
    `LINKEDIN_REFRESH_TOKEN=${LI_REFRESH}`,
    `LINKEDIN_REFRESH_TOKEN_EXPIRES_AT=${LI_REFRESH_EXP_MS}`,
    `LINKEDIN_CLIENT_ID=${LI_CLIENT}`,
    // X on OAuth2 with a refresh token present in .env: it must NOT travel.
    'X_ACCESS_TOKEN=fake-x-oauth2-access',
    `X_REFRESH_TOKEN=${X_REFRESH}`,
    'X_HANDLE=example_handle',
    'X_CLIENT_ID=fakexclientid',
  ]);
  installFetch();
  const res = await cloud.handLocalTokens('default');
  const li = vaultBody('linkedin');
  ok(li && li.token === LI_ACCESS, 'linkedin: token is still the access token');
  ok(li.refreshToken === LI_REFRESH, 'linkedin: refreshToken is LINKEDIN_REFRESH_TOKEN');
  ok(li.refreshExpiresAt === new Date(LI_REFRESH_EXP_MS).toISOString(), 'linkedin: refreshExpiresAt is the epoch-ms expiry as ISO');
  ok(li.oauthClientId === LI_CLIENT, 'linkedin: oauthClientId is LINKEDIN_CLIENT_ID');
  ok(!JSON.stringify(res).includes(LI_REFRESH), 'the returned summary never carries the refresh token value');
  ok(calls.every((c) => !c.url.includes(LI_REFRESH)), 'the refresh token is never in a url');

  // ---- (B) X never carries a refresh token, under any field name ---------------------
  const x = vaultBody('x');
  ok(x, 'x: the access token is still sealed');
  ok(!('refreshToken' in x) && !('oauthClientId' in x) && !('refreshExpiresAt' in x), 'x: the PUT body has no refresh fields at all');
  ok(!calls.some((c) => (c.body || '').includes(X_REFRESH)), 'x: the X refresh token value appears in NO request body');

  // ---- (C) linkedin with no refresh expiry: null, not a bogus date -------------------
  writeEnv([
    `LINKEDIN_ACCESS_TOKEN=${LI_ACCESS}`,
    `LINKEDIN_ORG_URN=${LI_ORG}`,
    `LINKEDIN_REFRESH_TOKEN=${LI_REFRESH}`,
    `LINKEDIN_CLIENT_ID=${LI_CLIENT}`,
  ]);
  installFetch();
  await cloud.handLocalTokens('default');
  const li2 = vaultBody('linkedin');
  ok(li2.refreshToken === LI_REFRESH && li2.refreshExpiresAt === null, 'linkedin without LINKEDIN_REFRESH_TOKEN_EXPIRES_AT seals refreshExpiresAt: null');

  // ---- (D) linkedin with no refresh token: no refresh fields sent ---------------------
  writeEnv([`LINKEDIN_ACCESS_TOKEN=${LI_ACCESS}`, `LINKEDIN_ORG_URN=${LI_ORG}`]);
  installFetch();
  await cloud.handLocalTokens('default');
  const li3 = vaultBody('linkedin');
  ok(li3 && !li3.refreshToken, 'linkedin without a refresh token seals the access token alone');

  // ---- (E) handToken itself refuses to forward refresh fields for a non-linkedin lane --
  installFetch();
  await cloud.handToken({ clientId: 'default', platform: 'x', platformAccountId: 'example_handle', token: 'fake', refreshToken: X_REFRESH, oauthClientId: 'c' });
  const x2 = vaultBody('x');
  ok(!('refreshToken' in x2) && !('oauthClientId' in x2), 'handToken drops refresh fields for any lane but linkedin');

  console.log(`[cloud-vault-linkedin-refresh] OK - linkedin seals refresh token + expiry + client id; x never does (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
