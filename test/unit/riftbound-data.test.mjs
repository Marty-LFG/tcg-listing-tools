// test/unit/riftbound-data.test.mjs — resolveRiftboundCard/iterateRiftboundSet, the server-side
// half of Riftbound resolution. Everything the bulk pipeline lists (lib/enumerate.mjs,
// lib/channels/ebay-map.mjs, lib/collectr-resolve.mjs) comes through here, so a wrong variant or
// finish reaches an eBay listing rather than a console.
//
// The helper-level parity with the builder lives in test/invariants/riftbound-mirror.test.mjs; this
// file exercises the resolution ON TOP of them, against a fixture catalog (the real
// data/riftbound.json is gitignored, so tests must not depend on it).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRiftboundCard, iterateRiftboundSet, loadRiftboundSets } from '../../lib/riftbound-data.mjs';

const CATALOG = {
  ogn: {
    name: 'Origins', code: 'OGN', total: 298,
    cards: [
      { k: '27', num: '027/298', name: 'Darius, Trifarian', rarity: 'Rare', type: 'Unit', domain: 'Fury', e: '3', p: '1', m: '4', img: 'https://riot/27.png' },
      { k: '27a', num: '027a/298', name: 'Darius, Trifarian (Alternate Art)', rarity: 'Showcase', type: 'Unit', domain: 'Fury', e: '3', p: '1', m: '4', img: 'https://riot/27a.png' },
      { k: '299', num: '299/298', name: 'Daughter of the Void (Overnumbered)', rarity: 'Showcase', type: 'Unit', domain: 'Chaos', e: '5', p: '1', m: '5', img: 'https://riot/299.png' },
      { k: '299*', num: '299*/298', name: 'Daughter of the Void (Signature)', rarity: 'Showcase', type: 'Unit', domain: 'Chaos', e: '5', p: '1', m: '5', img: 'https://riot/299s.png' },
      { k: '7a', num: '007a/298', name: 'Fury Rune (Alternate Art)', rarity: 'Showcase', type: 'Rune', domain: 'Fury', e: '', p: '', m: '', img: 'https://riot/7a.png' },
      { k: '42', num: '042/298', name: 'Calm Rune', rarity: 'Common', type: 'Rune', domain: 'Calm', e: '', p: '', m: '', img: 'https://riot/42.png' },
    ],
  },
  ven: {
    name: 'Vendetta', code: 'VEN', total: 166,
    cards: [
      { k: '167', num: '167/166', name: 'Vi, Destructive (Overnumbered)', rarity: 'Rare', type: 'Unit', domain: 'Fury', e: '2', p: '1', m: '3', img: 'https://riot/167.png' },
      { k: 'sp1', num: 'SP1/006', name: "Kai'Sa, Survivor", rarity: 'Showcase', type: 'Unit', domain: 'Mind', e: '4', p: '1', m: '3', img: 'https://riot/sp1.png' },
    ],
  },
  unl: {
    name: 'Unleashed', code: 'UNL', total: 219,
    cards: [
      { k: '238', num: '238/219', name: 'Baron Nashor (Ultimate)', rarity: 'Epic', type: 'Unit', domain: 'Chaos', e: '10', p: '3', m: '12', img: 'https://riot/238.png' },
    ],
  },
};

let FIXTURE;
before(() => {
  FIXTURE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rbdata-')), 'riftbound.json');
  fs.writeFileSync(FIXTURE, JSON.stringify(CATALOG));
});
after(() => { try { fs.rmSync(path.dirname(FIXTURE), { recursive: true, force: true }); } catch {} });

const resolve = (set, num) => resolveRiftboundCard(set, num, FIXTURE);

