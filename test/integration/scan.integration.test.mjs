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
import { scanPlugin, scanConfig, scanTimeoutMs, finishCard } from '../../lib/scan.mjs';
import { sharpOrNull } from '../helpers/image-diff.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// sharp is a native dependency; a checkout without it must still run this suite, so the fixture
// builders live behind the same skip the unit tests use.
const sharpForTests = await sharpOrNull();
// One card of a stated physical size on a black platen, at a stated dpi — the same construction the
// unit fixtures use, because finishCard's decisions are all downstream of what the analyzer measures.
async function cardOn({ wmm, hmm, dpi, frameW, frameH }) {
  const w = Math.round(wmm / 25.4 * dpi), h = Math.round(hmm / 25.4 * dpi);
  const card = await sharpForTests({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  return sharpForTests({ create: { width: frameW, height: frameH, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: card, left: Math.round((frameW - w) / 2), top: Math.round((frameH - h) / 2) }])
    .png().toBuffer();
}

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
    // 1200 default is the owner's call (max quality; it is also the WIA driver's ceiling)
    assert.equal(json.defaultDpi, 1200);
    // 160×220 default: forgiving placement window, the route crops the response to the card
    assert.deepEqual(json.region, { wmm: 160, hmm: 220 });
    assert.equal(typeof json.analyzeAvailable, 'boolean');
    // the sheet lane's window is the whole platen, and it is advertised separately from the
    // single-card region so the client can label the two buttons honestly
    assert.deepEqual(json.sheetRegion, { wmm: 210, hmm: 297 });
    assert.equal(typeof json.sheetAvailable, 'boolean');
  });
  it('is repeatable (the probe is polled by the UI)', async () => {
    const a = await get('/api/scan');
    const b = await get('/api/scan');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(b.json, a.json);
  });
  it('env knobs flow through to the probe (defaultDpi + region + sheet region)', async () => {
    // a second router with different knobs — proves scanConfig reads the env block, not constants
    const { makeScanRouter } = await import('../../lib/scan.mjs');
    const router = makeScanRouter({
      SCANNER_ENABLED: 'false', SCANNER_DPI_DEFAULT: '300',
      SCANNER_REGION_W_MM: '90', SCANNER_REGION_H_MM: '120',
      SCANNER_SHEET_W_MM: '200', SCANNER_SHEET_H_MM: '280',
    });
    const srv2 = http.createServer((req, res) => { req.url = '/'; router(req, res); });
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch('http://127.0.0.1:' + srv2.address().port + '/');
      const j = await r.json();
      assert.equal(j.defaultDpi, 300);
      assert.deepEqual(j.region, { wmm: 90, hmm: 120 });
      assert.deepEqual(j.sheetRegion, { wmm: 200, hmm: 280 });
    } finally {
      await new Promise((r) => srv2.close(r));
    }
  });
  it('the sheet region defaults to A4 and is independent of the single-card region', () => {
    const cfg = scanConfig({ SCANNER_REGION_W_MM: '110', SCANNER_REGION_H_MM: '140' });
    assert.equal(cfg.wmm, 110);
    assert.equal(cfg.sheetWmm, 210, 'shrinking the card window must not shrink the platen window');
    assert.equal(cfg.sheetHmm, 297);
  });
});

