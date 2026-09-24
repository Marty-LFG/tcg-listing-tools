// test/data/riftbound-character.test.mjs — the Character aspect, checked against the real bake.
//
// riftboundCharacter reads the champion out of a card NAME in the form "<Champion>, <Epithet>"
// ("Darius, Trifarian"). Where that name comes from has moved, and this file is how that was caught:
// Riot used to ship it whole, and around 2026-09-24 split it into `name` "Darius" + `subtitle`
// "Trifarian". The next bake held 3 comma names instead of 297, the Character aspect and the
// "Darius (Trifarian)" display names emptied out on every champion Unit, and the first assertion
// below is what went red. The source of truth is now Riot's two fields plus the Champion super-type,
// rejoined in scripts/build-riftbound-data.mjs printedName() — so if this fails again, look there and
// at the gallery payload's `subtitle`, not at the consumers.
//
// A unit test on a fixture can only confirm the rule we believe; this confirms it against the ~1170
// names Riot actually publishes, and against TCGplayer's own product names as a second source.
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
import { championTag, riftboundDisplayName } from '../../lib/riftbound-data.mjs';

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
        'only ' + commaNames.length + ' comma-form names left in the bake — Riot has changed how '
        + 'champion cards are named again (last time: `name` + a new `subtitle` field, 2026-09-24). '
        + 'Fix printedName() in scripts/build-riftbound-data.mjs, or the Character aspect stays empty');
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

    // The bake carries the champion TWICE — in the rejoined name, and as `ch` (from the same name for
    // a Unit, from the tag line for a Legend). The two derivations must agree, or the Character
    // aspect and the storefront's display name would name different champions for one card.
    const championUnits = cards.filter((c) => /^unit$/i.test(c.type || '') && c.ch);
    it('every champion Unit carries its champion, and the Character aspect agrees with it', () => {
      assert.ok(championUnits.length >= 250, 'only ' + championUnits.length + ' Units carry a champion (`ch`)');
      const disagree = championUnits.filter((c) => riftboundCharacter(c.name, c.type) !== c.ch);
      assert.deepEqual(disagree.map((c) => c.name + ' / ch=' + c.ch), []);
    });

    it('every champion Unit gets its "<Champion> (<Epithet>)" display name', () => {
      // riftboundDisplayName leaves a name alone when it does not start with "<ch>, " — which is
      // exactly what every champion Unit silently fell back to when the epithet left the name.
      const bare = championUnits.filter((c) => {
        const base = c.name.replace(/\s*\((Alternate Art|Overnumbered|Signature|Ultimate)\)\s*$/, '');
        return riftboundDisplayName({ name: base, type: c.type, champion: c.ch }) === base;
      });
      assert.deepEqual(bare.map((c) => c.name), []);
    });

    // A second, independent source: the keyless TCGplayer index (data/riftbound-prices.json, same
    // gitignored/server-owned rules) names every product the way the market searches it. A champion
    // Unit whose rejoined name disagrees with TCGplayer's means the join is wrong, not the market.
    // Counted 2026-09-24: 294 of 294 identical. The floor leaves room for a new set's odd product.
    const prices = readJson('data/riftbound-prices.json');
    it('champion Unit names match TCGplayer\'s product names',
      { skip: prices && prices.cards ? false : 'no data/riftbound-prices.json to compare against' }, () => {
        const strip = (s) => String(s || '').replace(/\s*\((Alternate Art|Overnumbered|Signature|Ultimate)\)\s*$/i, '').trim().toLowerCase();
        let compared = 0;
        const wrong = [];
        for (const [key, set] of Object.entries(catalog)) {
          for (const c of (set.cards || [])) {
            if (!/^unit$/i.test(c.type || '') || !c.ch) continue;
            const tp = prices.cards[String(set.code || key).toUpperCase() + '-' + c.k];
            if (!tp || !tp.name) continue;
            compared++;
            if (strip(tp.name) !== strip(c.name)) wrong.push(set.code + '-' + c.k + ': ' + c.name + ' | TCGplayer: ' + tp.name);
          }
        }
        assert.ok(compared >= 200, 'only ' + compared + ' champion Units found in the price index');
        assert.ok(wrong.length <= compared * 0.05, wrong.length + ' of ' + compared + ' disagree:\n' + wrong.slice(0, 15).join('\n'));
      });
  });
