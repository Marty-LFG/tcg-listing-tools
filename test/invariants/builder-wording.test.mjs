// test/invariants/builder-wording.test.mjs — Golden Rule 6: the six card builders'
// condition/protection/footer wording is owner-verified and must stay BYTE-IDENTICAL
// across all six. LEGO/Funko intentionally carry their own PROTECTION wording (boxed
// goods don't ship in penny sleeves) but sit on the SAME postage bands, so the band
// phrases are shared suite-wide alongside the footer.
// The canonical strings come from lib/listing-copy.mjs + lib/shipping-bands.mjs (no copies in this test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read, extractFn, CARD_BUILDERS, COLLECTIBLE_BUILDERS } from '../helpers/extract-inline.mjs';
import { CARD_CONDITION_SUFFIX, CARD_PROTECTION, CARD_FOOTER, DEFAULT_CARD_CONDITION } from '../../lib/listing-copy.mjs';
import { DEFAULT_BANDS, postagePhrase, postageOptions, money } from '../../lib/shipping-bands.mjs';

const ALL_BUILDERS = [...CARD_BUILDERS, ...COLLECTIBLE_BUILDERS];

describe('card builders (GR6: identical owner-verified wording)', () => {
  for (const file of CARD_BUILDERS) {
    it(file, () => {
      const src = read(file);
      assert.ok(src.includes(CARD_PROTECTION), 'protection line missing/reworded');
      assert.ok(src.includes(CARD_FOOTER), 'footer line missing/reworded');
      assert.ok(src.includes(CARD_CONDITION_SUFFIX), 'condition suffix missing/reworded');
      assert.ok(src.includes(DEFAULT_CARD_CONDITION), 'safe default condition missing');
    });
  }
});

describe('collectibles builders (GR6: own protection wording, shared bands)', () => {
  for (const file of COLLECTIBLE_BUILDERS) {
    it(`${file} keeps its own condition/protection model`, () => {
      const src = read(file);
      assert.ok(!src.includes(CARD_PROTECTION), 'card penny-sleeve protection leaked into a boxed-goods builder');
      assert.ok(!src.includes(CARD_CONDITION_SUFFIX), 'card condition suffix leaked into a boxed-goods builder');
      assert.ok(src.includes(CARD_FOOTER), 'the footer IS shared suite-wide');
      assert.ok(/function (condText|postageText)/.test(src), 'own condText()/postageText() expected');
    });
  }
});

