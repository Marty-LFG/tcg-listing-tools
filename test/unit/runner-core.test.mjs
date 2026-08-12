// test/unit/runner-core.test.mjs — the pure logic behind stock-runner.html (lib/runner-core.mjs).
//
// These are the rules that decide what gets published without a human looking at it, so they get
// exact assertions rather than smoke tests. The page imports this same module, so a rule cannot
// drift between what the grid shows and what is asserted here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  numKeys, numRank, cmpRank, printingOrder, printingsFor, mtgPrintingsFor, finishFromRarity, pickPrinting,
  parseCatch, isNearMint, medianOf, flagsFor, deriveState, isPublishable, rowKey,
  refuseRow, blockingRefusals, scaleGeometry, atMechanicalUndercut, SPREAD_WIDE,
  PRICE_CEILING_AUD, MEDIAN_MULT, MTG_PRINTING_TOKENS,
} from '../../lib/runner-core.mjs';
import { variantToken } from '../../lib/listing-copy.mjs';

// ---------------------------------------------------------------------------
describe('numKeys — typed number → lookup keys (GR10: lookup only, never storage)', () => {
  it('collapses printed zero-padding', () => {
    assert.ok(numKeys('004').includes('4'));
    assert.ok(numKeys('4').includes('4'));
  });
  it('drops the /total so 25 and 25/197 find the same card', () => {
    assert.ok(numKeys('25/197').includes('25'));
    assert.deepEqual(numKeys('25/197'), numKeys('25'));
  });
  it('keeps a subset prefix and also offers the unpadded form', () => {
    const k = numKeys('TG01');
    assert.ok(k.includes('TG01'));
    assert.ok(k.includes('TG1'));
  });
  it('handles promo numbers with long prefixes', () => {
    const k = numKeys('SWSH039');
    assert.ok(k.includes('SWSH039'));
    assert.ok(k.includes('SWSH39'));
  });
  it('an alpha suffix survives (alt-art 199a is not 199 — GR5)', () => {
    assert.ok(numKeys('199a').includes('199A'));
    assert.ok(!numKeys('199a').includes('199'));
  });
  it('empty input → no keys', () => {
    assert.deepEqual(numKeys(''), []);
    assert.deepEqual(numKeys(null), []);
  });
});

// ---------------------------------------------------------------------------
describe('numRank / cmpRank — grid order matches the physical pile', () => {
  const sortNums = (list) => list
    .map((n) => ({ n, r: numRank(n, 'normal') }))
    .sort((a, b) => cmpRank(a.r, b.r))
    .map((x) => x.n);

  it('sorts numerically, not as strings (the pokemontcg.io orderBy=number trap)', () => {
    // A string sort gives 1, 10, 2 — which stops the grid matching the pile.
    assert.deepEqual(sortNums(['10', '2', '1']), ['1', '2', '10']);
  });
  it('zero-padding does not change the position', () => {
    assert.deepEqual(sortNums(['012', '3']), ['3', '012']);
  });
  it('keeps a subset block (TG) together and after the plain numbers', () => {
    const out = sortNums(['TG02', '5', 'TG01', '120']);
    assert.deepEqual(out, ['5', '120', 'TG01', 'TG02']);
  });
  it('an alpha suffix sorts next to its base number', () => {
    assert.deepEqual(sortNums(['199a', '199', '200']), ['199', '199a', '200']);
  });
  it('within one number, printings run Normal → Reverse → Holo', () => {
    const rows = [
      { k: 'holofoil' }, { k: 'reverseHolofoil' }, { k: 'normal' },
    ].map((x) => ({ k: x.k, r: numRank('25', x.k) })).sort((a, b) => cmpRank(a.r, b.r));
    assert.deepEqual(rows.map((x) => x.k), ['normal', 'reverseHolofoil', 'holofoil']);
  });
});

describe('printingOrder', () => {
  it('normal < reverse < holo', () => {
    assert.equal(printingOrder('normal'), 0);
    assert.equal(printingOrder('reverseHolofoil'), 1);
    assert.equal(printingOrder('holofoil'), 2);
  });
  it('1st Edition holo still ranks as holo', () => {
    assert.equal(printingOrder('1stEditionHolofoil'), 2);
  });
  // Scryfall's plain finish is literally the string "Nonfoil", which CONTAINS "foil". Without the
  // negation test the /holo|foil/ branch catches it and every unfoiled Magic card ranks as a foil —
  // and `n` on the catch line, which asks printingOrder for a 0, would find nothing and silently
  // fall through to whatever printing happened to be first.
  it('"Nonfoil" contains "foil", and still ranks 0', () => {
    assert.equal(printingOrder('nonfoil'), 0);
    assert.equal(printingOrder('foil'), 2);
    assert.equal(printingOrder('etched'), 2);
    assert.equal(printingOrder('surgefoil'), 2);
  });
  // Pinned because the negation above is a change to a shared function: the Pokémon and Lorcana
  // finish strings must rank exactly as they did before it existed.
  it('every pre-existing key ranks exactly as it always has', () => {
    assert.deepEqual(
      ['normal', 'holofoil', 'reverseHolofoil', '1stEditionNormal', '1stEditionHolofoil', 'unlimited', 'unlimitedHolofoil', 'usd', 'usd_foil'].map(printingOrder),
      [0, 2, 1, 0, 2, 0, 2, 0, 2]);
  });
  it('an unknown key ranks 0 rather than throwing', () => {
    assert.equal(printingOrder('somethingNew'), 0);
  });
});

