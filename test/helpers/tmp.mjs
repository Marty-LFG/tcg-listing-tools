// test/helpers/tmp.mjs — temp dirs/files for tests that need writable disk (SQLite etc.).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh temp directory, auto-removed on process exit (best-effort).
export function tmpDir(prefix = 'tcg-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked on win */ } });
  return dir;
}

export function tmpFile(name, prefix) {
  return path.join(tmpDir(prefix), name);
}
