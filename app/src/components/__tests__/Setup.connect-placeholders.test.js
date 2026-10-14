import { describe, it, expect } from 'vitest';
import { CONNECT_FIELDS, connectPlaceholder } from '../Setup.jsx';
import { makeT } from '../../lib/i18n.js';

// Phase-3 D-3: the Nostr NWC field showed the raw key "connect.nostrNwc.placeholder" as its
// placeholder (missing in both locales, visible once D5 opened this form on a connected
// card). t() returns the key itself for a missing string, so the fallback must only use a
// placeholder that exists, and every connect form field must resolve to real words or none.
const KEY_LOOKING = /^[a-z]+\.[a-zA-Z.]+$/;

describe('Connect form placeholders never render a raw key', () => {
  for (const locale of ['en', 'de-CH']) {
    const t = makeT(locale);
    for (const [lane, { fields }] of Object.entries(CONNECT_FIELDS)) {
      it(`${locale} ${lane}: every field placeholder is words or absent`, () => {
        for (const f of fields) {
          const p = connectPlaceholder(f, t);
          if (p !== undefined) expect(p).not.toMatch(KEY_LOOKING);
        }
      });
    }
  }

  it('a field whose placeholder key is missing gets no placeholder at all', () => {
    const t = makeT('en');
    expect(connectPlaceholder({ key: 'x', labelKey: 'connect.doesNotExist' }, t)).toBeUndefined();
    expect(connectPlaceholder({ key: 'x', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.nope' }, t)).toBeUndefined();
  });

  it('the Nostr wallet field has a real hint in both languages', () => {
    const nwc = CONNECT_FIELDS.nostr.fields.find((f) => f.key === 'nwcUri');
    expect(connectPlaceholder(nwc, makeT('en'))).toMatch(/wallet/i);
    expect(connectPlaceholder(nwc, makeT('de-CH'))).toMatch(/Wallet/);
  });
});
