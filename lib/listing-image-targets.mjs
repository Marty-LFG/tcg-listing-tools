// lib/listing-image-targets.mjs — the THIRD axis of the compositor.
//
//   variant  = which rail art          (default | japanese | sealed)
//   profile  = per-productType tweaks  (single | slab | sealed)
//   target   = WHICH FRAME, FOR WHICH CHANNEL   <- this module
//
// THE RULE THAT DECIDES EVERY FRAME: rails fill the frame's dead axis.
//
//   eBay 1600x1600, portrait card  -> dead space left/right  -> vertical rails (unchanged)
//   Shopify 1512x2112 (63:88)      -> NO dead space, so we make some, top and bottom
//   Shopify 1600x1600 sealed       -> dead space top/bottom   -> horizontal bands
//   OG 1200x630                    -> dead space left/right   -> vertical rails, art reused
//
// Shopify is the only frame where the dead space is created rather than inherited, because its grid
// is built on 63:88 — the card's own ratio — so a trimmed scan would fill it edge to edge. Creating
// it HORIZONTALLY is the deliberate call: side rails would squeeze a portrait card's width badly
// (the eBay square gets away with it only because the card is already width-constrained there), and
// horizontal type needs no rotation, so a band carries a full set name and printed number at
// readable size where a 300px vertical rail manages two clipped lines.
//
// SPLIT BY DESIGN, the same rule as ASSET_VERSION. The frame sizes here are the storefront's grid
// contract, not taste: 1512x2112 is 63:88 EXACTLY (63x24, 88x24), so rounding it to a "tidier"
// 1500x2100 (which is 5:7) would break every tile. Those live in CODE. What the owner may tune —
// band thickness, jpeg quality, the OG's own geometry, which is our design and not Shopify's —
// lives in data/listing-image.config.json and is whitelisted on the way in.

export const DEFAULT_TARGET = 'ebay-square';

// Written as the ratio and its multiplier, never as two literals, so the invariant test can assert
// 1512/2112 === 63/88 by construction rather than by someone re-checking the arithmetic.
export const CARD_RATIO = Object.freeze({ w: 63, h: 88 });
export const SHOPIFY_SCALE = 24;                 // 63x24 = 1512, 88x24 = 2112
export const SHOPIFY_SQUARE = 1600;              // sealed / bundle / accessory
export const OG_FRAME = Object.freeze({ width: 1200, height: 630 });

export const TARGETS = Object.freeze({
  'ebay-square': Object.freeze({
    id: 'ebay-square', channel: 'ebay', rails: 'vertical',
    // A FUNCTION, not two numbers: layout.canvas is config-overridable and the lab has a slider on
    // it, so hardcoding 1600 here would make both of those lie. Every other frame is fixed.
    frame: (layout) => ({ width: layout.canvas, height: layout.canvas }),
    ground: '#ffffff', format: 'jpeg', ext: 'jpg',
  }),
  'shopify-card': Object.freeze({
    id: 'shopify-card', channel: 'shopify', rails: 'horizontal',
    frame: () => ({ width: CARD_RATIO.w * SHOPIFY_SCALE, height: CARD_RATIO.h * SHOPIFY_SCALE }),
    // 'rail' means the ground is the rail art's own plum, not a colour anyone picks. The storefront
    // has a light AND a dark mode; a branded surround is deliberately dark in both, the way a card's
    // own border is, where a neutral mat would be wrong in one of them.
    ground: 'rail', format: 'jpeg', ext: 'jpg',
  }),
  'shopify-square': Object.freeze({
    id: 'shopify-square', channel: 'shopify', rails: 'horizontal',
    frame: () => ({ width: SHOPIFY_SQUARE, height: SHOPIFY_SQUARE }),
    ground: 'rail', format: 'jpeg', ext: 'jpg',
  }),
  'og-card': Object.freeze({
    id: 'og-card', channel: 'shopify', rails: 'vertical',
    frame: () => ({ ...OG_FRAME }),
    ground: 'rail', format: 'jpeg', ext: 'jpg',
  }),
});

export const TARGET_IDS = Object.freeze(Object.keys(TARGETS));

// There is deliberately NO separate slab target. A slab and a raw single are framed identically —
// contained on plum in the same 63:88 tile — and differ only in what the bands SAY. productType
// still picks the band content and the rail variant.
export const SHOPIFY_TARGET_FOR = Object.freeze({
  single: 'shopify-card',
  slab: 'shopify-card',
  sealed: 'shopify-square',
});

export function resolveTarget(id = DEFAULT_TARGET) {
  const t = TARGETS[id];
  if (!t) throw new Error(`unknown target '${id}' (have: ${TARGET_IDS.join(', ')})`);
  return t;
}

export function resolveTargetFrame(target, layout) {
  const f = target.frame(layout);
  if (!(f.width > 0 && f.height > 0)) throw new Error(`target '${target.id}' resolved to an empty frame`);
  return f;
}

