// lib/set-art-data.mjs — one reader for the per-game baked set-art indexes
// (data/<game>-set-art.json, written by scripts/build-{mtg-set-logos,lorcana-set-art,
// swu-set-art,onepiece-set-art}.mjs).
//
// All four bakes share one doc shape — { format, game, sets: { <normKey>: entry } } with entries
// keyed under BOTH the normalised set name and set code — so composeMetaFor needs exactly one
// lookup function however much a given game's bake carries (MTG: logoUrl; Lorcana: logoUrl +
// printedTotal; SWU: printedTotal; One Piece: name↔code only).
//
// Absence is a state, not an error: a host that has never run the bake resolves null for
// everything and the rail falls back to the game logo (GR7).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normSetKey } from './pkm-sets-cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX_FORMAT = 1;

const FILES = {
  mtg: 'mtg-set-art.json',
  lorcana: 'lorcana-set-art.json',
  swu: 'swu-set-art.json',
  onepiece: 'onepiece-set-art.json',
};

// Memoised per game on file mtime, same shape as lib/riftbound-data.mjs — the compose path calls
// this per listing and a JSON parse per compose would be pure waste.
const _cache = new Map();   // game -> { mtime, sets }

function loadIndex(game) {
  const file = FILES[game];
  if (!file) return null;
  const p = path.join(ROOT, 'data', file);
  let mtime;
  try { mtime = fs.statSync(p).mtimeMs; } catch { _cache.delete(game); return null; }
  const hit = _cache.get(game);
  if (hit && hit.mtime === mtime) return hit.sets;
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Refuse a shape we do not understand rather than mis-reading it (same rule as the symbol bake).
    const sets = doc && doc.format === INDEX_FORMAT && doc.sets && typeof doc.sets === 'object' ? doc.sets : null;
    _cache.set(game, { mtime, sets });
    return sets;
  } catch {
    // Negative-cache under the same mtime — a corrupt file must not cost a full read + parse-throw
    // on every compose until it is rewritten (the rewrite changes mtime and clears this naturally).
    _cache.set(game, { mtime, sets: null });
    return null;
  }
}

/**
 * findGameSetArt('lorcana', { code: '1', name: 'The First Chapter' })
 *   -> { name, code, logoUrl?, printedTotal? } | null
 * Candidates are tried in order: name first (the more specific identity), then code.
 */
export function findGameSetArt(game, { code, name } = {}) {
  const sets = loadIndex(game);
  if (!sets) return null;
  for (const c of [name, code]) {
    const k = normSetKey(c);
    // Object.hasOwn, not a truthiness peek: `sets` is JSON-parsed with a live prototype chain, and
    // an identity normalising to 'constructor' would otherwise return Object.prototype.constructor
    // as the "entry" — and print "Object" on the rail as the set name.
    if (k && Object.hasOwn(sets, k) && sets[k]) return sets[k];
  }
  return null;
}

export function clearSetArtCache() { _cache.clear(); }
