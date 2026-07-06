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

// The five card builders (Golden Rule 6 scope) + the two collectibles builders.
export const CARD_BUILDERS = [
  'pokemon-listing-builder.html',
  'mtg-listing-builder.html',
  'swu-listing-builder.html',
  'lorcana-listing-builder.html',
  'riftbound-listing-builder.html',
];
export const COLLECTIBLE_BUILDERS = ['lego-listing-builder.html', 'funko-listing-builder.html'];
