// test/integration/runs-manifest.test.mjs — building a run's manifest through the real API: claims, the
// chase ladder, dealing a slot's pool across bundles, pinning a god bundle, and the guarantee panel.
//
// THE ONE THAT MATTERS IS THE GUARANTEE PANEL. Two of Edition 1's five chases are Mega Attack Rares, not
// Art Rares, and the Dark Charizard in live stock is a PSA 8 among PSA 10s. Both are cards that look
// right on a shelf and make an anchored sentence false. The panel has to refuse them WHILE THERE IS
// STILL TIME TO SWAP THEM — which is the whole reason it exists at build time rather than at lock.
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
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
};
const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b || {});
const put = (p, b) => req('PUT', p, b || {});

// Three bundles rather than twenty-five: the arithmetic is the same and the fixtures are readable.
// Labels are written as the singular noun phrase the guarantee should contain — the label IS the noun.
const SLOTS = [
  { slot: 'slab', label: 'graded card', kind: 'inventory', qty_per_bundle: 1, singleton: true, requires_cert: true, is_chase_slot: true },
  { slot: 'packs', label: 'sealed pack', kind: 'sealed', qty_per_bundle: 3, max_lines: 3 },
  { slot: 'art', label: 'art card', kind: 'inventory', qty_per_bundle: 1, singleton: true },
];
const CLAIMS = [
  { claim_type: 'grader', subject: 'slab', operator: 'eq', value: 'PSA' },
  { claim_type: 'min_grade', subject: 'slab', operator: 'gte', value: '10' },
  { claim_type: 'language', subject: 'bundle', operator: 'eq', value: 'JA' },
  { claim_type: 'slot_count', subject: 'bundle', operator: 'eq', value: 'art:1,packs:3,slab:1' },
];

const RUN = 'DEV-M1';
const slabIds = [], artIds = [];
const slabHolds = [], artHolds = [];

// ONE before hook, not two. Two top-level hooks do not sequence against each other in node:test, so
// the fixtures ran against an unbooted server.
before(async () => {
  srv = await bootServer();

  const made = await post('/api/runs', {
    public_id: RUN, mode: 'dev', edition: 1, name: 'Manifest fixture', unit_count: 3, slots: SLOTS,
  });
  assert.equal(made.status, 201, made.text);

  // Three conforming slabs, three art cards, and nine boosters across three sets.
  for (let i = 1; i <= 3; i++) {
    const slab = await post('/api/inventory/items', {
      game: 'pokemon', name: `Chase ${i}`, quantity: 1, status: 'in_stock', language: 'JA',
      rarity: 'Art Rare', grading_company: 'PSA', grade: 10, cert_number: `MCERT-${i}`,
    });
    slabIds.push(slab.json.id);
    const art = await post('/api/inventory/items', {
      game: 'pokemon', name: `Art ${i}`, quantity: 1, status: 'in_stock', language: 'JA', rarity: 'Art Rare',
    });
    artIds.push(art.json.id);
    slabHolds.push((await post(`/api/runs/${RUN}/hold`, { kind: 'inventory', item_id: slab.json.id })).json.id);
    artHolds.push((await post(`/api/runs/${RUN}/hold`, { kind: 'inventory', item_id: art.json.id })).json.id);
  }
  for (const set of ['M3', 'M4', 'M5']) {
    const sealed = await post('/api/sealed/items', {
      game: 'pokemon', product_type: 'booster_pack', name: `${set} boosters`, set_code: set,
      language: 'JA', quantity: 3, status: 'in_stock',
    });
    await post(`/api/runs/${RUN}/hold`, { kind: 'sealed', item_id: sealed.json.id, qty: 3 });
  }
}, { timeout: 60_000 });

