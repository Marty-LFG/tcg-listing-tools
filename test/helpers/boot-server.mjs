// test/helpers/boot-server.mjs — boots the REAL Vite dev server (vite.config.js, all
// plugins/proxies/middlewares) in-process on an ephemeral port, with the SQLite stores
// redirected to a temp dir (TCG_TRACKER_DB / TCG_REPRICER_DB) so tests never touch
// data/*.db. Telegram is force-disabled so no long-poll loop starts from a test run.
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

export async function bootServer() {
  const dataDir = tmpDir('tcg-int-');
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
    trackerDb: process.env.TCG_TRACKER_DB,
    repricerDb: process.env.TCG_REPRICER_DB,
    postsaleDb: process.env.TCG_POSTSALE_DB,
    dbFileExists: (p) => fs.existsSync(p),
    close: () => server.close(),
  };
}
