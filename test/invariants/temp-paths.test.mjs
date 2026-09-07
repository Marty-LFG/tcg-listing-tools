// test/invariants/temp-paths.test.mjs — a test's scratch path is never named after the process id.
//
// THE BUG THIS EXISTS TO PREVENT, which already happened once (f409b32):
//
//   const DIR = path.join(os.tmpdir(), 'tcg-postsale-inbox-' + process.pid);
//
// Windows RECYCLES pids, so that name is not unique across runs. On its own that would be harmless —
// but the file's teardown could not delete the directory either, because rmSync fails EPERM on
// Windows while a SQLite handle is open, and the `catch {}` swallowed it. 197 of those directories
// accumulated, each holding a database. Eventually a run whose pid matched an old one opened a
// database that was not empty, a leftover row silently swallowed an ON CONFLICT DO NOTHING insert,
// and a test that asserts a deal was created got zero.
//
// It failed roughly one run in nine, passed in isolation, and passed on retry — which is the worst
// shape a test failure can have, because the reflex is to re-run it and move on.
//
// TWO PROPERTIES, and only the first is enforced here:
//
//   · UNIQUENESS prevents inheritance. That is the correctness bug, and mkdtemp settles it: a leaked
//     directory with a unique name can never be handed to a later run.
//   · CLEANUP prevents disk leak. Nothing on Windows guarantees it while a handle is open, so it is
//     a matter of care in each file's teardown (close the handle BEFORE removing the directory) and
//     not something a source assertion can decide.
//
// So this pins uniqueness only. A leak is wasted disk; an inherited database is a wrong answer.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';

const TEST_DIR = path.join(ROOT, 'test');

/** Every .mjs under test/, recursively. */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = walk(TEST_DIR);

describe('no test builds a scratch path from process.pid', () => {
  it('found test files to check', () => {
    // A walk that silently returns nothing would make every assertion below vacuous — the exact
    // failure mode half of this session was spent removing.
    assert.ok(files.length > 50, `only found ${files.length} test files — did the walk break?`);
  });

  it('every temp path is unique by construction', () => {
    const offenders = [];

    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      // This file necessarily contains the pattern it bans, in prose.
      if (rel === 'test/invariants/temp-paths.test.mjs') continue;

      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const code = line.trim();
        // Commentary is where the reasoning lives — the fixed files quote the old expression to
        // explain it, and flagging that would make the guard unusable.
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (!code.includes('process.pid')) return;
        // process.pid is fine on its own — listings-compose-context uses it to vary a Buffer's bytes
        // so two fixtures hash differently. It is only a problem when it names a PATH.
        const isPath = /tmpdir\(\)|path\.join|\.db['"`]|\.json['"`]|mkdir/.test(code);
        if (isPath) offenders.push(`${rel}:${i + 1}  ${code}`);
      });
    }

    assert.deepEqual(offenders, [],
      'a pid is not unique — Windows recycles them, and a leaked directory then becomes a later run\'s '
      + 'starting state. Use tmpDir(prefix) or tmpFile(name, prefix) from test/helpers/tmp.mjs, which '
      + 'are built on mkdtempSync:\n  ' + offenders.join('\n  '));
  });

  it('the helper everyone should be using is still built on mkdtemp', () => {
    // The guard above is only worth anything while the recommended alternative actually provides the
    // guarantee. If tmpDir ever stopped using mkdtempSync, every converted file would quietly lose it.
    const helper = fs.readFileSync(path.join(TEST_DIR, 'helpers', 'tmp.mjs'), 'utf8');
    assert.match(helper, /mkdtempSync/, 'tmpDir must keep using mkdtempSync — that IS the uniqueness');
    assert.match(helper, /export function tmpDir/);
    assert.match(helper, /export function tmpFile/);
  });
});

describe('the pieces that make a run leave nothing behind', () => {
  // A full `pnpm verify` leaks ZERO temp directories. Getting there took three structural things, and
  // any one of them going missing brings the leak back quietly — the symptom is disk, not a red test,
  // so nothing else would notice. Measuring the leak properly means running a whole suite and counting
  // temp, which is not something a unit test can do; these pins are the next best thing.
  //
  // To measure it by hand:
  //   before=$(ls "$TEMP" | grep -cE '^(tcg-|sealimg-|sealed-listing-)')
  //   pnpm verify
  //   after=$(ls  "$TEMP" | grep -cE '^(tcg-|sealimg-|sealed-listing-)')   # after should equal before

  it('the four database modules each export a closer', () => {
    // A closer must CLEAR its singleton as well as closing the handle. Closing without clearing would
    // leave every later open() returning a closed database — a failure nobody would trace to teardown.
    for (const [file, fn, singleton] of [
      ['lib/db.mjs', 'closeDb', '_db'],
      ['lib/postsale-db.mjs', 'closePostsaleDb', '_pdb'],
      ['lib/repricer-db.mjs', 'closeRepricerDb', '_rdb'],
      ['lib/keepers-db.mjs', 'closeKeepersDb', '_kdb'],
    ]) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(src.includes(`export function ${fn}(`), `${file} must export ${fn}`);
      const body = src.slice(src.indexOf(`export function ${fn}(`));
      assert.match(body.slice(0, 400), new RegExp(singleton + ' = null'),
        `${fn} must clear ${singleton}, not just close the handle`);
    }
  });

  it('vite.config.js closes them when the dev server shuts down', () => {
    // THE SUBTLE ONE. Vite evaluates this config in its own module graph, so lib/db.mjs is
    // instantiated twice in a test process — once for the plugins, once for whatever the test
    // imports. Closing from the test side reached a different singleton and did nothing; measured, it
    // returned false for all four. Only a plugin is on the right side of that boundary, and only a
    // STATIC import shares the instance: a dynamic import() inside the plugin loads a third copy.
    const cfg = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
    assert.match(cfg, /name: 'db-cleanup'/, 'the db-cleanup plugin is what closes the plugin-side databases');
    for (const fn of ['closeDb', 'closePostsaleDb', 'closeRepricerDb', 'closeKeepersDb']) {
      assert.ok(cfg.includes(`import { ${fn} } from`),
        `${fn} must be imported STATICALLY — a dynamic import() gets a different module instance`);
    }
    assert.match(cfg, /plugins: withRegistry\(\[dbCleanup,/, 'the plugin has to be in the array to run');
  });

  it('the helper retries past Windows handle-release lag', () => {
    // Closing a file does not always release its handle immediately on Windows, so an rmSync issued
    // microseconds later can still get EPERM even when the owner did everything right.
    const helper = fs.readFileSync(path.join(TEST_DIR, 'helpers', 'tmp.mjs'), 'utf8');
    assert.match(helper, /maxRetries: \d+/, 'rmSync needs maxRetries or a correct teardown can still lose the race');
  });
});

describe('no test writes scratch into the working tree', () => {
  it('nothing builds a temp path under test/ or the repo root', () => {
    // Two files used to put their cache in `test/.tmp-compose-cache-<pid>` and
    // `test/.tmp-band-cache-<pid>`. git does not ignore either, so a leak there shows up in
    // `git status` and can be committed — which none of the os.tmpdir() leaks ever could.
    const offenders = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (rel === 'test/invariants/temp-paths.test.mjs') continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (/['"`]\.tmp-/.test(code)) offenders.push(`${rel}:${i + 1}  ${code}`);
      });
    }
    assert.deepEqual(offenders, [],
      'scratch belongs in os.tmpdir() via test/helpers/tmp.mjs, not in the working tree where git can '
      + 'see it:\n  ' + offenders.join('\n  '));
  });
});
