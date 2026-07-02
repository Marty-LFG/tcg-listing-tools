// lib/collectr.mjs — Workflow B: parse a Collectr portfolio CSV export and map each
// row into the canonical ImportRow the bulk pipeline consumes (same shape the set
// enumerator emits, plus the owned-inventory fields Collectr carries: quantity,
// condition, grade, cost basis, override, portfolio).
//
// PURE module: no DOM, no fetch, no DB, and NO cents — money stays float here;
// lib/pricing.mjs does the single Math.round(x*100) (Golden Rule 3). Enrichment
// (identity/image/live price) lives in lib/collectr-resolve.mjs.
//
// Authoritative CSV schema (from real exports, 2026-07):
//   Portfolio Name, Category, Set, Product Name, Card Number, Rarity, Variance,
//   Grade, Card Condition, Average Cost Paid, Quantity,
//   Market Price (As of YYYY-MM-DD), Price Override, Watchlist, Date Added, Notes
// Quirks handled: quoted thousands ("4,051.73"); Variance mixes edition+finish
// ('1st Edition Holofoil'); Grade is 'Ungraded' or '<Company> <grade> <label>'
// ('PSA 10.0 GEM - MT', 'BGS 10.0 Black Label', 'TAG 10.0 Pristine'); Product Name
// sometimes repeats the number ('Misty (18)'); graded rows often export Market
// Price = 0 (Collectr has no graded market data).
import { variantToken } from './listing-copy.mjs';

// ---------------------------------------------------------------------------
// RFC-4180-ish CSV parser (state machine): quoted fields with embedded commas,
// "" escapes, CRLF/LF. Returns rows of raw cell strings — never throws.
// ---------------------------------------------------------------------------
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------
// Header mapping — case-insensitive, tolerant of the date suffix on
// "Market Price (As of 2026-07-01)" so a new export never breaks the import.
// ---------------------------------------------------------------------------
const HEADER_MAP = [
  [/^portfolio/i, 'portfolio'],
  [/^category/i, 'category'],
  [/^set$/i, 'set'],
  [/^product\s*name/i, 'product_name'],
  [/^card\s*number/i, 'card_number'],
  [/^rarity/i, 'rarity'],
  [/^variance/i, 'variance'],
  [/^grade$/i, 'grade'],
  [/^card\s*condition/i, 'card_condition'],
  [/^average\s*cost/i, 'avg_cost'],
  [/^quantity/i, 'quantity'],
  [/^market\s*price/i, 'market_price'],
  [/^price\s*override/i, 'price_override'],
  [/^watchlist/i, 'watchlist'],
  [/^date\s*added/i, 'date_added'],
  [/^notes/i, 'notes'],
];
function mapHeader(cells) {
  return cells.map((h) => {
    const t = (h || '').trim();
    for (const [re, key] of HEADER_MAP) if (re.test(t)) return key;
    return null;
  });
}

// "Market Price (As of 2026-07-01)" -> the export's price date, if present.
function priceDateFrom(headerCells) {
  for (const h of headerCells) {
    const m = /market\s*price.*?(\d{4}-\d{2}-\d{2})/i.exec(h || '');
    if (m) return m[1];
  }
  return null;
}

export function parseCollectr(text) {
  const warnings = [];
  const all = parseCsv(text);
  if (!all.length) return { header: [], rows: [], warnings: ['empty file'] };
  const keys = mapHeader(all[0]);
  if (!keys.includes('product_name') || !keys.includes('category')) {
    return { header: all[0], rows: [], warnings: ['not a Collectr export — expected header with Category/Product Name'] };
  }
  const priceDate = priceDateFrom(all[0]);
  const rows = [];
  for (let i = 1; i < all.length; i++) {
    const cells = all[i];
    if (!cells.length || cells.every((c) => (c || '').trim() === '')) continue;
    const r = { _line: i + 1, market_price_date: priceDate };
    keys.forEach((k, j) => { if (k) r[k] = (cells[j] != null ? cells[j] : '').trim(); });
    if (!r.product_name) { warnings.push('row ' + (i + 1) + ': no Product Name — skipped'); continue; }
    rows.push(r);
  }
  return { header: all[0], rows, warnings };
}

