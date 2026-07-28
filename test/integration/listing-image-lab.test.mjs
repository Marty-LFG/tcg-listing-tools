// test/integration/listing-image-lab.test.mjs — the lab routes and the /api/settings contract for
// the compositor, against the REAL dev server (all plugins, real middleware ordering).
//
// The two behaviours worth booting a server for:
//   · the lab's sliders are request-scoped — dragging one must never write the config on disk;
//   · /api/settings refuses geometry that would emit a broken image on every listing, using the
//     SAME validator the compositor runs, so a save can never pass something a compose then rejects.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootServer } from '../helpers/boot-server.mjs';
import { ROOT } from '../helpers/extract-inline.mjs';
import { sharpOrNull, fakeCard } from '../helpers/image-diff.mjs';

const sharp = await sharpOrNull();
let S, dataUrl;

const get = (p) => fetch(S.base + p).then(async (r) => ({ status: r.status, json: await r.json() }));
const post = (p, body) => fetch(S.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json() }));
const put = (p, body) => fetch(S.base + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json() }));

const CONFIG_FILE = path.join(ROOT, 'data', 'listing-image.config.json');
let savedConfig = null;

before(async () => {
  // The server writes the REAL data/listing-image.config.json (it is not redirected the way the DBs
  // are), so snapshot and restore it rather than leaving the owner's settings changed by a test run.
  try { savedConfig = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch { savedConfig = null; }
  S = await bootServer();
  if (sharp) dataUrl = 'data:image/jpeg;base64,' + (await fakeCard(733, 1024)).toString('base64');
});
after(async () => {
  if (S) await S.close();
  try {
    if (savedConfig != null) fs.writeFileSync(CONFIG_FILE, savedConfig);
    else fs.rmSync(CONFIG_FILE, { force: true });
  } catch { /* best effort */ }
});

describe('GET /api/listing-image/config', () => {
  it('describes the compositor, the variants and what is overridable', async () => {
    const r = await get('/api/listing-image/config');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.assetVersion, 'string');
    assert.ok(Array.isArray(r.json.variants) && r.json.variants.includes('default'));
    assert.ok(r.json.overridable.layout.includes('railWidth'));
    assert.ok(r.json.overridable.text.includes('fill'));
    assert.equal(r.json.defaults.canvas, 1600);
    assert.ok(r.json.status, 'readiness must be reported so the page can explain itself');
  });
  it('seeds the server-owned config file on boot', () => {
    assert.ok(fs.existsSync(CONFIG_FILE), 'data/listing-image.config.json was not seeded');
    assert.equal(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).enabled, false, 'seeded config must ship disabled');
  });
});

