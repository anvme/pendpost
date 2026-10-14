import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tripwire (Tier-1 flywheel): the Studio never renders a raw error line inline.
//
// Every error the owner sees is ONE plain sentence from the single mapper in
// lib/failureCopy.js (humanizeAction / humanizeFailure / humanizeCheck / humanizeConnect,
// or plainError for a sentence the Studio wrote itself). The server's or engine's own line
// (English, "HTTP 500 internal", "OAuthException: ...") may ride the InfoTip "?" only.
// This class was corrected by hand five times in one round, so it is now a check.
//
// It scans app/src/components/**/*.jsx and app/src/lib/*.js(x) (not tests, not
// failureCopy.js, which IS the mapper) for the shapes a raw render takes. A `.message`
// handed to the mapper, logged, compared or regex-tested is fine: those calls are cut out
// of the source before the patterns run. Anything the patterns cannot tell apart goes in
// ALLOWED with its reason.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..');

// The error object's message: e / err / error / ex, optionally chained (mutation.error?.message).
const ERR = String.raw`\b(?:e|err|error|ex)\??\.message\b`;

// A simple alias of the raw line inside one file counts as the raw line too:
// `const detail = err.message;` then `<p>{detail}</p>`. The right-hand side may wrap it in
// String(..), trim it, put it behind a fallback (`err?.message || 'x'`, `?? ..`) or in a
// ternary branch (`typeof err?.message === 'string' ? err.message.trim() : ''`). The line
// must END the value there (`;`, `,`, `)`, `||`, `??`, `:`), so a value DERIVED from it
// (`err.message.includes(..)`, `.length`, `=== 'x'`, a condition `err.message ? a : b`) is
// not the line itself. An alias of an alias counts as well. Scope-blind on purpose: a name
// bound to the raw line anywhere in the file is raw everywhere in it, so a reused name
// needs a rename, not a pass.
const aliasDecl = (E) => new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[^;\n]*?\?\s+)?(?:String\(\s*)?\(?\s*(?:${E})(?:\.trim\(\))?(?=\s*(?:[;,)\n]|\|\||\?\?|:|$))`, 'g');
// An identifier may hold `$`, a regex metacharacter.
const nameAlt = (names) => [...names].map((n) => n.replace(/\$/g, '\\$')).join('|');

function aliasesOf(clean) {
  const names = new Set();
  for (;;) {
    const E = names.size ? String.raw`${ERR}|(?<![\w$.])(?:${nameAlt(names)})\b` : ERR;
    const re = aliasDecl(E);
    let grew = false;
    let m;
    while ((m = re.exec(clean))) if (!names.has(m[1])) { names.add(m[1]); grew = true; }
    if (!grew) return names;
  }
}

const patternsFor = (ERR) => [
  // A JSX child that shows the message itself: {err.message}, {x || err?.message},
  // {err.message || t('..')}. Not an attribute value (label={..} feeds the "?"), not a
  // template slot (${..}); a condition ({err.message ? ..}) is not a value, so no match.
  { name: 'jsx child', re: new RegExp(String.raw`(?<![=\w$])\{\s*(?:[^{}]*?(?:\|\||\?\?)\s*)?${ERR}\s*(?:\}|\|\||\?\?)`, 'g') },
  // A state setter fed the raw line: setError(err.message), setMsg(e?.message || ..).
  // Whatever that state holds is what the component later renders.
  { name: 'setter', re: new RegExp(String.raw`\bset[A-Z]\w*\(\s*${ERR}`, 'g') },
  // A toast is a render too: showToast({ text: err.message }).
  { name: 'toast', re: new RegExp(String.raw`\bshowToast\((?:[^()]|\([^()]*\))*?${ERR}`, 'g') },
  // A translated sentence that splices the raw line in: t('x', { reason: err.message }).
  { name: 't() var', re: new RegExp(String.raw`\bt\(\s*(['"\`])[^'"\`]*\1\s*,\s*\{[^}]*${ERR}`, 'g') },
  // A native hover title is still visible text (and hover-only): title={err.message}.
  { name: 'title attr', re: new RegExp(String.raw`\btitle=\{[^}]*${ERR}`, 'g') },
  // The visible field of an alert / toast / confirm object: { text: .. }, { body: .. }.
  // (`raw:` is the "?" description and is cut out first.)
  { name: 'visible field', re: new RegExp(String.raw`\b(?:text|body|title|description):\s*(?:[^,{}]*?(?:\|\||\?\?)\s*)?${ERR}`, 'g') },
];

// Calls whose `.message` argument is fine, cut out (balanced parentheses) before scanning:
// the mapper and its helpers, console logging, and regex / string tests on the line.
const SAFE_CALL = /\b(?:humanize\w*|errAlert|errReason|errText|plainError|console\.\w+)\(|\.(?:test|includes|startsWith|endsWith|match)\(/g;
// `raw: err.message` is the "?" description, the one place the raw line may go.
const rawField = (E) => new RegExp(String.raw`\braw:\s*(?:${E})`, 'g');

// 'relative/path:snippet' -> why it is not a render. The snippet must appear in the match.
const ALLOWED = {
  'components/ui/ActionButton.jsx:setError(err?.message':
    "the hook's own state: it only reaches callers through onError as the raw detail, which they put behind the \"?\"",
};

// Keep line numbers stable: every cut keeps its newlines.
const blank = (s) => s.replace(/[^\n]/g, ' ');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // A line comment, but not the "//" inside "https://" or a string ending in ':'.
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
}

function stripSafeCalls(src) {
  let out = src;
  SAFE_CALL.lastIndex = 0;
  let m;
  while ((m = SAFE_CALL.exec(out))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < out.length && depth) {
      if (out[i] === '(') depth += 1;
      else if (out[i] === ')') depth -= 1;
      i += 1;
    }
    const inner = out.slice(m.index + m[0].length, i - 1);
    out = out.slice(0, m.index + m[0].length) + blank(inner) + out.slice(i - 1);
    SAFE_CALL.lastIndex = m.index + m[0].length;
  }
  return out;
}

function scan(src) {
  const safe = stripSafeCalls(stripComments(src));
  const names = aliasesOf(safe);
  // The raw line, or any alias of it: (?:err.message|detail|msg).
  const E = names.size ? String.raw`(?:${ERR}|(?<![\w$.])(?:${nameAlt(names)})\b)` : ERR;
  const clean = safe.replace(rawField(E), blank);
  const hits = [];
  for (const { name, re } of patternsFor(E)) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean))) {
      const line = clean.slice(0, m.index).split('\n').length;
      hits.push({ pattern: name, line, text: m[0].replace(/\s+/g, ' ').trim() });
    }
  }
  return hits;
}

function collect(dir, { recurse, exts }) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (recurse) out.push(...collect(full, { recurse, exts })); }
    else if (exts.some((x) => entry.name.endsWith(x))) out.push(full);
  }
  return out;
}

