// test/unit/runs-rarity.test.mjs — the committed rarity vocabulary (lib/runs-rarity.mjs).
//
// The table's hash goes inside headerDigest, so it is anchored and can never be re-issued for a run
// already published. The vector below is the specification's own (docs/RUNS_PLAN.md §11.1): 417 bytes
// canonical, hash ca971d5d…. A change to the table, the sort, or the encoding moves it.
//
// The rest of this file is about the three ways the naive comparison fails silently.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RARITY_TABLE_VERSION, RARITY_SOURCES, RARITY_CLASSES,
  rarityClass, rarityDisplay, rarityTableCanonical, rarityTableHash, rarityTable,
} from '../../lib/runs-rarity.mjs';
import { pkmRarityAbbrev } from '../../lib/listing-copy.mjs';

describe('the published vector', () => {
  it('serialises to 417 bytes', () => {
    assert.equal(new TextEncoder().encode(rarityTableCanonical()).length, 417);
  });

  it('hashes to the value the specification publishes', async () => {
    assert.equal(await rarityTableHash(),
      'ca971d5d15666d83cfeb4b451dc3bd99d6639e7eeee70c23002c39a7d28d83e0');
  });

  it('sorts byte-wise, so a space beats an underscore', () => {
    const c = rarityTableCanonical();
    assert.ok(c.indexOf('mega attack rare') < c.indexOf('mega_attack_rare'),
      'localeCompare or a plain sort would order these the other way and move the hash');
  });

  it('carries both counts, so a verifier cannot be fed a truncated table', () => {
    const c = rarityTableCanonical();
    assert.ok(c.startsWith('7:SOURCES,1:7,'), c.slice(0, 40));
    assert.ok(c.includes('7:CLASSES,1:4,'));
  });

  it('the version label and the hash travel together', async () => {
    const t = await rarityTable();
    assert.equal(t.version, RARITY_TABLE_VERSION);
    assert.equal(t.version, 'rarity-v1');
    // A label pins nothing a verifier can check; the hash is what does. Both go in the header.
    assert.equal(t.hash, await rarityTableHash());
  });
});

describe('the three failures a string comparison would make silently', () => {
  it('CROSS-LANGUAGE ALIAS: one physical card, two source strings, one class', () => {
    assert.equal(rarityClass('Art Rare'), 'ART_RARE');
    assert.equal(rarityClass('Illustration Rare'), 'ART_RARE');
    assert.equal(rarityClass('Special Art Rare'), 'SPECIAL_ART_RARE');
    assert.equal(rarityClass('Special Illustration Rare'), 'SPECIAL_ART_RARE');
    // And the aliases must not bleed across the plain/special boundary, which is a real price gap.
    assert.notEqual(rarityClass('Art Rare'), rarityClass('Special Art Rare'));
  });

  it('ABBREVIATION COLLISION: the listing map calls two different cards AR, this table does not', () => {
    // Pinned against the real map rather than described, so it fails if that map is ever "fixed" and
    // someone concludes this separate table is redundant. It is not: the collision is harmless in a
    // listing title and would let an Amazing Rare satisfy an Art Rare guarantee.
    assert.equal(pkmRarityAbbrev('art rare'), 'AR');
    assert.equal(pkmRarityAbbrev('amazing rare'), 'AR');
    assert.notEqual(rarityClass('art rare'), rarityClass('amazing rare'));
  });

  it('UNMAPPED VALUE: no class, so it can satisfy no claim', () => {
    for (const s of ['Double Rare', 'Ultra Rare', 'Hyper Rare', 'Radiant Rare', '', '   ', null, undefined]) {
      assert.equal(rarityClass(s), null, JSON.stringify(s));
    }
    // The one that made this necessary: live stock already holds a MEGA_ATTACK_RARE row, and the
    // listing map returns '' for it — indistinguishable from "no rarity" to a caller that trusts it.
    assert.equal(pkmRarityAbbrev('mega attack rare'), '');
    assert.equal(rarityClass('mega attack rare'), 'MEGA_ATTACK_RARE');
  });
});

describe('folding', () => {
  it('is case-insensitive over ASCII, and normalises before folding', () => {
    for (const s of ['ART RARE', 'art rare', 'Art Rare', 'aRt RaRe', '  Art Rare\t']) {
      assert.equal(rarityClass(s), 'ART_RARE', JSON.stringify(s));
    }
  });

  it('accepts the underscored source form the catalogues actually emit', () => {
    assert.equal(rarityClass('mega_attack_rare'), 'MEGA_ATTACK_RARE');
    assert.equal(rarityClass('MEGA_ATTACK_RARE'), 'MEGA_ATTACK_RARE');
  });

  it('folds ASCII ONLY — a Turkish locale must not change the answer', () => {
    // toLowerCase() in tr-TR maps 'I' to a dotless i, so "ILLUSTRATION RARE" would stop matching and a
    // lock would fail depending on the machine it ran on. Asserted against the actual divergence.
    assert.notEqual('I'.toLocaleLowerCase('tr-TR'), 'i');
    assert.equal(rarityClass('ILLUSTRATION RARE'), 'ART_RARE');
  });
});

describe('the table is a closed vocabulary', () => {
  it('every source maps to a class that has a display name', () => {
    for (const [source, cls] of Object.entries(RARITY_SOURCES)) {
      assert.ok(RARITY_CLASSES[cls], `${source} -> ${cls} has no display name`);
      assert.equal(rarityDisplay(cls), RARITY_CLASSES[cls]);
    }
  });

  it('every class is reachable from at least one source', () => {
    const reachable = new Set(Object.values(RARITY_SOURCES));
    for (const cls of Object.keys(RARITY_CLASSES)) {
      assert.ok(reachable.has(cls), `${cls} is declared but nothing maps to it`);
    }
  });

  it('source keys are already folded, so a lookup can never miss its own table', () => {
    for (const source of Object.keys(RARITY_SOURCES)) {
      assert.equal(source, source.toLowerCase().normalize('NFC'), source);
      assert.equal(rarityClass(source), RARITY_SOURCES[source]);
    }
  });

  it('rarityDisplay refuses an unknown class rather than echoing it', () => {
    assert.equal(rarityDisplay('MADE_UP_RARE'), null);
    assert.equal(rarityDisplay(null), null);
    assert.equal(rarityDisplay('toString'), null, 'and it is not fooled by a prototype key');
  });

  it('rarityClass is not fooled by a prototype key either', () => {
    assert.equal(rarityClass('constructor'), null);
    assert.equal(rarityClass('__proto__'), null);
  });
});