// ---------------------------------------------------------------------------
// variantToken is the UNIQUE(game, identity_key, variant) column, so these strings ARE stock
// identity. Pinned here beside printingOrder because the two move together.
describe('variantToken — the identity column', () => {
  it('the pre-existing tokens are unchanged', () => {
    assert.equal(variantToken('', 'Normal'), 'Base');
    assert.equal(variantToken('', 'Holofoil'), 'Holo');
    assert.equal(variantToken('', 'Reverse Holofoil'), 'Reverse Holo');
    assert.equal(variantToken('', 'Foil'), 'Foil');
    assert.equal(variantToken('', 'Enchanted'), 'Enchanted');
    assert.equal(variantToken('1st Edition', 'Holofoil'), '1st Edition Holo');
    assert.equal(variantToken('Unlimited', 'Holofoil'), 'Holo');
  });
  it('"Nonfoil" is Base, not Foil — the negation is tested first', () => {
    assert.equal(variantToken('', 'Nonfoil'), 'Base');
  });
  // Scryfall prices etched separately (usd_etched) because TCGplayer sells it as its own product.
  // Collapsing it onto 'Foil' would put two different cards on one row of the UNIQUE index.
  it('etched foil earns its own identity, like surge foil already does', () => {
    assert.equal(variantToken('', 'Etched Foil'), 'Etched Foil');
    assert.equal(variantToken('', 'Surge Foil'), 'Surge Foil');
  });
});

// ---------------------------------------------------------------------------
describe('mtgPrintingsFor — the same matrix, off Scryfall', () => {
  const card = (over) => Object.assign({ finishes: [], promo_types: [], prices: {} }, over);

  it('the common case: one print, two finishes, two prices', () => {
    const out = mtgPrintingsFor(card({ finishes: ['nonfoil', 'foil'], prices: { usd: '1.50', usd_foil: '6.00' } }));
    assert.deepEqual(out.map((p) => p.key), ['nonfoil', 'foil']);
    assert.deepEqual(out.map((p) => p.variant), ['Base', 'Foil']);
    assert.deepEqual(out.map((p) => p.marketUsd), [1.5, 6]);
  });

  it('a foil-only print offers only the foil', () => {
    const out = mtgPrintingsFor(card({ finishes: ['foil'], prices: { usd_foil: '199.99' } }));
    assert.deepEqual(out.map((p) => p.key), ['foil']);
    assert.equal(out[0].marketUsd, 199.99);
  });

  // NEO has 12 of these. Etched is always its OWN collector number, never a third finish beside
  // nonfoil+foil — counted across every cached set, the only combinations are nonfoil+foil,
  // nonfoil, foil and etched.
  it('an etched print prices off usd_etched and keeps its own identity', () => {
    const out = mtgPrintingsFor(card({ finishes: ['etched'], prices: { usd_etched: '12.00', usd_foil: '3.00' } }));
    assert.deepEqual(out.map((p) => p.key), ['etched']);
    assert.equal(out[0].variant, 'Etched Foil');
    assert.equal(out[0].marketUsd, 12);
  });

  // Scryfall marks surge only in promo_types and calls the printing plain "foil".
  it('surge foil is promoted out of "foil" into its own product', () => {
    const out = mtgPrintingsFor(card({ finishes: ['foil'], promo_types: ['surgefoil'], prices: { usd_foil: '50.00' } }));
    assert.equal(out[0].key, 'surgefoil');
    assert.equal(out[0].variant, 'Surge Foil');
  });

  // Scryfall reports the PLAIN foil figure for a surge print (HOC #53 says 50.00; the real spread
  // is #25 US$29.93 vs #65 US$125). The disagreement detector is the runner's only independent
  // second opinion, so feeding it a number wrong by 4x turns a real check into noise.
  it('and refuses to price it, because that figure is known-bad', () => {
    const p = mtgPrintingsFor(card({ finishes: ['foil'], promo_types: ['surgefoil'], prices: { usd_foil: '50.00' } }))[0];
    assert.equal(p.marketUsd, null, 'no figure at all beats a wrong one (GR4)');
    assert.equal(p.marketUnreliable, true, 'and the grid says why, so the empty cell is a decision');
    assert.equal(p.marketUsdRaw, 50, 'the raw number survives for anyone who wants to eyeball it');
  });

  it('a missing price is null, never zero', () => {
    const out = mtgPrintingsFor(card({ finishes: ['nonfoil'], prices: { usd: null } }));
    assert.equal(out[0].marketUsd, null);
  });

  it('an unknown finish is ignored rather than invented into one', () => {
    const out = mtgPrintingsFor(card({ finishes: ['glossy', 'nonfoil'], prices: { usd: '1' } }));
    assert.deepEqual(out.map((p) => p.key), ['nonfoil']);
  });

  it('no finishes at all → empty, so the caller falls back', () => {
    assert.deepEqual(mtgPrintingsFor(card({})), []);
    assert.deepEqual(mtgPrintingsFor(null), []);
  });
});

