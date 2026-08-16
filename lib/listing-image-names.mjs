// lib/listing-image-names.mjs — alt text, filenames, and the ordered image set for a Shopify PDP.
//
// Pure string work: no sharp, no disk, no network. That matters for the test suite — the image
// tests skip wholesale on a host without sharp, and none of this should skip with them.
//
// WHERE THE FIELDS COME FROM, and why it is split:
//   · identity  (card name, set, printed number, language)  <- composeMetaFor(item)
//   · condition, grade, cert                                <- the STOCK ROW, directly
//
// That split is not tidiness. composeMetaFor deliberately omits condition, because condition on a
// rail would split an NM and an LP of one card — two rows with identical source bytes — into two
// separately composed and separately hosted images across the whole store. Alt text has no such
// constraint and the storefront needs condition, so it reads that one field off the row instead.
// Taking IDENTITY from composeMetaFor rather than re-deriving it is what stops the alt text and the
// image itself ever naming two different sets.

// Shopify's own limit. Truncating here beats having the API reject the upload.
const ALT_MAX = 512;

// Alt text is customer-facing copy, and mystery-bundle imagery must never carry a value claim.
// Enforced by an invariant test rather than trusted to whoever edits the templates next.
export const VALUE_CLAIM_RE = /[$€£¥]|\b(value|valued|worth|rrp|priced?|bargain|profit)\b/i;

const clean = (v) => String(v == null ? '' : v).trim();

// Every field is DROPPED when missing, never stringified. Each one is absent on some real row, and
// "Iono undefined — undefined (English), " is worse than a shorter true sentence.
const join = (parts, sep) => parts.map(clean).filter(Boolean).join(sep);

// 10 renders '10', 9.5 renders '9.5' — JS already does the right thing, but pin the intent so
// nobody "helpfully" adds toFixed(1) and turns every PSA 10 into a PSA 10.0.
const gradeToken = (g) => (g == null || g === '' ? '' : String(g));

/**
 * @param item  the stock row — condition / grading_company / grade / cert_number
 * @param meta  composeMetaFor(item) — cardName / setName / cardNumber / language / productType
 */
export function altTextFor(item = {}, meta = {}) {
  const productType = clean(meta.productType) || 'single';
  const language = clean(meta.language);
  const setName = clean(meta.setName);
  const lang = language ? `(${language})` : '';

  let head, tail;
  if (productType === 'sealed') {
    head = clean(item.name) || clean(meta.cardName);
    tail = join([join([setName, lang], ' '), 'sealed'], ', ');
  } else if (productType === 'slab') {
    head = join([meta.cardName, meta.cardNumber], ' ');
    const grade = join([item.grading_company || meta.grader, gradeToken(item.grade != null ? item.grade : meta.grade)], ' ');
    const cert = clean(item.cert_number || meta.certNumber);
    tail = join([join([setName, lang], ' '), grade, cert ? `cert ${cert}` : ''], ', ');
  } else {
    head = join([meta.cardName, meta.cardNumber], ' ');
    tail = join([join([setName, lang], ' '), item.condition], ', ');
  }

  // An em dash separates the thing from its attributes, and only when there are attributes.
  const out = join([head, tail], ' — ');
  return out.length > ALT_MAX ? out.slice(0, ALT_MAX - 1).trimEnd() + '…' : out;
}

// The SKU is the join key across local stock, eBay and Shopify, so the filename stays traceable back
// to the physical item. Sanitised rather than trusted: it reaches a filesystem path and a URL, and
// `logos/../.env` must not be representable. Uppercased because every SKU scheme in this repo
// already is (AAC-097, STG-000123, BK-PKM-000042).
export function sanitiseSkuToken(sku) {
  return clean(sku).toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

// `position` is omitted entirely for images that are not in the gallery strip — the social card has
// no position, and numbering it 1 would make it collide with the front of the card.
export function imageFilename({ sku, position, view, ext }) {
  const s = sanitiseSkuToken(sku) || 'ITEM';
  const v = clean(view).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'image';
  const e = clean(ext).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'jpg';
  const n = Number(position);
  return position == null || !Number.isFinite(n) || n < 1 ? `${s}-${v}.${e}` : `${s}-${n}-${v}.${e}`;
}

// The gallery views, in the order the PDP wants them. Position 1 is ALWAYS the actual card — the
// storefront's own invariant is that what you see is what you get, so a branded composite there
// would be a stock render standing in for the item.
export const VIEWS = Object.freeze(['front', 'back', 'corners', 'cert', 'branded', 'og']);
const GALLERY_ORDER = Object.freeze(['front', 'back', 'corners', 'cert', 'branded']);

/**
 * Assemble the ordered image set for one item.
 *
 * @param rendered  the renderer's ACTUAL results, [{ view, target, result }] — not the requests.
 *                  The extension has to come from the bytes that were produced, so predicting it
 *                  from productType is exactly the bug this signature prevents.
 * @param urlFor    (contentHash, ext, filename) -> string
 */
export function buildImageSet({ item = {}, meta = {}, sku, rendered = [], urlFor } = {}) {
  const gallery = rendered
    .filter((r) => r && r.result && r.view !== 'og')
    .sort((a, b) => GALLERY_ORDER.indexOf(a.view) - GALLERY_ORDER.indexOf(b.view));

  const alt = altTextFor(item, meta);
  const images = [];
  let position = 0;

  for (const r of gallery) {
    position += 1;
    if (position === 1 && r.view === 'branded') {
      // A programming error, not a data problem: the caller ordered the set wrongly, and shipping
      // it would put store furniture where the actual card belongs on every collection tile and
      // every social preview.
      throw new Error('the branded composite cannot be position 1 — position 1 must be the actual card');
    }
    const ext = r.result.ext || 'jpg';
    const filename = imageFilename({ sku, position, view: r.view, ext });
    images.push({
      position, view: r.view, target: r.target || r.result.target, filename, alt,
      contentHash: r.result.contentHash, composeVersion: r.result.composeVersion,
      width: r.result.width, height: r.result.height,
      bytes: r.result.buffer ? r.result.buffer.length : null,
      review: r.result.review || null,
      url: urlFor ? urlFor(r.result.contentHash, ext, filename) : null,
    });
  }

  // The social card is not a gallery image — it has no position and never appears in the PDP strip.
  const social = rendered.find((r) => r && r.view === 'og' && r.result) || null;

  return {
    sku: sanitiseSkuToken(sku),
    productType: clean(meta.productType) || 'single',
    alt,
    images,
    social: social ? {
      view: 'og', target: social.target || social.result.target,
      // No position: it is not in the gallery strip.
      filename: imageFilename({ sku, view: 'og', ext: social.result.ext || 'jpg' }),
      contentHash: social.result.contentHash,
      composeVersion: social.result.composeVersion,
      width: social.result.width, height: social.result.height,
      bytes: social.result.buffer ? social.result.buffer.length : null,
      url: urlFor ? urlFor(social.result.contentHash, social.result.ext || 'jpg', null) : null,
    } : null,
    needsReview: images.some((i) => i.review),
  };
}
