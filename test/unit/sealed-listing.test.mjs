// test/unit/sealed-listing.test.mjs — the sealed publish path (lib/sealed-listing.mjs).
//
// Offline: the payload builder and every refusal are pure, so the whole contract can be asserted
// without an eBay call. The refusals are the point. A blocked publish must name which ONE thing is
// missing, because "publish failed" on a listing with eight preconditions is not a diagnosis.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDbAt } from '../../lib/db.mjs';
import {
  toSealedListing, validateSealedListing, sealedBandFor, sealedAspects, poolUnits,
  publishSealedPool, SEALED_CONDITION_ID, BAND_FOR_TYPE, sealedCategoryFor, SEALED_CATEGORY,
} from '../../lib/sealed-listing.mjs';

const CFG = {
  policies: { paymentPolicyId: '266339227012', returnPolicyId: '271220873012' },
  shipping: {
    sealedBands: [
      { id: 'sealed_small', label: 'Sealed - Small', costCents: 1170, extraCents: 0, policyId: '273398168012' },
      { id: 'sealed_medium', label: 'Sealed - Medium', costCents: 1600, extraCents: 0, policyId: '273398171012' },
    ],
  },
  sealed: {},
};
const POOL = {
  pool_sku: 'BKS-PKM-EN-SSP-BOX', game: 'pokemon', language: 'EN', set_code: 'SSP',
  set_name: 'Surging Sparks (SSP)', product_type: 'booster_box', variant: null,
  condition: 'sealed', factory_sealed: 1, pack_count: 36, price_cents: 24900, name: null,
};
const build = (over = {}, cfg = CFG, units = 3) => {
  const pool = { ...POOL, ...over };
  return { pool, listing: toSealedListing(pool, { units, cfg }) };
};

describe('sealedBandFor — postage by size, never by price', () => {
  it('packs and bundles share the small satchel, a box gets its own', () => {
    assert.equal(sealedBandFor('booster_pack', CFG).id, 'sealed_small');
    assert.equal(sealedBandFor('booster_bundle', CFG).id, 'sealed_small');
    assert.equal(sealedBandFor('booster_box', CFG).id, 'sealed_medium');
    assert.deepEqual(BAND_FOR_TYPE.booster_box, 'sealed_medium');
  });
  it('an unpinned band resolves to null rather than a price-derived fallback', () => {
    assert.equal(sealedBandFor('booster_box', { shipping: { sealedBands: [] } }), null);
    assert.equal(sealedBandFor('booster_box', {}), null);
    // a band present but with no policy assigned is NOT usable
    assert.equal(sealedBandFor('booster_box', { shipping: { sealedBands: [{ id: 'sealed_medium', policyId: '' }] } }), null);
  });
});

describe('toSealedListing — the payload publishListing receives', () => {
  it('lists as NEW, at pool quantity, on the pinned category', () => {
    const { listing } = build();
    assert.equal(listing.conditionId, SEALED_CONDITION_ID);
    assert.equal(listing.conditionId, 1000);
    assert.equal(listing.quantity, 3, 'one offer at quantity N, not N offers');
    assert.equal(listing.categoryId, '261044', 'a box goes to CCG Sealed Boxes');
    assert.equal(listing.sku, 'BKS-PKM-EN-SSP-BOX');
  });
  it('stamps the sealed band, which is what keeps it off the price-banded table', () => {
    const { listing } = build();
    assert.equal(listing.postageBand.policyId, '273398171012');
    assert.equal(listing.postageBand.id, 'sealed_medium');
  });
  it('titles within 80 and carries the language token only when it is not English', () => {
    const en = build().listing.title;
    assert.ok(en.length <= 80, en);
    assert.ok(!/Japanese/.test(en));
    assert.match(build({ language: 'JP' }).listing.title, /Japanese/);
  });
  it('the description quotes what the band actually charges', () => {
    assert.match(build().listing.descriptionHtml, /\$16\.00 anywhere in Australia however many you take/);
  });
  it('a per-extra-item band never claims a flat rate', () => {
    const cfg = { ...CFG, shipping: { sealedBands: [{ id: 'sealed_medium', costCents: 1600, extraCents: 1600, policyId: 'X' }] } };
    const html = toSealedListing(POOL, { units: 2, cfg }).descriptionHtml;
    assert.match(html, /\$16\.00 for one anywhere in Australia/);
    assert.ok(!/however many you take/.test(html), 'must not promise a flat rate it does not have');
  });
  it('an owner title or description wins, because a revise replaces rather than patches', () => {
    const { listing } = build({ title_override: 'My own title', desc_override: '<p>mine</p>' });
    assert.equal(listing.title, 'My own title');
    assert.equal(listing.descriptionHtml, '<p>mine</p>');
  });
});