// ---------------------------------------------------------------------------
describe('printingsFor — the matrix comes from DATA, not a rarity regex (GR5)', () => {
  it('a single-printing card is unambiguous', () => {
    const out = printingsFor({ tcgplayer: { prices: { normal: { market: 0.25 } } } });
    assert.equal(out.length, 1);
    assert.equal(out[0].key, 'normal');
    assert.equal(out[0].variant, 'Base');
    assert.equal(out[0].marketUsd, 0.25);
  });
  it('a normal + reverse card offers both, in printing order', () => {
    const out = printingsFor({ tcgplayer: { prices: { reverseHolofoil: { market: 1.5 }, normal: { market: 0.3 } } } });
    assert.deepEqual(out.map((p) => p.key), ['normal', 'reverseHolofoil']);
    assert.deepEqual(out.map((p) => p.variant), ['Base', 'Reverse Holo']);
  });
  it('1st Edition keys carry the edition into the variant token', () => {
    const out = printingsFor({ tcgplayer: { prices: { '1stEditionHolofoil': { market: 400 } } } });
    assert.equal(out[0].edition, '1st Edition');
    assert.equal(out[0].variant, '1st Edition Holo');
  });
  it('falls back through market → mid → low for the figure', () => {
    assert.equal(printingsFor({ tcgplayer: { prices: { normal: { mid: 2 } } } })[0].marketUsd, 2);
    assert.equal(printingsFor({ tcgplayer: { prices: { normal: { low: 1 } } } })[0].marketUsd, 1);
    assert.equal(printingsFor({ tcgplayer: { prices: { normal: {} } } })[0].marketUsd, null);
  });
  it('an unknown price key is ignored rather than invented into a finish', () => {
    const out = printingsFor({ tcgplayer: { prices: { somethingNew: { market: 5 }, normal: { market: 1 } } } });
    assert.deepEqual(out.map((p) => p.key), ['normal']);
  });
  it('no price object at all → empty, so the caller knows to fall back', () => {
    assert.deepEqual(printingsFor({}), []);
    assert.deepEqual(printingsFor(null), []);
    assert.deepEqual(printingsFor({ tcgplayer: {} }), []);
  });
});

describe('finishFromRarity — the chipped fallback', () => {
  it('reverse is tested before holo', () => {
    assert.equal(finishFromRarity('Reverse Holo Rare').variant, 'Reverse Holo');
  });
  it('plain "Rare" returns Holo — which is exactly why this is a flagged guess, not data', () => {
    assert.equal(finishFromRarity('Rare').variant, 'Holo');
    assert.ok(finishFromRarity('Rare').fromRarity);
  });
  it('common → Base', () => {
    assert.equal(finishFromRarity('Common').variant, 'Base');
  });
});

describe('pickPrinting', () => {
  const ps = printingsFor({ tcgplayer: { prices: { normal: { market: 1 }, reverseHolofoil: { market: 3 }, holofoil: { market: 9 } } } });
  it('a typed token wins', () => {
    assert.equal(pickPrinting(ps, 'reverseHolofoil').key, 'reverseHolofoil');
    assert.equal(pickPrinting(ps, 'holofoil').key, 'holofoil');
  });
  it('no token → the first in printing order (Normal)', () => {
    assert.equal(pickPrinting(ps, null).key, 'normal');
  });
  it('a token with no matching printing falls back rather than throwing', () => {
    const only = printingsFor({ tcgplayer: { prices: { holofoil: { market: 9 } } } });
    assert.equal(pickPrinting(only, 'reverseHolofoil').key, 'holofoil');
  });
  it('empty printings → null', () => {
    assert.equal(pickPrinting([], 'normal'), null);
  });

  // Magic has three printings that all sort as 2 (foil, etched, surge), so the order heuristic
  // alone would hand back whichever sorted first and quietly ignore what was typed.
  it('an exact key beats the order heuristic', () => {
    const mtgPs = mtgPrintingsFor({ finishes: ['nonfoil', 'foil'], prices: { usd: '1', usd_foil: '5' } });
    assert.equal(pickPrinting(mtgPs, 'nonfoil').key, 'nonfoil');
    assert.equal(pickPrinting(mtgPs, 'foil').key, 'foil');
    assert.equal(pickPrinting(mtgPs, null).key, 'nonfoil', 'the unfoiled default');
  });
});

