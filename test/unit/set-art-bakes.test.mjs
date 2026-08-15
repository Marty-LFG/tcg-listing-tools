// test/unit/set-art-bakes.test.mjs — the per-game set-art bakes and their readers.
//
// Pure parsing offline; the baked-index assertions skip (never silently pass) on a host that has
// not run the bakes. The three parsers here each guard a GR4/GR5 rule: a wrong wordmark, a wrong
// denominator or the wrong printing's art is worse than none.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logoMatchesSet } from '../../scripts/fandom-set-logos.mjs';
import { printedTotalOf } from '../../scripts/build-lorcana-set-art.mjs';
import { rosterFromCards } from '../../scripts/build-swu-set-art.mjs';
import { variantTagOf } from '../../scripts/build-onepiece-tcgimages.mjs';
import { findGameSetArt } from '../../lib/set-art-data.mjs';
import { cleanOnepieceArt, productImageUrl, canonPrintingTag } from '../../lib/onepiece-clean-art.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baked = (f) => fs.existsSync(path.join(ROOT, 'data', f));

describe('logoMatchesSet — the suffix-anchored guard on wiki logo files', () => {
  it('accepts an exact stem or a subtitle-wordmark suffix', () => {
    assert.ok(logoMatchesSet('The_First_Chapter_logo.jpg', 'The First Chapter'));
    assert.ok(logoMatchesSet('Neon_Dynasty_logo.png', 'Kamigawa: Neon Dynasty'));
  });
  it('refuses PREFIX matches — the sibling-set trap', () => {
    // A "Modern Horizons 3" page that mentions MH1's wordmark must not bake it onto MH3 —
    // the merges are accretive, so a wrong hit would be permanent. The cost: a legitimate
    // prefix wordmark ('Outlaws_logo' on Outlaws of Thunder Junction) now misses and the rail
    // wears the game logo — a wrong wordmark is worse than none (GR4).
    assert.ok(!logoMatchesSet('Modern_Horizons_logo.png', 'Modern Horizons 3'));
    assert.ok(!logoMatchesSet('Innistrad_logo.png', 'Innistrad: Midnight Hunt'));
    assert.ok(!logoMatchesSet('Outlaws_logo.jpg', 'Outlaws of Thunder Junction'));
  });
  it('refuses an unrelated logo mentioned on the page', () => {
    assert.ok(!logoMatchesSet('Rise_of_the_Floodborn_logo.png', 'The First Chapter'));
    assert.ok(!logoMatchesSet('Project_TCG_logo.png', 'Bloomburrow'));
  });
  it('an empty stem can never match', () => {
    assert.ok(!logoMatchesSet('logo.png', 'Bloomburrow'));
  });
});

describe('printedTotalOf — the Lorcana denominator', () => {
  const card = (n, rarity) => ({ collector_number: String(n), rarity });
  it('is the max collector number across BASE rarities only', () => {
    const cards = [card(1, 'Common'), card(204, 'Legendary'), card(150, 'Super_rare')];
    assert.equal(printedTotalOf(cards), 204);
  });
  it('chase rarities are numbered PAST the printed total and must not stretch it', () => {
    // TFC: Enchanted run 205–216, the cards still print /204.
    const cards = [card(204, 'Rare'), card(216, 'Enchanted'), card(242, 'Iconic'), card(222, 'Epic')];
    assert.equal(printedTotalOf(cards), 204);
  });
  it('no base cards, no denominator — never an invented one', () => {
    assert.equal(printedTotalOf([card(5, 'Promo')]), null);
    assert.equal(printedTotalOf([]), null);
  });
});

describe('rosterFromCards — the SWU roster off the official card payload', () => {
  const row = (code, name, cardCount) => ({ attributes: { cardCount, expansion: { data: { attributes: { code, name } } } } });
  it('one entry per expansion, the largest cardCount winning', () => {
    const roster = rosterFromCards([row('SOR', 'Spark of Rebellion', '252'), row('SOR', 'Spark of Rebellion', '18'), row('SHD', 'Shadows of the Galaxy', '262')]);
    assert.deepEqual(roster.find((s) => s.code === 'SOR').printedTotal, 252);
    assert.equal(roster.length, 2);
  });
  it('a card with no expansion is skipped, never a crash', () => {
    assert.deepEqual(rosterFromCards([{ attributes: {} }, null]), []);
  });
});

describe('variantTagOf — One Piece printing identity off the product name', () => {
  it('a bare name is the base printing', () => {
    assert.equal(variantTagOf('Shanks'), '');
  });
  it('pure-digit parentheticals are disambiguators, not variants', () => {
    // TCGplayer writes "Roronoa Zoro (001)" vs "(025)" when one name spans several cards.
    assert.equal(variantTagOf('Roronoa Zoro (001)'), '');
    assert.equal(variantTagOf('Roronoa Zoro (001) (Parallel)'), 'Parallel');
  });
  it('unknown decoration stays a tag — strictness beats mistaking it for the base printing', () => {
    assert.equal(variantTagOf('Mr. 3 (Galdino)'), 'Galdino');
    assert.equal(variantTagOf('Monkey.D.Luffy (Parallel Manga Alternate Art)'), 'Parallel Manga Alternate Art');
  });
});