describe('resolveRiftboundCard — variant, rarity and finish', () => {
  it('a base print', () => {
    const c = resolve('ogn', '27');
    assert.equal(c.name, 'Darius, Trifarian');
    assert.equal(c.variant, '');
    assert.equal(c.rarity, 'Rare');
    assert.equal(c.finish, 'Non-foil');
    assert.equal(c.number, '027/298', 'printed number verbatim (GR5)');
    // championTag splits on " - ", but Riot's gallery writes "Darius, Trifarian" with a comma, so
    // the offline lane produces no tag. Pinned as-is: it is a known gap, not something this change
    // introduced, and "fixing" it here would silently rewrite tags on every existing riftbound row.
    assert.equal(c.tags, '');
  });
  it('alternate art: name stripped, variant set, Showcase foil', () => {
    const c = resolve('ogn', '27a');
    assert.equal(c.name, 'Darius, Trifarian', 'the parenthetical is a label, not part of the name');
    assert.equal(c.variant, 'Alternate Art');
    assert.equal(c.rarity, 'Showcase');
    assert.equal(c.finish, 'Foil');
  });
  it('Signature and Overnumbered resolve to DIFFERENT variants on the same number', () => {
    const sig = resolve('ogn', '299*'), over = resolve('ogn', '299');
    assert.equal(sig.variant, 'Signature');
    assert.equal(over.variant, 'Overnumbered');
    assert.equal(sig.name, over.name, 'same card, different treatment');
    for (const c of [sig, over]) { assert.equal(c.rarity, 'Showcase'); assert.equal(c.finish, 'Foil'); }
  });
  it('an Overnumbered card is foil even when the source called it a rare', () => {
    const c = resolve('ven', '167');
    assert.equal(c.variant, 'Overnumbered');
    assert.equal(c.rarity, 'Showcase');
    assert.equal(c.finish, 'Foil');
  });
  it('Ultimate is its own variant, not folded into Overnumbered', () => {
    // UNL-238 is over the set total, so without the override it would read Overnumbered — and the
    // listing would call the set's US$1,635 headline card the same thing as a US$160 poro.
    const c = resolve('unl', '238');
    assert.equal(c.name, 'Baron Nashor');
    assert.equal(c.variant, 'Ultimate');
    assert.equal(c.rarity, 'Showcase');
    assert.equal(c.finish, 'Foil');
  });
  it('an SP promo is a Showcase foil with NO variant — its number is the marker', () => {
    const c = resolve('ven', 'sp1');
    assert.equal(c.name, "Kai'Sa, Survivor");
    assert.equal(c.variant, '');
    assert.equal(c.rarity, 'Showcase');
    assert.equal(c.finish, 'Foil');
    assert.equal(c.number, 'SP1/006');
    assert.equal(c.image, 'https://static.dotgg.gg/riftbound/cards/VEN-SP1.webp', 'CDN key is uppercase');
  });
});

describe('resolveRiftboundCard — how it is addressed', () => {
  it('accepts the catalog key or the set code, in either case', () => {
    for (const s of ['ogn', 'OGN', 'Ogn']) assert.equal(resolve(s, '27').name, 'Darius, Trifarian', s);
  });
  it('accepts the number as typed, as printed, or zero-padded', () => {
    for (const n of ['27', '027', '027/298', '27A']) assert.ok(resolve('ogn', n), n);
  });
  it('one SP card answers to every way it can be typed', () => {
    for (const n of ['sp1', 'SP1', 'SP01', 'SP1/006']) {
      assert.equal(resolve('ven', n)?.name, "Kai'Sa, Survivor", n);
    }
  });
  it('returns null rather than guessing', () => {
    assert.equal(resolve('ogn', '9999'), null);
    assert.equal(resolve('nope', '27'), null);
    assert.equal(resolve('ogn', ''), null);
  });
});

describe('resolveRiftboundCard — rune reprints', () => {
  it('R01a resolves to the canonical Origins printing, keeping its PRINTED number', () => {
    const c = resolve('ogn', 'R01a');
    assert.equal(c.name, 'Fury Rune');
    assert.equal(c.number, '007a/298', 'Origins prints its runes with ordinary collector numbers');
  });
  it('a reprint set keeps R## as the printed number and takes the per-set art', () => {
    const c = resolve('ven', 'R01a');
    assert.equal(c.name, 'Fury Rune');
    assert.equal(c.number, 'R01a');
    assert.equal(c.image, 'https://static.dotgg.gg/riftbound/cards/VEN-R01a.webp');
  });
});

describe('the set list and the enumerator', () => {
  it('loadRiftboundSets carries id, code, name and the printed total', () => {
    const sets = loadRiftboundSets(FIXTURE);
    assert.deepEqual(sets.map((s) => s.code), ['OGN', 'VEN', 'UNL']);
    assert.equal(sets.find((s) => s.code === 'VEN').total, 166);
    assert.equal(sets.find((s) => s.code === 'UNL').total, 219);
  });
  it('iterateRiftboundSet yields every card, canonicalised', () => {
    const rows = [...iterateRiftboundSet('ven', FIXTURE)];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.canonical.variant), ['Overnumbered', '']);
    assert.deepEqual(rows.map((r) => r.canonical.finish), ['Foil', 'Foil']);
  });
});
