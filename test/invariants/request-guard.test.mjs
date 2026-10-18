// test/invariants/request-guard.test.mjs — the dev server hands out no database, answers no forged
// Host, and takes no write from another site's page (audit S1 + S2, 2026-10-16).
//
// Both findings were confirmed against the running server, not read off the code:
//   · S1: GET /data/postsale.db returned a SQLite header to any LAN device. Vite serves the whole
//     project root and only denied .env / certs / .git by default; every store, the backups and the
//     eBay token sat beside the baked catalogs the pages fetch.
//   · S2: `Host: evil.example` got a 200 from /api/status, and the routes answered preflights with
//     `access-control-allow-origin: *`. Plugin middleware runs BEFORE Vite's own host check and CORS,
//     so neither ever applied to /api/*, and a hostile page on any LAN or tailnet device could publish
//     listings, message buyers or rewrite settings.
//
// So this boots the REAL server (vite.config.js, every plugin) and asks it, the way the audit did.
// The source pins at the bottom cover what a request cannot: that the guard is first, and that no
// route has put the wildcard header back.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { bootServer } from '../helpers/boot-server.mjs';
import { ROOT, read } from '../helpers/extract-inline.mjs';
import { FS_DENY, VITE_FS_DENY_DEFAULTS } from '../../lib/request-guard.mjs';

const TAILNET_NAME = 'alcserver-probe.example-tailnet.ts.net';

// Raw node:http, because fetch() silently replaces a Host header with the URL's (measured: it sends
// 127.0.0.1 whatever you set), and a forged Host is the whole point of half of these.
function raw(base, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    // host: null means send NO Host header at all; node:http fills in its own for '' or undefined.
    const noHost = headers.host === null;
    const hdrs = { ...headers };
    if (noHost) delete hdrs.host;
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers: hdrs, setHost: !noHost }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

let srv, host, probeDir, probeRel;
const written = new Map();   // probe path -> the bytes on disk, so a refusal can be told from the file

