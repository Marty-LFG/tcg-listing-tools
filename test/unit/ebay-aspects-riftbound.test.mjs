// test/unit/ebay-aspects-riftbound.test.mjs — the Riftbound side of the eBay AU 183454 derivations.
//
// Same two jobs as the Magic and Lorcana suites: derive Riftbound's own aspects, and make sure the
// POKÉMON ones stop leaking onto a game with no species, no stage and no HP.
//
// Every enum referenced here was read off the LIVE Taxonomy on 2026-08-25
// (scripts/check-ebay-aspects.mjs --game "Riftbound"). MOST OF WHAT THIS FILE PINS IS AN ABSENCE,
// and that is deliberate: eBay silently DROPS a FREE_TEXT value that misses its enum, so a
// near-miss never fails a publish — it just quietly earns no facet. Every "goes verbatim" assertion
// below is therefore a decision someone could later "fix" by reaching for another game's word, and
// each one says why that would be wrong (GR4).
//
// The absences, as measured: Epic and Showcase have no Rarity member; Unit / Gear / Legend /
// Battlefield / Rune have no Card Type member (only Spell does); none of the six domains is an
// Attribute/Colour member; 'Riot Games' is not a Manufacturer member; Overnumbered, Signature and
// Ultimate have no Features member; and Riot's set roster carries no release date at all, so
// Year Manufactured has no input.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  toEbayListing, validateListing, loadEbayCategories,
  riftboundCardTypeAspect, riftboundDomainAspect, riftboundFeatures,
  ebayManufacturer, ebayFinish,
} from '../../lib/channels/ebay-map.mjs';
import { riftboundCharacter } from '../../lib/listing-copy.mjs';

const cats = loadEbayCategories();

// A FIXTURE catalog, not the real one: data/riftbound.json is gitignored, so a suite that leaned on
// it would pass here and fail on a fresh clone (the same rule test/unit/riftbound-data.test.mjs
// states). buildRowIn calls resolveRiftboundCard with no path argument, so the only way to point it
// somewhere is RIFTBOUND_DATA_PATH — which lib/riftbound-data.mjs reads per call for exactly this.
//
// The names carry their '(Alternate Art)' / '(Signature)' suffixes because that is how the bake
// writes them and how cardToCanonical derives the treatment back out.
const CATALOG = {
  ogn: {
    name: 'Origins', code: 'OGN', total: 298,
    cards: [
      { k: '1', num: '001/298', name: 'Blazing Scorcher', rarity: 'Common', type: 'Unit', domain: 'Fury', e: '5', p: '', m: '5', img: 'https://riot/1.png', a: 'League Splash Team' },
      { k: '27a', num: '027a/298', name: 'Darius, Trifarian (Alternate Art)', rarity: 'Rare', type: 'Unit', domain: 'Fury', e: '3', p: '1', m: '4', img: 'https://riot/27a.png', a: 'Envar Studio' },
      { k: '299*', num: '299*/298', name: 'Daughter of the Void (Signature)', rarity: 'Rare', type: 'Legend', domain: 'Fury;Mind', e: '', p: '', m: '', img: 'https://riot/299s.png', a: 'Kudos Productions' },
      { k: '284', num: '284/298', name: 'Blade of the Ruined King', rarity: 'Rare', type: 'Gear', domain: 'Colorless', e: '', p: '', m: '', img: 'https://riot/284.png', a: 'Fairfoul' },
    ],
  },
};

let TMP;
before(() => {
  TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rbasp-')), 'riftbound.json');
  fs.writeFileSync(TMP, JSON.stringify(CATALOG));
  process.env.RIFTBOUND_DATA_PATH = TMP;
});
after(() => { delete process.env.RIFTBOUND_DATA_PATH; });

