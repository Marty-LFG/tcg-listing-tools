// test/helpers/tmp.mjs — temp dirs/files for tests that need writable disk (SQLite etc.).
//
// TWO PROPERTIES, and both had to be earned separately:
//
//   · UNIQUENESS — mkdtempSync asks the OS for a name no other run can hold. That is the one that
//     matters for correctness: a leaked directory with a unique name can never become a later run's
//     starting state. Naming a directory after process.pid does not give it, because Windows recycles
//     pids, and f409b32 is the flake that came of exactly that.
//   · CLEANUP — a leak is only wasted disk, but it had reached 16,646 directories and 8.5GB.
//
// The retries below are the cleanup half. See the comment on rmDir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Removes a directory, retrying past Windows' handle-release lag.
 *
 * WHY THE RETRIES ARE NOT SUPERSTITION. On Windows, closing a file does not always release its handle
 * immediately — the OS finishes asynchronously, and an rmSync issued microseconds later still gets
 * EPERM. A test that dutifully closed its database in after() could therefore STILL fail to delete its
 * own directory at exit, and the bare `catch {}` that used to be here turned that into silence.
 *
 * Measured: with a SQLite handle deliberately left open, rmSync fails EPERM and retries cannot help —
 * that case needs the owner to close it. But with the handle closed, the directory was still surviving
 * an immediate rmSync and removing cleanly a moment later, which is precisely what maxRetries is for.
 * fs.rmSync retries on EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM with a linear backoff.
 *
 * So this fixes the lag, not the leak-by-neglect: a test that never closes its handles still leaks,
 * and no helper can fix that from the outside.
 */
function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    return true;
  } catch {
    return false;   // genuinely still held — the owner did not close something
  }
}

/**
 * Fresh temp directory, removed on process exit.
 *
 * The default prefix is deliberately vague because most callers do not care; pass one when you want
 * to be able to tell whose directory it is while debugging a leak.
 */
export function tmpDir(prefix = 'tcg-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => { rmDir(dir); });
  return dir;
}

/** A path inside a fresh unique directory. The directory, not the file, is what teardown removes. */
export function tmpFile(name, prefix) {
  return path.join(tmpDir(prefix), name);
}

/**
 * Remove a directory this helper handed out, now rather than at exit.
 *
 * For a test that closes its own handles and wants the disk back between cases. Exported so callers
 * do not each reinvent the retry loop above — and so the retry policy stays in one place.
 */
export function tmpCleanup(dir) {
  return rmDir(dir);
}
