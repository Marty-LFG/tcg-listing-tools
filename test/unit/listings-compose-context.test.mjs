// test/unit/listings-compose-context.test.mjs — the compositor's decision layer in lib/listings.mjs.
//
// Three things decide whether a listing gets branded rails: the master switch in
// data/listing-image.config.json, the per-path applyTo flags, and the per-listing toggle on the
// uploader. This pins the precedence and pins what goes ON the rail — the meta shape is what makes
// two conditions of one card share a single eBay upload instead of doubling the store's.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { composeMetaFor, composeContext, storePhotoOriginal, printedCardNumber, isBlackStarPromoSet } from '../../lib/listings.mjs';
import { ROOT } from '../helpers/extract-inline.mjs';
import { isRailDrawable, PROMO_STAR_URL } from '../../lib/listing-image-config.mjs';

// composeContext reads the real config file, so these assertions pin the SHIPPED state: disabled.
const shipped = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'listing-image.config.json'), 'utf8')); }
  catch { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'listing-image.config.example.json'), 'utf8')); }
})();

describe('composeMetaFor', () => {
  it('maps the stored 2-letter language code to a readable name', () => {
    // The rail is buyer-facing: 'JP · MEGA SYMPHONIA' reads like a typo.
    assert.equal(composeMetaFor({ language: 'JP' }).language, 'Japanese');
    assert.equal(composeMetaFor({ language: 'EN' }).language, 'English');
  });
  it('derives productType from the stock row', () => {
    assert.equal(composeMetaFor({}).productType, 'single');
    assert.equal(composeMetaFor({ grading_company: 'PSA', grade: '10' }).productType, 'slab');
    assert.equal(composeMetaFor({ product_type: 'sealed' }).productType, 'sealed');
  });
  it('a graded row is a slab even with no company recorded', () => {
    assert.equal(composeMetaFor({ grade: '9' }).productType, 'slab');
  });
  it('carries the card name — line 1 of every rail', () => {
    assert.equal(composeMetaFor({ name: 'Parasect' }).cardName, 'Parasect');
    assert.equal(composeMetaFor({ name: 'Iron Defender', set_code: 'M5', language: 'JP' }).cardName, 'Iron Defender');
    assert.equal(composeMetaFor({}).cardName, '', 'never undefined — it would hash as "undefined"');
  });
  it('carries set name, number and rarity', () => {
    const m = composeMetaFor({ set_name: 'Base Set', number: '58/102', rarity: 'Rare Holo' });
    assert.equal(m.setName, 'Base Set');
    assert.equal(m.cardNumber, '58/102');
    assert.equal(m.rarity, 'Rare Holo');
  });
  it('resolves the set symbol when the set is one we have cached', () => {
    // Cold cache in CI is fine — the assertion is "a URL or nothing", never a crash.
    const m = composeMetaFor({ set_name: 'Pitch Black', set_code: 'PBL', number: '006/084' });
    assert.equal(typeof m.setSymbolUrl, 'string');
    if (m.setSymbolUrl) assert.match(m.setSymbolUrl, /^https?:\/\//);
  });
  it('an unknown set yields no symbol rather than throwing', () => {
    const m = composeMetaFor({ set_name: 'No Such Set At All', number: '1/1' });
    assert.equal(m.setSymbolUrl, '');
  });

  const symbolsBaked = fs.existsSync(path.join(ROOT, 'data', 'pokemon-set-symbols.json'));

  describe('Black Star Promo sets: boxed mark right, PROMO star left', () => {
    // The owner-approved promo design: every promo listing wears the (unbranded) PROMO star in the
    // logo slot — no promo era has a wordmark — and the badge slot carries the SET's own boxed mark
    // where one exists. pokemontcg.io must never supply the badge here: its "symbol" for a promo
    // set is the generic star, which would put the same mark on both rails.
    it('detects every promo era by name, plus the baked MEP set by its TCGplayer identity', () => {
      for (const name of ['Wizards Black Star Promos', 'SM Black Star Promos', 'SWSH Black Star Promos',
        'Scarlet & Violet Black Star Promos', 'SVP Black Star Promos', 'MEP Black Star Promos', 'Mega Evolution Promo']) {
        assert.ok(isBlackStarPromoSet(name, ''), `${name} not detected`);
      }
      assert.ok(isBlackStarPromoSet('', 'mep'), 'the baked roster code alone must be enough');
      assert.ok(!isBlackStarPromoSet('Base Set', 'BS'));
      assert.ok(!isBlackStarPromoSet('Mega Evolution', 'me1'), 'the MAIN Mega Evolution set is not a promo set');
    });
    it('every promo era wears the star in the logo slot', () => {
      for (const set_name of ['Wizards Black Star Promos', 'SWSH Black Star Promos', 'Scarlet & Violet Black Star Promos', 'Mega Evolution Promo']) {
        assert.equal(composeMetaFor({ game: 'pokemon', set_name, number: '1' }).setLogoUrl, PROMO_STAR_URL, set_name);
      }
    });
    it('an older promo era gets NO badge symbol — the number stands alone', () => {
      // SWSH has no boxed mark anywhere (the star IS its printed symbol, and the star is already on
      // the left) — falling through to pokemontcg.io here would put the star on both rails.
      const m = composeMetaFor({ game: 'pokemon', name: 'Pikachu', set_name: 'SWSH Black Star Promos', set_code: 'swshp', number: 'SWSH039', language: 'EN' });
      assert.equal(m.setSymbolUrl, '');
      assert.doesNotMatch(m.setLogoUrl + m.setSymbolUrl, /pokemontcg\.io\/swshp/, 'never that set’s own star art');
    });
    it('the baked Mega Evolution Promo set gets its boxed MEP badge',
      { skip: !symbolsBaked && 'data/pokemon-set-symbols.json not built on this host' }, () => {
        // MEP is absent from pokemontcg.io — the alias into the Bulbapedia bake ("MEP Black Star
        // Promos") is the only source. A skip, not an if: never green by resolving nothing.
        const m = composeMetaFor({ game: 'pokemon', name: 'Meganium', set_name: 'Mega Evolution Promo', set_code: 'mep', number: '001', language: 'EN' });
        assert.match(m.setSymbolUrl, /SetSymbolMEP_Black_Star_Promos/);
        assert.equal(m.setLogoUrl, PROMO_STAR_URL);
        assert.equal(m.cardNumber, '001', 'promos print bare — the alias must not invent a denominator');
      });
    it('SVP resolves its boxed mark under pokemontcg.io’s long set name',
      { skip: !symbolsBaked && 'data/pokemon-set-symbols.json not built on this host' }, () => {
        const m = composeMetaFor({ game: 'pokemon', name: 'Pikachu with Grey Felt Hat', set_name: 'Scarlet & Violet Black Star Promos', set_code: 'SVP', number: '085', language: 'EN' });
        assert.match(m.setSymbolUrl, /SetSymbolSVP_Black_Star_Promos/, 'the boxed SVP mark, not the generic star');
        assert.equal(m.setLogoUrl, PROMO_STAR_URL);
      });
  });

  describe('non-English cards resolve against the JP index, not the English one', () => {
    // A JP card is a different product, not a translation: its own set name, its own card count and
    // therefore its own printed number. The English set's identity on a JP rail is simply wrong.
    it('uses the romanised JP set name for a JP row saved under its English set', () => {
      const m = composeMetaFor({ set_name: 'Pitch Black', set_code: 'M5', number: '102', language: 'JP' });
      assert.equal(m.language, 'Japanese');
      assert.equal(m.setName, 'Abyss Eye', 'a JP card is not in "Pitch Black"');
    });
    it('numbers it out of the JAPANESE card count', () => {
      // JP Abyss Eye holds 81 cards, so a secret rare prints 102/081 — a number that does not exist
      // in the 84-card English set.
      const m = composeMetaFor({ set_name: 'Pitch Black', set_code: 'M5', number: '102', language: 'JP' });
      assert.equal(m.cardNumber, '102/081');
    });
    it('resolves by the native name and by the English equivalent too', () => {
      for (const name of ['Abyss Eye', 'アビスアイ', 'Pitch Black']) {
        assert.equal(composeMetaFor({ set_name: name, number: '1', language: 'JP' }).setName, 'Abyss Eye', `failed for ${name}`);
      }
    });
    it('English rows are untouched by any of this', () => {
      const m = composeMetaFor({ set_name: 'Pitch Black', set_code: 'PBL', number: '006/084', language: 'EN' });
      assert.equal(m.setName, 'Pitch Black');
      assert.equal(m.cardNumber, '006/084');
    });
    it('an unknown JP set falls back to the row rather than throwing', () => {
      const m = composeMetaFor({ set_name: 'Not A Real JP Set', number: '5', language: 'JP' });
      assert.equal(m.setName, 'Not A Real JP Set');
    });
    it('NEVER falls back to the native name — the rail font cannot draw it', () => {
      // 146 of 277 JP sets have no romanised name in the bake. Using name_native there would put
      // Japanese script on a Latin-only rail, which renders via a system font on Windows and as
      // blank boxes on a server without one.
      const m = composeMetaFor({ set_name: 'Start Deck 100', set_code: 'MC', number: '5', language: 'JP' });
      assert.ok(isRailDrawable(m.setName), `setName "${m.setName}" is not drawable by the rail font`);
    });
    it('a nameSuspect row never puts the upstream name on the rail', () => {
      // TCGdex returns ONE set's identity for a whole block of distinct codes — all fifteen JP CS*
      // ids come back as トリプレットビート. The bake marks them; the owner's own value wins.
      const m = composeMetaFor({ set_name: 'Triplet Beat', set_code: 'CS1A', number: '5', language: 'JP' });
      assert.equal(m.setName, 'Triplet Beat', 'the owner’s stored name must win over a suspect upstream one');
    });
    it('resolves the JP set logo by code as well as by name', () => {
      // Bulbapedia files them as SV3a_Raging_Surf_Logo.png — findable from either identity.
      const byCode = composeMetaFor({ set_name: 'Raging Surf', set_code: 'SV3a', number: '50', language: 'JP' });
      if (byCode.setLogoUrl) assert.match(byCode.setLogoUrl, /Raging_Surf_Logo/);
    });
  });

  describe('every JP set in the bake produces rail-drawable output', () => {
    it('no set name reaching the rail needs a font we do not ship', () => {
      const bad = [];
      for (const code of ['M5', 'SV3a', 'S12a', 'MC', 'M-P', 'SVLN', 'CS1.5']) {
        const m = composeMetaFor({ set_name: '', set_code: code, number: '1', language: 'JP' });
        if (m.setName && !isRailDrawable(m.setName)) bad.push(code + '=' + m.setName);
      }
      assert.deepEqual(bad, [], 'these would render as blank boxes on a host without a CJK font');
    });
  });
  it('does NOT carry condition — that is the whole NM/LP dedupe argument', () => {
    const nm = composeMetaFor({ set_name: 'Base Set', condition: 'Near Mint' });
    const lp = composeMetaFor({ set_name: 'Base Set', condition: 'Lightly Played' });
    assert.equal(nm.condition, undefined);
    assert.deepEqual(nm, lp);
  });
  it('never returns undefined fields that would leak into a hash as "undefined"', () => {
    const m = composeMetaFor({});
    for (const [k, v] of Object.entries(m)) assert.equal(typeof v, 'string', `${k} is ${typeof v}`);
  });

  describe('set identity is POKÉMON-only — no other game borrows its art', () => {
    // findSet/findSetSymbol/findSetLogo match on a bare set code or name and are NOT game-scoped,
    // so codes collide across games. MTG's 'LTR' (Tales of Middle-earth) is Pokémon's Legendary
    // Treasures (bw11, printedTotal 113): un-guarded, a Magic card came back with a Pokémon symbol,
    // a Pokémon logo and a fabricated '246/113' — a set it is not from and a number not on it.
    it('an MTG row whose set code collides with a Pokémon set never borrows the Pokémon art', () => {
      const m = composeMetaFor({ game: 'mtg', name: 'The One Ring', set_name: 'The Lord of the Rings: Tales of Middle-earth', set_code: 'LTR', number: '246' });
      assert.doesNotMatch(m.setSymbolUrl, /pokemontcg\.io/, 'LTR is Pokémon bw11 as well as Magic LTR');
      assert.doesNotMatch(m.setLogoUrl || '', /pokemontcg\.io/);
      assert.equal(m.setLogoUrl, '', 'Magic has no set wordmark');
      assert.equal(m.cardNumber, '246', 'never a Pokémon denominator');
      // Whatever symbol it does get must be Magic's own (Phase E), or none at all on a cold cache.
      if (m.setSymbolUrl) assert.match(m.setSymbolUrl, /svgs\.scryfall\.io/);
    });
    it('the SAME code still resolves for an actual Pokémon row — the guard is on game, not on LTR', () => {
      const m = composeMetaFor({ game: 'pokemon', set_name: 'Legendary Treasures', set_code: 'LTR', number: '1' });
      assert.equal(m.setSymbolUrl, 'https://images.pokemontcg.io/bw11/symbol.png');
    });
    it('Magic has no set wordmark, and Scryfall exposes no printed total', () => {
      const m = composeMetaFor({ game: 'mtg', set_name: 'The Hobbit', set_code: 'HOB', number: '1' });
      assert.equal(m.setLogoUrl, '');
      assert.equal(m.cardNumber, '1', "GR10 pads Pokémon '1' to '001'; Magic prints '1'");
    });
    it('a game-less fixture is still treated as Pokémon (game is NOT NULL on real rows)', () => {
      assert.equal(composeMetaFor({ set_name: 'Legendary Treasures', number: '1' }).setSymbolUrl,
        composeMetaFor({ game: 'pokemon', set_name: 'Legendary Treasures', number: '1' }).setSymbolUrl);
    });

    // Lorcana is the worst case for this guard, because its set codes are BARE NUMBERS and single
    // letters+digits ('1'…'13', 'P1', 'P2', 'D23') — the most collidable identifiers any game in
    // the repo uses. Un-guarded, a Disney card could take a Pokémon symbol, a Pokémon wordmark and
    // a fabricated 'n/total' (GR4 + GR10).
    it('a Lorcana row never borrows Pokémon set art, whatever its code collides with', () => {
      for (const set_code of ['1', '2', '13', 'P1', 'P2', 'D23', 'DIS', 'C2', 'cp', 'PD1']) {
        const m = composeMetaFor({ game: 'lorcana', name: 'Ariel - Ethereal Voice', set_name: 'Whispers in the Well', set_code, number: '241' });
        assert.doesNotMatch(m.setSymbolUrl || '', /pokemontcg\.io|bulbagarden/, `set_code ${set_code} borrowed Pokémon art`);
        assert.doesNotMatch(m.setLogoUrl || '', /pokemontcg\.io|bulbagarden/, `set_code ${set_code} borrowed a Pokémon logo`);
        assert.equal(m.cardNumber, '241', `set_code ${set_code} invented a denominator`);
      }
    });
    it('Lorcana gets NO set art at all — Lorcast publishes neither a symbol nor a wordmark', () => {
      // Deliberate, and the reason the branch exists at all rather than resolving art: constructing
      // a symbol URL from the set code is the images.scrydex.com placeholder trap (AGENTS.md 19).
      // The masthead falls back to the set name, exactly as it does for Magic's missing wordmark.
      const m = composeMetaFor({ game: 'lorcana', set_name: 'Whispers in the Well', set_code: '10', number: '241' });
      assert.equal(m.setSymbolUrl, '');
      assert.equal(m.setLogoUrl, '');
      assert.equal(m.setName, 'Whispers in the Well', 'the owner’s own name still reaches the rail');
    });
    it('a promo-shaped Lorcana set is not mistaken for a Pokémon Black Star promo', () => {
      // isBlackStarPromoSet matches on the NAME, and 'Promo Set 1' is close enough to be worth
      // pinning — a Lorcana promo must not pick up the Pokémon black star in the wordmark slot.
      const m = composeMetaFor({ game: 'lorcana', name: 'Mickey Mouse - Brave Little Tailor', set_name: 'Promo Set 1', set_code: 'P1', number: '1' });
      assert.equal(m.setLogoUrl, '', 'the black star belongs to Pokémon promos only');
      assert.equal(m.setSymbolUrl, '');
      assert.equal(m.cardNumber, '1');
    });
    it('every Lorcana meta value is still a string — the rail renderer takes no nulls', () => {
      const m = composeMetaFor({ game: 'lorcana', set_name: 'Whispers in the Well', set_code: '10', number: '241' });
      for (const [k, v] of Object.entries(m)) assert.equal(typeof v, 'string', `${k} is ${typeof v}`);
    });
  });
});

describe('printedCardNumber (Golden Rule 10 on the rail)', () => {
  it('passes an ALREADY-PRINTED number through untouched', () => {
    // The trap: formatCardNumber takes the RAW upstream number. "069/086" matches neither numeric
    // branch, so it falls to the trailing `raw + '/' + denom` and comes back "069/086/086".
    assert.equal(printedCardNumber({ number: '069/086', set_name: 'Pitch Black', printed_total: 86 }), '069/086');
    assert.equal(printedCardNumber({ number: '106/086', printed_total: 86 }), '106/086');
    assert.equal(printedCardNumber({ number: 'TG01/TG30', printed_total: 30 }), 'TG01/TG30');
  });
  it('rebuilds a bare number from the set era — modern pads to three digits', () => {
    assert.equal(printedCardNumber({ number: '6', set_name: 'Pitch Black', printed_total: 84, set_series: 'Mega Evolution', set_release_date: '2026/07/17' }), '006/084');
  });
  it('pre-Sword & Shield keeps its natural width', () => {
    assert.equal(printedCardNumber({ number: '58', set_name: 'Base Set', printed_total: 102, set_release_date: '1999/01/09' }), '58/102');
  });
  it('a promo prints bare, with no invented denominator', () => {
    assert.equal(printedCardNumber({ number: 'SWSH039', set_name: 'SWSH Black Star Promos', printed_total: 307 }), 'SWSH039');
  });
  it('an empty number stays empty rather than becoming a lone slash', () => {
    assert.equal(printedCardNumber({}), '');
    assert.equal(printedCardNumber({ number: '   ' }), '');
  });
  it('never throws on a malformed row — the rail badge is not worth a failed listing', () => {
    assert.doesNotThrow(() => printedCardNumber({ number: '4', printed_total: 'wat', set_release_date: 'nonsense' }));
  });
  it('is a POKÉMON rule — other games keep the number verbatim', () => {
    // GR10 rebuilds the padding pokemontcg.io strips, from that set's era and printed total. No
    // other game supplies those: Scryfall's set.card_count counts PRINTINGS (HOB is 321, with alt
    // treatments numbered past 250), so there is no denominator and inventing one is GR4.
    assert.equal(printedCardNumber({ game: 'mtg', number: '1', set_name: 'The Hobbit' }), '1');
    assert.equal(printedCardNumber({ game: 'lorcana', number: '12', set_name: 'The First Chapter' }), '12');
    assert.equal(printedCardNumber({ game: 'pokemon', number: '58', set_name: 'Base Set', printed_total: 102, set_release_date: '1999/01/09' }), '58/102');
  });
});

describe('composeContext', () => {
  const item = { language: 'JP', set_name: 'Mega Symphonia' };

  it('ships OFF — nothing gets branded until the owner turns it on', () => {
    assert.equal(shipped.enabled, false, 'the shipped config must have enabled:false');
    const c = composeContext(item, null);
    assert.equal(c.enabled, false);
    assert.match(c.reason, /disabled in settings/);
  });

  it('an explicit false beats the config, and says why', () => {
    const c = composeContext(item, false);
    assert.equal(c.enabled, false);
    assert.match(c.reason, /turned off for this listing/);
  });

  it('an explicit true beats a disabled config', () => {
    const c = composeContext(item, true);
    assert.equal(c.enabled, true);
    assert.equal(c.meta.language, 'Japanese');
    assert.equal(c.meta.setName, 'Mega Symphonia');
    assert.ok(c.options.cfg, 'the resolved config must ride along so the compositor does not re-read it');
  });

  it('null defers to the config rather than defaulting to on', () => {
    assert.equal(composeContext(item, undefined).enabled, shipped.enabled);
    assert.equal(composeContext(item, null).enabled, shipped.enabled);
  });

  it('respects the per-path applyTo flags even when forced on', () => {
    // Rolling out ownerPhotos first, before catalogArt, is the documented sequence — so an explicit
    // per-listing "yes" must still not brand a path the owner has switched off.
    const both = composeContext(item, true, { path: 'catalogArt' });
    assert.equal(both.enabled, shipped.applyTo.catalogArt);
    if (!shipped.applyTo.catalogArt) assert.match(both.reason, /applyTo\.catalogArt is off/);
  });

  it('defaults to the catalogArt path when none is named', () => {
    assert.deepEqual(composeContext(item, true), composeContext(item, true, { path: 'catalogArt' }));
  });
});

describe('storePhotoOriginal', () => {
  it('content-addresses, so re-uploading the same photo costs nothing', () => {
    const buf = Buffer.from('pretend jpeg bytes ' + process.pid);
    const a = storePhotoOriginal(buf, 'jpg');
    const b = storePhotoOriginal(buf, 'jpg');
    try {
      assert.equal(a, b, 'the same bytes must land on the same path');
      assert.ok(fs.existsSync(a));
      assert.equal(fs.readFileSync(a).toString(), buf.toString());
      assert.match(path.basename(a), /^[0-9a-f]{64}\.jpg$/);
    } finally { try { fs.rmSync(a, { force: true }); } catch {} }
  });
  it('different bytes get different paths', () => {
    const a = storePhotoOriginal(Buffer.from('one ' + process.pid), 'jpg');
    const b = storePhotoOriginal(Buffer.from('two ' + process.pid), 'jpg');
    try { assert.notEqual(a, b); } finally { for (const f of [a, b]) { try { fs.rmSync(f, { force: true }); } catch {} } }
  });
});
