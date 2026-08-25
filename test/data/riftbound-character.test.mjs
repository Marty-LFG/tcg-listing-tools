// test/data/riftbound-character.test.mjs — the Character aspect, checked against the real bake.
//
// riftboundCharacter reads the champion out of a card NAME: Riot writes "<Champion>, <Epithet>"
// ("Darius, Trifarian"). That is a derivation from a naming convention, not from a field, so a unit
// test on a fixture can only confirm the rule we believe. This file confirms the rule against the
// ~1170 names Riot actually publishes — and, more usefully, it FAILS LOUDLY if Riot ever changes the
// convention, instead of the Character aspect quietly emptying out on every listing.
//
// It also pins the two things that make this derivation safe rather than a guess:
//   · the TYPE GATE — the one comma-name that is not a Unit has a PLACE before the comma, not a
//     champion ("Heisho, Shell of the World", a Battlefield), so an ungated split would put a
//     location in the Character aspect;
//   · the SEPARATOR — championTag (lib/riftbound-data.mjs) splits on " - ", which is riftscribe's
//     and TCGplayer's shape and hits almost nothing in this bake. That is why a second derivation
//     exists rather than a change to the mirrored one.
//
// data/riftbound.json is gitignored and server-owned, so the suite SKIPS when it is absent rather
// than failing a fresh checkout.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';
import { riftboundCharacter } from '../../lib/listing-copy.mjs';
import { championTag } from '../../lib/riftbound-data.mjs';

const readJson = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; } };
const catalog = readJson('data/riftbound.json');
const have = !!(catalog && Object.keys(catalog).length);

const cards = [];
if (have) for (const set of Object.values(catalog)) for (const c of (set.cards || [])) cards.push(c);

describe('the Riftbound Character derivation vs the real bake',
  { skip: have ? false : 'bake data/riftbound.json first (node scripts/build-riftbound-data.mjs)' }, () => {
    const commaNames = cards.filter((c) => String(c.name || '').includes(', '));
    const units = commaNames.filter((c) => /^unit$/i.test(c.type || ''));

    it('the comma convention is alive, and it is overwhelmingly a Unit convention', () => {
      // Counted 2026-08-25: 297 comma names, 296 of them Units. The floor is deliberately well
      // below that — this guards against the convention DISAPPEARING, not against it drifting a
      // few cards either way.
      assert.ok(commaNames.length >= 250,
        'only ' + commaNames.length + ' comma-form names left in the bake — Riot may have changed '
        + 'how champion cards are named, which would silently empty the Character aspect');
      const ratio = units.length / commaNames.length;
      assert.ok(ratio > 0.95, 'comma names are ' + Math.round(ratio * 100) + '% Units, expected >95%');
    });

    it('every Unit with a comma name yields a champion', () => {
      const misses = units.filter((c) => !riftboundCharacter(c.name, c.type));
      assert.deepEqual(misses.map((c) => c.name), []);
    });

    it('and NO non-Unit ever does, however comma-shaped its name', () => {
      // This is the whole reason for the type gate. "Heisho, Shell of the World" is a Battlefield
      // and the words before its comma name a place.
      const leaked = cards
        .filter((c) => !/^unit$/i.test(c.type || ''))
        .filter((c) => riftboundCharacter(c.name, c.type));
      assert.deepEqual(leaked.map((c) => c.name + ' [' + c.type + ']'), []);
    });

    it('yields a plausible champion name, not a sentence fragment', () => {
      const out = [...new Set(units.map((c) => riftboundCharacter(c.name, c.type)))];
      assert.ok(out.length >= 50, 'only ' + out.length + ' distinct champions resolved');
      for (const name of out) {
        assert.ok(name.length <= 24, 'suspiciously long champion name: ' + JSON.stringify(name));
        assert.ok(!name.includes(','), 'a second comma survived: ' + JSON.stringify(name));
        assert.ok(name.trim() === name, 'untrimmed: ' + JSON.stringify(name));
      }
    });

    // championTag is under the GR9 mirror with riftbound-listing-builder.html and must not be
    // changed to fix this. Proving it is the WRONG instrument here is what justifies the second
    // export — otherwise the obvious "tidy" is to make the two one function.
    it('championTag is a different separator, and would find almost nothing here', () => {
      const viaDash = cards.filter((c) => championTag(c.name));
      assert.ok(viaDash.length < 20,
        'championTag suddenly matches ' + viaDash.length + ' cards — if Riot has moved to the " - " '
        + 'form, riftboundCharacter should be revisited rather than left as the second derivation');
      assert.ok(units.length > viaDash.length * 10, 'the comma form is the one that carries the data');
    });
  });
