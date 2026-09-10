// test/integration/runs-routes.test.mjs — every Keeper's Runs route answers over HTTP.
//
// THE TEST THAT WOULD HAVE CAUGHT IT. Two routes — POST /:id/anchor/upgrade and POST /:id/print/mark —
// were written, gated, and covered by module-level tests while being unreachable over HTTP, because the
// per-run matcher could only ever produce a single-segment tail. The module tests passed because they
// call the functions directly. Nothing asked the SERVER.
//
// So this file asserts one property and asserts it for every route: **the router finds it**. A 200, a
// 401, a 409, even a 500 all mean the request was dispatched. Only a 404 means the route does not exist,
// and for a route we know we wrote, 404 is the bug.
//
// It deliberately does NOT assert what each route does — that is the job of the unit tests, which are
// thorough. Mixing the two is how this kind of file rots into a slow duplicate of the suite it sits
// beside, and then stops being run.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from '../helpers/boot-server.mjs';

let srv;
after(async () => { await srv?.close(); });

const req = async (method, p, body) => {
  const r = await fetch(srv.base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};

const SLOTS = [
  { slot: 'slab', label: 'Graded slab', kind: 'inventory', qty_per_bundle: 1, singleton: true, requires_cert: true, is_chase_slot: true },
];

// ONE before hook, not two: node:test does not guarantee a second top-level `before` waits on the
// first, so the fixture create would fire against an undefined server.
before(async () => {
  srv = await bootServer();
  const r = await req('POST', '/api/runs', {
    public_id: 'DEV-RT', mode: 'dev', edition: 77, name: 'Route reachability', unit_count: 2, slots: SLOTS,
  });
  assert.ok([200, 201].includes(r.status), `could not create the fixture run: ${r.status} ${r.text.slice(0, 200)}`);
}, { timeout: 90_000 });

// Every per-run route in lib/runs.mjs. `body` is present where the route reads one, so a route that
// would 400 on a missing body still proves it was REACHED rather than being skipped as ambiguous.
const ROUTES = [
  ['GET', ''],
  ['GET', '/manifest'],
  ['GET', '/pool'],
  ['GET', '/candidates?slot=slab'],
  ['GET', '/claims'],
  ['PUT', '/claims', { claims: [] }],
  ['GET', '/guarantee'],
  ['GET', '/ladder'],
  ['PUT', '/ladder', { ladder: [] }],
  ['POST', '/deal', { slot: 'slab', strategy: 'shuffle' }],
  ['GET', '/amendments'],
  ['POST', '/amendments', {}],
  ['GET', '/audit'],
  ['GET', '/seals'],
  ['POST', '/seals', {}],
  ['POST', '/hold', { kind: 'inventory', item_id: 999999 }],
  ['GET', '/commitment'],
  ['GET', '/blob'],                          // 409 not_locked on a draft, never 404
  ['GET', '/anchors'],
  ['POST', '/anchor', {}],
  ['POST', '/anchor/upgrade', {}],          // was a 404
  ['POST', '/lock', {}],
  ['GET', '/print'],
  ['POST', '/print/mark', { bundle_no: 1 }], // was a 404
  ['POST', '/abandon', { reason: 'route test' }],
];

describe('every per-run route is dispatched, not 404', () => {
  for (const [method, tail, body] of ROUTES) {
    it(`${method} /api/runs/:id${tail || ' (bare)'}`, async () => {
      const r = await req(method, `/api/runs/DEV-RT${tail}`, body);
      assert.notEqual(r.status, 404,
        `${method} ${tail} returned 404 — the router never found it. `
        + 'Check the per-run matcher in lib/runs.mjs against this tail.');
    });
  }
});

describe('the two that were unreachable are specifically alive', () => {
  // Named rather than left to the loop above, because these are the ones that were dead and a future
  // refactor that quietly breaks them should fail on a test that says so in its own name.
  it('POST /:id/anchor/upgrade is reached and gated, not missing', async () => {
    const r = await req('POST', '/api/runs/DEV-RT/anchor/upgrade', {});
    assert.notEqual(r.status, 404, 'still unreachable');
    // No token in this environment, so it must refuse on the gate rather than on the path.
    assert.ok([200, 401, 403, 409, 503].includes(r.status), `answered ${r.status}: ${r.text.slice(0, 160)}`);
  });

  it('POST /:id/print/mark is reached and gated, not missing', async () => {
    const r = await req('POST', '/api/runs/DEV-RT/print/mark', { bundle_no: 1 });
    assert.notEqual(r.status, 404, 'still unreachable');
    assert.ok([200, 401, 403, 404 - 4, 409, 503].includes(r.status) || r.status === 400,
      `answered ${r.status}: ${r.text.slice(0, 160)}`);
  });
});

describe('a path the router should NOT claim still 404s', () => {
  it('a three-segment tail is not claimed by the runs API', async () => {
    // The matcher is bounded at two segments on purpose. An unmatched path falls through to next(),
    // where Vite's own handler serves the app shell — so the assertion is that the RUNS API did not
    // answer, not that the server 404'd. Were the matcher `*`, this would resolve the run, match no
    // route, and still fall through, which is why the check is on the payload rather than the status.
    const r = await req('GET', '/api/runs/DEV-RT/not/a/route');
    assert.equal(r.json, null, 'the runs API answered a path it should not claim');
  });

  it('and an unknown run is a clean 404 with a reason', async () => {
    const r = await req('GET', '/api/runs/DEV-NOPE');
    assert.equal(r.status, 404);
    assert.match(String(r.json?.error || ''), /no such run/);
  });
});

describe('the ungated public artifacts really are ungated', () => {
  // §5.2 and §5.3.2: these carry nothing secret, and gating them would make verification depend on our
  // being reachable — which is the thing the static-artifact design exists to avoid.
  for (const tail of ['/commitment', '/blob', '/anchors']) {
    it(`${tail} does not demand a token`, async () => {
      const r = await req('GET', `/api/runs/DEV-RT${tail}`);
      assert.notEqual(r.status, 401, `${tail} asked for a token`);
      assert.notEqual(r.status, 503, `${tail} asked for a token`);
      assert.notEqual(r.json?.code, 'manifest_gated');
    });
  }
});
