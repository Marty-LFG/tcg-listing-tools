// lib/plugin-registry.mjs — answer "is this dev server running the code that is on disk?"
//
// Written after a real incident. ALCSERVER reported the current git commit and served the new
// /api/settings entry, yet /api/listing-image/* fell through to Vite's page fallback: the process
// had `lib/status.mjs` loaded but had never run the new plugin's `configureServer`, which only fires
// at startup. The uploader page just said "could not read the compositor settings" and nothing
// pointed at the actual cause.
//
// The trap is that a stale process has stale EVERYTHING in memory — its config object, its module
// graph, even the git commit if that was memoised at boot. Comparing two in-memory values can never
// catch it. So this compares two things that genuinely differ:
//
//   · WHEN the running server registered its plugins (memory, frozen at startup), against
//   · the newest mtime of the server sources ON DISK (read fresh on every call).
//
// A source file newer than the registration means the process predates the code. That is exactly
// what a `git pull` without a restart looks like, and it is what this reports.
//
// THE SECOND INCIDENT (2026-09-13) slipped past that comparison. A `git pull` writes many files over
// a few hundred milliseconds; Vite began restarting on the FIRST lib change, bundled vite.config.js
// before git had rewritten it, and coalesced the later "vite.config.js changed" trigger into the
// restart already in flight. The result registered AFTER every file's mtime — not stale by time —
// yet ran the old plugin list with the new library code: lib/status.mjs knew about the arbitrage
// settings while /api/arb fell through to the page fallback. So there is a second comparison that
// does not involve time at all: how many entries the running config handed withRegistry, against
// how many the plugins array in vite.config.js ON DISK has. A mismatch is that race, by name.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Server sources whose changes need a restart to take effect. Deliberately NOT the HTML pages or
// anything under data/ — those are re-read per request, so a newer one proves nothing.
const WATCHED = [
  { file: 'vite.config.js' },
  { dir: 'lib', ext: '.mjs' },
];

const _registered = new Map();   // plugin name -> ISO timestamp
let _firstAt = null;
let _givenCount = null;          // how many entries the RUNNING config's plugins array had

/** Called from each plugin's configureServer, via withRegistry() in vite.config.js. */
export function notePlugin(name) {
  const at = new Date().toISOString();
  if (!_firstAt) _firstAt = at;
  _registered.set(name, at);
}

export const registeredPlugins = () => [..._registered.keys()].sort();
export const registeredAt = () => _firstAt;

/**
 * Wrap a Vite plugins array so every plugin records itself when its configureServer runs.
 * One call site in vite.config.js, so a plugin added later is covered without remembering to.
 * Plugins with no configureServer are passed through untouched — they own no routes, so their
 * presence tells us nothing about whether the server is stale.
 */
export function withRegistry(plugins) {
  _givenCount = Array.isArray(plugins) ? plugins.length : null;
  return plugins.map((p) => {
    if (!p || typeof p.configureServer !== 'function') return p;
    const inner = p.configureServer;
    return {
      ...p,
      configureServer(server) {
        notePlugin(p.name || '(unnamed)');
        return inner.call(this, server);
      },
    };
  });
}

function* walk(dir, ext) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, ext);
    else if (e.name.endsWith(ext)) yield p;
  }
}

function watchedFiles() {
  const out = [];
  for (const w of WATCHED) {
    if (w.file) { const p = path.join(ROOT, w.file); if (fs.existsSync(p)) out.push(p); }
    else out.push(...walk(path.join(ROOT, w.dir), w.ext));
  }
  return out;
}

// Slack between a file's mtime and the registration timestamp. Registration happens during startup,
// while the files it loaded were written moments earlier, and mtime resolution varies by filesystem
// (FAT is 2s). Without this every server would look stale the instant it booted.
export const MTIME_SLACK_MS = 2000;

/**
 * The pure comparison, split out so it can be tested without touching real file times.
 * @param firstAt ISO timestamp of the first plugin registration, or null
 * @param files   [{ path, mtimeMs }] — server sources as they are on disk right now
 */
