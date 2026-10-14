// LinkedIn Community Management scopes are opt-in per brand (LINKEDIN_CMA=1): LinkedIn refuses
// the whole sign-in when an app asks for a scope it lacks, so the default request must stay the
// base set, and an opted-in brand must ask for the statistics + comment scopes and read comments.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-li-cma-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log(`  ok - ${m}`); };
try {
  const { authScopes, cmaEnabled } = await import('../scripts/linkedin-social.mjs');
  const env = (vars) => (k) => vars[k] ?? null;
  const base = authScopes(env({}));
  ok(!/rw_organization_admin|social_feed/.test(base), 'no CMA scopes without the flag');
  ok(/w_organization_social/.test(base) && /r_organization_social/.test(base), 'base scopes stay');
  const cma = authScopes(env({ LINKEDIN_CMA: '1' }));
  for (const s of ['rw_organization_admin', 'r_organization_followers', 'r_organization_social_feed', 'w_organization_social_feed']) ok(cma.split(' ').includes(s), `LINKEDIN_CMA=1 asks for ${s}`);
  ok(!/\bopenid\b|\bprofile\b/.test(cma), 'a CMA app never asks for openid/profile (the product sits alone on its app)');
  ok(/\bopenid\b/.test(base), 'the default set keeps openid for member posting');
  ok(!cmaEnabled(env({ LINKEDIN_CMA: '0' })), 'LINKEDIN_CMA=0 stays off');

  const { laneReadAvailable, commentReadCapabilities } = await import('../lib/comments.mjs');
  ok(laneReadAvailable('linkedin') === false, 'without the flag LinkedIn comment reads stay pending');
  ok(commentReadCapabilities().linkedin.readBlocked === 'linkedin_cma_pending', 'pending reason shown');
  fs.writeFileSync(path.join(WS, '.env'), 'LINKEDIN_CMA=1\n');
  ok(laneReadAvailable('linkedin') === true, 'with LINKEDIN_CMA=1 LinkedIn comments are readable');
  ok(commentReadCapabilities().linkedin.readBlocked === null, 'no pending reason once opted in');
  const { failureClass } = await import('../lib/insights.mjs');
  ok(failureClass({ errorCode: 'needs_page_role', errorMessage: 'needs_page_role: the connected LinkedIn account is not a super admin of the Page' }) === 'needs_page_role', 'a Page-role 403 reads needs_page_role, not needs_scope');
  ok(failureClass({ error: 'needs_scope' }) === 'needs_scope', 'a real missing scope still reads needs_scope');
  console.log(`[linkedin-cma-scopes] OK (${pass} assertions)`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