describe('POST /api/listing-image/resolve', () => {
  it('returns geometry without rendering anything', async () => {
    const r = await post('/api/listing-image/resolve', { meta: { productType: 'sealed', language: 'English', setName: 'Prismatic Evolutions' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.variant, 'sealed');
    assert.equal(r.json.layout.railWidth, 220);
    assert.deepEqual(r.json.textLines, ['ENGLISH · PRISMATIC EVOLUTIONS']);
    assert.equal(r.json.dataUrl, undefined, 'resolve must not render');
  });
  it('400s on geometry that cannot close, naming the offending value', async () => {
    const r = await post('/api/listing-image/resolve', { layoutOverrides: { cardPaddingY: 900 } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /padding leaves no room/);
  });
});

describe('POST /api/listing-image/preview', { skip: !sharp && 'sharp not installed' }, () => {
  it('composes an uploaded data URL', async () => {
    const r = await post('/api/listing-image/preview', { dataUrl, meta: { language: 'Japanese', setName: 'Mega Symphonia' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.width, 1600);
    assert.equal(r.json.variant, 'japanese');
    assert.match(r.json.dataUrl, /^data:image\/jpeg;base64,/);
    assert.match(r.json.contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.json.textLines, ['JAPANESE · MEGA SYMPHONIA']);
  });

  it('applies slider overrides WITHOUT writing them to disk', async () => {
    const before = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const r = await post('/api/listing-image/preview', { dataUrl, meta: {}, layoutOverrides: { railWidth: 180 }, textOverrides: { fill: 0.9 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.layout.railWidth, 180, 'the override did not reach the compositor');
    assert.equal(r.json.layout.cardBox.width, 1240);
    const after = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    assert.deepEqual(after, before, 'a preview must never persist the layout — saving is a separate act');
  });

  it('ignores an override key that is not whitelisted', async () => {
    const r = await post('/api/listing-image/preview', { dataUrl, meta: {}, layoutOverrides: { railWidth: 200, evil: 'yes' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.layout.evil, undefined);
    assert.equal(r.json.layout.railWidth, 200);
  });

  it('400s (not 500s) on impossible geometry, so the page can blame the right slider', async () => {
    const r = await post('/api/listing-image/preview', { dataUrl, layoutOverrides: { railWidth: 800 } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /rails leave no room/);
  });

  it('rejects a missing or malformed source', async () => {
    assert.equal((await post('/api/listing-image/preview', { meta: {} })).status, 400);
    assert.equal((await post('/api/listing-image/preview', { dataUrl: 'nope' })).status, 400);
    const ftp = await post('/api/listing-image/preview', { url: 'ftp://example.com/a.jpg' });
    assert.equal(ftp.status, 400);
    assert.match(ftp.json.error, /http/);
  });

  it('an unknown explicit variant is a 400, not a crash', async () => {
    const r = await post('/api/listing-image/preview', { dataUrl, options: { variant: 'ghost' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unknown rail variant/);
  });
});

describe('POST /api/listing-image/reload-assets', () => {
  it('re-reads the art and reports readiness', async () => {
    const r = await post('/api/listing-image/reload-assets', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(r.json.status.rails.default);
  });
});

describe('unknown routes', () => {
  it('404 with a useful message', async () => {
    const r = await get('/api/listing-image/nope');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /unknown listing-image route/);
  });
});

describe('/api/status plugins — the staleness check', () => {
  // Written after ALCSERVER served /api/listing-image/* as HTML because the plugin's
  // configureServer had never run in that process, while every other signal (git commit, the
  // /api/settings entry) read perfectly current. One GET has to be able to say that.
  it('lists the route-owning plugins THIS process registered', async () => {
    const j = await fetch(S.base + '/api/status').then((r) => r.json());
    assert.ok(j.plugins, '/api/status has no plugins block');
    assert.ok(Array.isArray(j.plugins.registered));
    assert.ok(j.plugins.registered.includes('listing-image-lab'), `listing-image-lab did not register: ${j.plugins.registered.join(', ')}`);
    for (const core of ['listings', 'status', 'inventory', 'img-proxy']) {
      assert.ok(j.plugins.registered.includes(core), `${core} missing from the registry`);
    }
    assert.ok(j.plugins.registered.length >= 15, `only ${j.plugins.registered.length} plugins registered`);
  });

  it('a just-booted server is not stale, and says when it registered', async () => {
    const j = await fetch(S.base + '/api/status').then((r) => r.json());
    assert.equal(j.plugins.stale, false, `stale on a fresh boot: ${JSON.stringify(j.plugins.stale_files)}`);
    assert.ok(j.plugins.registered_at, 'registration time is half the comparison — it must be reported');
    assert.equal(j.plugins.note, null);
  });

  it('goes stale when a server source is written after boot, and names it', async () => {
    // Exactly the pull-without-restart case: a source on disk moves past the running process.
    //
    // Deliberately a NEW file rather than touching an existing one. Every lib/*.mjs that
    // vite.config.js imports is a watched config dependency, so bumping its mtime makes Vite
    // restart the whole dev server mid-suite and every later test dies on a closed socket. A file
    // nothing imports is invisible to Vite's watcher and still visible to the registry's walk.
    const probe = path.join(ROOT, 'lib', '__staleness-probe.mjs');
    const future = new Date(Date.now() + 3600e3);
    try {
      fs.writeFileSync(probe, '// temporary fixture for the staleness check\n');
      fs.utimesSync(probe, future, future);
      const j = await fetch(S.base + '/api/status').then((r) => r.json());
      assert.equal(j.plugins.stale, true);
      assert.ok(j.plugins.stale_files.includes('lib/__staleness-probe.mjs'), `stale_files did not name it: ${JSON.stringify(j.plugins.stale_files)}`);
      assert.match(j.plugins.note, /restart the dev server/);
    } finally {
      fs.rmSync(probe, { force: true });
    }
    const after = await fetch(S.base + '/api/status').then((r) => r.json());
    assert.equal(after.plugins.stale, false, 'should recover once the newer file is gone');
  });
});

describe('/api/settings listing-image', () => {
  let base;
  before(async () => { base = (await get('/api/settings/listing-image')).json.content; });

  it('is listed as editable', async () => {
    const all = await get('/api/settings');
    assert.ok(all.json.files['listing-image'], 'listing-image missing from /api/settings');
    assert.equal(all.json.files['listing-image'].editable, true);
  });

  it('accepts a valid override and reports it applied', async () => {
    const r = await put('/api/settings/listing-image', { ...base, layoutOverrides: { railWidth: 280 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.saved, true);
    assert.equal(r.json.content.layoutOverrides.railWidth, 280);
  });

  it('a saved override shows up in a preview that sends none of its own', { skip: !sharp && 'sharp not installed' }, async () => {
    const r = await post('/api/listing-image/preview', { dataUrl, meta: {} });
    assert.equal(r.json.layout.railWidth, 280, 'the saved config did not reach the compositor');
  });

  it('a preview that DOES send overrides replaces the saved ones for that call only', async () => {
    // Sending an empty object is how the lab says "no overrides", distinct from omitting the key,
    // which means "use whatever is saved".
    const cleared = await post('/api/listing-image/resolve', { meta: {}, layoutOverrides: {} });
    assert.equal(cleared.json.layout.railWidth, 300, 'an explicit empty override set should fall back to the defaults, not the saved 280');
    const kept = await post('/api/listing-image/resolve', { meta: {} });
    assert.equal(kept.json.layout.railWidth, 280, 'omitting the key should keep the saved value');
  });

  it('REFUSES geometry that would break every listing', async () => {
    for (const [label, body, pattern] of [
      ['rails too wide', { layoutOverrides: { railWidth: 800 } }, /rails leave no room/],
      ['padding too deep', { layoutOverrides: { cardPaddingY: 900 } }, /padding leaves no room/],
      ['non-integer rail', { layoutOverrides: { railWidth: 300.5 } }, /railWidth must be/],
      ['quality out of range', { layoutOverrides: { quality: 0 } }, /quality must be/],
      ['unknown layout key', { layoutOverrides: { nonsense: 1 } }, /not an overridable key/],
      ['unknown text key', { textOverrides: { nonsense: 1 } }, /not an overridable key/],
      ['bad text rail', { textOverrides: { rail: 'middle' } }, /text.rail must be/],
      ['unknown rail art', { variantOverrides: { korean: 'ghost' } }, /unknown rail art/],
      ['no font', { font: { family: '', file: '' } }, /font.family and font.file/],
      ['enabled not boolean', { enabled: 'yes' }, /enabled must be boolean/],
      ['applyTo not boolean', { applyTo: { catalogArt: 'yes', ownerPhotos: true } }, /applyTo/],
    ]) {
      const r = await put('/api/settings/listing-image', { ...base, ...body });
      assert.equal(r.status, 400, `${label} should have been rejected`);
      assert.match(r.json.error, pattern, label);
    }
  });

  it('validates against EVERY productType profile, not just the default one', async () => {
    // 220 is fine for singles (300 rails) but the sealed profile narrows rails further; a value that
    // only closes for one profile must not save, or sealed listings break while singles look fine.
    const r = await put('/api/settings/listing-image', { ...base, layoutOverrides: { cardPaddingY: 760 } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /padding leaves no room/);
  });

  it('a rejected save leaves the previous config intact', async () => {
    const before = fs.readFileSync(CONFIG_FILE, 'utf8');
    await put('/api/settings/listing-image', { ...base, layoutOverrides: { railWidth: 900 } });
    assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before, 'a 400 must not have touched the file');
  });
});
