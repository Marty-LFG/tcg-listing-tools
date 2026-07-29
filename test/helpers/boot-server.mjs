// test/helpers/boot-server.mjs — boots the REAL Vite dev server (vite.config.js, all
// plugins/proxies/middlewares) in-process on an ephemeral port, with the SQLite stores
// redirected to a temp dir (TCG_TRACKER_DB / TCG_REPRICER_DB) so tests never touch
// data/*.db, and the owner-editable configs redirected to a temp COPY (TCG_CONFIG_DIR)
// so a /api/settings PUT can be exercised for real without rewriting the checked-in
// data/*.config.json. Telegram is force-disabled so no long-poll loop starts from a test run.
//
// Env must be set BEFORE vite loads the config (lib/db.mjs reads it at module scope),
// hence the dynamic import('vite'). node:test runs each file in its own process, so
// these process.env mutations never leak into other suites.
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { tmpDir } from './tmp.mjs';
import { ROOT } from './extract-inline.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Copy the owner-editable config surface into `dir`. A settings PUT rewrites these files in
// place, so a run that touched the real ones leaves `git status` dirty — and an aborted run
// leaves a moved baseline that fails the NEXT run's round-trip. The copy makes both impossible.
//
// listing-image.config.json is deliberately NOT copied: it is gitignored and server-owned, and
// the server seeds it from the tracked data/listing-image.config.example.json on boot. Leaving
// it out is what lets the lab suite assert that seeding actually happens.
function copyConfigs(dir) {
  const src = path.join(ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (f === 'listing-image.config.json') continue;
    if (!f.endsWith('.config.json') && f !== 'grading-companies.json') continue;
    fs.copyFileSync(path.join(src, f), path.join(dir, f));
  }
  return dir;
}

export async function bootServer() {
  const dataDir = tmpDir('tcg-int-');
  process.env.TCG_CONFIG_DIR = copyConfigs(path.join(dataDir, 'config'));
  process.env.TCG_TRACKER_DB = path.join(dataDir, 'tracker.db');
  process.env.TCG_REPRICER_DB = path.join(dataDir, 'repricer.db');
  process.env.TCG_POSTSALE_DB = path.join(dataDir, 'postsale.db');
  process.env.TCG_BACKUP_DIR = path.join(dataDir, 'backups');   // the backup job must never touch real data/backups
  process.env.TELEGRAM_BOT_TOKEN = '';        // never start the Telegram poller from tests
  process.env.TELEGRAM_CHAT_ID = '';

  const port = await freePort();
  const { createServer } = await import('vite');
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    logLevel: 'silent',
    server: { port, strictPort: true, host: '127.0.0.1', open: false },
  });
  await server.listen();

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    dataDir,
    configDir: process.env.TCG_CONFIG_DIR,
    configFile: (f) => path.join(process.env.TCG_CONFIG_DIR, f),
    trackerDb: process.env.TCG_TRACKER_DB,
    repricerDb: process.env.TCG_REPRICER_DB,
    postsaleDb: process.env.TCG_POSTSALE_DB,
    dbFileExists: (p) => fs.existsSync(p),
    close: () => server.close(),
  };
}
