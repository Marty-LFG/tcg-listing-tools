// test/unit/shipping-bands.test.mjs — the band resolver is the single source for "what does postage
// cost on this item", read by the offer's fulfilmentPolicyId, the description's quoted amount, the
// repricer's delivered→list conversion and the settings validator. A boundary that moves by one cent
// silently mis-prices a whole price range, so every boundary is pinned here by number.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BANDS, DEFAULT_MIN_BAND_FOR_SLAB, POSTAGE_COPY, POSTAGE_UNKNOWN,
  normalizeBands, shippingOf, bandIndexForPrice, bandForPrice, bandIndexForListing, bandForListing,
  bandMinCents, bandForCost, listPriceForDelivered, postagePhrase, money, validateBands, unassignedBands,
} from '../../lib/shipping-bands.mjs';

const BANDS = DEFAULT_BANDS;
const band = (id) => BANDS.find((b) => b.id === id);
// a sound table with the same bounds but no policies picked yet — the state right after migration
const withoutPolicies = () => BANDS.map((b) => ({ ...b, policyId: '' }));

describe('bandIndexForPrice — the owner\'s figures read as CENTS', () => {
  // ≤ $49.98 / $49.99–$149.98 / ≥ $149.99. Ceilings of 4998 and 14998 are the only reading with no gap.
  const cases = [
    [1, 0], [170, 0], [4997, 0], [4998, 0],
    [4999, 1], [5000, 1], [14997, 1], [14998, 1],
    [14999, 2], [15000, 2], [1000000, 2],
  ];
  for (const [cents, want] of cases) {
    it(`${cents}c → band ${want + 1}`, () => assert.equal(bandIndexForPrice(cents, BANDS), want));
  }
});

describe('bandIndexForPrice — an unreadable price is NEVER band 1', () => {
  // Falling back to the cheapest band would quietly charge $1.70 postage on an item whose price we
  // could not read. Each caller has to handle -1 out loud instead.
  for (const bad of [null, undefined, 0, -1, -4999, NaN, Infinity, -Infinity, 'x', '', {}, []]) {
    it(`${JSON.stringify(bad) ?? String(bad)} → -1`, () => {
      assert.equal(bandIndexForPrice(bad, BANDS), -1);
      assert.equal(bandForPrice(bad, BANDS), null);
    });
  }
  it('a numeric string still resolves', () => assert.equal(bandIndexForPrice('5000', BANDS), 1));
});

describe('bandForListing — graded slabs never travel untracked', () => {
  it('a raw card follows its price', () => {
    assert.equal(bandForListing(2000, BANDS, { slab: false }).id, 'letter');
  });
  it('a $20 slab is lifted off the untracked band', () => {
    assert.equal(bandForListing(2000, BANDS, { slab: true }).id, 'tracked');
    assert.equal(bandIndexForListing(2000, BANDS, { slab: true }), DEFAULT_MIN_BAND_FOR_SLAB);
  });
  it('a dear slab keeps its own higher band — the floor only ever lifts', () => {
    assert.equal(bandForListing(200000, BANDS, { slab: true }).id, 'signature');
  });
  it('the floor is configurable and 0 disables it', () => {
    const ship = { minBandForSlab: 0, bands: BANDS };
    assert.equal(bandForListing(2000, ship, { slab: true }).id, 'letter');
  });
  it('a floor past the end clamps to the top band rather than throwing', () => {
    assert.equal(bandForListing(2000, { minBandForSlab: 99, bands: BANDS }, { slab: true }).id, 'signature');
  });
  it('a bare array defaults the floor to tracked — forgetting to thread it fails SAFE', () => {
    assert.equal(bandForListing(2000, BANDS, { slab: true }).id, 'tracked');
    assert.equal(shippingOf(BANDS).minBandForSlab, DEFAULT_MIN_BAND_FOR_SLAB);
  });
  it('an unreadable price stays unresolved even for a slab', () => {
    assert.equal(bandForListing(null, BANDS, { slab: true }), null);
  });
});

