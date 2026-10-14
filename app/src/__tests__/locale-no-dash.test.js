import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';

// Copy-hygiene guard (owner HARD rule: zero em dashes anywhere). A spaced hyphen
// " - " standing in for a dash reads as the same AI-writing tell as an em dash, so
// no locale VALUE may use one, and the real dash characters (em dash U+2014, en dash
// U+2013) are banned outright. Rewrite with a colon, a comma, a period + new
// sentence, or parentheses instead.
//
// Ranges: write them without spaces ("10-20") or in words ("10 to 20" / "10 bis 20").

// Legitimate " - " uses, as exact substrings that are cut out of a value before the
// check runs (so the rest of that value is still guarded). Keep this list short and
// comment every entry.
const ALLOWED_SUBSTRINGS = [
  // composer.error.idFormat / composer.error.xReplyToFormat: the hyphen here is a
  // literal allowed ID character in a character list, not a dash.
  '0-9, - or _',
  '0-9, - oder _',
];

const SPACED_HYPHEN = / - /;
const DASH_CHARS = /[–—]/;

function offenders(catalog, pattern) {
  return Object.entries(catalog.strings)
    .filter(([, value]) => typeof value === 'string')
    .filter(([, value]) => {
      let v = value;
      for (const allowed of ALLOWED_SUBSTRINGS) v = v.split(allowed).join('');
      return pattern.test(v);
    })
    .map(([key, value]) => `${key}: ${value}`);
}

describe.each([
  ['en', en],
  ['de-CH', deCH],
])('%s locale copy hygiene', (_name, catalog) => {
  it('has no spaced hyphen " - " used as a dash', () => {
    expect(offenders(catalog, SPACED_HYPHEN)).toEqual([]);
  });

  it('has no em dash or en dash', () => {
    expect(offenders(catalog, DASH_CHARS)).toEqual([]);
  });
});
