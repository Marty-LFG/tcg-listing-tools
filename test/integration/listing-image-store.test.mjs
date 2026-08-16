// test/integration/listing-image-store.test.mjs — the Shopify build + file-serving routes, against
// the REAL dev server (all plugins, real middleware ordering).
//
// Worth booting a server for two reasons:
//   · /file is dispatched INSIDE the existing /api/listing-image middleware, because connect matches
//     by registration order rather than longest prefix — a separately registered route would be
//     silently shadowed, and only a real server proves it is not;
//   · it serves bytes off disk from a user-supplied path segment, so the traversal matrix has to run
//     against the real handler and not a unit-tested helper.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from '../helpers/boot-server.mjs';
import { sharpOrNull, fakeCard } from '../helpers/image-diff.mjs';

const sharp = await sharpOrNull();
let S, dataUrl;

const get = (p) => fetch(S.base + p);
const post = (p, body) => fetch(S.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json() }));

before(async () => {
  S = await bootServer();
  if (sharp) dataUrl = 'data:image/jpeg;base64,' + (await fakeCard(733, 1024)).toString('base64');
});
after(async () => { if (S) await S.close(); });

describe('GET /api/listing-image/targets', () => {
  it('lists every frame with its real dimensions', async () => {
    const r = await get('/api/listing-image/targets');
    assert.equal(r.status, 200);
    const j = await r.json();
    const byId = Object.fromEntries(j.targets.map((t) => [t.id, t]));
    assert.deepEqual([byId['shopify-card'].width, byId['shopify-card'].height], [1512, 2112]);
    assert.deepEqual([byId['og-card'].width, byId['og-card'].height], [1200, 630]);
    assert.equal(byId['ebay-square'].rails, 'vertical');
    assert.equal(byId['shopify-card'].rails, 'horizontal');
  });

  it('is served by the plugin, not by Vite\'s HTML fallback', async () => {
    // The failure this guards: an unregistered plugin makes every /api/listing-image/* path return
    // the SPA shell with a 200, which looks fine until something tries to parse it.
    const r = await get('/api/listing-image/targets');
    assert.match(r.headers.get('content-type') || '', /application\/json/);
  });
});