describe('bandMinCents — lower bounds are DERIVED, so a gap cannot exist', () => {
  it('band 1 starts at one cent', () => assert.equal(bandMinCents(BANDS, 0), 1));
  it('each band starts one cent above the last band\'s ceiling', () => {
    assert.equal(bandMinCents(BANDS, 1), 4999);
    assert.equal(bandMinCents(BANDS, 2), 14999);
  });
  it('every ceiling and the cent above it land in adjacent bands', () => {
    for (let i = 1; i < BANDS.length; i++) {
      assert.equal(bandIndexForPrice(BANDS[i - 1].maxCents, BANDS), i - 1);
      assert.equal(bandIndexForPrice(BANDS[i - 1].maxCents + 1, BANDS), i);
    }
  });
});

describe('bandForCost — a live listing\'s postage identifies its band', () => {
  it('each configured cost maps back to its own band', () => {
    for (const b of BANDS) assert.equal(bandForCost(b.costCents, BANDS).id, b.id);
  });
  it('a cost no band charges is null, not a guess', () => {
    // A hand-made listing on a flat $9.95 parcel policy must not be mistaken for one of ours.
    for (const c of [0, 995, 171, 1519, null, NaN, 'x']) assert.equal(bandForCost(c, BANDS), null);
  });
  it('duplicate costs are ambiguous, so the answer is null', () => {
    const dup = [{ ...band('letter'), costCents: 500 }, { ...band('tracked'), costCents: 500 }, band('signature')];
    assert.equal(bandForCost(500, dup), null);
  });
});

describe('listPriceForDelivered — closed form, never an iteration', () => {
  // Solving P = D − cost(band(P)) has NO solution for D in [5169,5824] or [15825,16518], and a naive
  // re-resolve loop oscillates there forever (D=5500: 5330 → band 2 → 4674 → band 1 → 5330 → …).
  const cases = [
    [1000, 830],       // comfortably inside band 1
    [5168, 4998],      // the last anchor band 1 can satisfy exactly
    [5500, 4998],      // DEAD ZONE — resolves to the ceiling below
    [5824, 4998],      // last cent of the dead zone
    [5825, 4999],      // first anchor band 2 can satisfy: 4999 + 826
    [6000, 5174],
    [15824, 14998],    // top of band 2 exactly
    [16000, 14998],    // DEAD ZONE 2
    [16518, 14998],    // last cent of it
    [16519, 14999],    // first anchor band 3 can satisfy
    [20000, 18480],
  ];
  for (const [D, want] of cases) {
    it(`delivered ${D}c → list ${want}c`, () => assert.equal(listPriceForDelivered(D, BANDS), want));
  }
  it('an anchor below the cheapest postage is null, not a negative price', () => {
    for (const D of [1, 100, 170, 171]) {
      const got = listPriceForDelivered(D, BANDS);
      assert.ok(got === null || got > 0, `D=${D} gave ${got}`);
    }
    assert.equal(listPriceForDelivered(100, BANDS), null);
  });
  for (const bad of [null, undefined, 0, -5000, NaN, 'x']) {
    it(`${String(bad)} → null`, () => assert.equal(listPriceForDelivered(bad, BANDS), null));
  }

  it('PROPERTY: the answer is the HIGHEST list price that still delivers at or under the anchor', () => {
    const delivered = (p) => p + bandForPrice(p, BANDS).costCents;
    for (let D = 100; D <= 30000; D += 7) {
      const p = listPriceForDelivered(D, BANDS);
      if (p == null) { assert.ok(D < 171, `null at D=${D}, which should have had an answer`); continue; }
      assert.ok(p >= 1, `D=${D} produced a non-positive price ${p}`);
      assert.ok(delivered(p) <= D, `D=${D} → ${p} delivers ${delivered(p)}, over the anchor`);
      assert.ok(delivered(p + 1) > D, `D=${D} → ${p} is not the highest; ${p + 1} delivers ${delivered(p + 1)}`);
    }
  });

  it('the slab floor keeps a cheap slab out of the untracked band', () => {
    // A $20 slab pays $8.26, so band 2's effective range starts at ONE CENT rather than at 4999.
    const p = listPriceForDelivered(2826, BANDS, { minBandIndex: 1 });
    assert.equal(p, 2000);
    assert.equal(listPriceForDelivered(2826, BANDS), 2656);   // ...whereas a raw card takes band 1
  });
});

