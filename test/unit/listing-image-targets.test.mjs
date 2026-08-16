// test/unit/listing-image-targets.test.mjs — the output-frame registry.
// Pure: no sharp, no disk, runs everywhere.
//
// The important assertion in here is the LAST one. targetFingerprint() returning '' for the eBay
// square is the entire reason adding Shopify frames costs nothing: composeHash appends the target
// segment only when it is non-empty, so every image already hosted on a live eBay listing keeps its
// key. Everything else in this file is arithmetic.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_RATIO, SHOPIFY_SCALE, SHOPIFY_SQUARE, OG_FRAME, DEFAULT_TARGET,
  TARGETS, TARGET_IDS, SHOPIFY_TARGET_FOR, resolveTarget, resolveTargetFrame, targetFingerprint,
} from '../../lib/listing-image-targets.mjs';
import { PROFILES, composeHash, resolveLayout, DEFAULT_CONFIG } from '../../lib/listing-image-config.mjs';

describe('the 63:88 frame', () => {
  it('1512 x 2112 is 63:88 EXACTLY — derived, not typed', () => {
    const w = CARD_RATIO.w * SHOPIFY_SCALE;
    const h = CARD_RATIO.h * SHOPIFY_SCALE;
    assert.equal(w, 1512);
    assert.equal(h, 2112);
    // No rounding drift: the two ratios are the same rational number, not merely close.
    assert.equal(w * CARD_RATIO.h, h * CARD_RATIO.w);
  });

  it('is what shopify-card actually resolves to', () => {
    assert.deepEqual(resolveTargetFrame(TARGETS['shopify-card'], {}), { width: 1512, height: 2112 });
  });

  it('sealed is square and the OG card is the wide one', () => {
    assert.deepEqual(resolveTargetFrame(TARGETS['shopify-square'], {}), { width: SHOPIFY_SQUARE, height: SHOPIFY_SQUARE });
    assert.deepEqual(resolveTargetFrame(TARGETS['og-card'], {}), { ...OG_FRAME });
  });
});

describe('the registry', () => {
  it('TARGET_IDS is derived from TARGETS, never copied', () => {
    assert.deepEqual([...TARGET_IDS].sort(), Object.keys(TARGETS).sort());
  });

  it('every target declares an id matching its key', () => {
    for (const [k, t] of Object.entries(TARGETS)) assert.equal(t.id, k);
  });

  it('every target is jpeg — branded grounds are opaque, so nothing needs alpha', () => {
    for (const t of Object.values(TARGETS)) {
      assert.equal(t.format, 'jpeg');
      assert.equal(t.ext, 'jpg');
    }
  });

  it('rails fill the dead axis: square and wide frames get vertical, the 63:88 tile gets bands', () => {
    assert.equal(TARGETS['ebay-square'].rails, 'vertical');
    assert.equal(TARGETS['og-card'].rails, 'vertical');
    assert.equal(TARGETS['shopify-card'].rails, 'horizontal');
    assert.equal(TARGETS['shopify-square'].rails, 'horizontal');
  });

  it('resolveTarget throws on an unknown id rather than falling back', () => {
    assert.throws(() => resolveTarget('shopify-slab'), /unknown target 'shopify-slab'/);
  });

  it('resolveTarget defaults to the eBay square', () => {
    assert.equal(resolveTarget().id, DEFAULT_TARGET);
    assert.equal(resolveTarget(undefined).id, DEFAULT_TARGET);
  });

  it('the eBay frame follows layout.canvas — it is overridable and the lab has a slider on it', () => {
    assert.deepEqual(resolveTargetFrame(TARGETS['ebay-square'], { canvas: 1600 }), { width: 1600, height: 1600 });
    assert.deepEqual(resolveTargetFrame(TARGETS['ebay-square'], { canvas: 2400 }), { width: 2400, height: 2400 });
  });

  it('every productType profile maps to a Shopify target — a new profile forces a decision here', () => {
    assert.deepEqual(Object.keys(SHOPIFY_TARGET_FOR).sort(), Object.keys(PROFILES).sort());
    for (const id of Object.values(SHOPIFY_TARGET_FOR)) assert.ok(TARGETS[id], `${id} is not a target`);
  });

  it('slabs and raw singles share a frame — they differ in what the bands say, not in geometry', () => {
    assert.equal(SHOPIFY_TARGET_FOR.slab, SHOPIFY_TARGET_FOR.single);
  });
});

describe('targetFingerprint — the append-only guarantee', () => {
  it('is EMPTY for the eBay square, and that is the whole point', () => {
    assert.equal(targetFingerprint(TARGETS['ebay-square']), '');
    assert.equal(targetFingerprint(resolveTarget()), '');
  });

  it('is non-empty and distinct for every other target', () => {
    const seen = new Set();
    for (const id of TARGET_IDS) {
      if (id === DEFAULT_TARGET) continue;
      const fp = targetFingerprint(TARGETS[id]);
      assert.ok(fp, `${id} must contribute to the hash`);
      assert.ok(!seen.has(fp), `${id} collides with another target's fingerprint`);
      seen.add(fp);
    }
  });

  it('an empty target segment hashes identically to omitting it', () => {
    const layout = resolveLayout(DEFAULT_CONFIG, {}, {});
    const base = { sourceBytes: Buffer.from('x'), layout, variant: 'default', textLines: [], assetDigest: 'd', badge: '' };
    assert.equal(composeHash(base), composeHash({ ...base, target: '' }));
    assert.equal(composeHash(base), composeHash({ ...base, target: targetFingerprint(TARGETS['ebay-square']) }));
  });

  it('a real target segment DOES change the hash — the frames must not collide', () => {
    const layout = resolveLayout(DEFAULT_CONFIG, {}, {});
    const base = { sourceBytes: Buffer.from('x'), layout, variant: 'default', textLines: [], assetDigest: 'd', badge: '' };
    const shopify = composeHash({ ...base, target: targetFingerprint(TARGETS['shopify-card']) });
    assert.notEqual(composeHash(base), shopify);
    assert.notEqual(shopify, composeHash({ ...base, target: targetFingerprint(TARGETS['og-card']) }));
  });
});