// ---------------------------------------------------------------------------
describe('parseCatch — the entry grammar', () => {
  const setCodes = new Set(['OBF', 'PAF', 'SVI']);
  const P = (s) => parseCatch(s, { setCodes });

  it('the common case is just a number', () => {
    assert.equal(P('125').num, '125');
    assert.equal(P('125').qty, null);
    assert.equal(P('125').printing, null);
  });
  it('accepts the printed full number', () => {
    assert.equal(P('25/197').num, '25/197');
  });
  it('accepts promo and subset numbers', () => {
    assert.equal(P('SWSH039').num, 'SWSH039');
    assert.equal(P('TG01').num, 'TG01');
  });
  it('printing tokens', () => {
    assert.equal(P('125 r').printing, 'reverseHolofoil');
    assert.equal(P('125 h').printing, 'holofoil');
    assert.equal(P('125 n').printing, 'normal');
  });

  // A game brings its own printing vocabulary. Magic has no reverse holo, and its two words are
  // nonfoil and foil — there is deliberately no etched or surge token, because those are separate
  // collector numbers and a token for them could only ever match nothing.
  describe('a game can bring its own printing vocabulary', () => {
    const M = (s) => parseCatch(s, { setCodes: new Set(['HOB', 'NEO']), printingTokens: MTG_PRINTING_TOKENS });

    it('Magic reads n and f as its own finishes', () => {
      assert.equal(M('249 n').printing, 'nonfoil');
      assert.equal(M('249 f').printing, 'foil');
      assert.equal(M('249 h').printing, 'foil', 'h carries over as an alias for plain foil');
    });
    it('"hp" is STILL heavily played under the Magic vocabulary', () => {
      const r = M('249 hp');
      assert.equal(r.cond, 'Heavily Played');
      assert.equal(r.printing, null);
    });
    it('r means nothing in Magic rather than silently meaning reverse holo', () => {
      const r = M('249 r');
      assert.equal(r.printing, null);
      assert.deepEqual(r.unknown, ['r'], 'an unrecognised token is surfaced, not swallowed');
    });
    it('the rest of the grammar is unchanged', () => {
      const r = M('249 f x3 @12.50 lp');
      assert.equal(r.num, '249'); assert.equal(r.printing, 'foil');
      assert.equal(r.qty, 3); assert.equal(r.askAud, 12.5); assert.equal(r.cond, 'Lightly Played');
    });
    it('a bare Magic set code still switches sets mid-pile', () => {
      assert.equal(M('neo').setCode, 'NEO');
    });
    it('the default vocabulary is untouched when nothing is passed', () => {
      assert.equal(parseCatch('125 r', { setCodes }).printing, 'reverseHolofoil');
    });
  });
  it('"hp" is heavily played, NOT holofoil — the ordering trap', () => {
    const r = P('125 hp');
    assert.equal(r.cond, 'Heavily Played');
    assert.equal(r.printing, null);
  });
  it('quantity — several copies become ONE listing, not several rows', () => {
    assert.equal(P('125 x3').qty, 3);
    assert.equal(P('125 X12').qty, 12);
    assert.equal(P('125 x0').qty, null);       // nonsense, not a silent 0-qty listing
  });
  it('price override in AUD', () => {
    assert.equal(P('125 @12.50').askAud, 12.5);
    assert.equal(P('125 @0').askAud, 0);
    assert.equal(P('125 @abc').askAud, null);
  });
  it('condition tokens', () => {
    assert.equal(P('125 lp').cond, 'Lightly Played');
    assert.equal(P('125 mp').cond, 'Moderately Played');
    assert.equal(P('125 nm').cond, 'Near Mint');
  });
  it('name search', () => {
    assert.equal(P('*charizard').nameQuery, 'charizard');
    assert.equal(P('*charizard').num, null);
  });
  it('a bare known set code switches sets mid-pile (the mixed shoebox)', () => {
    const r = P('obf 125');
    assert.equal(r.setCode, 'OBF');
    assert.equal(r.num, '125');
  });
  it('a set code is only a set code when it is a KNOWN one', () => {
    assert.equal(parseCatch('zzz 125', { setCodes }).setCode, null);
    assert.deepEqual(parseCatch('zzz 125', { setCodes }).unknown, ['zzz']);
  });
  it('order does not matter and everything composes', () => {
    const a = P('obf 125 r x3 @12.50 lp');
    const b = P('lp @12.50 x3 r 125 obf');
    assert.deepEqual(a, b);
    assert.equal(a.setCode, 'OBF');
    assert.equal(a.num, '125');
    assert.equal(a.printing, 'reverseHolofoil');
    assert.equal(a.qty, 3);
    assert.equal(a.askAud, 12.5);
    assert.equal(a.cond, 'Lightly Played');
  });
  it('empty input is inert, never a throw', () => {
    const r = P('   ');
    assert.equal(r.num, null);
    assert.deepEqual(r.unknown, []);
    assert.doesNotThrow(() => parseCatch(null, {}));
    assert.doesNotThrow(() => parseCatch('125', undefined));
  });
});

