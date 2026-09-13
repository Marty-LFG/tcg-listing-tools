// test/unit/riftbound-display-name.test.mjs — riftboundDisplayName, the champion-first name.
//
// Riot names a Legend by its epithet ("Keeper of the Hammer") and keeps the champion in the tag
// line; a champion Unit is printed "<Champion>, <Epithet>". The storefront names both
// "<Champion> (<Epithet>)" (bk-shopify, Marty 2026-09-13). The bake supplies `ch`; this is the one
// function that turns it into a name, and it must leave every other card's printed name alone.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { riftboundDisplayName } from '../../lib/riftbound-data.mjs';
import { groupCards } from '../../scripts/build-riftbound-data.mjs';

describe('riftboundDisplayName', () => {
  it('a Legend leads with its champion and keeps the epithet in brackets', () => {
    assert.equal(riftboundDisplayName({ name: 'Keeper of the Hammer', type: 'Legend', champion: 'Poppy' }), 'Poppy (Keeper of the Hammer)');
    assert.equal(riftboundDisplayName({ name: 'Green Father', type: 'Legend', champion: 'Ivern' }), 'Ivern (Green Father)');
  });
  it('a champion Unit swaps the comma form for the bracket form', () => {
    assert.equal(riftboundDisplayName({ name: 'Darius, Executioner', type: 'Unit', champion: 'Darius' }), 'Darius (Executioner)');
  });
  it('a Unit whose name does not start with its champion is left alone', () => {
    // "Yi, Honed" is Master Yi's card; the bake carries the tag, the name does not start with it.
    assert.equal(riftboundDisplayName({ name: 'Yi, Honed', type: 'Unit', champion: 'Master Yi' }), 'Yi, Honed');
  });
  it('anything without a champion is untouched, whatever its shape', () => {
    assert.equal(riftboundDisplayName({ name: 'Heisho, Shell of the World', type: 'Battlefield', champion: '' }), 'Heisho, Shell of the World');
    assert.equal(riftboundDisplayName({ name: 'Fury Rune', type: 'Rune' }), 'Fury Rune');
    assert.equal(riftboundDisplayName({ name: 'Keeper of the Hammer', type: 'Legend' }), 'Keeper of the Hammer');
    assert.equal(riftboundDisplayName(null), '');
  });
});

// The bake side: `ch` comes from the gallery's tags for a Legend and from the name for a champion
// Unit, and is '' for everything else — a guess would be GR4.
describe('groupCards — the champion (`ch`)', () => {
  const card = (publicCode, name, o = {}) => ({
    publicCode, name,
    set: { value: { label: 'Unleashed' } },
    cardType: { type: [{ label: o.type || 'Unit' }], ...(o.superType ? { superType: [{ label: o.superType }] } : {}) },
    rarity: { value: { id: 'rare' } },
    domain: { values: [{ label: 'Body' }] },
    energy: { value: { id: 3 } }, power: { value: { id: 1 } }, might: { value: { id: 4 } },
    cardImage: { url: 'https://cmsassets.rgpub.io/x.png' },
    illustrator: { values: [{ label: 'Pandart Studio' }] },
    ...(o.tags ? { tags: { label: 'Tags', tags: o.tags } } : {}),
  });
  const out = groupCards([
    card('UNL-203/219', 'Keeper of the Hammer', { type: 'Legend', tags: ['Poppy'] }),
    card('UNL-197/219', 'Curator of the Sands', { type: 'Legend', tags: ['Dog', 'Shurima', 'Nasus'] }),
    card('UNL-050/219', 'Darius, Executioner', { type: 'Unit', superType: 'Champion', tags: ['Trifarian', 'Darius'] }),
    card('UNL-051/219', 'Allay, Eager Admirer', { type: 'Unit', tags: ['Yordle', 'Bandle City'] }),
    card('UNL-100/219', 'Ambush', { type: 'Spell' }),
  ], [{ id: 'UNL', name: 'Unleashed', collectorNumberMax: 219 }]);
  const find = (k) => out.ordered.unl.cards.find((c) => c.k === k);
  it("a Legend's champion is the last tag", () => {
    assert.equal(find('203').ch, 'Poppy');
    assert.equal(find('197').ch, 'Nasus');
  });
  it("a champion Unit's champion is its name before the comma", () => {
    assert.equal(find('50').ch, 'Darius');
  });
  it('a non-champion Unit and a Spell bake no champion', () => {
    assert.equal(find('51').ch, '');
    assert.equal(find('100').ch, '');
  });
});
