// test/helpers/extract-inline.mjs — shared source-extraction helpers for the test suite.
//
// Generalised from scripts/check-listing-copy.mjs: the builders are standalone HTML
// pages with classic inline <script>s that tests cannot import, so invariant tests
// read the HTML as text and extract functions (brace-counted) or whole script bodies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Strip JS comments so an invariant can assert on what the code DOES rather than on what it says.
// Without this, a source-scanning test cannot tell the difference between a module that calls
// postagePhrase() and one whose header explains why it must never call postagePhrase() — and the
// second is exactly the comment such a test wants to encourage.
//
// Quote-, template- AND regex-aware. Regex literals are the reason this is not four lines: a pattern
// like /"/g contains a bare double quote, and a stripper that does not know it is inside a regex opens
// a string state that never closes — after which every later comment in the file survives, silently,
// and the invariant using this passes for the wrong reason. (That happened on the first draft.)
//
// Telling a regex from a division needs context, so we use the standard heuristic: a '/' begins a
// regex when the previous significant token cannot end an expression. Character classes are tracked,
// so /[^/]/ is handled too. Newlines inside block comments are preserved so line numbers line up.
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n']);
const REGEX_KEYWORDS = /\b(return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/;

export function stripComments(src) {
  let out = '';
  let state = 'code';                       // code | line | block | sq | dq | tpl | regex
  let prev = '';                            // last significant char emitted in code state
  let inClass = false;                      // inside a regex [...] character class
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === '/') {
        // Regex or division? Division can only follow something that ends an expression.
        const isRegex = prev === '' || REGEX_PRECEDERS.has(prev) || REGEX_KEYWORDS.test(out.trimEnd());
        if (isRegex) { state = 'regex'; inClass = false; }
        out += c; prev = c; i++; continue;
      }
      if (c === "'" || c === '"' || c === '`') state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
      out += c;
      if (!/\s/.test(c) || c === '\n') prev = c;
      i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; prev = '\n'; out += c; } i++; continue; }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; } else { if (c === '\n') out += c; i++; }
      continue;
    }
    if (state === 'regex') {
      if (c === '\\') { out += c + (d || ''); i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { state = 'code'; prev = '/'; }
      else if (c === '\n') { state = 'code'; prev = '\n'; }   // an unterminated regex is not a regex
      out += c; i++; continue;
    }
    // inside a string / template
    if (c === '\\') { out += c + (d || ''); i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'; prev = c;
    }
    out += c; i++;
  }
  return out;
}

// Extract `marker...{body}` from source by brace-counting from the first '{' after marker.
export function extractFn(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('marker not found: ' + marker);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced braces after: ' + marker);
}

// All inline <script> blocks of an HTML source (skips <script src=...>).
// Returns [{ type: 'classic'|'module', body, index }].
export function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /type\s*=\s*["']?module/i.test(attrs) ? 'module' : 'classic';
    const body = m[2];
    if (body.trim()) out.push({ type, body, index: i });
    i++;
  }
  return out;
}

// The card builders (Golden Rule 6 scope) + the two collectibles builders.
export const CARD_BUILDERS = [
  'pokemon-listing-builder.html',
  'mtg-listing-builder.html',
  'swu-listing-builder.html',
  'lorcana-listing-builder.html',
  'riftbound-listing-builder.html',
  'onepiece-listing-builder.html',
];
export const COLLECTIBLE_BUILDERS = ['lego-listing-builder.html', 'funko-listing-builder.html'];