// ---------------------------------------------------------------------------
describe('isNearMint — the gate on stock catalog art', () => {
  it('the tool’s two spellings both count as NM', () => {
    assert.ok(isNearMint('Near Mint'));
    assert.ok(isNearMint('Ungraded, Near Mint'));
    assert.ok(isNearMint('NM'));
  });
  it('an empty condition defaults to NM (the safe default the uploader uses)', () => {
    assert.ok(isNearMint(''));
    assert.ok(isNearMint(null));
    assert.ok(isNearMint(undefined));
  });
  it('anything played is not NM', () => {
    assert.ok(!isNearMint('Lightly Played'));
    assert.ok(!isNearMint('Heavily Played'));
    assert.ok(!isNearMint('Damaged'));
  });
});

describe('medianOf', () => {
  it('odd and even counts', () => {
    assert.equal(medianOf([1, 5, 3]), 3);
    assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  });
  it('ignores nulls, zeroes and non-numbers rather than skewing the median', () => {
    assert.equal(medianOf([null, 4, undefined, 2, 0, 'x', 6]), 4);
  });
  it('nothing priced yet → 0, which disables the relative rule', () => {
    assert.equal(medianOf([]), 0);
    assert.equal(medianOf(null), 0);
  });
});

// ---------------------------------------------------------------------------
describe('flagsFor — what stops a bad price going live', () => {
  const ks = (row, med) => flagsFor(row, med || 0).map((f) => f.k);

  it('an ordinary priced row is clean', () => {
    assert.deepEqual(ks({ askAud: 6.5, mktAud: 4 }, 5), []);
  });
  it('over the A$150 per-card ceiling', () => {
    assert.ok(ks({ askAud: PRICE_CEILING_AUD + 0.01 }).includes('ceiling'));
    assert.ok(!ks({ askAud: PRICE_CEILING_AUD }).includes('ceiling'));   // the boundary itself passes
  });
  it('more than 4× the batch median — the decimal-slip catcher', () => {
    assert.ok(ks({ askAud: 41 }, 10).includes('median'));
    assert.ok(!ks({ askAud: 40 }, 10).includes('median'));
  });
  it('the relative rule is inert until the batch has a median', () => {
    assert.ok(!ks({ askAud: 41 }, 0).includes('median'));
  });
  it('under the floor, where the fee eats the sale', () => {
    assert.ok(ks({ askAud: 0.5 }).includes('tiny'));
  });
  it('disagreement with TCGplayer catches a comps query that hooked the WRONG card (GR5)', () => {
    assert.ok(ks({ askAud: 100, mktAud: 5 }).includes('disagree'));    // 20×
    assert.ok(ks({ askAud: 2, mktAud: 50 }).includes('disagree'));     // 0.04×
    assert.ok(!ks({ askAud: 10, mktAud: 8 }).includes('disagree'));    // 1.25× — normal AU premium
  });
  it('no market figure → no disagreement flag, rather than a divide-by-zero', () => {
    assert.ok(!ks({ askAud: 100, mktAud: 0 }).includes('disagree'));
    assert.ok(!ks({ askAud: 100 }).includes('disagree'));
  });
  it('a hand-typed price on a card with no comps still wants a human (GR4)', () => {
    assert.ok(ks({ askAud: 5, noComps: true }).includes('noComps'));
  });
  it('asking-only comps with no market figure = nothing corroborated the price', () => {
    // Observed live: Marketplace Insights soft-403s, the engine falls back to ASKING prices and
    // still reports confidence 'medium' / reliable true. A US$0.30 common came back at A$18.08.
    assert.ok(ks({ askAud: 18.08, askOnly: true }).includes('unverified'));
  });
  it('...but a market figure IS a second opinion, so asking-only alone does not flag', () => {
    assert.ok(!ks({ askAud: 9, askOnly: true, mktAud: 8 }).includes('unverified'));
  });
  it('sold-price comps never raise it', () => {
    assert.ok(!ks({ askAud: 18, askOnly: false }).includes('unverified'));
  });
  it('a title at the 80-char limit may have silently dropped a token', () => {
    assert.ok(ks({ askAud: 5, title: 'x'.repeat(80) }).includes('title'));
    assert.ok(!ks({ askAud: 5, title: 'x'.repeat(79) }).includes('title'));
  });
  it('a duplicate against existing stock', () => {
    assert.ok(ks({ askAud: 5, dupe: { hit: true } }).includes('dupe'));
  });
  it('every flag carries a sentence — colour alone is not actionable (DESIGN.md)', () => {
    for (const f of flagsFor({ askAud: 999, mktAud: 1, title: 'x'.repeat(80), dupe: { hit: true }, noComps: true }, 10)) {
      assert.ok(typeof f.why === 'string' && f.why.length > 10, 'flag ' + f.k + ' needs a reason');
    }
  });
  it('an unpriced row raises no price flags at all (that is EYES, not CHECK)', () => {
    assert.deepEqual(ks({ askAud: null, mktAud: 5 }, 10), []);
  });
});

