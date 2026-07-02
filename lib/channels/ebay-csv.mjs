// lib/channels/ebay-csv.mjs — Phase 1 sink: canonical listing objects (from
// ebay-map.mjs) → an eBay File Exchange / Seller Hub Reports "Add" CSV for AU
// fixed-price listings. Dependency-free writer: RFC-4180 quoting + UTF-8 BOM
// (so "Pokémon"/“é” survive Excel + eBay's parser). CustomLabel = SKU is the
// idempotency key — re-uploading revises rather than duplicates.
//
// Header flavour note (owner decision D6 pending a real upload): this emits the
// classic File Exchange smart-header format. Seller Hub Reports accepts the same
// Add schema; the 3-row sample gate (P1-7) validates against the owner's account
// before any real batch upload. Multi-variation output is EXPERIMENTAL on EBAY_AU
// (see ebay-map.mjs LIVE FINDING) — per-card is the primary shape.

const CRLF = '\r\n';
const BOM = '﻿';

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvLine(cells) { return cells.map(csvCell).join(','); }
const money = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));   // cents → edge format ONLY here (GR3)

// Stable aspect column order (union of everything ebay-map emits).
const ASPECT_COLUMNS = [
  'Game', 'Card Name', 'Set', 'Card Number', 'Rarity', 'Finish', 'Language',
  'Card Condition', 'Graded', 'Professional Grader', 'Grade', 'Certification Number', 'Features',
];

const ACTION_HEADER = 'Action(SiteID=Australia|Country=AU|Currency=AUD|Version=1193)';

// Per-card shape: one Add row per listing.
export function toPerCardCsv(listings, opts = {}) {
  const loc = opts.location || 'Australia';
  const header = [ACTION_HEADER, 'CustomLabel', 'Category', 'Title', 'ConditionID',
    'PicURL', 'Description', 'Format', 'Duration', 'StartPrice', 'Quantity', 'Location',
    ...ASPECT_COLUMNS.map((a) => 'C:' + a)];
  const lines = [csvLine(header)];
  for (const l of listings) {
    lines.push(csvLine([
      'Add', l.sku || '', l.categoryId || '', l.title, l.conditionId,
      l.imageUrl || '', l.descriptionHtml, 'FixedPrice', 'GTC',
      money(l.price_cents), l.quantity, loc,
      ...ASPECT_COLUMNS.map((a) => (l.aspects && l.aspects[a]) || ''),
    ]));
  }
  return BOM + lines.join(CRLF) + CRLF;
}

// Multi-variation shape (EXPERIMENTAL): parent row + Relationship=Variation children,
// single custom 'Card' axis. Validate with a 3-row sample upload before real use.
export function toVariationCsv(groups, opts = {}) {
  const loc = opts.location || 'Australia';
  const header = [ACTION_HEADER, 'CustomLabel', 'Category', 'Title', 'Relationship', 'RelationshipDetails',
    'ConditionID', 'PicURL', 'Description', 'Format', 'Duration', 'StartPrice', 'Quantity', 'Location',
    ...ASPECT_COLUMNS.map((a) => 'C:' + a)];
  const lines = [csvLine(header)];
  for (const g of groups) {
    const first = g.variations[0] || {};
    const axisValues = g.variations.map((v) => v.attrs.Card).join(';');
    // Parent: carries title/category/description; RelationshipDetails declares the axis domain.
    lines.push(csvLine([
      'Add', '', first.categoryId || '', g.parentTitle, '', 'Card=' + axisValues,
      first.conditionId || '', first.imageUrl || '', first.descriptionHtml || '', 'FixedPrice', 'GTC',
      '', '', loc,
      ...ASPECT_COLUMNS.map((a) => (first.aspects && a === 'Game' && first.aspects[a]) || ''),
    ]));
    for (const v of g.variations) {
      lines.push(csvLine([
        '', v.sku || '', '', '', 'Variation', 'Card=' + v.attrs.Card,
        '', v.imageUrl || '', '', '', '',
        money(v.price_cents), v.quantity, '',
        ...ASPECT_COLUMNS.map(() => ''),
      ]));
    }
  }
  return BOM + lines.join(CRLF) + CRLF;
}
