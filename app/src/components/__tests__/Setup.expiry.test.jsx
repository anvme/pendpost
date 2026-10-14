import { describe, it, expect } from 'vitest';
import { expiryNotice } from '../Setup.jsx';
import en from '../../locales/en.json';
import de from '../../locales/de-CH.json';

// Re-auth never surprises: a lane card shows "Expires in N days. Reconnect" ONLY when the
// lane cannot renew itself (no refresh token) and its sign-in runs out within 14 days, or
// already ran out. A lane that renews itself (the daily refresh does it 14 days ahead)
// shows nothing extra.
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-07T08:00:00Z');
const at = (ms) => new Date(NOW + ms).toISOString();

describe('Setup expiry notice', () => {
  it('a lane that renews itself never shows an expiry', () => {
    expect(expiryNotice({ canAutoRenew: true, tokenExpiresAt: at(3 * DAY) }, NOW)).toBeNull();
    expect(expiryNotice({ canAutoRenew: true, tokenExpiresAt: at(-DAY) }, NOW)).toBeNull();
  });

  it('a lane that cannot renew shows the days left inside 14 days', () => {
    expect(expiryNotice({ canAutoRenew: false, tokenExpiresAt: at(9.5 * DAY) }, NOW)).toEqual({ key: 'setup.expiry.soon', n: 10 });
    expect(expiryNotice({ canAutoRenew: false, tokenExpiresAt: at(20 * DAY) }, NOW)).toBeNull();
  });

  it('tomorrow and expired read their own sentence', () => {
    expect(expiryNotice({ canAutoRenew: false, tokenExpiresAt: at(5 * 3600 * 1000) }, NOW)).toEqual({ key: 'setup.expiry.one', n: 1 });
    expect(expiryNotice({ canAutoRenew: false, tokenExpiresAt: at(-1000) }, NOW)).toEqual({ key: 'setup.expiry.expired', n: 0 });
  });

  it('no expiry known, no line', () => {
    expect(expiryNotice({ canAutoRenew: false, tokenExpiresAt: null }, NOW)).toBeNull();
    expect(expiryNotice(null, NOW)).toBeNull();
  });

  it('the copy exists in en and de-CH, no em dash, no eszett', () => {
    for (const key of ['setup.expiry.soon', 'setup.expiry.one', 'setup.expiry.expired']) {
      for (const pack of [en, de]) {
        expect(typeof pack.strings[key]).toBe('string');
        expect(pack.strings[key]).not.toMatch(/ß|—/);
      }
    }
  });
});
