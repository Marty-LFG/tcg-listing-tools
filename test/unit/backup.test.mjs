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

describe('the pre-grade image mirror', () => {
  // These bytes are the only unregenerable thing in data/: photographs of cards that may since have
  // been sold. The DB snapshot beside them holds nothing but their sha256 filenames.
  const storeWith = (files) => {
    const dir = tmpDir('bk-store-');
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  };
  const A = 'a'.repeat(64) + '.jpg', B = 'b'.repeat(64) + '.png';

  it('mirrors the store once, beside the snapshots rather than inside them', async () => {
    const { db } = makeDb();
    const out = tmpDir('bk-out-');
    const store = storeWith({ [A]: 'card-a-bytes', [B]: 'card-b-bytes' });
    const rec = await runBackup({ sources: [{ name: 'tracker', db }], outDir: out, keep: 14, storeDir: store });

    assert.equal(rec.images.mirrored, 2);
    assert.equal(rec.images.total_files, 2);
    const mirror = path.join(out, 'pregrade-images');
    assert.equal(fs.readFileSync(path.join(mirror, A), 'utf8'), 'card-a-bytes');
    // and NOT duplicated into the timestamped snapshot folder
    const snap = path.join(out, snapDirs(out)[0]);
    assert.equal(fs.existsSync(path.join(snap, 'pregrade-images')), false);
  });

  it('is content-addressed, so a second pass copies nothing again', async () => {
    const { db } = makeDb();
    const out = tmpDir('bk-out-');
    const store = storeWith({ [A]: 'card-a-bytes' });
    await runBackup({ sources: [{ name: 'tracker', db }], outDir: out, keep: 14, storeDir: store });
    const rec2 = await runBackup({ sources: [{ name: 'tracker', db }], outDir: out, keep: 14, storeDir: store });
    assert.equal(rec2.images.mirrored, 0, 'nothing re-copied');
    assert.equal(rec2.images.skipped, 1);
  });

  it('re-copies an entry whose mirrored size does not match — a half-written file from a killed pass', async () => {
    const { db } = makeDb();
    const out = tmpDir('bk-out-');
    const store = storeWith({ [A]: 'the-whole-file' });
    await runBackup({ sources: [{ name: 'tracker', db }], outDir: out, keep: 14, storeDir: store });
    const mirrored = path.join(out, 'pregrade-images', A);
    fs.writeFileSync(mirrored, 'trunc');                       // simulate the interrupted copy
    const rec = await runBackup({ sources: [{ name: 'tracker', db }], outDir: out, keep: 14, storeDir: store });
    assert.equal(rec.images.repaired, 1);
    assert.equal(fs.readFileSync(mirrored, 'utf8'), 'the-whole-file');
  });

  it('survives rotation — the one thing that must never delete these bytes', async () => {
    const { db } = makeDb();
    const out = tmpDir('bk-out-');
    const store = storeWith({ [A]: 'card-a-bytes' });
    for (let i = 0; i < 4; i++) {
      await runBackup({ sources: [{ name: 'tracker', db }], outDir: out, keep: 1, storeDir: store,
        now: new Date(Date.UTC(2026, 6, 13, 10, i)) });
    }
    assert.equal(snapDirs(out).length, 1, 'rotation kept only the newest snapshot');
    assert.ok(fs.existsSync(path.join(out, 'pregrade-images', A)), 'the mirror outlived every rotation');
  });

  it('an absent store is not a failure, and include_images:false skips it entirely', async () => {
    const { db } = makeDb();
    const out = tmpDir('bk-out-');
    const rec = await runBackup({ sources: [{ name: 'tracker', db }], outDir: out, keep: 14,
      storeDir: path.join(tmpDir('bk-none-'), 'does-not-exist') });
    assert.equal(rec.ok, true);
    assert.equal(rec.images.absent, true);
    assert.equal(rec.images.mirrored, 0);

    const out2 = tmpDir('bk-out-');
    const rec2 = await runBackup({ sources: [{ name: 'tracker', db }], outDir: out2, keep: 14,
      includeImages: false, storeDir: storeWith({ [A]: 'x' }) });
    assert.equal(rec2.images, null);
    assert.equal(fs.existsSync(path.join(out2, 'pregrade-images')), false);
  });
});