describe('sealedAspects', () => {
  it('emits the identity aspects and lets a configured value override', () => {
    const a = sealedAspects(POOL, CFG);
    assert.equal(a.Language, 'English');
    // SELECTION_ONLY on 261044, and its enum has exactly one member. 'Booster Box' would be REJECTED.
    assert.equal(a.Configuration, 'Box');
    assert.ok(!('Number of Packs' in a), 'not an aspect on the boxes category');
    const over = sealedAspects(POOL, { sealed: { gameAspect: 'Pokémon', aspects: { Language: 'Japanese' } } });
    assert.equal(over.Game, 'Pokémon');
    assert.equal(over.Language, 'Japanese', 'the owner can correct a category we guessed wrong about');
  });
  it('drops empty values rather than shipping blank specifics', () => {
    const a = sealedAspects({ ...POOL, pack_count: null, set_name: '' }, CFG);
    assert.ok(!('Number of Packs' in a));
    assert.ok(!('Set' in a));
  });
});

describe('validateSealedListing — every refusal names its one cause', () => {
  const errsFor = (over, cfg = CFG, units = 3) => {
    const { pool, listing } = build(over, cfg, units);
    return validateSealedListing(listing, pool, cfg);
  };
  it('passes when everything is in place', () => {
    assert.deepEqual(errsFor({}), []);
  });
  it('refuses when no category resolves, and says where to get one', () => {
    // A v1 type always resolves now, because the baked values were read live off eBay. This guard
    // is for the types that come later: a tin has no category yet, so it refuses on BOTH counts.
    const e = errsFor({ product_type: 'tin' });
    assert.match(e.join(' '), /no eBay category resolves/);
    assert.match(e.join(' '), /listings\/categories/);
    assert.match(e.join(' '), /outside v1/);
  });
  it('refuses a sub-dollar price by eBay error code', () => {
    assert.match(errsFor({ price_cents: 99 }).join(' '), /25016/);
  });
  it('refuses with no units, because an offer at quantity 0 is not a listing', () => {
    assert.match(errsFor({}, CFG, 0).join(' '), /no units in stock/);
  });
  it('refuses anything not factory sealed — the gate that keeps catalog art honest', () => {
    assert.match(errsFor({ condition: 'opened' }).join(' '), /not factory sealed/);
    assert.match(errsFor({ factory_sealed: 0 }).join(' '), /not factory sealed/);
  });
  it('refuses a product type outside v1', () => {
    assert.match(errsFor({ product_type: 'elite_trainer_box' }).join(' '), /outside v1/);
  });
  it('refuses when no postage policy is pinned for the size class', () => {
    assert.match(errsFor({}, { ...CFG, shipping: { sealedBands: [] } }).join(' '), /no eBay policy is pinned/);
  });
  it('refuses an over-length title', () => {
    assert.match(errsFor({ title_override: 'x'.repeat(81) }).join(' '), /title over 80/);
  });
});