// The timeout is derived, not chosen, because POST /sheet scans ~1.8× the area of the single-card
// window and a constant tuned for the small one is a kill switch on the big one.
describe('scanTimeoutMs — sized from area and dpi', () => {
  it('reproduces the hand-picked 240s for the measured 1200dpi/160×220mm case', () => {
    // The one number this model has to agree with: 1200dpi over 160×220mm measured ~83s live and
    // was given 240s by hand. If a future edit moves this, it has moved a verified constant.
    const ms = scanTimeoutMs(160, 220, 1200);
    assert.ok(ms > 230_000 && ms < 250_000, `expected ~240s, got ${Math.round(ms / 1000)}s`);
  });
  it('leaves real headroom over both live measurements', () => {
    // 600dpi/160×220mm measured ~23s, 1200dpi ~83s. A timeout that does not clear its own
    // measurement by a wide margin is a flake waiting for a cold lamp.
    assert.ok(scanTimeoutMs(160, 220, 600) > 23_000 * 2, '600dpi headroom');
    assert.ok(scanTimeoutMs(160, 220, 1200) > 83_000 * 2, '1200dpi headroom');
  });
  it('scales with the platen: A4 gets more time than a card window at the same dpi', () => {
    assert.ok(scanTimeoutMs(210, 297, 1200) > scanTimeoutMs(160, 220, 1200));
    assert.ok(scanTimeoutMs(210, 297, 1200) > scanTimeoutMs(210, 297, 600));
  });
  it('never drops below a 60s floor, and never runs away past 10 minutes', () => {
    assert.equal(scanTimeoutMs(10, 10, 300), 60_000, 'a tiny fast scan still gets the cold-lamp floor');
    assert.ok(scanTimeoutMs(300, 450, 1200) <= 600_000, 'the ceiling is a ceiling');
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
  it('a body that is valid JSON but not an object → 400, not a 500', async () => {
    // `null`, `7` and `[]` all parse. Each one reaches a `body.side` read as a property access on a
    // non-object, and on null that is a TypeError — a 500 where the caller deserves a 400 (GR7).
    for (const raw of ['null', '7', '[]', '"front"']) {
      const { status, json } = await post('/api/scan', raw);
      assert.equal(status, 400, `body ${raw} must be a clean 400`);
      assert.equal(json.ok, false);
      assert.equal(json.error, 'bad_request');
    }
  });
});

describe('POST /api/scan/sheet — the multi-card lane refuses cleanly too', () => {
  it('valid request while disabled → 503 unconfigured, and no powershell was spawned', async () => {
    const { status, json } = await post('/api/scan/sheet', {});
    assert.equal(status, 503);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'unconfigured');
  });
  it('off-menu dpi → 400 before the disabled check', async () => {
    // The order matters: a caller with a broken dpi should learn that, not "no scanner here".
    const { status, json } = await post('/api/scan/sheet', { dpi: 450 });
    assert.equal(status, 400);
    assert.equal(json.error, 'bad_request');
    assert.match(json.message, /300\/600\/1200/);
  });
  it('a region bigger than any platen → 400', async () => {
    const { status, json } = await post('/api/scan/sheet', { region: { wmm: 900, hmm: 1200 } });
    assert.equal(status, 400);
    assert.match(json.message, /region/i);
  });
  it('a non-numeric or negative region → 400, never a raw COM error from the ps1', async () => {
    for (const region of [{ wmm: 'wide', hmm: 297 }, { wmm: -10, hmm: 297 }, { wmm: 210, hmm: 0 }]) {
      const { status, json } = await post('/api/scan/sheet', { region });
      assert.equal(status, 400, `region ${JSON.stringify(region)} must be rejected here`);
      assert.equal(json.ok, false);
    }
  });
  it('garbage (non-JSON) body → 400, not a crash (GR7)', async () => {
    const { status, json } = await post('/api/scan/sheet', 'not json at all');
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'bad_request');
  });
  it('valid JSON that is not an object → the platen defaults, not a TypeError', async () => {
    // `null` here means "no knobs", which is a legitimate request: scan the whole platen at the
    // default dpi. It must land on the same 503 an empty object does, never a 500.
    for (const raw of ['null', '[]', '3']) {
      const { status, json } = await post('/api/scan/sheet', raw);
      assert.equal(status, 503, `body ${raw} should fall through to the disabled check`);
      assert.equal(json.error, 'unconfigured');
    }
  });
  it('GET on the sheet route → 404 JSON (it is a POST-only action)', async () => {
    const { status, json } = await get('/api/scan/sheet');
    assert.equal(status, 404);
    assert.equal(json.ok, false);
  });
  it('an omitted region is allowed — the platen default is the whole point', async () => {
    // Reaching 503 (not 400) proves validation passed and the request died on "no scanner",
    // which is the only thing left between here and a carriage pass.
    const { status } = await post('/api/scan/sheet', { dpi: 600 });
    assert.equal(status, 503);
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

// finishCard is the sequence both lanes run on every card — auto-rotate, deskew, crop, JPEG. It is
// the only part of the scan path that can be driven without a carriage, so it is driven here rather
// than left to the one box that has a scanner attached.
describe('finishCard — the per-card finish shared by both lanes', { skip: sharpForTests ? false : 'sharp unavailable' }, () => {
  const analyze = async (b, o) => (await import('../../lib/scan-centering.mjs')).analyzeCardImage(b, o);

  it('a sideways card is rotated to portrait, cropped, and leaves as JPEG', async () => {
    const buf = await cardOn({ wmm: 88, hmm: 63, dpi: 300, frameW: 1400, frameH: 1100 });
    const f = await finishCard(buf, analyze, { dpi: 300, w: 1400, h: 1100 });
    assert.equal(f.rotated, true, 'a card wider than tall is a sideways card, not a landscape one');
    assert.ok(f.h > f.w, `expected portrait, got ${f.w}x${f.h}`);
    assert.equal(f.mediaType, 'image/jpeg');
    assert.equal(f.cropped, true);
    assert.ok(f.analysis, 'a found card must come back with its analysis');
  });

  it('a sleeved card is STILL cropped, even though its confidence is capped at 0.35', async () => {
    // The cap says "do not trust this measurement"; the crop only needs "we know where the object
    // is". Conflating the two would send the owner's routine case — he scans sleeved — back to
    // full-frame payloads, which is what the crop exists to prevent.
    const buf = await cardOn({ wmm: 66, hmm: 92, dpi: 300, frameW: 1200, frameH: 1500 });
    const f = await finishCard(buf, analyze, { dpi: 300, w: 1200, h: 1500 });
    assert.equal(f.analysis.physical.match, 'sleeved');
    assert.ok(f.analysis.confidence.outer <= 0.35, 'the honest confidence must reach the client uncapped-upward');
    assert.equal(f.cropped, true, 'a capped confidence must not cost the crop');
    assert.ok(f.w < 1200 && f.h < 1500, 'cropped means smaller');
  });

  it('nothing found: the image still comes back, as JPEG, with analysis null', async () => {
    // GR7 — a scan that the analyzer cannot read is still a perfectly good scan. On a sheet cell
    // this same null is what drops the cell; the two callers read it differently, on purpose.
    const blank = await sharpForTests({ create: { width: 900, height: 1200, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const f = await finishCard(blank, analyze, { dpi: 300, w: 900, h: 1200 });
    assert.equal(f.analysis, null);
    assert.equal(f.cropped, false);
    assert.equal(f.mediaType, 'image/jpeg', 'the no-crop fallback still re-encodes — a raw PNG is the 96MB case');
    assert.ok(f.reason && f.reason.ok === false, 'the analyzer verdict must survive for the caller to report');
  });

  it('an analyzer that is missing does not take the scan with it', async () => {
    // sharp is a native dep and can fail to load on a box that otherwise scans fine.
    const buf = await cardOn({ wmm: 63, hmm: 88, dpi: 300, frameW: 1000, frameH: 1300 });
    const dead = async () => ({ ok: false, error: 'sharp_unavailable', message: 'no sharp' });
    const f = await finishCard(buf, dead, { dpi: 300, w: 1000, h: 1300 });
    assert.equal(f.analysis, null);
    assert.equal(f.rotated, false);
    assert.equal(f.straightened, 0);
    assert.ok(f.buf.length > 0, 'the bytes are still there');
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