const FILES = [
  ...collect(path.join(SRC, 'components'), { recurse: true, exts: ['.jsx'] }),
  ...collect(path.join(SRC, 'lib'), { recurse: false, exts: ['.js', '.jsx'] }),
].filter((f) => !f.endsWith(path.join('lib', 'failureCopy.js')));

describe('no raw error text rendered inline', () => {
  it('the scanner flags each raw-render shape and passes the safe ones', () => {
    const bad = [
      '<p>{err.message}</p>',
      '<span>{error?.message || t("x")}</span>',
      'setError(e?.message || null);',
      "showToast({ kind: 'error', text: err.message });",
      "t('radar.ask.error.send', { reason: err.message })",
      '<b title={err.message}>x</b>',
      "confirm({ body: err.message || t('x') })",
      // A simple alias of the raw line is the raw line.
      'const detail = err.message;\n<p>{detail}</p>',
      "const msg = e?.message || 'failed';\nsetError(msg);",
      "const reason = String(err.message);\nshowToast({ kind: 'error', text: reason });",
      "const why = String(error?.message || '');\n<b title={why}>x</b>",
      "let d = err.message ?? '';\nt('k', { reason: d })",
      "var d = (err.message || 'x');\nconfirm({ body: d })",
      // An alias of an alias.
      'const raw0 = err.message;\nconst shown = raw0;\n<p>{shown}</p>',
      // Trimmed, or the branch of a type-guard ternary.
      'const line = err.message.trim();\n<p>{line}</p>',
      "const detail = typeof err?.message === 'string' ? err.message.trim() : '';\nsetStatus(detail);",
    ];
    for (const src of bad) expect(scan(src), src).not.toHaveLength(0);
    const good = [
      '<InfoTip label={err.message} />',
      'setError(humanizeAction(err, t, { fallbackKey: "error.action" }));',
      "showToast({ kind: 'error', text: errText(err, t, 'k') });",
      "setError({ text: t('k'), raw: err?.message || null });",
      'console.warn(err.message);',
      'if (/exists/i.test(err?.message || "")) return;',
      '{err?.message ? <X /> : null}',
      '// {err.message} in a comment',
      // An alias that only reaches the "?", a log, a condition or the raw field is fine,
      // and so is a value DERIVED from the line (a test, its length) or a same-named property.
      'const detail = err.message;\n<InfoTip label={detail} />',
      "const detail = err.message;\nsetError({ text: t('k'), raw: detail });",
      'const detail = err.message;\nconsole.warn(detail);',
      'const detail = err.message;\n{detail ? <X /> : null}',
      "const dup = err.message.includes('exists');\nsetDup(dup);",
      'const n = err?.message?.length;\nsetN(n);',
      'const detail = err.message;\n<p>{row.detail}</p>',
      "const text = humanizeAction(err, t, { fallbackKey: 'k' });\nsetError(text);",
      "const gone = err.message === 'not found';\nsetGone(gone);",
      "const label = err.message ? t('a') : t('b');\nsetLabel(label);",
      "const detail = typeof err?.message === 'string' ? err.message.trim() : '';\nsetStatus({ tone: 'error', msg: t('k'), raw: detail || null });",
    ];
    for (const src of good) expect(scan(src), src).toEqual([]);
  });

  it('no component or lib module renders a raw error line', () => {
    const used = new Set();
    const offenders = [];
    for (const file of FILES) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      for (const hit of scan(fs.readFileSync(file, 'utf8'))) {
        const key = Object.keys(ALLOWED).find((k) => k.startsWith(`${rel}:`) && hit.text.includes(k.slice(rel.length + 1)));
        if (key) used.add(key);
        else offenders.push(`${rel}:${hit.line} [${hit.pattern}] ${hit.text}`);
      }
    }
    expect(offenders, 'Route the error through humanizeAction/humanizeFailure (lib/failureCopy.js); the raw line may only be the InfoTip "?"').toEqual([]);
    // A stale allowlist entry hides nothing and only misleads: prune it.
    expect(Object.keys(ALLOWED).filter((k) => !used.has(k))).toEqual([]);
  });
});