describe('normalizeBands', () => {
  it('a missing table falls back to the defaults with NO policy assigned', () => {
    // Nothing on disk says which band the old single fulfilmentPolicyId was, and guessing is how a
    // $200 slab ends up on a $1.70 untracked letter. Fail closed instead.
    for (const empty of [undefined, null, [], {}, 'x']) {
      const got = normalizeBands(empty);
      assert.equal(got.length, DEFAULT_BANDS.length);
      assert.deepEqual(got.map((b) => b.id), DEFAULT_BANDS.map((b) => b.id));
      for (const b of got) assert.equal(b.policyId, '');
    }
  });
  it('fills field defaults under each element without touching the others', () => {
    const [a, b] = normalizeBands([{ id: 'a', maxCents: 100, costCents: 50 }, { id: 'b', costCents: 90 }]);
    assert.equal(a.copy, 'letter_untracked');
    assert.equal(a.policyId, '');
    assert.equal(a.costCents, 50);
    assert.equal(b.costCents, 90);
  });
  it('sorts by ceiling and gives the top band no ceiling', () => {
    const got = normalizeBands([
      { id: 'c', maxCents: null, costCents: 3 },
      { id: 'a', maxCents: 100, costCents: 1 },
      { id: 'b', maxCents: 200, costCents: 2 },
    ]);
    assert.deepEqual(got.map((b) => b.id), ['a', 'b', 'c']);
    assert.equal(got[2].maxCents, null);
  });
  it('a table saved with a ceiling on its top band still resolves every price', () => {
    // normalizeBands is the runtime-safety path; validateBands is what refuses to SAVE this.
    const got = normalizeBands([{ id: 'a', maxCents: 100, costCents: 1 }, { id: 'b', maxCents: 200, costCents: 2 }]);
    assert.equal(got[1].maxCents, null);
    assert.equal(bandIndexForPrice(999999, got), 1);
  });
  it('does not mutate its input', () => {
    const input = [{ id: 'a', maxCents: 100, costCents: 1 }, { id: 'b', maxCents: 200, costCents: 2 }];
    normalizeBands(input);
    assert.equal(input[1].maxCents, 200);
  });
});

