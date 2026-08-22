// test/integration/scan.integration.test.mjs — the /api/scan surface, no hardware ever touched.
//
// Deliberately NOT bootServer(): that helper boots the real vite.config.js, whose plugin list
// does not include scanPlugin yet (the orchestrator wires registration separately). Mounting the
// plugin on a bare node http server keeps this suite green either way — and, more importantly,
// lets us pin the env per router: SCANNER_ENABLED=false everywhere here, so no test can spawn
// powershell, spin up WIA COM, or move the real V39 II carriage.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPlugin } from '../../lib/scan.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let server, base;
before(async () => {
  // Register exactly the way vite would: hand configureServer a server whose middlewares.use
  // records the mount, then replicate connect's route handling (match on the path prefix, strip
  // it from req.url before the handler runs — the router dispatches on the remainder).
  const mounts = [];
  scanPlugin({ SCANNER_ENABLED: 'false' }).configureServer({
    middlewares: { use: (route, fn) => mounts.push({ route, fn }) },
    config: { server: { port: 0 } },
  });
  assert.equal(mounts.length, 1, 'scanPlugin mounts a single prefix (registration-order trap)');
  server = http.createServer((req, res) => {
    const m = mounts.find((x) => {
      const p = String(req.url).split('?')[0];
      return p === x.route || p.startsWith(x.route + '/');
    });
    if (!m) { res.statusCode = 404; return res.end('{}'); }
    req.url = req.url.slice(m.route.length) || '/';
    m.fn(req, res, () => { res.statusCode = 404; res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => new Promise((r) => server.close(r)));

const get = async (p) => {
  const r = await fetch(base + p);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};
const post = async (p, body) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};

describe('GET /api/scan — capability probe', () => {
  it('answers 200 JSON with the full shape, never a crash (GR7)', async () => {
    const { status, json } = await get('/api/scan');
    assert.equal(status, 200);
    assert.equal(typeof json.enabled, 'boolean');
    // SCANNER_ENABLED=false is the no-powershell path, so here the answer is definite
    assert.equal(json.enabled, false);
    assert.equal(json.device, null);
    assert.deepEqual(json.dpiOptions, [300, 600, 1200]);
    assert.equal(json.defaultDpi, 600);
    // 160×220 default: forgiving placement window, the route crops the response to the card
    assert.deepEqual(json.region, { wmm: 160, hmm: 220 });
    assert.equal(typeof json.analyzeAvailable, 'boolean');
  });
  it('is repeatable (the probe is polled by the UI)', async () => {
    const a = await get('/api/scan');
    const b = await get('/api/scan');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(b.json, a.json);
  });
  it('env knobs flow through to the probe (defaultDpi + region)', async () => {
    // a second router with different knobs — proves scanConfig reads the env block, not constants
    const { makeScanRouter } = await import('../../lib/scan.mjs');
    const router = makeScanRouter({ SCANNER_ENABLED: 'false', SCANNER_DPI_DEFAULT: '300', SCANNER_REGION_W_MM: '90', SCANNER_REGION_H_MM: '120' });
    const srv2 = http.createServer((req, res) => { req.url = '/'; router(req, res); });
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch('http://127.0.0.1:' + srv2.address().port + '/');
      const j = await r.json();
      assert.equal(j.defaultDpi, 300);
      assert.deepEqual(j.region, { wmm: 90, hmm: 120 });
    } finally {
      await new Promise((r) => srv2.close(r));
    }
  });
});

describe('POST /api/scan — refusals are clean JSON, never a 500', () => {
  it('valid request while disabled → 503 unconfigured', async () => {
    const { status, json } = await post('/api/scan', { side: 'front' });
    assert.equal(status, 503);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'unconfigured');
  });
  it('invalid side → 400 before the disabled check (the caller learns the real problem)', async () => {
    const { status, json } = await post('/api/scan', { side: 'sideways' });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'bad_request');
  });
  it('missing side → 400', async () => {
    const { status, json } = await post('/api/scan', {});
    assert.equal(status, 400);
    assert.equal(json.ok, false);
  });
  it('off-menu dpi → 400 (450 is not a stop the driver path supports)', async () => {
    const { status, json } = await post('/api/scan', { side: 'front', dpi: 450 });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.match(json.message, /300\/600\/1200/);
  });
  it('garbage (non-JSON) body → 400, not a crash', async () => {
    const { status, json } = await post('/api/scan', 'this is not json');
    assert.equal(status, 400);
    assert.equal(json.ok, false);
  });
});

describe('POST /api/scan/analyze', () => {
  it('garbage (non-JSON) body → 400 clean JSON, no crash (GR7)', async () => {
    const { status, json } = await post('/api/scan/analyze', '<<<not json>>>');
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'bad_request');
  });
  it('missing image → 400', async () => {
    const { status, json } = await post('/api/scan/analyze', { nope: true });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
  });
  it('a well-formed but junk image never crashes — ok:false (or a real analysis) either way', async () => {
    // 1×1 transparent PNG: whether lib/scan-centering.mjs has landed yet or not (it is being
    // written in parallel), the contract is a JSON verdict — sharp_unavailable / no_card /
    // analyze_failed are all acceptable; a 500 is not.
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const { status, json } = await post('/api/scan/analyze', { image: { dataB64: png1x1, mediaType: 'image/png' } });
    assert.equal(status, 200);
    assert.ok(json && typeof json.ok === 'boolean');
    if (!json.ok) assert.equal(typeof json.error, 'string');
  });
});

describe('route hygiene', () => {
  it('unknown sub-route → 404 JSON', async () => {
    const { status, json } = await get('/api/scan/nope');
    assert.equal(status, 404);
    assert.equal(json.ok, false);
  });
  it('unsupported method on / → 404 JSON, not a hang', async () => {
    const r = await fetch(base + '/api/scan', { method: 'DELETE' });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).ok, false);
  });
  it('the PowerShell half of the contract is where the router expects it', () => {
    // The router execFiles scripts/wia-scan.ps1 by absolute path; a rename breaks scanning at
    // runtime only on the one box with the scanner — cheap to catch here instead.
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'wia-scan.ps1')), 'scripts/wia-scan.ps1 missing');
  });
});