describe('publishSealedPool — refuses before any eBay call, and audits the refusal', () => {
  const freshDb = () => {
    const p = path.join(os.tmpdir(), `sealed-listing-${process.pid}-${Math.round(process.hrtime()[1])}.db`);
    return { db: openDbAt(p), p };
  };
  const seed = (db, over = {}) => {
    const pool = { ...POOL, ...over };
    const keys = Object.keys(pool).filter((k) => pool[k] !== undefined);
    db.prepare(`INSERT INTO sealed_pools (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => pool[k]));
    return pool;
  };
  const addStock = (db, poolSku, units) => {
    const r = db.prepare(`INSERT INTO sealed_items (sku, game, product_type, name, language, status, pool_sku, quantity)
                          VALUES (?,?,?,?,?,?,?,?)`)
      .run('BK-SLD-PKM-' + Math.round(Math.random() * 1e6), 'pokemon', 'booster_box', 'box', 'EN', 'in_stock', poolSku, units);
    db.prepare('INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)')
      .run(r.lastInsertRowid, 'Crate 1', units);
  };

  it('an unknown pool is a clean 409-shaped refusal, not a crash', async () => {
    const { db, p } = freshDb();
    const out = await publishSealedPool({}, db, CFG, { poolSku: 'NOPE' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'no_pool');
    db.close(); fs.unlinkSync(p);
  });

  it('sums units from PLACEMENTS across several acquisitions, not the cached mirror', async () => {
    const { db, p } = freshDb();
    seed(db);
    addStock(db, POOL.pool_sku, 2);
    addStock(db, POOL.pool_sku, 4);
    assert.equal(poolUnits(db, POOL.pool_sku), 6, 'two acquisitions, one pool, one offer at 6');
    db.close(); fs.unlinkSync(p);
  });

  it('a dry run validates the whole payload and writes a preview to the audit, with no eBay call', async () => {
    const { db, p } = freshDb();
    seed(db); addStock(db, POOL.pool_sku, 3);
    const out = await publishSealedPool({}, db, CFG, { poolSku: POOL.pool_sku, dryRun: true });
    assert.equal(out.ok, true);
    assert.equal(out.dryRun, true);
    assert.equal(out.listing.quantity, 3);
    const push = db.prepare('SELECT * FROM sealed_listing_pushes ORDER BY id DESC LIMIT 1').get();
    assert.equal(push.action, 'preview');
    assert.equal(push.status, 'ok');
    db.close(); fs.unlinkSync(p);
  });

  it('an unpublishable pool never reaches eBay and the refusal is auditable afterwards', async () => {
    const { db, p } = freshDb();
    seed(db, { condition: 'opened' }); addStock(db, POOL.pool_sku, 3);
    // env is {} on purpose: any eBay call would throw, so reaching one is a test failure in itself.
    const out = await publishSealedPool({}, db, CFG, { poolSku: POOL.pool_sku });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'not_publishable');
    assert.match(out.error, /not factory sealed/);
    const push = db.prepare('SELECT * FROM sealed_listing_pushes ORDER BY id DESC LIMIT 1').get();
    assert.equal(push.status, 'skipped');
    assert.match(push.error, /not factory sealed/);
    db.close(); fs.unlinkSync(p);
  });
});

describe('sealedCategoryFor — sealed is TWO categories, not one', () => {
  it('files a box and a pack separately, off eBay live suggestions', () => {
    assert.equal(sealedCategoryFor('booster_box', {}), '261044');   // CCG Sealed Boxes
    assert.equal(sealedCategoryFor('booster_pack', {}), '183456');  // CCG Sealed Packs
    assert.notEqual(SEALED_CATEGORY.booster_box, '183454', 'never the singles category');
  });
  it('puts a bundle with the boxes, which is the judgement call', () => {
    // eBay's top suggestion for "pokemon booster bundle" is Deck Boxes/Storage, which is wrong.
    assert.equal(sealedCategoryFor('booster_bundle', {}), '261044');
  });
  it('config wins, so a category eBay moves needs no release', () => {
    assert.equal(sealedCategoryFor('booster_box', { sealed: { categories: { booster_box: '999' } } }), '999');
  });
});

describe('sealedAspects — SELECTION_ONLY is a rejection, FREE_TEXT is a silent loss', () => {
  it('a box sends Configuration Box, because that is the only member of the enum', () => {
    assert.equal(sealedAspects({ ...POOL, product_type: 'booster_box' }, CFG).Configuration, 'Box');
  });
  it('a pack sends Configuration Pack, the sole member of 183456 s enum', () => {
    const a = sealedAspects({ ...POOL, product_type: 'booster_pack' }, CFG);
    assert.equal(a.Configuration, 'Pack');
    assert.equal(a['Number of Packs'], '36', 'packs DO carry it, boxes do not');
  });
  it('never invents a SELECTION_ONLY value for a category whose enum is unread', () => {
    // A wrong SELECTION_ONLY value FAILS the publish, unlike FREE_TEXT which quietly earns no facet.
    const a = sealedAspects({ ...POOL, product_type: 'tin' }, { sealed: { categories: { tin: '999999' } } });
    assert.ok(!('Configuration' in a));
  });
});