describe('validateBands — the ONE validator both the settings API and the publish guard use', () => {
  const ok = (bands, why) => assert.equal(validateBands(bands), null, why);
  const bad = (bands, match) => {
    const err = validateBands(bands);
    assert.ok(err, 'expected a rejection');
    assert.match(err, match);
  };

  it('accepts the shipped table', () => ok(DEFAULT_BANDS));
  it('accepts a table with no policies picked yet', () => {
    // The owner has to be able to save the band table BEFORE picking the eBay policies for it.
    // accountReadyGuard is what refuses to publish with a band left unassigned.
    ok(withoutPolicies());
    assert.equal(unassignedBands(withoutPolicies()).length, 3);
    assert.equal(unassignedBands(DEFAULT_BANDS).length, 0);
  });

  it('rejects an empty or non-array table', () => {
    for (const v of [null, undefined, [], {}, 'x']) bad(v, /at least one band/);
  });
  it('rejects a missing or duplicated id', () => {
    bad([{ ...band('letter'), id: '' }, band('tracked'), band('signature')], /needs an id/);
    bad([band('letter'), { ...band('tracked'), id: 'letter' }, band('signature')], /share the id "letter"/);
  });
  it('rejects a free band — that is how free postage sneaks back in', () => {
    bad([{ ...band('letter'), costCents: 0 }, band('tracked'), band('signature')], /above zero/);
    bad([{ ...band('letter'), costCents: -1 }, band('tracked'), band('signature')], /above zero/);
    bad([{ ...band('letter'), costCents: 1.5 }, band('tracked'), band('signature')], /whole-cent/);
  });
  it('rejects a ceiling on the top band, and a missing one anywhere else', () => {
    bad([band('letter'), band('tracked'), { ...band('signature'), maxCents: 99999 }], /last band .* no ceiling/);
    bad([{ ...band('letter'), maxCents: null }, band('tracked'), band('signature')], /needs a whole-cent ceiling/);
  });
  it('rejects ceilings that do not increase — which is what makes a gap or overlap impossible', () => {
    bad([{ ...band('letter'), maxCents: 20000 }, band('tracked'), band('signature')], /ceilings must increase/);
    bad([{ ...band('letter'), maxCents: 14998 }, band('tracked'), band('signature')], /ceilings must increase/);
  });
  it('rejects postage that does not strictly increase', () => {
    // Load-bearing twice over: listPriceForDelivered needs delivered(P) monotone, and bandForCost
    // needs cost→band to be one-to-one so a live listing's postage identifies its band.
    bad([{ ...band('letter'), costCents: 900 }, band('tracked'), band('signature')], /postage must increase/);
    bad([{ ...band('letter'), costCents: 826 }, band('tracked'), band('signature')], /postage must increase/);
  });
  it('rejects wording that has no template', () => {
    bad([{ ...band('letter'), copy: 'free' }, band('tracked'), band('signature')], /no description wording/);
  });
  it('rejects a service code that is not shaped like one, but allows a blank', () => {
    bad([{ ...band('letter'), serviceCode: 'regular letter' }, band('tracked'), band('signature')], /does not look like one/);
    ok([{ ...band('letter'), serviceCode: '' }, band('tracked'), band('signature')]);
  });
  it('rejects a policy id that is not a number, or one used on two bands', () => {
    bad([{ ...band('letter'), policyId: 'TCG Free AU Post' }, band('tracked'), band('signature')], /not a number/);
    bad([band('letter'), { ...band('tracked'), policyId: band('letter').policyId }, band('signature')], /more than one band/);
  });
});

describe('postage copy', () => {
  it('money renders whole cents', () => {
    assert.equal(money(170), '$1.70');
    assert.equal(money(826), '$8.26');
    assert.equal(money(1520), '$15.20');
    assert.equal(money(0), '$0.00');
  });
  it('every band quotes its OWN amount and no other band\'s', () => {
    for (const b of BANDS) {
      const phrase = postagePhrase(b);
      assert.ok(phrase.includes(money(b.costCents)), `${b.id} does not quote ${money(b.costCents)}`);
      for (const other of BANDS) {
        if (other.id === b.id) continue;
        assert.ok(!phrase.includes(money(other.costCents)), `${b.id} also quotes ${other.id}'s amount`);
      }
    }
  });
  it('no band promises a delivery date — estimates are eBay\'s, not ours', () => {
    for (const b of BANDS) assert.doesNotMatch(postagePhrase(b), /\bday(s)?\b|\barriv|\bdeliver(ed|y) (by|in)\b/i);
  });
  it('only the untracked band says there is no tracking', () => {
    assert.match(postagePhrase(band('letter')), /no tracking/i);
    assert.doesNotMatch(postagePhrase(band('tracked')), /no tracking/i);
    assert.doesNotMatch(postagePhrase(band('signature')), /no tracking/i);
  });
  it('an unresolved band quotes no amount at all, so it cannot contradict a policy', () => {
    assert.equal(postagePhrase(null), POSTAGE_UNKNOWN);
    assert.doesNotMatch(POSTAGE_UNKNOWN, /\$/);
  });
  it('every band names a template that exists', () => {
    for (const b of BANDS) assert.ok(POSTAGE_COPY[b.copy], `${b.id} → ${b.copy}`);
  });
});
