// test/unit/riftbound-bake.test.mjs — groupCards(), the pure core of the Riftbound catalog bake.
//
// This is where the variant treatment is DECIDED, once, and frozen into the card name so the
// builder, lib/riftbound-data.mjs and the bulk pipeline all read one answer. Getting it wrong is
// expensive in the literal sense: on TCGplayer, OGN "299*" is a Signature at US$2,739 while plain
// "299" is an Overnumbered at US$296 — the bake used to label both "Overnumbered".
//
// The other half of the job is being self-updating: Riot's gallery ships its own set roster
// ([{id, name, collectorNumberMax}] in release order), so a new set must need no code change.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupCards, TREATMENT_OVERRIDE } from '../../scripts/build-riftbound-data.mjs';

// Minimal shape of a Riot gallery card (the Sanity CMS field wrappers the bake reads through).
const card = (publicCode, name, o = {}) => ({
  publicCode,
  name,
  set: { value: { label: o.setName || 'Vendetta' } },
  cardType: { type: [{ label: o.type || 'Unit' }] },
  rarity: { value: { id: o.rarity || 'rare' } },
  domain: { values: [{ label: o.domain || 'Fury' }] },
  energy: { value: { id: o.e != null ? o.e : 3 } },
  power: { value: { id: o.p != null ? o.p : 1 } },
  might: { value: { id: o.m != null ? o.m : 4 } },
  cardImage: { url: o.img || 'https://cmsassets.rgpub.io/x.png' },
});
const ROSTER = [
  { id: 'OGN', name: 'Origins', collectorNumberMax: 298 },
  { id: 'VEN', name: 'Vendetta', collectorNumberMax: 166 },
];
const find = (out, set, k) => out.ordered[set].cards.find((c) => c.k === k);

describe('groupCards — variant derivation from the printed number', () => {
  const out = groupCards([
    card('VEN-001/166', 'Baccai Sandspinner', { rarity: 'common' }),
    card('VEN-138a/166', 'Shen, Leader of the Kinkou Order'),
    card('VEN-167/166', 'Vi, Destructive', { rarity: 'rare' }),
    card('VEN-SP1/006', "Kai'Sa, Survivor", { rarity: 'epic' }),
    card('OGN-299/298', 'Daughter of the Void', { setName: 'Origins', rarity: 'showcase' }),
    card('OGN-299*/298', 'Daughter of the Void', { setName: 'Origins', rarity: 'showcase' }),
  ], ROSTER);

  it('a trailing * is a SIGNATURE, not an Overnumbered', () => {
    assert.equal(find(out, 'ogn', '299*').name, 'Daughter of the Void (Signature)');
  });
  it('a number above the set total is Overnumbered — even when Riot calls the card a rare', () => {
    // Riot's own rarity field says "rare" for VEN 167; TCGplayer sells it as a Showcase at US$125.
    assert.equal(find(out, 'ven', '167').name, 'Vi, Destructive (Overnumbered)');
    assert.equal(find(out, 'ogn', '299').name, 'Daughter of the Void (Overnumbered)');
  });
  it('the same card number with and without the * are two different cards', () => {
    assert.notEqual(find(out, 'ogn', '299').name, find(out, 'ogn', '299*').name);
  });
  it('a trailing letter is still Alternate Art', () => {
    assert.equal(find(out, 'ven', '138a').name, 'Shen, Leader of the Kinkou Order (Alternate Art)');
  });
  it('a base print inside the total gets no suffix at all', () => {
    assert.equal(find(out, 'ven', '1').name, 'Baccai Sandspinner');
  });
  it('SP promos carry no suffix but bake as Showcase — the number is their only marker', () => {
    const sp = find(out, 'ven', 'sp1');
    assert.equal(sp.name, "Kai'Sa, Survivor", 'no parenthetical: TCGplayer does not use one either');
    assert.equal(sp.rarity, 'Showcase', "Riot calls it 'epic'; it sells as a Showcase");
    assert.equal(sp.num, 'SP1/006', 'printed number verbatim, uppercase (GR5 + the dotgg CDN key)');
  });
  it('the * card is over the total too, so ordering the two rules matters', () => {
    // Guard against a regression to "over-total wins": that relabels every Signature.
    assert.ok(299 > 298 && find(out, 'ogn', '299*').name.endsWith('(Signature)'));
  });
});

describe('groupCards — TREATMENT_OVERRIDE (the one label no number can imply)', () => {
  const UNL = [{ id: 'UNL', name: 'Unleashed', collectorNumberMax: 219 }];
  it('overrides the derived treatment for the card it names', () => {
    // UNL-238 Baron Nashor is over the total, so the derivation alone would call it Overnumbered.
    // TCGplayer sells it as "(Ultimate)" at ~US$1,635 — 3x the set's Signatures.
    const out = groupCards([card('UNL-238/219', 'Baron Nashor', { setName: 'Unleashed', rarity: 'epic' })], UNL);
    assert.equal(find(out, 'unl', '238').name, 'Baron Nashor (Ultimate)');
  });
  it('leaves every other over-total card alone', () => {
    const out = groupCards([
      card('UNL-220/219', 'Pouty Poro', { setName: 'Unleashed', rarity: 'common' }),
      card('UNL-237/219', 'Keeper of the Hammer', { setName: 'Unleashed' }),
    ], UNL);
    assert.equal(find(out, 'unl', '220').name, 'Pouty Poro (Overnumbered)');
    assert.equal(find(out, 'unl', '237').name, 'Keeper of the Hammer (Overnumbered)');
  });
  it('is keyed by identity, so a same-numbered card in another set is untouched', () => {
    const out = groupCards([card('OGN-238/298', 'Some Origins Card', { setName: 'Origins' })], ROSTER);
    assert.equal(find(out, 'ogn', '238').name, 'Some Origins Card');
  });
  it('holds exactly the entries we believe in — a grown list wants a second look', () => {
    // Not a style rule: every entry here is a hardcode that test/data/riftbound-variants.test.mjs
    // has to keep honest against TCGplayer. If this count moves, that fence needs checking too.
    assert.deepEqual(Object.keys(TREATMENT_OVERRIDE), ['UNL-238']);
  });
});

