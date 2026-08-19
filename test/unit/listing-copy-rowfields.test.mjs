// test/unit/listing-copy-rowfields.test.mjs — rowToFields() must give every game its OWN prose.
//
// rowToFields had branches for riftbound, mtg and lorcana and an `else` that called pokemonPitch, so
// Star Wars and One Piece rows published from stock came out branded as Pokémon: a real listing read
// "Darth Vader from the Pokémon TCG Spark of Rebellion (SOR) set." The same gap left their card facts
// unset, and the frames were written against the BUILDERS' contract where val() always returns a
// string — `f.cost !== ''` is TRUE for undefined — so every One Piece table printed
// "Cost undefined · Power undefined · Counter undefined · Life undefined".
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rowToFields, buildDescription } from '../../lib/listing-copy.mjs';

const base = { condition: 'Near Mint', language: 'EN', price_cents: 4500 };
const swuRow = (over) => ({ game: 'swu', name: 'Darth Vader', set_name: 'Spark of Rebellion (SOR)',
  card_number: '010', rarity: 'Legendary', type: 'Leader', aspect: 'Aggression', variant: 'Standard', ...base, ...over });
const opRow = (over) => ({ game: 'onepiece', name: 'Monkey D. Luffy', set_name: 'Romance Dawn (OP-01)',
  card_number: 'OP01-001', rarity: 'L', type: 'Leader', color: 'Red', ...base, ...over });

describe('rowToFields — no game wears another game s branding', () => {
  it('a Star Wars row is never described as a Pokémon card', () => {
    const f = rowToFields(swuRow(), {});
    assert.match(f.pitch, /Star Wars: Unlimited/);
    assert.ok(!/Pok/i.test(f.pitch), 'pitch mentions Pokémon: ' + f.pitch);
    assert.ok(!/Pok/i.test(buildDescription('swu', f)), 'the rendered description mentions Pokémon');
  });

  it('a One Piece row gets the One Piece pitch', () => {
    const f = rowToFields(opRow(), {});
    assert.match(f.pitch, /One Piece Card Game/);
    assert.ok(!/Pok/i.test(buildDescription('onepiece', f)));
  });

  it('strips the set code from the SWU prose but keeps it in the table', () => {
    const f = rowToFields(swuRow(), {});
    assert.match(f.pitch, /Spark of Rebellion\./, 'prose should not carry "(SOR)"');
    assert.match(buildDescription('swu', f), /Spark of Rebellion \(SOR\)/, 'the Set row keeps the code');
  });
});

describe('rowToFields — a missing fact renders nothing, never the word undefined', () => {
  it('One Piece stats: no facts at all means no Stats row, not four undefineds', () => {
    const f = rowToFields(opRow(), {});
    const html = buildDescription('onepiece', f);
    assert.ok(!/undefined/.test(html), 'undefined leaked into the description');
    assert.ok(!/Stats/.test(html), 'an all-empty Stats row should be omitted entirely');
  });

  it('One Piece stats: renders only the facts that are actually present', () => {
    const f = rowToFields(opRow({ cost: 0, power: 5000, counter: null, life: 5 }), {});
    const html = buildDescription('onepiece', f);
    assert.ok(!/undefined/.test(html));
    assert.match(html, /Cost 0/, 'a zero cost is a real value and must survive');
    assert.match(html, /Power 5000/);
    assert.match(html, /Life 5/);
    assert.ok(!/Counter/.test(html), 'a null counter should be dropped');
  });

  it('SWU facts do not leak undefined either', () => {
    assert.ok(!/undefined/.test(buildDescription('swu', rowToFields(swuRow(), {}))));
    assert.ok(!/undefined/.test(buildDescription('swu', rowToFields(swuRow({ cost: 2, power: 3, hp: 7 }), {}))));
  });
});

describe('swuPitch — the article agrees with what follows it', () => {
  const pitchFor = (over) => rowToFields(swuRow(over), {}).pitch;
  it('"An Aggression-aspect", not "A Aggression-aspect"', () => {
    assert.match(pitchFor({ aspect: 'Aggression' }), /An Aggression-aspect/);
  });
  it('a consonant aspect still takes "A"', () => {
    assert.match(pitchFor({ aspect: 'Command' }), /A Command-aspect/);
    assert.match(pitchFor({ aspect: 'Vigilance' }), /A Vigilance-aspect/);
  });
  it('with no aspect it agrees with the card type instead', () => {
    assert.match(pitchFor({ aspect: '', rarity: 'Common', type: 'Event' }), /\ban event\b/);
    assert.match(pitchFor({ aspect: '', rarity: 'Common', type: 'Unit' }), /\ba unit\b/);
  });
});
