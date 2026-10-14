import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';

// Copy-hygiene guard (D14): engine jargon stays out of the words an owner reads.
// ".env", "60s-Zyklus", "API", "Versiegelt" and "Webhook" are words from the code,
// not from the owner's world. Say what happens in plain words instead ("the local
// configuration file", "Lokal aktiv", "sicher übertragen", "sofort").
//
// The guard is a denylist plus a REASONED allowlist, not a blanket ban. A key may be
// listed below only for one of two reasons:
//   'tip-only'     the value renders exclusively behind a "?" (InfoTip / Field help /
//                  NoteTip), the second layer where the exact technical name helps.
//   'portal-label' a form field label or example value that must match the platform
//                  portal's own wording, so the owner can find the same field there.
// Every entry names where it renders. Anything else gets rewritten.
const ALLOWLIST = {
  // Setup NoteTip -> InfoTip label (Setup.jsx NoteTip): the env var name behind "?".
  'setup.envName': 'tip-only',
  'setup.nostr.mediaServer.tip': 'tip-only',
  'setup.nostr.nwc.tip': 'tip-only',
  // Identifier Field help -> InfoTip (Setup.jsx `help={t(`setup.${field.tipKey}`)}`).
  'setup.idField.linkedinApiVersion.tip': 'tip-only',
  'setup.idField.gbpAccountId.tip': 'tip-only',
  // Radar Bluesky lane: InfoTip label (Radar.jsx, radar/LaneReadinessLine.jsx).
  'radar.source.bluesky.envHint': 'tip-only',
  // Cloud token skip reason: the file name sits behind the "?" (Cloud.jsx reasonTip).
  'cloud.tokens.reason.envTip': 'tip-only',
  // LinkedIn names this field "API version" (LinkedIn-Version header) in its docs.
  'setup.idField.linkedinApiVersion.label': 'portal-label',
  // X developer portal: "API Key Secret".
  'keys.label.xApiSecret': 'portal-label',
  // Ghost Admin > Integrations: "Admin API Key".
  'connect.adminApiKey': 'portal-label',
  // Discord channel settings > Integrations: "Copy Webhook URL", and the URL shape itself.
  'connect.webhookUrl': 'portal-label',
  'connect.webhookUrl.placeholder': 'portal-label',
};

const REASONS = new Set(['tip-only', 'portal-label']);

const JARGON = [/\.env\b/, /60s-Zyklus/, /\bAPI\b/, /Versiegelt|versiegelt/, /Webhook/i];

function offenders(catalog) {
  return Object.entries(catalog.strings)
    .filter(([key, value]) => typeof value === 'string' && !(key in ALLOWLIST))
    .filter(([, value]) => JARGON.some((re) => re.test(value)))
    .map(([key, value]) => `${key}: ${value}`);
}

describe('locale jargon allowlist', () => {
  it('gives every entry one of the two reasons', () => {
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      expect(REASONS.has(reason), `${key}: ${reason}`).toBe(true);
    }
  });

  it('lists only keys that exist and still need the exemption', () => {
    const stale = Object.keys(ALLOWLIST).filter((key) => {
      const values = [en.strings[key], deCH.strings[key]].filter((v) => typeof v === 'string');
      return !values.some((v) => JARGON.some((re) => re.test(v)));
    });
    expect(stale).toEqual([]);
  });
});

describe.each([
  ['en', en],
  ['de-CH', deCH],
])('%s locale has no engine jargon', (_name, catalog) => {
  it('uses plain words instead of .env, 60s-Zyklus, API, Versiegelt, Webhook', () => {
    expect(offenders(catalog)).toEqual([]);
  });
});
