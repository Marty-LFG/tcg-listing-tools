// test/unit/backup.test.mjs — the scheduled SQLite snapshot job (lib/backup.mjs).
// Exercises the real VACUUM INTO path against a throwaway DB (never touches data/*.db) + rotation +
// the singleton timer. Offline, no network.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpDir } from '../helpers/tmp.mjs';
import { runBackup, startBackups, stopBackups, getBackupState } from '../../lib/backup.mjs';

// A tiny throwaway DB with one row, so we can prove the snapshot is a real, readable copy.
function makeDb() {
  const file = path.join(tmpDir('bk-src-'), 'src.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  return { db, file };
}
const snapDirs = (out) => fs.readdirSync(out).filter((n) => /^\d{4}-\d{2}-\d{2}_/.test(n)).sort();

describe('runBackup — VACUUM INTO snapshot', () => {
  it('writes a valid, consistent copy of each source DB + a config bundle', async () => {
    const { db } = makeDb();
    const out = tmpDir('bk-out-');
    const rec = await runBackup({ sources: [{ name: 'tracker', db }], outDir: out, keep: 14,
      includeSecrets: false, now: new Date('2026-07-13T10:00:00Z') });

    assert.equal(rec.ok, true, 'backup reports ok');
    const dirs = snapDirs(out);
    assert.equal(dirs.length, 1, 'one snapshot folder created');
    const snapDb = path.join(out, dirs[0], 'tracker.db');
    assert.ok(fs.existsSync(snapDb) && fs.statSync(snapDb).size > 0, 'snapshot .db exists and is non-empty');

    // The copy must be a real, openable SQLite carrying the source rows (proves consistency).
    const copy = new DatabaseSync(snapDb, { readOnly: true });
    assert.equal(copy.prepare('SELECT v FROM t WHERE id = 1').get().v, 'hello');
    copy.close();
  });

  it('does NOT copy secrets when include_secrets is false (default)', async () => {
    const { db } = makeDb();
    const out = tmpDir('bk-out-');
    await runBackup({ sources: [{ name: 'tracker', db }], outDir: out, keep: 14,
      includeSecrets: false, now: new Date('2026-07-13T11:00:00Z') });
    const cfgDir = path.join(out, snapDirs(out)[0], 'config');
    const copied = fs.existsSync(cfgDir) ? fs.readdirSync(cfgDir) : [];
    assert.ok(!copied.includes('.env'), '.env must never be bundled unless include_secrets is on');
  });

  it('rotates to the newest `keep` snapshots', async () => {
    const { db } = makeDb();
    const out = tmpDir('bk-out-');
    for (const h of ['08', '09', '10', '11']) {
      await runBackup({ sources: [{ name: 'tracker', db }], outDir: out, keep: 2,
        includeSecrets: false, now: new Date(`2026-07-13T${h}:00:00Z`) });
    }
    const dirs = snapDirs(out);
    assert.equal(dirs.length, 2, 'only keep=2 snapshots remain');
    assert.deepEqual(dirs, ['2026-07-13_10-00-00', '2026-07-13_11-00-00'], 'the two NEWEST are kept');
  });

  it('a broken source is recorded, never thrown (GR7)', async () => {
    const out = tmpDir('bk-out-');
    const bad = { name: 'tracker', db: { exec() { throw new Error('boom'); } } };
    const rec = await runBackup({ sources: [bad], outDir: out, keep: 5, includeSecrets: false,
      now: new Date('2026-07-13T12:00:00Z') });
    assert.equal(rec.ok, false, 'overall ok=false when a source fails');
    assert.equal(rec.results.find((r) => r.name === 'tracker').ok, false);
  });
});

describe('startBackups / stopBackups — HMR-guarded singleton timer', () => {
  afterEach(() => stopBackups());
  it('start arms the timer; stop clears it (idempotent, no stacking)', () => {
    startBackups();
    assert.equal(getBackupState().running, true);
    startBackups();   // restart must cleanly replace, not stack
    assert.equal(getBackupState().running, true);
    stopBackups();
    assert.equal(getBackupState().running, false);
  });
});