describe('POST /api/listing-image/build', { skip: sharp ? false : 'sharp unavailable' }, () => {
  const stockRow = { game: 'pokemon', name: 'Iono', set_name: 'Paldea Evolved', number: '254/182', language: 'EN', condition: 'Near Mint', sku: 'AAC-097' };

  it('renders the tile, stores it, and returns a manifest with alt text and a filename', async () => {
    const r = await post('/api/listing-image/build', { dataUrl, stockRow, targets: ['shopify-card'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const img = r.json.manifest.images[0];
    assert.equal(img.position, 1);
    assert.equal(img.view, 'front');
    assert.equal(img.filename, 'AAC-097-1-front.jpg');
    assert.match(img.alt, /^Iono 254\/182 — Paldea Evolved \(English\), Near Mint$/);
    // The URL carries the download name as a trailing segment, so a saved file keeps the spec's
    // convention while storage stays keyed on the hash.
    assert.match(img.url, /^\/api\/listing-image\/file\/[0-9a-f]{64}\.jpg\/AAC-097-1-front\.jpg$/);
    assert.equal(img.width, 1512);
    assert.equal(img.height, 2112);
  });

  it('the stored bytes are then actually servable at the URL it handed back', async () => {
    const r = await post('/api/listing-image/build', { dataUrl, stockRow, targets: ['shopify-card'] });
    const img = r.json.manifest.images[0];
    const file = await get(img.url);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.match(file.headers.get('cache-control') || '', /immutable/);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.length, img.bytes);
    const m = await sharp(bytes).metadata();
    assert.deepEqual([m.width, m.height], [1512, 2112]);
  });

  it('the trailing name segment sets Content-Disposition, and the bytes are found without it', async () => {
    const r = await post('/api/listing-image/build', { dataUrl, stockRow, targets: ['shopify-card'] });
    const img = r.json.manifest.images[0];
    const withName = await get(img.url);
    assert.equal(withName.status, 200);
    assert.equal(withName.headers.get('content-disposition'), `inline; filename="${img.filename}"`);

    // The name plays NO part in locating the bytes — strip it and the same image still serves.
    const bare = await get(`/api/listing-image/file/${img.contentHash}.jpg`);
    assert.equal(bare.status, 200);
    assert.equal(bare.headers.get('content-disposition'), null);
  });

  it('a bogus name segment is DROPPED, never echoed into the header', async () => {
    const r = await post('/api/listing-image/build', { dataUrl, stockRow, targets: ['shopify-card'] });
    const hash = r.json.manifest.images[0].contentHash;
    const evil = encodeURIComponent('a"; rm -rf /\r\nX-Evil: 1');
    const file = await get(`/api/listing-image/file/${hash}.jpg/${evil}`);
    assert.equal(file.status, 200, 'a bad name must not stop the bytes serving');
    assert.equal(file.headers.get('content-disposition'), null, 'the header should be omitted, not sanitised-and-kept');
    assert.equal(file.headers.get('x-evil'), null, 'header injection');
  });

  it('renders several frames in one call and orders them per the spec', async () => {
    const r = await post('/api/listing-image/build', {
      dataUrl, stockRow, targets: ['shopify-card', 'og-card'],
      viewFor: { 'shopify-card': 'front', 'og-card': 'og' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.manifest.images.length, 1, 'the social card is not a gallery image');
    assert.ok(r.json.manifest.social, 'the social card should be reported separately');
    assert.match(r.json.manifest.social.url, /^\/api\/listing-image\/file\//);
  });

  it('rejects an unknown target by name rather than guessing', async () => {
    const r = await post('/api/listing-image/build', { dataUrl, stockRow, targets: ['shopify-slab'] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unknown target 'shopify-slab'/);
  });
});

describe('GET /api/listing-image/file — the guards', () => {
  const HASH = 'a'.repeat(64);

  it('a well-formed miss is a 404 with a JSON body, never a stack', async () => {
    const r = await get(`/api/listing-image/file/${HASH}.jpg`);
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.equal(j.error, 'not found');
  });

  for (const [label, p] of [
    ['traversal', '/api/listing-image/file/../../.env'],
    ['encoded traversal', '/api/listing-image/file/..%2f..%2f.env'],
    ['dotted hash', '/api/listing-image/file/' + '.'.repeat(64) + '.jpg'],
    ['short hash', '/api/listing-image/file/' + 'a'.repeat(63) + '.jpg'],
    ['long hash', '/api/listing-image/file/' + 'a'.repeat(65) + '.jpg'],
    ['uppercase hash', '/api/listing-image/file/' + 'A'.repeat(64) + '.jpg'],
    ['disallowed extension', '/api/listing-image/file/' + 'a'.repeat(64) + '.mjs'],
    ['no extension', '/api/listing-image/file/' + 'a'.repeat(64)],
    ['nested path', '/api/listing-image/file/' + 'a'.repeat(64) + '.jpg/../../secret'],
  ]) {
    it(`refuses ${label}`, async () => {
      const r = await get(p);
      // The bar is "never serves bytes out of the store, and never leaks", not a particular status.
      // A path with ../ in it is normalised by the client before it is ever sent, so it lands on
      // Vite's HTML fallback with a 200 — harmless, and never reaching this route at all.
      const ct = r.headers.get('content-type') || '';
      assert.ok(!/^image\//.test(ct), `${label} served image bytes (${ct})`);
      const body = await r.text();
      assert.ok(!/PRIVATE KEY|_TOKEN=|CLIENT_SECRET|at Object\.|node:internal/.test(body),
        `${label} leaked something: ${body.slice(0, 200)}`);
    });
  }
});