describe('groupCards — self-updating set roster', () => {
  it('takes codes, names, totals and RELEASE ORDER from Riot, not from a hardcoded list', () => {
    const out = groupCards([card('VEN-001/166', 'A'), card('OGN-001/298', 'B', { setName: 'Origins' })], ROSTER);
    assert.deepEqual(Object.keys(out.ordered), ['ogn', 'ven'], 'roster order, not first-seen');
    assert.equal(out.ordered.ven.name, 'Vendetta');
    assert.equal(out.ordered.ven.total, 166);
    assert.equal(out.ordered.ogn.total, 298);
  });
  it('a set absent from the roster still bakes, ordered after the known ones', () => {
    const out = groupCards([card('XYZ-001/180', 'Future', { setName: 'Some Future Set' }), card('OGN-001/298', 'B', { setName: 'Origins' })], ROSTER);
    assert.deepEqual(Object.keys(out.ordered), ['ogn', 'xyz']);
    assert.equal(out.ordered.xyz.name, 'Some Future Set');
    assert.equal(out.ordered.xyz.total, 180, 'total falls back to the printed denominator');
  });
  it('falls back to per-card denominators when Riot drops the roster entirely (GR7)', () => {
    const out = groupCards([card('VEN-167/166', 'Vi, Destructive')], []);
    assert.equal(out.ordered.ven.total, 166);
    assert.equal(find(out, 'ven', '167').name, 'Vi, Destructive (Overnumbered)');
  });
  it("never takes an SP card's /006 as the set total", () => {
    // "SP1/006" means "1 of the six-card showcase subset", not "set of 6". Reading it as the total
    // would mark every card above 6 as Overnumbered.
    const out = groupCards([card('VEN-SP1/006', 'K'), card('VEN-010/166', 'Ten')], []);
    assert.equal(out.ordered.ven.total, 166);
    assert.equal(find(out, 'ven', '10').name, 'Ten');
  });
});

describe('groupCards — what it keeps, skips and how it orders', () => {
  it('skips tokens and rune reprints (no printed /TOTAL, no identity of their own)', () => {
    const out = groupCards([
      card('VEN-001/166', 'Keep'), { publicCode: 'UNL-T04', name: 'Token' }, { publicCode: 'VEN-R03', name: 'Mind Rune' },
    ], ROSTER);
    assert.equal(out.kept, 1);
    assert.equal(out.skipped, 2);
  });
  it('sorts the SP showcase block last, not first', () => {
    // parseInt('sp1') is NaN -> 0, which would otherwise sort SP ahead of card #1.
    const out = groupCards([card('VEN-SP2/006', 'B'), card('VEN-010/166', 'Ten'), card('VEN-SP1/006', 'A'), card('VEN-001/166', 'One')], ROSTER);
    assert.deepEqual(out.ordered.ven.cards.map((c) => c.k), ['1', '10', 'sp1', 'sp2']);
  });
  it('stats ride only on units', () => {
    const out = groupCards([card('VEN-001/166', 'Spell', { type: 'Spell' }), card('VEN-002/166', 'Unit')], ROSTER);
    assert.equal(find(out, 'ven', '1').e, '3', 'the bake stores stats; the resolver hides them per type');
    assert.equal(find(out, 'ven', '2').type, 'Unit');
  });
});

describe('groupCards — newSets (the Telegram alert trigger)', () => {
  const cards = [card('OGN-001/298', 'A', { setName: 'Origins' }), card('VEN-001/166', 'B')];
  it('reports a set the previous bake did not have', () => {
    const out = groupCards(cards, ROSTER, { ogn: { code: 'OGN', name: 'Origins', cards: [] } });
    assert.deepEqual(out.newSets.map((s) => s.code), ['VEN']);
    assert.equal(out.newSets[0].name, 'Vendetta');
    assert.equal(out.newSets[0].cards, 1);
    assert.equal(out.newSets[0].total, 166);
  });
  it('reports NOTHING on a cold start, so a fresh deploy does not alert every set', () => {
    // data/riftbound.json is gitignored; without this guard the first bake after a deploy would
    // announce all five sets as brand new.
    assert.deepEqual(groupCards(cards, ROSTER, {}).newSets, []);
    assert.deepEqual(groupCards(cards, ROSTER).newSets, []);
  });
  it('reports nothing when the roster is unchanged', () => {
    const prior = { ogn: { code: 'OGN' }, ven: { code: 'VEN' } };
    assert.deepEqual(groupCards(cards, ROSTER, prior).newSets, []);
  });
});