// Rows as they come back OUT OF THE DATABASE: identity, name, set, number, rarity, variant — and
// nothing else. Every fact below is re-resolved by buildRowIn from the baked catalog, which is
// exactly the path a /revise-price or a repricer apply takes, and the one that used to lose aspects.
const row = (over) => ({
  sku: 'AAA-001', game: 'riftbound', language: 'EN', condition: 'Ungraded, Near Mint',
  quantity: 1, target_price_cents: 1250, ...over,
});
const SIG = row({                              // OGN 299*/298 — Signature Legend, dual-domain
  name: 'Daughter of the Void', set_name: 'Origins (OGN)', number: '299*/298',
  rarity: 'Showcase', variant: 'Signature', identity_key: 'OGN-299*', target_price_cents: 460000,
});
const ALT = row({                              // OGN 027a/298 — Alternate Art, a champion Unit
  name: 'Darius, Trifarian', set_name: 'Origins (OGN)', number: '027a/298',
  rarity: 'Showcase', variant: 'Alternate Art', identity_key: 'OGN-27a',
});
const BASE = row({                             // OGN 001/298 — a plain Common
  name: 'Blazing Scorcher', set_name: 'Origins (OGN)', number: '001/298',
  rarity: 'Common', variant: 'Base', identity_key: 'OGN-1',
});
const GEAR = row({                             // OGN 284/298 — a Colorless Gear, spelling-fix case
  name: 'Blade of the Ruined King', set_name: 'Origins (OGN)', number: '284/298',
  rarity: 'Rare', variant: 'Base', identity_key: 'OGN-284',
});
// The GR7 case: an identity the catalog cannot resolve (a fresh clone with no bake, or a read
// landing mid-rename). Everything arrives on the row from card_facts instead, and the listing has
// to come out just as complete — createOrReplaceInventoryItem is a full replace, so a thin row
// STRIPS aspects off a listing that is already live.
const COLD = row({
  name: 'Vi, Destructive', set_name: 'Vendetta (VEN)', number: '167/166',
  rarity: 'Showcase', variant: 'Overnumbered', identity_key: 'NOSUCH-999',
  finish: 'Foil', rb_type: 'Unit', rb_domain: 'Fury / Mind', character: 'Vi',
  illustrator: 'Six More Vodka',
});

const asp = (item) => toEbayListing(item, null, cats).aspects;

describe('the Game aspect — the one eBay requires, and the one a near-miss hides in', () => {
  it('is the LIVE member "Riftbound: League of Legends TCG"', () => {
    // REQUIRED and FREE_TEXT: a value off the enum still publishes, it just earns no facet. This
    // one shipped as the bare 'Riftbound' for months for exactly that reason.
    assert.equal(cats.games.riftbound.gameAspect, 'Riftbound: League of Legends TCG');
    assert.equal(asp(SIG).Game, 'Riftbound: League of Legends TCG');
  });
  it('lands on the shared Trading Card Singles category', () => {
    const l = toEbayListing(SIG, null, cats);
    assert.equal(l.categoryId, '183454');
    assert.deepEqual(validateListing(l).errors, []);
  });
});

describe('Set — the parens the title needs and the facet does not', () => {
  it('strips the "(OGN)" the row stores, the same way Magic\'s "(HOB)" is stripped', () => {
    assert.equal(asp(SIG).Set, 'Origins');
    assert.equal(asp(COLD).Set, 'Vendetta');
  });
  it('but the TITLE keeps the code, because that is what disambiguates a title', () => {
    assert.match(toEbayListing(ALT, null, cats).title, /\(OGN\)/);
  });
});

describe('Rarity — verbatim, including the two words eBay has no member for', () => {
  it('sends Showcase as Showcase, not as the enum\'s nearest-looking word', () => {
    // The enum carries Common / Uncommon / Rare / Legendary / Secret Rare and 52 others. It does
    // NOT carry Showcase or Epic, and 'Legendary' is another game's word — not Riftbound's Epic.
    assert.equal(asp(SIG).Rarity, 'Showcase');
    assert.equal(asp(BASE).Rarity, 'Common', 'Common IS a member, so this one earns a real facet');
    assert.equal(asp(row({ ...BASE, rarity: 'Epic' })).Rarity, 'Epic');
    assert.notEqual(asp(row({ ...BASE, rarity: 'Epic' })).Rarity, 'Legendary');
  });
});