// ---------------------------------------------------------------------------
// Field parsers
// ---------------------------------------------------------------------------

// "4,051.73" | "974.76" | "0" | "" -> float | null (0 = Collectr has no value).
export function parseMoney(s) {
  const t = String(s == null ? '' : s).replace(/[",$\s]/g, '').replace(/,/g, '');
  if (t === '') return null;
  const v = parseFloat(t);
  if (!isFinite(v)) return null;
  return v > 0 ? v : null;
}

// Variance = edition + finish. 'Normal' | 'Holofoil' | 'Reverse Holofoil' |
// '1st Edition' | 'Unlimited Holofoil' | '1st Edition Holofoil' (observed).
export function parseVariance(variance) {
  let s = String(variance == null ? '' : variance).trim();
  let edition = null;
  if (/^1st\s*edition\b/i.test(s)) { edition = '1st Edition'; s = s.replace(/^1st\s*edition\b\s*/i, ''); }
  else if (/^unlimited\b/i.test(s)) { edition = 'Unlimited'; s = s.replace(/^unlimited\b\s*/i, ''); }
  let finish;
  if (/reverse/i.test(s)) finish = 'Reverse Holofoil';
  else if (/holo/i.test(s)) finish = 'Holofoil';
  else if (/enchanted/i.test(s)) finish = 'Enchanted';
  else if (/foil/i.test(s)) finish = 'Foil';
  else finish = 'Normal';
  return { edition, finish, variant: variantToken(edition, finish) };
}

// Grade = 'Ungraded' | '<Company> <grade> <label...>' (PSA 10.0 GEM - MT, BGS 10.0
// Black Label, TAG 10.0 Pristine). '10.0' -> 10 numeric so the PriceCharting ladder
// rungs ('PSA 10') match. Unknown shapes degrade to raw + a warning (GR7).
export function parseGrade(gradeCell) {
  const s = String(gradeCell == null ? '' : gradeCell).trim();
  if (!s || /^ungraded$/i.test(s)) return { graded: false };
  const m = /^([A-Za-z]{2,6})\s+(\d+(?:\.\d+)?)\s*(.*)$/.exec(s);
  if (!m) return { graded: false, warning: 'unrecognised Grade "' + s + '" — treated as raw' };
  const grade = parseFloat(m[2]);
  return {
    graded: true,
    grading_company: m[1].toUpperCase(),
    grade: isFinite(grade) ? Math.round(grade * 10) / 10 : null,
    grade_label: s,
  };
}

// Card Number formats: '149' | '4' | '123/172' | '050/185' | '203/193'.
// display stays VERBATIM for the title (GR5); lookupNum is the bare number with
// leading zeros stripped, for identity resolution against the game APIs.
export function normalizeNumber(raw) {
  const display = String(raw == null ? '' : raw).trim();
  let lookupNum = display.split('/')[0].trim().replace(/^0+(?=\w)/, '');
  return { display, lookupNum };
}

// Strip ONLY a trailing "(<number>)" that repeats the card number ('Misty (18)').
// Meaningful parentheticals — (Full Art), (Team Plasma), (Bottom), (Prime),
// (Delta Species) — pass through verbatim (they're value-bearing, GR5).
export function cleanProductName(name, lookupNum) {
  const s = String(name == null ? '' : name).trim();
  const m = /^(.*?)\s*\((\d+)\)\s*$/.exec(s);
  if (m && lookupNum && m[2].replace(/^0+(?=\d)/, '') === String(lookupNum)) return m[1].trim();
  return s;
}

// Collectr Category -> our GAMES key (null = game not supported by the tool;
// the row still imports/saves with Collectr's own data but can't enrich or export).
export const COLLECTR_GAMES = {
  'pokemon': 'pokemon', 'pokémon': 'pokemon',
  'lorcana': 'lorcana', 'disney lorcana': 'lorcana',
  'magic': 'mtg', 'magic: the gathering': 'mtg', 'mtg': 'mtg',
  'star wars unlimited': 'swu', 'star wars: unlimited': 'swu',
  'riftbound': 'riftbound',
};
export function gameFor(category) {
  return COLLECTR_GAMES[String(category == null ? '' : category).trim().toLowerCase()] || null;
}

// ---------------------------------------------------------------------------
// CollectrRow -> canonical ImportRow (+ per-row warnings). market currency is a
// passed POLICY ('AUD' default — the owner's Collectr shows AUD; 'USD' converts
// downstream via /api/fx). Floats only; no FX; no cents (GR3 boundary is pricing).
// ---------------------------------------------------------------------------
export function toImportRow(cr, opts = {}) {
  const warnings = [];
  const marketCurrency = (opts.marketCurrency || 'AUD').toUpperCase();
  const game = opts.game !== undefined ? opts.game : gameFor(cr.category);
  if (!game) warnings.push('row ' + (cr._line || '?') + ': unsupported game "' + (cr.category || '') + '" — imported without enrichment/eBay category');

  const { display: number, lookupNum } = normalizeNumber(cr.card_number);
  const name = cleanProductName(cr.product_name, lookupNum);
  const vr = parseVariance(cr.variance);
  const gr = parseGrade(cr.grade);
  if (gr.warning) warnings.push('row ' + (cr._line || '?') + ': ' + gr.warning);

  const market = parseMoney(cr.market_price);
  const override = parseMoney(cr.price_override);
  const cost = parseMoney(cr.avg_cost);
  const qty = Math.max(1, Math.round(parseFloat(cr.quantity) || 1));

  const row = {
    source: 'collectr',
    portfolio: cr.portfolio || '',
    game,
    identity_key: null,                     // filled by best-effort enrichment
    lookup_num: lookupNum,                  // resolver input (stripped number)
    name,
    set_id: null,
    set_name: cr.set || '',
    number,
    rarity: cr.rarity || '',
    finish: vr.finish,
    edition: vr.edition,
    variant: gr.graded ? vr.variant : vr.variant,
    printing_key: null,
    language: 'EN',
    image: null,
    condition: cr.card_condition || '',
    quantity: qty,
    graded: !!gr.graded,
    grading_company: gr.graded ? gr.grading_company : null,
    grade: gr.graded ? gr.grade : null,
    grade_label: gr.graded ? gr.grade_label : null,
    cost_aud: cost,                         // Collectr cost basis (owner's display currency)
    override_aud: override,                 // Price Override 0 => null (no $0 overrides)
    market_currency: marketCurrency,
    market_source_value: market,            // raw Collectr figure retained verbatim (GR4 audit)
    market_usd: marketCurrency === 'USD' ? market : null,
    market_aud: marketCurrency === 'AUD' ? market : null,
    market_source: 'collectr',
    watchlist: /^true$/i.test(cr.watchlist || ''),
    date_added: cr.date_added || null,
    notes: cr.notes || '',
    market_price_date: cr.market_price_date || null,
    resolved: false,
  };
  return { row, warnings };
}

// Whole-file convenience: parse + map. Returns { rows, warnings, summaryBase }.
export function importCollectr(text, opts = {}) {
  const parsed = parseCollectr(text);
  const warnings = [...parsed.warnings];
  const rows = [];
  for (const cr of parsed.rows) {
    const { row, warnings: w } = toImportRow(cr, opts);
    warnings.push(...w);
    rows.push(row);
  }
  const portfolios = [...new Set(rows.map((r) => r.portfolio).filter(Boolean))];
  const byGame = {};
  for (const r of rows) { const k = r.game || (r.source === 'collectr' ? 'unsupported' : '?'); byGame[k] = (byGame[k] || 0) + 1; }
  return { rows, warnings, portfolios, byGame };
}
