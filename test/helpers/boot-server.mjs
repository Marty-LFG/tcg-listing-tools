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

/**
 * EVERY CREDENTIAL THAT COULD REACH A REAL ACCOUNT, BLANKED BEFORE THE SERVER BOOTS.
 *
 * ⚠ THIS LIST IS LOAD-BEARING, AND THE COST OF A GAP IS NOT A FAILED TEST.
 *
 * On 2026-08-23 a card called "Batch Guard 210/197" appeared for sale on the live eBay store, priced
 * at A$28.33 with a Charizard picture on it. It was a TEST FIXTURE. runner-stage.test.mjs stages that
 * row and then POSTs the real /api/listings/batch route asserting a 409 not_connected — an assertion
 * that only holds on a machine WITHOUT eBay consent. This helper blanked the Telegram and LLM keys and
 * reasoned explicitly about not making "a live, billed model call", but never blanked eBay's. So on the
 * box that actually trades, the guard passed, the batch ran, and the suite listed a fake card to real
 * customers. Nothing recorded it locally either, because the databases ARE redirected — the row lived
 * and died in a temp DB while the listing was real and permanent.
 *
 * The lesson is the shape of the list, not the one missing entry: a test suite that is safe only
 * because of what a machine happens to lack is not safe, it is lucky. So this covers every channel the
 * server can write to, including ones no test touches today.
 *
 * SHOPIFY IS HERE BEFORE ANY TEST NEEDS IT, deliberately. shopifyPlugin joined vite.config.js in the
 * same week, which means bootServer now boots it, which means the exact same trap is one route call
 * away — and Shopify's version writes products to a store rather than a listing to a marketplace.
 *
 * eBay needs three of these blanked, not one: EBAY_REFRESH_TOKEN covers the env path, and CERT_ID +
 * APP_ID cover the STORED path, because data/ebay-oauth.json holds the refresh token encrypted under a
 * key derived from the Cert ID and its path is a module-level const that cannot be redirected. Blanking
 * the Cert ID makes decryptSecret return null, which is what actually makes oauthStatus report
 * disconnected on a consented box.
 */
export const OFFLINE_ENV = Object.freeze([
  // eBay — the one that got us. All three, for the reason above.
  'EBAY_APP_ID', 'EBAY_CERT_ID', 'EBAY_REFRESH_TOKEN', 'EBAY_RUNAME',
  // Shopify — before it can bite, not after.
  'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_SHOP', 'SHOPIFY_DEV_SHOP',
  // Telegram: never start the poller from a test run.
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  // vite's loadEnv() reads the developer's real .env, so without these a test that triggers a draft
  // makes a live, billed model call. Blanking them also puts the drafter on its documented no-key path,
  // which is what lets the fallback be tested at all.
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  // Everything else that spends money or touches an account we do not own.
  'BRICKLINK_CONSUMER_KEY', 'BRICKLINK_CONSUMER_SECRET', 'BRICKLINK_TOKEN', 'BRICKLINK_TOKEN_SECRET',
  // Read-only catalog keys. They cannot mutate anything, so they are a different risk class from the
  // ones above — but a test that makes a live upstream call is non-deterministic, burns someone's rate
  // limit, and fails on a plane. Every catalog the suite needs is baked into data/ already.
  'SCRYDEX_API_KEY', 'POKEMONTCG_API_KEY', 'REBRICKABLE_API_KEY', 'BRICKSET_API_KEY',
]);

/**
 * bootServer({ env }) — `env` supplies EXPLICIT FAKE credentials for a test that needs a route to think
 * it is connected, and stubs the network itself.
 *
 * Applied AFTER the blanking above, never before, and that ordering is the safety property: a test can
 * only ever get the values it wrote as literals in its own file. Setting process.env before calling this
 * helper does NOT work and must not be made to work — that is exactly the shape that let a real,
 * consented credential reach a live publish route.
 */
export async function bootServer({ env: fakeEnv = {} } = {}) {
  const dataDir = tmpDir('tcg-int-');
  process.env.TCG_CONFIG_DIR = copyConfigs(path.join(dataDir, 'config'));
  process.env.TCG_TRACKER_DB = path.join(dataDir, 'tracker.db');
  process.env.TCG_REPRICER_DB = path.join(dataDir, 'repricer.db');
  process.env.TCG_POSTSALE_DB = path.join(dataDir, 'postsale.db');
  process.env.TCG_BACKUP_DIR = path.join(dataDir, 'backups');   // the backup job must never touch real data/backups
  for (const k of OFFLINE_ENV) process.env[k] = '';
  // Then, and only then, the caller's declared fakes.
  for (const [k, v] of Object.entries(fakeEnv)) process.env[k] = v;

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