// ---------------------------------------------------------------------------
describe('deriveState — the band a row lands in', () => {
  it('a clean priced row is READY and publishable', () => {
    const s = deriveState({ askAud: 6, mktAud: 5, cond: 'Near Mint' }, 5);
    assert.equal(s, 'READY');
    assert.ok(isPublishable(s));
  });
  it('no confident price → EYES, and EYES never publishes', () => {
    const s = deriveState({ askAud: null, cond: 'Near Mint' }, 5);
    assert.equal(s, 'EYES');
    assert.ok(!isPublishable(s));
  });
  it('a flagged row is CHECK until released, then CHECKED', () => {
    const row = { askAud: 900, mktAud: 5, cond: 'Near Mint' };
    assert.equal(deriveState(row, 5), 'CHECK');
    assert.ok(!isPublishable('CHECK'));
    assert.equal(deriveState({ ...row, released: true }, 5), 'CHECKED');
    assert.ok(isPublishable('CHECKED'));
  });
  it('sub-NM is HELD before price is even considered (eBay bans stock photos on used items)', () => {
    assert.equal(deriveState({ askAud: 6, cond: 'Lightly Played' }, 5), 'HELD');
    assert.ok(!isPublishable('HELD'));
  });
  it('HELD outranks a release — you cannot approve your way past a played card', () => {
    assert.equal(deriveState({ askAud: 6, cond: 'Heavily Played', released: true }, 5), 'HELD');
  });
  it('comps in flight → PRICING, which is not publishable', () => {
    assert.equal(deriveState({ pricing: true, cond: 'Near Mint' }, 5), 'PRICING');
    assert.ok(!isPublishable('PRICING'));
  });
  it('terminal states win over everything', () => {
    assert.equal(deriveState({ listingUrl: 'https://ebay', askAud: 999, cond: 'Heavily Played' }, 1), 'LIVE');
    assert.equal(deriveState({ failed: true, askAud: 6, cond: 'Near Mint' }, 5), 'FAILED');
    assert.equal(deriveState({ staged: true, askAud: 6, cond: 'Near Mint' }, 5), 'STAGED');
  });
  it('a missing row does not throw', () => {
    assert.equal(deriveState(null, 0), 'EYES');
  });
});

// ---------------------------------------------------------------------------
describe('scaleGeometry — the rail must actually vary between rows', () => {
  // The naive version is broken in a way that is easy to re-introduce: clusterValue returns
  // cheapestInCluster and clusterLo as the SAME expression, and recommendedFromCluster is
  // cheapestInCluster − 1c, so a cheapest→hi rail with a lo→hi band draws one identical picture on
  // every unedited row. These tests exist to keep it honest.
  it('an unedited ask (cheapest − 1c) sits hard left, which is correct and readable', () => {
    const g = scaleGeometry({ askAud: 9.99, clusterLo: 10, clusterHi: 20, fair: 14 });
    assert.equal(g.caretPct, 0, 'the ask is the lowest point in the domain');
    assert.ok(g.bandLeftPct > 0, 'the cluster band starts to the right of the ask');
    assert.equal(g.inBand, false, 'undercutting means outside the cluster, by construction');
  });

  it('the `fair` tick MOVES with the cluster — the part that differs row to row', () => {
    const low = scaleGeometry({ askAud: 9.99, clusterLo: 10, clusterHi: 20, fair: 11 });
    const high = scaleGeometry({ askAud: 9.99, clusterLo: 10, clusterHi: 20, fair: 19 });
    assert.ok(high.tickPct > low.tickPct + 20, 'a skewed cluster must look different');
  });

  it('two rows with different cluster shapes render differently', () => {
    const tight = scaleGeometry({ askAud: 9.99, clusterLo: 10, clusterHi: 11, fair: 10.5 });
    const wide = scaleGeometry({ askAud: 9.99, clusterLo: 10, clusterHi: 90, fair: 40 });
    assert.notEqual(tight.tickPct.toFixed(1), wide.tickPct.toFixed(1));
    assert.equal(tight.wide, false);
    assert.equal(wide.wide, true, 'hi/lo past ' + SPREAD_WIDE + '× is the same threshold comps calls unreliable');
  });

  it('a hand-typed price INSIDE the cluster reads as in-band', () => {
    const g = scaleGeometry({ askAud: 15, clusterLo: 10, clusterHi: 20, fair: 14 });
    assert.equal(g.inBand, true);
    assert.ok(g.caretPct > 0 && g.caretPct < 100);
  });

  it('a hand-typed price ABOVE the cluster stays on screen instead of clipping', () => {
    const g = scaleGeometry({ askAud: 50, clusterLo: 10, clusterHi: 20, fair: 14 });
    assert.equal(g.inBand, false);
    assert.equal(g.caretPct, 100, 'the domain stretches to include it');
    assert.ok(g.bandWidthPct < 100, 'the cluster no longer fills the rail');
  });

  it('every percentage stays inside 0–100', () => {
    for (const g of [
      scaleGeometry({ askAud: 0.5, clusterLo: 10, clusterHi: 20, fair: 14 }),
      scaleGeometry({ askAud: 999, clusterLo: 10, clusterHi: 20, fair: 14 }),
      scaleGeometry({ askAud: 15, clusterLo: 10, clusterHi: 20, fair: 999 }),
    ]) {
      for (const k of ['bandLeftPct', 'bandWidthPct', 'tickPct', 'caretPct']) {
        if (g[k] == null) continue;
        assert.ok(g[k] >= 0 && g[k] <= 100, k + ' out of range: ' + g[k]);
      }
    }
  });

  it('a degenerate cluster (lo === hi) does not divide by zero', () => {
    const g = scaleGeometry({ askAud: 10, clusterLo: 10, clusterHi: 10, fair: 10 });
    assert.ok(g);
    assert.ok(isFinite(g.bandWidthPct) && g.bandWidthPct > 0);
  });

  it('no cluster → nothing to draw', () => {
    assert.equal(scaleGeometry({ askAud: 10 }), null);
    assert.equal(scaleGeometry({ askAud: 10, clusterLo: 20, clusterHi: 10 }), null, 'inverted range is not a rail');
  });

  it('no ask yet → a rail with no caret, never a caret at zero pretending to be a price', () => {
    const g = scaleGeometry({ clusterLo: 10, clusterHi: 20, fair: 14 });
    assert.equal(g.caretPct, null);
    assert.equal(g.inBand, null);
  });
});

