import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';

// Q11: inbox.realtimeOff (the Setup capability badge's tip) promised "pendpost checks
// regularly". It does not, by default: the comment sweep is opt-in (lib/config.mjs
// COMMENT_WATCH_DEFAULTS.enabled false) and never reads x or ghost (lib/comments.mjs
// PLATFORM_LANE). So the line states what is true today and makes no polling promise.
describe('inbox.realtimeOff makes no polling promise', () => {
  it.each([
    ['en', en, /regularly|checks|polls|every/i],
    ['de-CH', deCH, /regelmässig|schaut|prüft|alle \d/i],
  ])('%s', (_name, catalog, promise) => {
    const s = catalog.strings['inbox.realtimeOff'];
    expect(typeof s).toBe('string');
    expect(s).not.toMatch(promise);
  });
});