describe('Card Type — Spell earns a facet, and Gear is not called Equipment', () => {
  it('goes verbatim', () => {
    assert.equal(riftboundCardTypeAspect('Spell'), 'Spell');     // a live member: 233 cards
    assert.equal(riftboundCardTypeAspect('Unit'), 'Unit');
    assert.equal(riftboundCardTypeAspect('Battlefield'), 'Battlefield');
    assert.equal(riftboundCardTypeAspect('  Legend  '), 'Legend');
    assert.equal(riftboundCardTypeAspect(''), null);
    assert.equal(riftboundCardTypeAspect(null), null);
  });
  it('never borrows Magic\'s "Equipment" for a Gear', () => {
    // Equipment IS a member and IS constrained to Riftbound in eBay's own data, which is precisely
    // the trap: it would earn a facet by calling the card something it is not.
    assert.equal(riftboundCardTypeAspect('Gear'), 'Gear');
  });
  it('reads the re-resolved rb_type off a row that has been through the DB', () => {
    assert.equal(asp(ALT)['Card Type'], 'Unit');
    assert.equal(asp(SIG)['Card Type'], 'Legend');
    assert.equal(asp(COLD)['Card Type'], 'Unit', 'and off card_facts when the catalog is cold');
  });
});

describe('Attribute/Colour — the domain, verbatim, with one spelling fix', () => {
  it('sends the domain rather than a colour it maps to', () => {
    // The 27 members are colours. Fury is not Red as far as a buyer filtering Red is concerned,
    // and Riot publishes no such mapping — so nothing is translated to buy the facet.
    assert.equal(riftboundDomainAspect('Fury'), 'Fury');
    assert.equal(riftboundDomainAspect('Order'), 'Order');
    assert.notEqual(riftboundDomainAspect('Fury'), 'Red');
  });
  it('normalises Colorless to the AU member Colourless', () => {
    // A SPELLING of the same word, not another game's vocabulary — the same substitution
    // MTG_COLOUR_ASPECT already makes for Colourless / Multicoloured.
    assert.equal(riftboundDomainAspect('Colorless'), 'Colourless');
    assert.equal(riftboundDomainAspect('colorless'), 'Colourless');
  });
  it('takes the FIRST domain on a dual-domain card, because the aspect is SINGLE', () => {
    // domainDisp joins them as 'Fury / Mind'; 175 cards are dual.
    assert.equal(riftboundDomainAspect('Fury / Mind'), 'Fury');
    assert.equal(asp(SIG)['Attribute/MTG:Colour'], 'Fury', 'the Signature Legend is Fury;Mind');
    assert.equal(asp(COLD)['Attribute/MTG:Colour'], 'Fury');
  });
  it('normalises a Colorless card resolved out of the catalog, not just the raw helper', () => {
    assert.equal(asp(GEAR)['Attribute/MTG:Colour'], 'Colourless');
    assert.equal(asp(GEAR)['Card Type'], 'Gear', 'and its type is Gear, never Equipment');
  });
  it('is unset rather than empty when there is no domain', () => {
    assert.equal(riftboundDomainAspect(''), null);
    assert.equal(riftboundDomainAspect(null), null);
  });
});