before(async () => {
  // The probe files have to be INSIDE the project root — that is the only tree Vite's static server
  // serves, so an os.tmpdir() file could never prove a deny rule. They go in a fresh mkdtemp
  // directory under data/img-cache/ (gitignored, so git never sees a leak; addressed only by URL
  // hash, so nothing walks it), removed in after(). Each deny rule is a '**/'-prefixed glob, so a
  // nested copy of the data/... path proves the same rule as the real location without putting a
  // fake token or a fake backup beside the owner's real ones while the suite runs.
  const cache = path.join(ROOT, 'data', 'img-cache');
  fs.mkdirSync(cache, { recursive: true });
  probeDir = fs.mkdtempSync(path.join(cache, 'request-guard-probe-'));
  probeRel = '/' + path.relative(ROOT, probeDir).replace(/\\/g, '/');
  const put = (rel, body) => {
    const f = path.join(probeDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    written.set(rel, body);
  };
  put('probe.db', 'SQLite format 3\0probe');
  put('probe.db-wal', 'wal');
  put('probe.db-shm', 'shm');
  put('data/backups/2026-10-16_00-00-00/manifest.json', '{"probe":true}');
  put('data/ebay-oauth.json', '{"refresh_token":"probe"}');
  put('data/photo-originals/probe.jpg', 'jpeg');
  put('data/pregrade-images/probe.png', 'png');
  put('catalog.json', '{"catalog":"probe"}');     // the control: an ordinary JSON beside them is served

  srv = await bootServer({ env: { TCG_ALLOWED_HOSTS: TAILNET_NAME } });
  host = new URL(srv.base).host;
});

after(async () => {
  if (srv) await srv.close();
  if (probeDir) fs.rmSync(probeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('S1 — the static server never hands out a store, a backup, the token or a photo', () => {
  const denied = [
    'probe.db', 'probe.db-wal', 'probe.db-shm',
    'data/backups/2026-10-16_00-00-00/manifest.json',
    'data/ebay-oauth.json',
    'data/photo-originals/probe.jpg',
    'data/pregrade-images/probe.png',
  ];

  for (const rel of denied) {
    it(`${rel} answers 403, gzip or not`, async () => {
      // Both encodings, because a .json under /data is answered by the dataGzip middleware when the
      // client accepts gzip — which runs ahead of Vite's static handler and its deny list. That path
      // served data/ebay-oauth.json until it was taught to ask Vite's matcher.
      for (const enc of ['gzip', 'identity']) {
        const r = await raw(srv.base, { path: `${probeRel}/${rel}`, headers: { host, 'accept-encoding': enc } });
        assert.equal(r.status, 403, `${rel} (${enc}) must be refused, got ${r.status}`);
        assert.notEqual(r.buf.toString('latin1'), written.get(rel), 'the body must be the refusal, not the file');
      }
    });
  }

  it('the other ways into a file are refused too: ?raw, ?import and /@fs/', async () => {
    const abs = '/@fs/' + path.join(probeDir, 'probe.db').replace(/\\/g, '/').replace(/^\//, '');
    for (const p of [`${probeRel}/probe.db?raw`, `${probeRel}/probe.db?import`, abs]) {
      const r = await raw(srv.base, { path: p, headers: { host } });
      assert.equal(r.status, 403, `${p} must be refused, got ${r.status}`);
    }
  });

  it('the real stores on this box are refused, where they exist', async () => {
    // The exact request the audit made. Skipped per file on a fresh checkout that has no database yet.
    for (const f of ['tracker.db', 'postsale.db', 'keepers.db', 'repricer.db', 'postsale.db-wal']) {
      if (!fs.existsSync(path.join(ROOT, 'data', f))) continue;
      const r = await raw(srv.base, { path: `/data/${f}`, headers: { host } });
      assert.equal(r.status, 403, `/data/${f} must be refused`);
      assert.ok(!r.buf.subarray(0, 16).toString('latin1').startsWith('SQLite format 3'), `/data/${f} leaked a SQLite header`);
    }
  });

  it('the baked catalogs the pages fetch are still served, gzipped and plain', async () => {
    // funko_pop.json is tracked, so it exists on every checkout; riftbound.json is a bake.
    for (const f of ['/data/funko_pop.json', `${probeRel}/catalog.json`]) {
      const gz = await raw(srv.base, { path: f, headers: { host, 'accept-encoding': 'gzip' } });
      assert.equal(gz.status, 200, `${f} (gzip) must still be served`);
      assert.equal(gz.headers['content-encoding'], 'gzip', `${f} should come through the gzip middleware`);
      const plain = await raw(srv.base, { path: f, headers: { host, 'accept-encoding': 'identity' } });
      assert.equal(plain.status, 200, `${f} (plain) must still be served`);
      assert.ok(plain.json, `${f} must be JSON`);
    }
    if (fs.existsSync(path.join(ROOT, 'data', 'riftbound.json'))) {
      const r = await raw(srv.base, { path: '/data/riftbound.json', headers: { host } });
      assert.equal(r.status, 200, 'the Riftbound builder fetches /data/riftbound.json directly');
    }
  });
});

describe('S2 — only a Host that names this machine is answered', () => {
  // The DNS-rebinding shapes: a hostile name re-pointed at this box, with and without our port, and
  // names that merely START like an allowed one.
  for (const forged of ['evil.example', 'rebind.attacker.test:5273', 'localhost.evil.example:5273', '127.0.0.1.evil.example']) {
    it(`Host ${forged} is refused on /api/status`, async () => {
      const r = await raw(srv.base, { path: '/api/status', headers: { host: forged } });
      assert.equal(r.status, 403, `a forged Host must not reach /api/status (got ${r.status})`);
      assert.equal(r.json && r.json.code, 'forbidden_host');
    });
  }

  it('a forged Host is refused on a page and on the gzipped catalog path too', async () => {
    // dataGzip runs before Vite's own host check, so it needed the guard as much as /api/* did.
    for (const p of ['/', '/index.html', '/data/funko_pop.json']) {
      const r = await raw(srv.base, { path: p, headers: { host: 'evil.example:' + new URL(srv.base).port, 'accept-encoding': 'gzip' } });
      assert.equal(r.status, 403, `${p} must refuse a forged Host`);
    }
  });

  it('an IP that is not one of this machine\'s addresses is refused', async () => {
    const r = await raw(srv.base, { path: '/api/status', headers: { host: '203.0.113.7:5273' } });
    assert.equal(r.status, 403);
  });

  it('a missing or malformed Host is refused', async () => {
    // No Host at all never reaches us: node's own parser answers an HTTP/1.1 request without one
    // with a 400 (requireHostHeader). That is a refusal too, so either code passes; a 200 does not.
    const none = await raw(srv.base, { path: '/api/status', headers: { host: null } });
    assert.ok([400, 403].includes(none.status), `a request with no Host must be refused (got ${none.status})`);
    for (const h of ['a:b:c', 'evil.example:notaport', '[::1', '[not-an-ip]:5273']) {
      const r = await raw(srv.base, { path: '/api/status', headers: { host: h } });
      assert.equal(r.status, 403, `Host ${JSON.stringify(h)} must be refused`);
    }
  });

  it('loopback by IP and by name is answered', async () => {
    const port = new URL(srv.base).port;
    for (const h of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const r = await raw(srv.base, { path: '/api/status', headers: { host: h } });
      assert.equal(r.status, 200, `${h} is this machine`);
    }
  });

  it('a name listed in TCG_ALLOWED_HOSTS is answered (the tailnet case)', async () => {
    const r = await raw(srv.base, { path: '/api/status', headers: { host: `${TAILNET_NAME}:${new URL(srv.base).port}` } });
    assert.equal(r.status, 200);
  });
});

describe('S2 — a write from another site\'s page is refused before any route runs', () => {
  const ORDERS = '/api/purchasing/orders';
  const marker = 'request-guard-' + Date.now();
  const count = async () => {
    const r = await fetch(`${srv.base}${ORDERS}?facet=all&q=${encodeURIComponent(marker)}`);
    return (await r.json()).orders.length;
  };
  const post = (headers, body = JSON.stringify({ supplier: marker })) =>
    raw(srv.base, { method: 'POST', path: ORDERS, headers: { host, 'content-type': 'application/json', ...headers }, body });

  it('a cross-origin POST is refused and creates nothing', async () => {
    const before = await count();
    const r = await post({ origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(r.status, 403);
    assert.equal(r.json && r.json.code, 'cross_site_write');
    assert.equal(await count(), before, 'the route must never have run');
  });

  it('every browser shape of "not from this server" is refused', async () => {
    const port = new URL(srv.base).port;
    const shapes = [
      { origin: 'http://evil.example' },                                // a foreign page
      { origin: 'null' },                                               // sandboxed iframe, file://, data:
      { 'sec-fetch-site': 'cross-site' },                               // Origin stripped, metadata still says so
      { origin: `http://127.0.0.1:${Number(port) + 1}` },               // same host, another port: same-SITE, not same-origin
      { origin: `http://localhost:${port}` },                           // this server under another name is still another origin
    ];
    const before = await count();
    for (const h of shapes) {
      const r = await post(h);
      assert.equal(r.status, 403, `${JSON.stringify(h)} must be refused`);
    }
    // The no-preflight form post: text/plain carrying JSON, which the body readers parse regardless.
    const form = await post({ origin: 'http://evil.example', 'content-type': 'text/plain' });
    assert.equal(form.status, 403, 'a simple-request form post must be refused too');
    assert.equal(await count(), before);
  });

  it('the guard covers PUT, PATCH and DELETE as well as POST', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = await raw(srv.base, { method, path: '/api/settings/tracker', headers: { host, origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 403, `${method} from a foreign origin must be refused`);
    }
  });

  it('a same-origin POST still works', async () => {
    const before = await count();
    const r = await post({ origin: srv.base, 'sec-fetch-site': 'same-origin' });
    assert.equal(r.status, 201, `same-origin create must succeed (${r.buf.toString().slice(0, 200)})`);
    assert.equal(r.json.created, true);
    assert.equal(await count(), before + 1);
  });

  it('a POST with no Origin (curl, the collector, the headless analyst) still works', async () => {
    const before = await count();
    const r = await post({});
    assert.equal(r.status, 201);
    assert.equal(await count(), before + 1);
  });

  it('no response invites a cross-origin read: no wildcard CORS on a GET or a preflight', async () => {
    const get = await raw(srv.base, { path: ORDERS, headers: { host, origin: 'http://evil.example' } });
    assert.equal(get.status, 200, 'a GET is not a write; it is answered');
    assert.equal(get.headers['access-control-allow-origin'], undefined, 'and the browser must not let the foreign page read it');
    const pre = await raw(srv.base, {
      method: 'OPTIONS', path: ORDERS,
      headers: { host, origin: 'http://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.equal(pre.status, 403, 'a foreign preflight is refused');
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
  });
});

describe('the wiring a request cannot see', () => {
  const vite = read('vite.config.js');

  it('requestGuard is the FIRST plugin, so it runs before every route', () => {
    const m = vite.match(/plugins:\s*withRegistry\(\[\s*([A-Za-z_$][\w$]*)/);
    assert.ok(m, 'could not read the plugins array');
    assert.equal(m[1], 'requestGuard', 'anything listed before the guard serves requests it never checked');
  });

  it('server.fs.deny is FS_DENY, which keeps Vite\'s own defaults', () => {
    assert.match(vite, /deny:\s*\[\.\.\.FS_DENY\]/);
    for (const d of VITE_FS_DENY_DEFAULTS) assert.ok(FS_DENY.includes(d), `setting deny replaces Vite's defaults — ${d} must be re-listed`);
    for (const d of ['**/*.db', '**/*.db-wal', '**/*.db-shm', '**/data/backups/**', '**/data/ebay-oauth.json', '**/data/photo-originals/**', '**/data/pregrade-images/**']) {
      assert.ok(FS_DENY.includes(d), `${d} must be denied`);
    }
  });

  it('every path pattern is **/-prefixed, because Vite matches it against the ABSOLUTE path', () => {
    for (const d of FS_DENY) if (d.includes('/')) assert.match(d, /^\*\*\//, `${d} would match nothing`);
  });

  it('the gzip middleware asks Vite\'s deny matcher before reading a file', () => {
    assert.match(vite, /isFileLoadingAllowed\(server\.config,\s*normalizePath\(file\)\)/);
  });

  it('no route sends a wildcard CORS header, except the two Runs public-record GETs', () => {
    // RUNS_PLAN §5.3.2: an independently hosted verifier must be able to read the blob and the
    // disclosure, so those two stay readable cross-origin. They are GET-only and public by design.
    const files = ['vite.config.js', ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => 'lib/' + f)];
    const allowed = { 'lib/runs.mjs': 2 };
    for (const f of files) {
      const src = read(f);
      // Setting one, as a call or as an object key. runs-artifacts.mjs READS the header off a
      // remote response, which is not this server sending it.
      const sets = (src.match(/setHeader\(\s*['"]access-control-allow-[a-z-]+['"]|['"]access-control-allow-[a-z-]+['"]\s*:/gi) || []).length;
      assert.equal(sets, allowed[f] || 0, `${f} sets ${sets} CORS header(s)`);
    }
    const runs = read('lib/runs.mjs');
    assert.match(runs, /x-bkr1-blob-sha256/, 'the blob GET is one of the two');
    assert.match(runs, /tail === '\/disclosure' && method === 'GET'/, 'the disclosure GET is the other');
  });
});