describe('atMechanicalUndercut — the batch integrity check', () => {
  it('an untouched ask sits exactly at the recommendation', () => {
    assert.equal(atMechanicalUndercut(9.99, 9.99), true);
  });
  it('a hand-moved ask does not', () => {
    assert.equal(atMechanicalUndercut(12.5, 9.99), false);
    assert.equal(atMechanicalUndercut(9.98, 9.99), false);
  });
  it('float noise inside half a cent still counts as untouched', () => {
    assert.equal(atMechanicalUndercut(9.990001, 9.99), true);
  });
  it('a missing figure is not a match', () => {
    assert.equal(atMechanicalUndercut(null, 9.99), false);
    assert.equal(atMechanicalUndercut(9.99, null), false);
  });
});

// ---------------------------------------------------------------------------
describe('refuseRow — the server-side gate a stale tab cannot bypass', () => {
  const NM = { priceCents: 600, condition: 'Near Mint', hasOwnerPhotos: false };
  const codes = (row, med, cfg) => refuseRow(row, med || 0, cfg).map((r) => r.code);

  it('an ordinary near-mint row at a sane price is allowed through', () => {
    assert.deepEqual(codes(NM, 500), []);
  });

  it('no price is refused, and short-circuits the other price rules', () => {
    assert.deepEqual(codes({ ...NM, priceCents: 0 }), ['no_price']);
    assert.deepEqual(codes({ ...NM, priceCents: null }), ['no_price']);
    assert.deepEqual(codes({ ...NM, priceCents: -1 }), ['no_price']);
  });

  it('over the per-card ceiling — releasable', () => {
    const r = refuseRow({ ...NM, priceCents: PRICE_CEILING_AUD * 100 + 1 }, 0);
    assert.deepEqual(r.map((x) => x.code), ['over_ceiling']);
    assert.equal(r[0].releasable, true);
  });
  it('the ceiling boundary itself passes', () => {
    assert.deepEqual(codes({ ...NM, priceCents: PRICE_CEILING_AUD * 100 }, 0), []);
  });

  it('over 4× the batch median — releasable', () => {
    const r = refuseRow({ ...NM, priceCents: 4100 }, 1000);
    assert.deepEqual(r.map((x) => x.code), ['over_median']);
    assert.equal(r[0].releasable, true);
    assert.deepEqual(codes({ ...NM, priceCents: 4000 }, 1000), []);   // exactly 4× passes
  });
  it('the median rule is inert when the batch has no median', () => {
    assert.deepEqual(codes({ ...NM, priceCents: 4100 }, 0), []);
  });

  it('under the floor — releasable', () => {
    const r = refuseRow({ ...NM, priceCents: 50 }, 0);
    assert.deepEqual(r.map((x) => x.code), ['under_floor']);
    assert.equal(r[0].releasable, true);
  });

  it('sub-NM with no owner photos is refused and is NOT releasable', () => {
    // eBay bans stock catalog images on used items. That is a policy breach, not a judgement call,
    // so no amount of approving gets past it.
    const r = refuseRow({ ...NM, condition: 'Lightly Played' }, 0);
    assert.deepEqual(r.map((x) => x.code), ['sub_nm_no_photos']);
    assert.equal(r[0].releasable, false);
  });
  it('sub-NM WITH owner photos is fine', () => {
    assert.deepEqual(codes({ ...NM, condition: 'Heavily Played', hasOwnerPhotos: true }, 0), []);
  });

  it('a graded slab with no photos is refused — a catalog scan hides the cert', () => {
    const r = refuseRow({ ...NM, graded: true, condition: null }, 0);
    assert.deepEqual(r.map((x) => x.code), ['graded_no_photos']);
    assert.equal(r[0].releasable, false);
  });
  it('a graded slab WITH photos is fine, and is never judged on card condition', () => {
    assert.deepEqual(codes({ ...NM, graded: true, condition: 'Lightly Played', hasOwnerPhotos: true }, 0), []);
  });

  it('several reasons stack rather than the first one hiding the rest', () => {
    const c = codes({ priceCents: 90000, condition: 'Lightly Played', hasOwnerPhotos: false }, 1000);
    assert.ok(c.includes('sub_nm_no_photos'));
    assert.ok(c.includes('over_ceiling'));
    assert.ok(c.includes('over_median'));
  });

  it('every refusal carries a usable sentence, not just a code', () => {
    for (const r of refuseRow({ priceCents: 90000, condition: 'Lightly Played' }, 1000)) {
      assert.ok(typeof r.message === 'string' && r.message.length > 20, r.code + ' needs a message');
      assert.equal(typeof r.releasable, 'boolean');
    }
  });

  it('the client and the server refuse on the SAME numbers', () => {
    // flagsFor (grid, dollars) and refuseRow (route, cents) must agree, or the owner sees a green
    // row the server then rejects. Same constants, checked at the boundary.
    const overCeiling = PRICE_CEILING_AUD + 1;
    assert.ok(flagsFor({ askAud: overCeiling }, 0).some((f) => f.k === 'ceiling'));
    assert.ok(codes({ ...NM, priceCents: overCeiling * 100 }, 0).includes('over_ceiling'));
    assert.ok(flagsFor({ askAud: 41 }, 10).some((f) => f.k === 'median'));
    assert.ok(codes({ ...NM, priceCents: 4100 }, 1000).includes('over_median'));
    assert.equal(MEDIAN_MULT, 4);
  });
});