describe('the baked indexes', () => {
  it('Lorcana: TFC carries the one wiki wordmark and its printed total',
    { skip: !baked('lorcana-set-art.json') && 'lorcana-set-art not baked on this host' }, () => {
      const tfc = findGameSetArt('lorcana', { name: 'The First Chapter' });
      assert.ok(tfc, 'TFC missing from the index');
      assert.match(tfc.logoUrl || '', /The_First_Chapter_logo/);
      assert.equal(tfc.printedTotal, 204);
      assert.deepEqual(findGameSetArt('lorcana', { code: '1' }), tfc, 'code and name must reach the same entry');
    });
  it('SWU: the printed totals are the card-face denominators, not the variant roster count',
    { skip: !baked('swu-set-art.json') && 'swu-set-art not baked on this host' }, () => {
      const sor = findGameSetArt('swu', { code: 'SOR' });
      assert.ok(sor, 'SOR missing from the index');
      assert.equal(sor.printedTotal, 252, 'swu-db’s 946-product roster count is the wrong number');
    });
  it('an unknown game or set resolves null, never a guess', () => {
    assert.equal(findGameSetArt('pokemon', { name: 'Base Set' }), null, 'Pokémon has its own pipeline — no index file exists for it');
    assert.equal(findGameSetArt('swu', { name: 'No Such Set' }), null);
  });
  it('a set name normalising onto Object.prototype resolves null, not the prototype', () => {
    // 'Constructor' -> normSetKey 'constructor' -> without Object.hasOwn the lookup returned
    // Object.prototype.constructor and the rail printed "Object" as the set name.
    for (const name of ['Constructor', 'To String', 'Has Own Property']) {
      assert.equal(findGameSetArt('swu', { name }), null, `${name} leaked the prototype chain`);
      assert.equal(findGameSetArt('lorcana', { code: name }), null);
    }
  });
});

describe('cleanOnepieceArt — variant-strict clean scans', () => {
  const skip = !baked('onepiece-tcg-images.json') && 'onepiece-tcg-images not baked on this host';
  it('serves the base printing for a plain row', { skip }, () => {
    assert.match(cleanOnepieceArt({ number: 'OP01-120', variant: '' }) || '', /tcgplayer-cdn\.tcgplayer\.com\/product\/\d+_in_1000x1000\.jpg/);
  });
  it('“Alternate Art” and Bandai’s “Parallel” are the same printing', { skip }, () => {
    const a = cleanOnepieceArt({ number: 'OP01-120', variant: 'Alternate Art' });
    const b = cleanOnepieceArt({ number: 'OP01-120', variant: 'Parallel' });
    assert.ok(a, 'the alt-art printing resolved nothing');
    assert.equal(a, b);
    assert.notEqual(a, cleanOnepieceArt({ number: 'OP01-120', variant: '' }), 'the alt art must not be the base scan');
  });
  it('an unmatched variant serves NOTHING — base art on an alt-art listing misrepresents it', { skip }, () => {
    assert.equal(cleanOnepieceArt({ number: 'OP01-120', variant: 'Wanted Poster Deluxe' }), null);
    assert.equal(cleanOnepieceArt({ number: 'OP99-999', variant: '' }), null);
  });
  it('the builder’s own vocabulary maps to the right printings', { skip }, () => {
    // 'Base Art' is the builder's default variant label — it IS the base printing, and before the
    // canon table it matched nothing (the swap silently dead for every builder-written base row).
    assert.equal(cleanOnepieceArt({ number: 'OP01-120', variant: 'Base Art' }),
      cleanOnepieceArt({ number: 'OP01-120', variant: '' }));
    // An alt-art flag carried in the NAME (variant field empty — a shape the aspects code proves
    // exists) must reach the ALT printing, never fail open to the base scan (GR5).
    const viaName = cleanOnepieceArt({ number: 'OP01-120', variant: '', name: 'Shanks (Alternate Art)' });
    assert.equal(viaName, cleanOnepieceArt({ number: 'OP01-120', variant: 'Parallel' }));
    assert.notEqual(viaName, cleanOnepieceArt({ number: 'OP01-120', variant: '' }));
  });
  it('non-English rows never get the EN TCGplayer scan', { skip }, () => {
    assert.equal(cleanOnepieceArt({ number: 'OP01-120', variant: '', language: 'JP' }), null);
  });
  it('digit disambiguators and printed aliases in the name are not variants', { skip }, () => {
    // optcgapi writes "Roronoa Zoro (001)" / "Mr.3(Galdino) (056)": the digits are its own
    // bookkeeping, and the alias is the PRINTED card name (TCGplayer's base product is plain
    // "Mr. 3", tag ''). Both must resolve the BASE printing — they previously failed closed and
    // kept the SAMPLE watermark on exactly these cards. A variant WORD in the name still counts.
    const zoro = cleanOnepieceArt({ number: 'OP01-001', variant: '', name: 'Roronoa Zoro (001)' });
    assert.ok(zoro, 'the digit tail must not block the base match');
    assert.equal(zoro, cleanOnepieceArt({ number: 'OP01-001', variant: '' }));
    assert.match(cleanOnepieceArt({ number: 'OP01-056', variant: '', name: 'Mr.3(Galdino) (056)' }) || '', /tcgplayer-cdn/,
      'a printed alias must fall through to the base printing');
    assert.equal(cleanOnepieceArt({ number: 'OP01-120', variant: '', name: 'Shanks (Alternate Art)' }),
      cleanOnepieceArt({ number: 'OP01-120', variant: 'Parallel' }), 'a variant WORD in the name still reaches the alt printing');
  });
  it('canonPrintingTag is the ONE vocabulary both writer and reader share', () => {
    assert.equal(canonPrintingTag('Alternate Art'), 'parallel');
    assert.equal(canonPrintingTag('Base Art'), '');
    assert.equal(canonPrintingTag('Parallel Manga Alternate Art'), 'parallelmangaalternateart', 'multi-word tags stay distinct');
  });
  it('productImageUrl is the pinned CDN shape', () => {
    assert.equal(productImageUrl(454664), 'https://tcgplayer-cdn.tcgplayer.com/product/454664_in_1000x1000.jpg');
  });
});