// THE HASH SEGMENT, and the single most load-bearing function in this module.
//
// It returns '' for the eBay square and for nothing else. composeHash appends the segment only when
// it is non-empty, so every content hash minted before targets existed — which is every branded
// image on every live eBay listing — comes out byte-identical. Built HERE and nowhere else, the
// same discipline composeFlags() and badgeKeyFor() already follow, because composeListingImage and
// hashFor must agree or a cache probe answers "hit" for an image the real compose renders
// differently.
export function targetFingerprint(target) {
  if (!target || target.id === DEFAULT_TARGET) return '';
  const f = target.frame({ canvas: 0 });
  return `${target.id}:${f.width}x${f.height}:${target.rails}:${target.format}`;
}

// --- band geometry -----------------------------------------------------------------------------

// Band thickness as a fraction of the frame's LONG edge. 0.093 x 2112 = 196px, which leaves a
// 1512 x 1720 card box; a 63:88 card lands there at 1230 x 1720 with plum on all four sides.
// Owner-tunable through data/listing-image.config.json (this is the default that seeds it).
export const DEFAULT_BAND_FRACTION = 0.093;

// --- OG card geometry ---------------------------------------------------------------------------

// The 1200x630 social card is WIDE, so its dead space is at the sides and it reuses the VERTICAL
// rail art rather than the bands. The rails are scaled by width and cropped from the top, which
// keeps the store mark's proportions and its position; the gradient is simply truncated.
export const OG_SAMPLE_FRACTION = 0.10;   // where the ground column is lifted from — see the note in the renderer

export function resolveOgGeometry(cfg, railArt) {
  const og = (cfg && cfg.shopify && cfg.shopify.og) || {};
  const railWidth = og.railWidth != null ? og.railWidth : 300;
  const cardPaddingY = og.cardPaddingY != null ? og.cardPaddingY : 38;
  const cardPaddingX = og.cardPaddingX != null ? og.cardPaddingX : 36;
  if (!Number.isInteger(railWidth) || railWidth < 1) throw new Error(`shopify.og.railWidth must be a positive integer (got ${railWidth})`);
  if (!Number.isInteger(cardPaddingY) || cardPaddingY < 0) throw new Error(`shopify.og.cardPaddingY must be a non-negative integer (got ${cardPaddingY})`);
  if (!Number.isInteger(cardPaddingX) || cardPaddingX < 0) throw new Error(`shopify.og.cardPaddingX must be a non-negative integer (got ${cardPaddingX})`);

  const { width, height } = OG_FRAME;
  const cardBox = { width: width - 2 * railWidth - 2 * cardPaddingX, height: height - 2 * cardPaddingY };
  if (cardBox.width < 100) throw new Error(`og rails leave no room for the card: ${width} - 2x${railWidth} - 2x${cardPaddingX} = ${cardBox.width}`);
  if (cardBox.height < 100) throw new Error(`og padding leaves no room for the card: ${height} - 2x${cardPaddingY} = ${cardBox.height}`);

  // The art is scaled by WIDTH and cropped from the top, so it must still be at least as tall as
  // the frame afterwards or the crop reads a squashed rail on every share. Checked against the
  // art's real dimensions, and the error names the variant so the fix is obvious.
  let scaledHeight = null;
  if (railArt && railArt.width > 0 && railArt.height > 0) {
    scaledHeight = Math.round(railArt.height * (railWidth / railArt.width));
    if (scaledHeight < height) {
      throw new Error(
        `shopify.og.railWidth ${railWidth} scales ${railArt.width}x${railArt.height} rail art to ${scaledHeight}px tall, `
        + `short of the ${height}px frame`);
    }
  }
  return { ...OG_FRAME, railWidth, cardPaddingY, cardPaddingX, cardBox, scaledHeight };
}

// Throws rather than emitting a squashed card, the same contract validateLayout() has for rails.
// Called from the settings validator too, so a bad fraction is refused at SAVE time with a message
// naming the number, not discovered on a rendered image.
export function resolveBandGeometry(frame, fraction = DEFAULT_BAND_FRACTION) {
  if (!(fraction > 0 && fraction < 0.5)) {
    throw new Error(`shopify.bandFraction must be >0 and <0.5 (got ${fraction})`);
  }
  const bandH = Math.round(Math.max(frame.width, frame.height) * fraction);
  const cardBox = { width: frame.width, height: frame.height - 2 * bandH };
  if (cardBox.height < 100) {
    throw new Error(
      `bands leave no room for the card: ${frame.height} - 2x${bandH} = ${cardBox.height} `
      + `(shopify.bandFraction ${fraction} is too thick for a ${frame.width}x${frame.height} frame)`);
  }
  return { bandH, cardBox };
}