describe('dealing a slot across the bundles', () => {
  // A pool hold has no slot — the schema forbids it — so a run with two inventory slots has one
  // undivided pool and the deal cannot guess. The operator says which holds feed which slot.
  it('REFUSES to guess when two slots share a kind, and names the ones that collide', async () => {
    const r = await post(`/api/runs/${RUN}/deal`, { slot: 'slab', strategy: 'distinct' });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'ambiguous_pool');
    assert.deepEqual(r.json.slots, ['slab', 'art']);
  });

  it('deals the slab slot from the holds it is given', async () => {
    const r = await post(`/api/runs/${RUN}/deal`, { slot: 'slab', strategy: 'distinct', reservation_ids: slabHolds });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.dealt, 3);
    for (const b of r.json.fill) assert.deepEqual(b.slots.slab, { want: 1, have: 1, complete: true });
  });

  it('refuses a hold that is not in the pool any more', async () => {
    const r = await post(`/api/runs/${RUN}/deal`, { slot: 'slab', strategy: 'distinct', reservation_ids: slabHolds });
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'not_in_pool');
  });

  it('SPLITS a sealed hold across bundles — one row cannot be in three places', async () => {
    // Nine boosters across three sets, three bundles, quota three: each hold of 3 has to become three
    // bound rows of 1.
    const r = await post(`/api/runs/${RUN}/deal`, { slot: 'packs', strategy: 'distinct' });
    assert.equal(r.status, 200, r.text);
    const run = await get(`/api/runs/${RUN}`);
    for (const b of run.json.fill) assert.deepEqual(b.slots.packs, { want: 3, have: 3, complete: true });
  });

  it('refuses stock that does not fill the run exactly, and says which way', async () => {
    // The art holds are three units for three bundles at a quota of one, which fits — so ask for the
    // deal with only two of them.
    const r = await post(`/api/runs/${RUN}/deal`, { slot: 'art', strategy: 'distinct', reservation_ids: artHolds.slice(0, 2) });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'not_dealable');
    assert.match(r.json.error, /2 unit\(s\) held, 3 needed/);
  });

  it('deals the art slot once it is given all three', async () => {
    const r = await post(`/api/runs/${RUN}/deal`, { slot: 'art', strategy: 'shuffle', reservation_ids: artHolds });
    assert.equal(r.status, 200, r.text);
    const run = await get(`/api/runs/${RUN}`);
    assert.ok(run.json.fill.every((b) => b.complete), 'every bundle should now be complete');
  });

  it('refuses an unknown strategy rather than picking one', async () => {
    const r = await post(`/api/runs/${RUN}/deal`, { slot: 'art', strategy: 'vibes' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json.strategies, ['shuffle', 'distinct', 'pinned']);
  });

  it('pinned deals nothing, because those items are placed by hand', async () => {
    const r = await post(`/api/runs/${RUN}/deal`, { slot: 'art', strategy: 'pinned', reservation_ids: [] });
    assert.equal(r.status, 200);
    assert.equal(r.json.pinned, true);
    assert.equal(r.json.dealt, 0);
  });
});
describe('the god bundle', () => {
  it('pins and unpins', async () => {
    const on = await req('PATCH', `/api/runs/${RUN}/bundles/2`, { pinned: true });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.pinned, true);
    const run = await get(`/api/runs/${RUN}`);
    assert.equal(run.json.bundles.find((b) => b.bundle_no === 2).pinned, 1);

    const off = await req('PATCH', `/api/runs/${RUN}/bundles/2`, { pinned: false });
    assert.equal(off.json.pinned, false);
  });

  it('refuses a bundle the run does not have', async () => {
    assert.equal((await req('PATCH', `/api/runs/${RUN}/bundles/99`, { pinned: true })).status, 404);
  });
});

describe('the chase ladder', () => {
  it('stores it and renumbers the ranks from one', async () => {
    const r = await put(`/api/runs/${RUN}/ladder`, {
      ladder: [
        { card_name: 'Mega Darkrai ex', set_code: 'M3', language: 'JA', grading_company: 'PSA', grade: '10' },
        { card_name: 'Voidgale Gengar', set_code: 'M4', language: 'JA', grading_company: 'PSA', grade: '10' },
      ],
    });
    assert.equal(r.status, 200, r.text);
    // Ranks must be unique and contiguous from 1 — a gap is a hash a verifier cannot rebuild.
    assert.deepEqual(r.json.ladder.map((l) => l.rank), [1, 2]);
    assert.equal(r.json.ladder[0].card_name, 'Mega Darkrai ex');
  });

  it('refuses an entry with no card name — the ladder is what "a chase" MEANS', async () => {
    assert.equal((await put(`/api/runs/${RUN}/ladder`, { ladder: [{ set_code: 'M3' }] })).status, 400);
  });
});