describe('Character — the champion, and only off a Unit', () => {
  it('reads the comma name Riot actually prints', () => {
    assert.equal(riftboundCharacter('Darius, Trifarian', 'Unit'), 'Darius');
    assert.equal(riftboundCharacter("Kai'Sa, Survivor", 'Unit'), "Kai'Sa");
    assert.equal(asp(ALT).Character, 'Darius');
  });
  // Counted over the bake: 296 of the 297 comma names are Units. The one that is not —
  // 'Heisho, Shell of the World', a Battlefield — has a PLACE before the comma. An ungated split
  // would put a location in the Character aspect.
  it('yields nothing on a non-Unit, however comma-shaped the name is', () => {
    assert.equal(riftboundCharacter('Heisho, Shell of the World', 'Battlefield'), '');
    assert.equal(riftboundCharacter('Hand of Noxus', 'Legend'), '');
    assert.equal(asp(SIG).Character, undefined, 'a Legend names a title, not a champion');
  });
  it('yields nothing on a Unit with no comma', () => {
    assert.equal(riftboundCharacter('Blazing Scorcher', 'Unit'), '');
    assert.equal(asp(BASE).Character, undefined);
  });
});

describe('Finish — the aspect the treatment used to hide', () => {
  it('maps the two finishes the data can produce', () => {
    assert.equal(ebayFinish('Non-foil'), 'Regular');   // the negation branch, tested before /foil/
    assert.equal(ebayFinish('Foil'), 'Foil');
  });
  // THE REGRESSION. Every other game's `variant` IS a printing token, so ebayFinish falls back to
  // it. Riftbound's is the TREATMENT, so ebayFinish('Signature') is null — and the Finish facet
  // went unset on precisely the cards worth the most.
  it('is set on a foil Showcase whose row carries only its treatment', () => {
    assert.equal(ebayFinish('Signature'), null, 'the fallback genuinely cannot answer this');
    assert.equal(asp(SIG).Finish, 'Foil');
    assert.equal(asp(ALT).Finish, 'Foil');
    assert.equal(asp(BASE).Finish, 'Regular');
    assert.equal(asp(COLD).Finish, 'Foil', 'and off card_facts when the catalog is cold');
  });
});

describe('Features — two real members, and three deliberate forfeits', () => {
  it('claims Showcase and Alternative Art, which are live members', () => {
    assert.deepEqual(riftboundFeatures('Showcase', 'Alternate Art'), ['Showcase', 'Alternative Art']);
    assert.deepEqual(riftboundFeatures('Showcase', 'Signature'), ['Showcase']);
    assert.deepEqual(riftboundFeatures('Common', 'Base'), []);
    assert.deepEqual(asp(ALT).Features, ['Showcase', 'Alternative Art']);
  });
  it('claims nothing for Overnumbered / Signature / Ultimate, which have no member', () => {
    // They are not folded into a near-miss: each already does its work at priority 82 in the
    // title, which is where a buyer reads it.
    assert.deepEqual(asp(SIG).Features, ['Showcase']);
    assert.deepEqual(asp(COLD).Features, ['Showcase']);
  });
  it('never claims Full Art, Borderless, Promo or Serial Numbered', () => {
    // All four ARE members. No field in data/riftbound.json says any of them is true, and an
    // aspect is a claim where the pitch prose is a description (GR4).
    for (const item of [SIG, ALT, BASE, COLD]) {
      for (const f of (asp(item).Features || [])) {
        assert.ok(!['Full Art', 'Borderless', 'Promo', 'Serial Numbered'].includes(f), f);
      }
    }
  });
  // A Signature is a PRINTING TREATMENT. Claiming an autograph on a US$3,085 card that carries
  // none is a misrepresentation, not an optimisation.
  it('leaves Autographed at No on a Signature', () => {
    assert.equal(asp(SIG).Autographed, 'No');
  });
});