export function assessStaleness(firstAt, files) {
  if (!firstAt) return { stale: null, stale_files: [], stale_count: 0, newest_source: null, newest_source_mtime: null, note: 'no plugin has registered yet' };
  const cutoff = Date.parse(firstAt);
  let newest = null, newestMs = 0;
  const stale = [];
  for (const f of files) {
    if (!Number.isFinite(f.mtimeMs)) continue;
    if (f.mtimeMs > newestMs) { newestMs = f.mtimeMs; newest = f.path; }
    if (f.mtimeMs > cutoff + MTIME_SLACK_MS) stale.push(f.path);
  }
  return {
    stale: stale.length > 0,
    stale_files: stale.sort().slice(0, 20),
    stale_count: stale.length,
    newest_source: newest,
    newest_source_mtime: newestMs ? new Date(newestMs).toISOString() : null,
    note: stale.length ? 'server sources on disk are newer than this process — restart the dev server' : null,
  };
}

/**
 * How many entries the plugins array in a vite.config.js SOURCE has. Counts top-level commas inside
 * the `withRegistry([ ... ])` literal, tracking bracket depth so `xPlugin(env)` and nested arrays do
 * not split. Null when the literal cannot be found — an unknown is never reported as a match.
 */
export function countConfigPlugins(source) {
  const src = String(source || '');
  const start = src.indexOf('withRegistry([');
  if (start < 0) return null;
  let i = start + 'withRegistry(['.length, depth = 0, entries = 0, sawContent = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth--;
    else if (ch === ']') { if (depth === 0) break; depth--; }
    else if (ch === ',' && depth === 0) { entries++; sawContent = false; continue; }
    if (!/\s/.test(ch)) sawContent = true;
  }
  if (i >= src.length) return null;
  return entries + (sawContent ? 1 : 0);
}

/**
 * The count comparison: running vs on disk. Pure, so the race can be tested without a race.
 */
export function assessPluginCount(givenCount, diskCount) {
  if (givenCount == null || diskCount == null) return { plugins_running: givenCount, plugins_on_disk: diskCount, count_mismatch: null };
  return {
    plugins_running: givenCount, plugins_on_disk: diskCount, count_mismatch: givenCount !== diskCount,
    ...(givenCount !== diskCount ? { note: `vite.config.js on disk lists ${diskCount} plugins but this process loaded ${givenCount} — the restart raced the pull; restart the dev server` } : {}),
  };
}

/**
 * { registered, registered_at, stale, stale_files, newest_source, newest_source_mtime,
 *   plugins_running, plugins_on_disk, count_mismatch }
 *
 * `stale: true` means at least one server source on disk is newer than the moment this process
 * registered its plugins — restart the dev server. Never throws: a diagnostic that can 500 is worse
 * than no diagnostic.
 */
export function pluginHealth() {
  const base = { registered: registeredPlugins(), registered_at: _firstAt };
  try {
    const files = watchedFiles().map((f) => {
      let mtimeMs = NaN;
      try { mtimeMs = fs.statSync(f).mtimeMs; } catch { /* vanished mid-walk */ }
      return { path: path.relative(ROOT, f).replace(/\\/g, '/'), mtimeMs };
    });
    const byTime = assessStaleness(_firstAt, files);
    let diskCount = null;
    try { diskCount = countConfigPlugins(fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8')); } catch { /* unreadable: unknown */ }
    const byCount = assessPluginCount(_givenCount, diskCount);
    // Either signal is enough: a stale-by-time server IS stale, and a count mismatch is stale even
    // when every file predates the registration timestamp.
    const stale = byTime.stale === true || byCount.count_mismatch === true ? true : byTime.stale;
    return { ...base, ...byTime, ...byCount, stale, note: byCount.count_mismatch ? byCount.note : byTime.note };
  } catch (e) { return { ...base, stale: null, stale_files: [], error: String(e?.message || e) }; }
}

// Test seam.
export function _reset() { _registered.clear(); _firstAt = null; _givenCount = null; }
