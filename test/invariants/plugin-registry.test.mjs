// test/invariants/plugin-registry.test.mjs — every route-owning plugin must go through withRegistry.
//
// The staleness check in /api/status is only as good as its coverage: a plugin added to the array
// outside the wrapper registers nothing, so its routes can be missing from a running server with
// nothing reporting it. That is the exact failure this whole module exists to catch, so it must not
// be possible to reintroduce by editing one line of vite.config.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pluginHealth, assessStaleness, withRegistry, registeredPlugins, notePlugin, MTIME_SLACK_MS, _reset } from '../../lib/plugin-registry.mjs';
import { read } from '../helpers/extract-inline.mjs';

const config = read('vite.config.js');

describe('vite.config.js plugin wiring', () => {
  it('the plugins array is wrapped in withRegistry', () => {
    assert.match(config, /plugins:\s*withRegistry\(\[/, 'plugins must be withRegistry([...]) or the staleness check goes blind');
  });

  it('there is exactly ONE plugins array, so nothing registers outside the wrapper', () => {
    const arrays = config.match(/^\s*plugins:\s*/gm) || [];
    assert.equal(arrays.length, 1, `found ${arrays.length} plugins: entries — each needs withRegistry`);
  });

  it('withRegistry is imported from the registry, not shadowed locally', () => {
    assert.match(config, /import \{ withRegistry \} from '\.\/lib\/plugin-registry\.mjs'/);
  });

  it('every plugin factory imported for the array is inside the wrapped call', () => {
    // Pull the array's contents and check each `xPlugin(env)` / bare identifier resolves to
    // something imported. Guards against a plugin appended after the closing bracket.
    const m = config.match(/plugins:\s*withRegistry\(\[([\s\S]*?)\]\)/);
    assert.ok(m, 'could not read the plugins array');
    const names = [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*(?:\(|,|\])/g)].map((x) => x[1]);
    assert.ok(names.length >= 15, `only found ${names.length} plugins — did the array move?`);
    for (const n of names) {
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`).test(config);
      const declared = new RegExp(`const\\s+${n}\\s*=`).test(config) || new RegExp(`function\\s+${n}\\b`).test(config);
      assert.ok(imported || declared, `plugin '${n}' in the array is neither imported nor declared`);
    }
  });
});

describe('withRegistry', () => {
  it('records each plugin when its configureServer runs, and still calls it', () => {
    _reset();
    const calls = [];
    const wrapped = withRegistry([
      { name: 'alpha', configureServer(s) { calls.push(['alpha', s]); } },
      { name: 'beta', configureServer(s) { calls.push(['beta', s]); } },
    ]);
    assert.deepEqual(registeredPlugins(), [], 'nothing registers until the server starts');
    for (const p of wrapped) p.configureServer('SERVER');
    assert.deepEqual(registeredPlugins(), ['alpha', 'beta']);
    assert.deepEqual(calls, [['alpha', 'SERVER'], ['beta', 'SERVER']], 'the original hook must still run, with its argument');
    _reset();
  });

  it('passes through a plugin with no configureServer untouched', () => {
    const plain = { name: 'no-routes', transform() {} };
    const [out] = withRegistry([plain]);
    assert.equal(out, plain, 'a plugin that owns no routes says nothing about staleness');
  });

  it('survives a null entry in the array', () => {
    assert.doesNotThrow(() => withRegistry([null, undefined, { name: 'x' }]));
  });

  it('preserves every other plugin property', () => {
    const [out] = withRegistry([{ name: 'k', enforce: 'pre', apply: 'serve', configureServer() {} }]);
    assert.equal(out.name, 'k');
    assert.equal(out.enforce, 'pre');
    assert.equal(out.apply, 'serve');
  });
});

describe('assessStaleness', () => {
  const T = (iso) => Date.parse(iso);
  const BOOT = '2026-07-28T10:00:00.000Z';

  it('flags a file written after the server registered — the pull-without-restart case', () => {
    const r = assessStaleness(BOOT, [
      { path: 'lib/old.mjs', mtimeMs: T('2026-07-28T09:00:00Z') },
      { path: 'lib/listing-image-lab.mjs', mtimeMs: T('2026-07-29T12:00:00Z') },
      { path: 'vite.config.js', mtimeMs: T('2026-07-29T12:00:00Z') },
    ]);
    assert.equal(r.stale, true);
    assert.deepEqual(r.stale_files, ['lib/listing-image-lab.mjs', 'vite.config.js']);
    assert.equal(r.stale_count, 2);
    assert.match(r.note, /restart the dev server/);
  });

  it('is not stale when every source predates registration', () => {
    const r = assessStaleness(BOOT, [
      { path: 'lib/a.mjs', mtimeMs: T('2026-07-28T09:59:00Z') },
      { path: 'vite.config.js', mtimeMs: T('2026-07-20T00:00:00Z') },
    ]);
    assert.equal(r.stale, false);
    assert.deepEqual(r.stale_files, []);
    assert.equal(r.note, null);
  });

  it('tolerates the startup race: files written moments before registration are not stale', () => {
    // The server stats its own sources AFTER loading them, so they are always a shade older.
    const r = assessStaleness(BOOT, [{ path: 'lib/a.mjs', mtimeMs: T(BOOT) + MTIME_SLACK_MS - 1 }]);
    assert.equal(r.stale, false, 'a sub-slack difference must not read as stale');
  });

  it('but a file past the slack window IS stale', () => {
    const r = assessStaleness(BOOT, [{ path: 'lib/a.mjs', mtimeMs: T(BOOT) + MTIME_SLACK_MS + 1 }]);
    assert.equal(r.stale, true);
  });

  it('reports the newest source even when nothing is stale', () => {
    const r = assessStaleness(BOOT, [
      { path: 'lib/a.mjs', mtimeMs: T('2026-07-01T00:00:00Z') },
      { path: 'lib/b.mjs', mtimeMs: T('2026-07-27T00:00:00Z') },
    ]);
    assert.equal(r.newest_source, 'lib/b.mjs');
    assert.equal(r.newest_source_mtime, '2026-07-27T00:00:00.000Z');
  });

  it('unknown is null, never false — "no plugin registered" must not read as healthy', () => {
    const r = assessStaleness(null, [{ path: 'lib/a.mjs', mtimeMs: Date.parse('2026-07-29T00:00:00Z') }]);
    assert.equal(r.stale, null);
    assert.match(r.note, /no plugin has registered/);
  });

  it('skips files whose mtime could not be read rather than counting them', () => {
    const r = assessStaleness(BOOT, [{ path: 'lib/gone.mjs', mtimeMs: NaN }]);
    assert.equal(r.stale, false);
    assert.equal(r.newest_source, null);
  });

  it('caps the reported list so a wholesale rebuild does not flood the response', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ path: `lib/f${String(i).padStart(2, '0')}.mjs`, mtimeMs: T('2026-07-29T00:00:00Z') }));
    const r = assessStaleness(BOOT, many);
    assert.equal(r.stale_files.length, 20);
    assert.equal(r.stale_count, 60, 'the full count must still be reported');
  });
});

describe('pluginHealth against the real tree', () => {
  it('reports "no plugin has registered yet" rather than claiming healthy', () => {
    _reset();
    const h = pluginHealth();
    assert.equal(h.stale, null, 'unknown must not be reported as false');
    assert.match(h.note, /no plugin has registered/);
  });

  it('walks the real server sources and names the newest', () => {
    _reset();
    notePlugin('fresh');
    const h = pluginHealth();
    assert.deepEqual(h.registered, ['fresh']);
    assert.ok(h.registered_at, 'registration time must be reported — it is half the comparison');
    assert.ok(h.newest_source, 'should report the newest source it looked at');
    assert.match(h.newest_source, /\.(mjs|js)$/);
    // Registering just now means nothing on disk can be newer.
    assert.equal(h.stale, false, `unexpectedly stale: ${JSON.stringify(h.stale_files)}`);
    _reset();
  });

  it('never throws — a diagnostic that 500s is worse than none', () => {
    _reset();
    assert.doesNotThrow(() => pluginHealth());
    notePlugin('x');
    assert.doesNotThrow(() => pluginHealth());
    _reset();
  });
});