describe('the flat aspects', () => {
  it('names Riot as the manufacturer, verbatim and facet-less', () => {
    // NOT a member (Ravensburger and Wizards of the Coast are). Sent anyway: a true item specific
    // a buyer reads, and it starts filtering for free if eBay adds it.
    assert.equal(ebayManufacturer('riftbound'), 'Riot Games');
    assert.equal(asp(SIG).Manufacturer, 'Riot Games');
  });
  it('joins the standard-size, card-stock allowlists', () => {
    assert.equal(asp(BASE)['Card Size'], 'Standard');
    assert.equal(asp(BASE).Material, 'Card Stock');
  });
  it('carries the printed number verbatim and the language as the enum word', () => {
    assert.equal(asp(ALT)['Card Number'], '027a/298');
    assert.equal(asp(ALT).Language, 'English');
  });
  it('carries the illustrator once the catalog has been baked with one', () => {
    // The gallery credits every card (1189/1189 when probed). A catalog baked before the field
    // existed simply leaves it unset — which is why this asserts the COLD row, whose artist rides
    // on card_facts and therefore does not depend on the local bake being current.
    assert.equal(asp(COLD).Illustrator, 'Six More Vodka');
  });
  it('leaves Year Manufactured UNSET, because Riot publishes no release date', () => {
    // The gallery roster is {id, name, collectorNumberMax} and nothing else (probed 2026-08-25).
    // Year Manufactured is SELECTION_ONLY, so a guess would be REJECTED rather than dropped — but
    // the reason it is absent is GR4, not the failure mode.
    for (const item of [SIG, ALT, BASE, COLD]) {
      assert.equal(asp(item)['Year Manufactured'], undefined);
    }
  });
});

describe('no Pokémon leakage', () => {
  it('emits no Stage, Speciality or HP on a game that has none', () => {
    for (const item of [SIG, ALT, BASE, COLD]) {
      const a = asp(item);
      assert.equal(a.Stage, undefined);
      assert.equal(a.Speciality, undefined);
      assert.equal(a.HP, undefined);
    }
  });
});

describe('the override channel — what the uploader can still say when the bake is gone', () => {
  // The rb_* facts are on OVERRIDE_FIELDS for the same reason Magic's colour/treatment are: the
  // stock tools hold them in card_facts at the moment they publish, and buildRowIn's re-resolve can
  // come back empty on a fresh clone. Without that, a cold catalog silently empties the card details
  // table and three aspects at once.
  it('an explicit rb_* value BEATS the catalog, so a correction sticks', () => {
    const corrected = row({
      name: 'Darius, Trifarian', set_name: 'Origins (OGN)', number: '027a/298',
      rarity: 'Showcase', variant: 'Alternate Art', identity_key: 'OGN-27a',
      rb_type: 'Spell', rb_domain: 'Order', character: 'Someone Else',
    });
    const a = asp(corrected);
    assert.equal(a['Card Type'], 'Spell');
    assert.equal(a['Attribute/MTG:Colour'], 'Order');
    assert.equal(a.Character, 'Someone Else');
  });
  it('and every rb_* key is actually on OVERRIDE_FIELDS, or pickOverrides drops it silently', async () => {
    const { OVERRIDE_FIELDS } = await import('../../lib/listings.mjs');
    for (const k of ['rb_type', 'rb_domain', 'rb_tags', 'rb_e', 'rb_p', 'rb_m']) {
      assert.ok(OVERRIDE_FIELDS.includes(k), k + ' is emitted by the adapter but never reaches the item');
    }
  });
});

describe('the DB round trip — everything above, from identity alone', () => {
  // This is the path /revise-price and a repricer apply take: no overrides at all, and
  // createOrReplaceInventoryItem is a full replace rather than a patch, so anything buildRowIn
  // fails to re-resolve is STRIPPED off a listing that is already live.
  it('re-resolves type, domain, character and finish with nothing but an identity key', () => {
    const bare = {
      sku: 'AAA-002', game: 'riftbound', language: 'EN', condition: 'Ungraded, Near Mint',
      quantity: 1, target_price_cents: 900, identity_key: 'OGN-27a',
      name: 'Darius, Trifarian', set_name: 'Origins (OGN)', number: '027a/298',
      rarity: 'Showcase', variant: 'Alternate Art',
    };
    const a = asp(bare);
    assert.equal(a['Card Type'], 'Unit');
    assert.equal(a['Attribute/MTG:Colour'], 'Fury');
    assert.equal(a.Character, 'Darius');
    assert.equal(a.Finish, 'Foil');
    assert.deepEqual(a.Features, ['Showcase', 'Alternative Art']);
  });
});