describe('blockingRefusals — what an explicit per-row approval can and cannot clear', () => {
  const rs = [{ code: 'over_ceiling', releasable: true }, { code: 'sub_nm_no_photos', releasable: false }];
  it('unreleased: everything blocks', () => {
    assert.deepEqual(blockingRefusals(rs, false).map((r) => r.code), ['over_ceiling', 'sub_nm_no_photos']);
  });
  it('released: only the releasable ones clear', () => {
    assert.deepEqual(blockingRefusals(rs, true).map((r) => r.code), ['sub_nm_no_photos']);
  });
  it('released with only releasable reasons clears completely', () => {
    assert.deepEqual(blockingRefusals([rs[0]], true), []);
  });
  it('empty / missing input is inert', () => {
    assert.deepEqual(blockingRefusals([], true), []);
    assert.deepEqual(blockingRefusals(null, true), []);
  });
});

// ---------------------------------------------------------------------------
describe('rowKey — one label per listing, N copies on it', () => {
  const base = { setId: 'sv3', rawNumber: '125', identityKey: 'sv3-125', variant: 'Base', cond: 'Near Mint' };

  it('two identical cards share a key, so they merge into one row with qty 2', () => {
    assert.equal(rowKey(base), rowKey({ ...base }));
  });
  it('a different printing is different stock (GR5)', () => {
    assert.notEqual(rowKey(base), rowKey({ ...base, variant: 'Reverse Holo' }));
  });
  it('a different condition is different stock', () => {
    assert.notEqual(rowKey(base), rowKey({ ...base, cond: 'Lightly Played' }));
  });
  it('the two NM spellings agree, so they do not split into two listings', () => {
    assert.equal(rowKey(base), rowKey({ ...base, cond: 'Ungraded, Near Mint' }));
  });
  it('a different language is different stock', () => {
    assert.notEqual(rowKey(base), rowKey({ ...base, language: 'JP' }));
  });
  // Load-bearing since Magic reached the runner. Set codes collide across games, and without the
  // game segment a Pokémon sv3-125 and a Magic hob-125 in the same pile would merge into one row —
  // one label, one listing, two different cards.
  it('two games never merge, even at the same identity', () => {
    assert.notEqual(rowKey({ ...base, game: 'pokemon' }), rowKey({ ...base, game: 'mtg' }));
  });
  it('a row built before the switcher existed is still Pokémon', () => {
    assert.equal(rowKey(base), rowKey({ ...base, game: 'pokemon' }));
  });
});