// The postage sentence became a FUNCTION of the price band when the store moved off free postage, so
// the mirror is frozen at the DEFAULTS: lib/shipping-bands.mjs owns DEFAULT_BANDS as code literals and
// config merely overrides them at runtime. Every builder ships those same literals inline, which is
// what keeps byte-identical parity working exactly as it did when this was one constant.
describe('postage bands (GR6: every builder mirrors lib/shipping-bands.mjs)', () => {
  // The sentence is ASSEMBLED at render time now, so a substring search of the source proves nothing.
  // Pull the builder's own bandMoney/postagePhrase out of the page, run them, and compare the RENDERED
  // sentence against the module's. That is the mirror the buyer actually sees.
  const builderPhrase = (file) => {
    const src = read(file);
    const fns = extractFn(src, 'function bandMoney(') + '\n' + extractFn(src, 'function postagePhrase(') + '\nreturn postagePhrase;';
    return new Function(fns)();   // eslint-disable-line no-new-func -- the whole point is running the page's own copy
  };

  for (const file of ALL_BUILDERS) {
    it(`${file} renders every band phrase identically`, () => {
      const phrase = builderPhrase(file);
      for (const b of DEFAULT_BANDS) {
        assert.equal(phrase(b), postagePhrase(b), `band "${b.id}" phrase drifted from lib/shipping-bands.mjs`);
      }
      assert.equal(phrase(null), postagePhrase(null), 'the unknown-band fallback drifted');
    });
    it(`${file} mirrors the band table itself`, () => {
      const src = read(file);
      // The amounts have to be present as CENTS too: the sentence is built from costCents at render
      // time, so a builder whose TABLE drifted would still print a perfectly plausible sentence
      // carrying the wrong money.
      for (const b of DEFAULT_BANDS) {
        assert.ok(new RegExp(`costCents\\s*:\\s*${b.costCents}\\b`).test(src), `band "${b.id}" costCents ${b.costCents} missing`);
        assert.ok(new RegExp(`id\\s*:\\s*'${b.id}'`).test(src), `band "${b.id}" missing from the inline table`);
      }
      assert.ok(/var POSTAGE_MIN_BAND_FOR_SLAB=1;/.test(src), 'the graded-slab floor must be mirrored too');
    });
  }
  it('no builder still promises free postage', () => {
    // The single most expensive thing that can go wrong here: a description saying postage is free
    // while eBay charges the buyer up to A$15.20 is a "not as described" claim on every listing.
    for (const file of ALL_BUILDERS) {
      assert.doesNotMatch(read(file), /FREE\s+(standard\s+)?postage|FREE shipping/i, `${file} still promises free postage`);
    }
  });
  it('every builder offers the band picker and refreshes it from the live config', () => {
    for (const file of ALL_BUILDERS) {
      const src = read(file);
      assert.ok(src.includes('id="f_postage"'), `${file} has no band picker`);
      assert.ok(src.includes('loadPostageBands();'), `${file} never refreshes the bands from config`);
    }
  });
  it('the amounts a buyer reads come from ONE table', () => {
    for (const b of DEFAULT_BANDS) assert.ok(postagePhrase(b).includes(money(b.costCents)));
  });

  // The options table is a SECOND mirrored surface. Same trick as the phrase: pull each builder's own
  // postageOptions out of the page, run it, compare against the module's.
  const builderOptions = (file) => {
    const src = read(file);
    const fns = extractFn(src, 'function bandMoney(') + '\n' + extractFn(src, 'function postageOptions(') + '\nreturn postageOptions;';
    return new Function(fns)();   // eslint-disable-line no-new-func -- running the page's own copy is the point
  };
  for (const file of ALL_BUILDERS) {
    it(`${file} builds the same option rows as the module`, () => {
      const rows = builderOptions(file);
      for (const b of DEFAULT_BANDS) {
        assert.deepEqual(rows(b), postageOptions(b), `band "${b.id}" rows drifted from lib/shipping-bands.mjs`);
      }
      // A band with one service renders no table at all — a one-row table says nothing the sentence
      // has not, and it is also what a builder whose live config fetch failed shows (GR7).
      assert.deepEqual(rows({ services: [{ code: 'X', label: 'X', costCents: 1 }] }), []);
      assert.deepEqual(rows({}), []);
      assert.deepEqual(rows(null), []);
    });
  }
  // B1 (audit 2026-10-16). The inline table above is the MIRROR DEFAULT, not the store's policies: a
  // builder whose /api/listings/config fetch failed used to keep it and print "Postage is $1.70 …
  // There's no tracking on that one" on a store whose cheapest band had become A$5.85 tracked. Now a
  // builder quotes nothing until the live table arrives. Run each page's OWN loader against a fake
  // select and a fake fetch, because the failure is in the control flow, not in any one string.
  const builderLoader = (file) => {
    const src = read(file);
    const live = src.match(/var POSTAGE_LIVE=(true|false);/);
    assert.ok(live, `${file} has no POSTAGE_LIVE flag`);
    assert.equal(live[1], 'false', `${file} must start NOT live — the defaults are not the store's bands`);
    const fns = ['function bandMoney(', 'function postagePhrase(', 'function bandById(', 'function bandRangeLabel(',
      'function readPostageBand(', 'function loadPostageBands('].map((m) => extractFn(src, m)).join('\n');
    const body = `var POSTAGE_BANDS=${JSON.stringify(DEFAULT_BANDS)};var POSTAGE_MIN_BAND_FOR_SLAB=1;var POSTAGE_LIVE=false;\n${fns}\n`
      + 'return { load: loadPostageBands, band: readPostageBand, phrase: postagePhrase, live: function(){ return POSTAGE_LIVE; } };';
    return (document, fetch, render) => new Function('document', 'fetch', 'render', body)(document, fetch, render);   // eslint-disable-line no-new-func
  };
  const fakeSelect = () => {
    const s = { options: [], _v: '' };
    Object.defineProperty(s, 'innerHTML', { set() { s.options = []; s._v = ''; }, get() { return ''; } });
    Object.defineProperty(s, 'value', { get() { return s._v; }, set(v) { if (s.options.some((o) => o.value === v)) s._v = v; } });
    s.appendChild = (o) => { s.options.push(o); if (s.options.length === 1) s._v = o.value; };
    return s;
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const fakeDoc = (sel) => ({ getElementById: (id) => (id === 'f_postage' ? sel : null), createElement: () => ({ value: '', textContent: '' }) });
  const LIVE_LETTER = { id: 'letter', label: 'Tracked letter', maxCents: 4998, costCents: 585, copy: 'tracked',
    services: [{ code: 'AU_TrackedLetter', label: 'Tracked letter', costCents: 585 }, { code: 'AU_Regular', label: 'Regular', costCents: 826 }] };
  const LIVE_BANDS = [LIVE_LETTER, ...DEFAULT_BANDS.slice(1)];

  for (const file of ALL_BUILDERS) {
    it(`${file} quotes NO amount when the live band config cannot be fetched`, async () => {
      for (const failing of [
        () => Promise.reject(new Error('offline')),
        () => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'listings error' }) }),
        () => Promise.resolve({ ok: true, status: 200, json: async () => ({ config: {} }) }),
      ]) {
        const sel = fakeSelect();
        const page = builderLoader(file)(fakeDoc(sel), failing, () => {});
        page.load();
        assert.equal(page.band(false), null, 'nothing to quote before the answer');
        await settle(); await settle();
        assert.equal(page.live(), false);
        assert.equal(page.band(false), null);
        assert.equal(page.band(true), null, 'not for a slab either');
        assert.equal(page.phrase(page.band(false)), postagePhrase(null), 'the neutral sentence, quoting no amount');
        assert.doesNotMatch(page.phrase(page.band(false)), /\$\d/);
        assert.deepEqual(sel.options.map((o) => o.value), [''], 'the picker offers no stale band either');
        assert.match(sel.options[0].textContent, /unavailable/i);
      }
    });
    it(`${file} quotes the LIVE band once the config answers`, async () => {
      const sel = fakeSelect();
      let rendered = 0;
      const ok = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { shipping: { minBandForSlab: 1, bands: LIVE_BANDS } } }) });
      const page = builderLoader(file)(fakeDoc(sel), ok, () => { rendered++; });
      page.load();
      await settle(); await settle();
      assert.equal(page.live(), true);
      assert.equal(rendered, 1, 'the preview re-renders with the real bands');
      assert.equal(page.band(false).costCents, 585);
      assert.equal(page.phrase(page.band(false)), postagePhrase(LIVE_LETTER));
      assert.equal(page.band(true).id, 'tracked', 'the slab floor still lifts a graded card');
      assert.deepEqual(sel.options.map((o) => o.value), LIVE_BANDS.map((b) => b.id));
    });
  }
  it('extras.js only gives undercut advice off the LIVE band table', () => {
    const src = read('extras.js');
    const fn = extractFn(src, 'function ebListForDelivered(');
    const run = (win) => new Function('window', fn + '\nreturn ebListForDelivered;')(win)(5000);   // eslint-disable-line no-new-func
    assert.equal(run({ POSTAGE_BANDS: DEFAULT_BANDS }), null, 'mirror defaults alone are not a basis for advice');
    assert.equal(run({ POSTAGE_BANDS: DEFAULT_BANDS, POSTAGE_LIVE: true }).listCents, 5000 - DEFAULT_BANDS[0].costCents);
  });
  it('every band with a choice actually has rows to show', () => {
    const multi = DEFAULT_BANDS.filter((b) => (b.services || []).length > 1);
    assert.ok(multi.length >= 2, 'the shipped table should exercise the multi-service case');
    for (const b of multi) assert.equal(postageOptions(b).length, b.services.length);
  });
});