describe('claims', () => {
  it('stores a valid set and reports its canonical form', async () => {
    const r = await put(`/api/runs/${RUN}/claims`, { claims: CLAIMS });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.claims.length, 4);
    const read = await get(`/api/runs/${RUN}/claims`);
    assert.match(read.json.canonical, /^6:grader,4:slab,2:eq,3:PSA,/);
    assert.equal(read.json.validation.ok, true);
  });

  it('refuses a set that does not validate, naming why', async () => {
    const r = await put(`/api/runs/${RUN}/claims`, {
      claims: [...CLAIMS, { claim_type: 'grader', subject: 'slab', operator: 'eq', value: 'BGS' }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unique/);
  });

  it('composes a field_mix value from its field, and keeps the two in step', async () => {
    // The table has a `field` column AND the composed value. Only one of them is hashed, so they are
    // written together and a read asserts they still agree.
    const r = await put(`/api/runs/${RUN}/claims`, {
      claims: [...CLAIMS, { claim_type: 'field_mix', subject: 'art', operator: 'eq', field: 'rarity', value: 'ART_RARE:3' }],
    });
    assert.equal(r.status, 200, r.text);
    const mix = r.json.claims.find((c) => c.claim_type === 'field_mix');
    assert.equal(mix.field, 'rarity');
    assert.equal(mix.value, 'rarity=ART_RARE:3');
    await put(`/api/runs/${RUN}/claims`, { claims: CLAIMS });
  });
});

// THE PANEL. A non-conforming card has to be refused here, at build time, by the claims themselves.
describe('the guarantee panel', () => {
  it('holds over a conforming manifest, and generates the sentence', async () => {
    const r = await get(`/api/runs/${RUN}/guarantee`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.holds ?? r.json.holds, true, JSON.stringify(r.json.results));
    assert.equal(r.json.sentence,
      'Every bundle contains one PSA 10 Japanese graded card, three Japanese sealed packs and one Japanese art card.');
  });

  it('REFUSES a PSA 8 among PSA 10s, and counts it', async () => {
    await req('PATCH', `/api/inventory/items/${slabIds[1]}`, { grade: 8 });
    const r = await get(`/api/runs/${RUN}/guarantee`);
    assert.equal(r.json.holds, false);
    const failed = r.json.results.find((x) => !x.holds);
    assert.equal(failed.claim.claim_type, 'min_grade');
    assert.equal(failed.counterexample_count, 1);
    await req('PATCH', `/api/inventory/items/${slabIds[1]}`, { grade: 10 });
  });

  it('REFUSES a Mega Attack Rare under a claim of Art Rare', async () => {
    const withRarity = [...CLAIMS, { claim_type: 'rarity_in', subject: 'slab', operator: 'in', value: 'ART_RARE,SPECIAL_ART_RARE' }];
    assert.equal((await put(`/api/runs/${RUN}/claims`, { claims: withRarity })).status, 200);
    assert.equal((await get(`/api/runs/${RUN}/guarantee`)).json.holds, true);

    await req('PATCH', `/api/inventory/items/${slabIds[0]}`, { rarity: 'Mega Attack Rare' });
    const r = await get(`/api/runs/${RUN}/guarantee`);
    assert.equal(r.json.holds, false);
    assert.equal(r.json.results.find((x) => !x.holds).claim.claim_type, 'rarity_in');

    await req('PATCH', `/api/inventory/items/${slabIds[0]}`, { rarity: 'Art Rare' });
    await put(`/api/runs/${RUN}/claims`, { claims: CLAIMS });
  });

  // The counts are things the run publishes anyway; the counterexamples name a bundle and a cert, which
  // is the pre-sale answer sheet.
  it('withholds WHICH card without a token, while still saying a claim failed', async () => {
    await req('PATCH', `/api/inventory/items/${slabIds[2]}`, { grade: 9 });
    const r = await get(`/api/runs/${RUN}/guarantee`);
    assert.equal(r.json.holds, false);
    assert.equal(r.json.detail, false);
    const failed = r.json.results.find((x) => !x.holds);
    assert.equal(failed.counterexample_count, 1, 'the count is not sensitive');
    assert.equal(failed.counterexamples, undefined, 'the cards are');
    assert.ok(!r.text.includes('MCERT-'), 'no cert number may appear without a token');
    await req('PATCH', `/api/inventory/items/${slabIds[2]}`, { grade: 10 });
  });

  it('says why the sentence cannot be generated rather than returning a broken one', async () => {
    // No slot_count claim: nothing supplies a quantity, so there is no sentence to commit.
    await put(`/api/runs/${RUN}/claims`, { claims: CLAIMS.filter((c) => c.claim_type !== 'slot_count') });
    const r = await get(`/api/runs/${RUN}/guarantee`);
    assert.equal(r.json.sentence, null);
    assert.match(r.json.sentence_error, /needs a slot_count claim/);
    await put(`/api/runs/${RUN}/claims`, { claims: CLAIMS });
  });
});

// R1-3. The bench workflow: check the picked bundle against its manifest, pre-assign seal serials, and
// keep an append-only record of anything that changes after the lock.
describe('the pick check', () => {
  it('is GATED — the response names the certs this bundle should contain', async () => {
    const r = await post(`/api/runs/${RUN}/pick/1`, { images: [{ dataB64: 'x' }] });
    assert.ok([401, 403, 503].includes(r.status), 'answered ' + r.status);
    assert.equal(r.json.code, 'manifest_gated');
    assert.ok(!r.text.includes('MCERT-'), 'a refusal must not leak what it refused');
  });

  it('refuses a bundle with nothing bound to it yet', async () => {
    // Gated first, so this asserts the ORDER of the guards rather than the message: without a token
    // the gate answers before the emptiness check ever runs.
    const r = await post(`/api/runs/${RUN}/pick/99`, { images: [] });
    assert.ok([401, 403, 404, 503].includes(r.status));
  });
});

describe('seal serials', () => {
  const roll = (n) => Array.from({ length: n }, (_, i) => (0xbeef0000 + i).toString(16).padStart(16, '0'));

  it('starts with none assigned', async () => {
    const r = await get(`/api/runs/${RUN}/seals`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ready, false);
    assert.equal(r.json.missing, 3);
  });

  it('REFUSES a roll no larger than the run', async () => {
    // Same size means a buyer who knows the roll knows the whole set in play.
    const r = await post(`/api/runs/${RUN}/seals`, { roll: roll(3) });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /LARGER than the run/);
  });

  it('assigns one per bundle from a larger roll, and reports ready', async () => {
    const r = await post(`/api/runs/${RUN}/seals`, { roll: roll(20) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.assigned, 3);
    assert.equal(r.json.spare, 17);
    assert.equal((await get(`/api/runs/${RUN}/seals`)).json.ready, true);
  });

  it('and the serials never appear on the open run route', async () => {
    // seal_serial addresses a parcel. The column list on that route is the control.
    const r = await get(`/api/runs/${RUN}`);
    assert.ok(!('seal_serial' in r.json.bundles[0]));
    assert.ok(!r.text.includes('beef0000'));
  });
});

describe('amendments', () => {
  it('refuse on a draft — edit the manifest instead', async () => {
    const r = await post(`/api/runs/${RUN}/amendments`, {
      reason: 'nope', new_header: 'a'.repeat(64), affected_bundles: [1],
    });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /still a draft/);
  });

  it('an unamended run is a chain of length zero', async () => {
    const r = await get(`/api/runs/${RUN}/amendments`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.amendments, []);
    assert.equal(r.json.chain.ok, true);
    assert.equal(r.json.chain.links, 0);
  });
});

describe('the audit surface', () => {
  it('records what was done, newest first', async () => {
    const r = await get(`/api/runs/${RUN}/audit`);
    assert.equal(r.status, 200);
    const actions = r.json.audit.map((a) => a.action);
    assert.ok(actions.includes('create'), 'the run creation is recorded');
    assert.ok(actions.includes('seal_serials'), 'the serial assignment is recorded');
    assert.ok(actions.includes('assign') || actions.includes('split'), 'the deal is recorded');
  });

  it('withholds the payloads without a token — they are manifest-shaped', async () => {
    const r = await get(`/api/runs/${RUN}/audit`);
    assert.equal(r.json.detail, false);
    for (const a of r.json.audit) {
      assert.equal(a.before_json, undefined);
      assert.equal(a.after_json, undefined);
    }
    // The action, actor and note are the operational record and stay readable.
    assert.ok(r.json.audit.every((a) => typeof a.action === 'string'));
  });

  it('and no seal serial reached the audit note', async () => {
    // The MAPPING is as sensitive as the manifest, and the audit surface is read more widely.
    const r = await get(`/api/runs/${RUN}/audit`);
    assert.ok(!r.text.includes('beef0000'));
  });
});
