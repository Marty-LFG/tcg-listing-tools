// Guards the DRY address-label contract shared by orders.html and shipping-label.html.
// label-render.js is a browser classic-script that assigns window.LR; we run it here with a tiny
// window/document shim (its canvas is only touched inside render fns, not at load) and assert the
// address helpers converge — the comma-vs-no-comma divergence that motivated the single renderer.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const src = readFileSync(new URL('../../label-render.js', import.meta.url), 'utf8')
const window = {}
const document = { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 0 }) }) }) }
new Function('window', 'document', src)(window, document)
const LR = window.LR

test('LR loaded from the classic script', () => {
  assert.ok(LR && typeof LR.cleanAddressLines === 'function' && typeof LR.normalizeLocality === 'function')
})

test('normalizeLocality collapses AU locality commas, leaves other lines alone', () => {
  assert.equal(LR.normalizeLocality('Werribee, VIC, 3030'), 'Werribee VIC 3030')
  assert.equal(LR.normalizeLocality('Werribee, VIC 3030'), 'Werribee VIC 3030')
  assert.equal(LR.normalizeLocality('Werribee VIC  3030'), 'Werribee VIC 3030')   // double space too
  assert.equal(LR.normalizeLocality('43 Westminster Drive'), '43 Westminster Drive')
  assert.equal(LR.normalizeLocality('Unit 4, 22 Pine St'), 'Unit 4, 22 Pine St')   // no state+postcode → untouched
})

test('cleanAddressLines: structured order → AusPost-style comma-free lines', () => {
  const order = { ship_name: 'Jerilee McLaughlin', ship_street1: '43 Westminster Drive', ship_city: 'Werribee', ship_state: 'VIC', ship_postal: '3030', ship_country: 'AU' }
  assert.deepEqual(LR.cleanAddressLines(order), ['Jerilee McLaughlin', '43 Westminster Drive', 'Werribee VIC 3030'])
})

test('cleanAddressLines strips eBay username + phone, drops the domestic AU country line', () => {
  const order = {
    ship_name: 'Jerilee McLaughlin', ship_street1: 'ebay:coincaseexchange', ship_street2: '43 Westminster Drive',
    ship_city: 'Werribee', ship_state: 'VIC', ship_postal: '3030', ship_country_name: 'Australia', ship_phone: '+61 400 611 332'
  }
  assert.deepEqual(LR.cleanAddressLines(order), ['Jerilee McLaughlin', '43 Westminster Drive', 'Werribee VIC 3030'])
})

test('foreign country line is kept', () => {
  const order = { ship_name: 'Sam Lee', ship_street1: '22 Pine St', ship_city: 'Austin', ship_state: 'TX', ship_postal: '78701', ship_country_name: 'United States' }
  assert.deepEqual(LR.cleanAddressLines(order), ['Sam Lee', '22 Pine St', 'Austin TX 78701', 'United States'])
})

test('qrSVG degrades to empty string when the qrcode lib is absent (no throw)', () => {
  // `qrcode` global is not defined in this shim → graceful empty, never an exception.
  assert.equal(LR.qrSVG('https://example.com'), '')
})

const O1 = { order_id: '17-1', sales_record_number: '10', buyer_username: 'archaon', ship_name: 'Sam Lee', ship_street1: '9 King St', ship_city: 'East Maitland', ship_state: 'NSW', ship_postal: '2323', ship_country: 'AU', currency: 'AUD', total_cents: 3050, paid_time: '2026-07-24T05:25:00Z', items: [{ title: 'Scraggy 138/086', quantity: 1, unit_price_cents: 3050, sku: 'AAC-066' }] }
const O2 = { order_id: '04-2', sales_record_number: '11', buyer_username: 'archaon', ship_name: 'Sam Lee', ship_street1: '9 King St', ship_city: 'East Maitland', ship_state: 'NSW', ship_postal: '2323', ship_country: 'AU', currency: 'AUD', total_cents: 5350, paid_time: '2026-07-24T05:13:00Z', items: [{ title: 'Okidogi 74/64', quantity: 1, unit_price_cents: 5350, sku: 'AAC-077' }, { title: 'Blitzle 114/086', quantity: 2, unit_price_cents: 500, sku: 'AAC-067' }] }

test('packingSlipHTML(single order) — one order id, order total, ship-to', () => {
  const html = LR.packingSlipHTML(O1)
  assert.match(html, /Order 17-1/)
  assert.match(html, /Order total/)
  assert.match(html, /Sam Lee/)
  assert.doesNotMatch(html, /htag">PACKING SLIP &middot; COMBINED/)
  assert.doesNotMatch(html, /<div class="ordhdr"/)   // no per-order sub-header elements on a single slip
})

test('packing slip is the CUSTOMER copy — no picking tick-box, no internal box/SKU code', () => {
  const html = LR.packingSlipHTML(O1)
  assert.doesNotMatch(html, /<span class="tick">/)      // no pick-off checkbox on the customer slip
  assert.doesNotMatch(html, /<span class="bx">/)        // no box/SKU column
  assert.doesNotMatch(html, />Box</)                    // no "Box" header cell
  assert.doesNotMatch(html, /AAC-066/)                  // the internal slot code is not shown to the buyer
  assert.match(html, /class="th/)                       // the (larger) card image column stays
})

test('packingSlipHTML([o1,o2]) — combined slip: both orders, one ship-to, combined total', () => {
  const html = LR.packingSlipHTML([O1, O2])
  assert.match(html, /htag">PACKING SLIP &middot; COMBINED/)
  assert.equal((html.match(/<div class="ordhdr"/g) || []).length, 2)   // one sub-header per order
  assert.match(html, /Order 17-1/)
  assert.match(html, /Order 04-2/)                      // both order ids appear (as sub-headers)
  assert.match(html, /2 orders/)
  assert.match(html, /Combined total/)
  assert.match(html, /A\$84\.00/)                       // 30.50 + 53.50 = 84.00
  assert.equal((html.match(/SHIP TO/g) || []).length, 1)   // ship-to printed once
  assert.equal((html.match(/Sam Lee/g) || []).length, 1)
  assert.match(html, /Thanks so much for your orders/)  // plural
})

test('packingSlipHTML([oneOrder]) — a single-item array is NOT treated as combined', () => {
  const html = LR.packingSlipHTML([O1])
  assert.doesNotMatch(html, /htag">PACKING SLIP &middot; COMBINED/)
  assert.match(html, /Order total/)
})

test('packing slip date is the SYDNEY date (rolls over near UTC midnight)', () => {
  // 24 Jul 14:30 UTC = 25 Jul 00:30 in Sydney — the slip must print the 25th, not the raw ISO 24th.
  const html = LR.packingSlipHTML({ ...O1, paid_time: '2026-07-24T14:30:00Z' })
  assert.match(html, /25 \w+ 2026/)
  assert.doesNotMatch(html, /hord">Order 17-1<\/div><div class="hsub">24 /)
})

test('pickSheetHTML — box-grouped seller list: tick box + image + full slot code + order', () => {
  const groups = [{ location: 'Box AAB', items: [{ sku: 'AAB-012', quantity: 1, title: 'Dreepy 247/217', order_id: '27-1', image_url: 'x.png' }] }]
  const html = LR.pickSheetHTML(groups, { order_count: 1, item_count: 1, unit_count: 1 })
  assert.match(html, /Box AAB/)                    // grouped by box
  assert.match(html, /AAB-012/)                    // the full slot code stays on the pick sheet
  assert.match(html, /<td class="chk">/)           // pick-off tick box
  assert.match(html, /class="pim"/)                // card image cell for a fast visual match
  assert.match(html, /27-1/)                       // order id column
  assert.match(html, /SORTED BY BOX/)
})

/* ---------- postage on the printed docs ----------
   The governing rule: only exceptions get ink. Roughly nine in ten card orders are free untracked
   letters, so a badge on every row would destroy the scan — the default has to be silent, and the
   upgrade has to be unmissable. These pin both halves of that.

   The second rule is that no tier marker may depend on a printed background. Browsers print with
   "Background graphics" off by default, so a reversed block can come out as white text on white
   paper. Invisible is the one failure this feature cannot have. */

const POST = (over = {}) => ({ tier: 'standard', upgrade: false, tracked: false, label: 'Standard delivery', paid_cents: 0, ...over })
// The store's NORMAL band since postage went banded: a $1.70 untracked letter. It is paid, and it
// still needs nothing different from the packer, so it must stay as quiet as a free letter ever was.
const LETTER = POST({ label: 'Regular letter', paid_cents: 170 })
const TRACKED = POST({ tier: 'tracked', upgrade: true, tracked: true, label: 'Tracked letter', paid_cents: 826 })
const EXPRESS = POST({ tier: 'express', upgrade: true, tracked: true, label: 'Express Post', paid_cents: 1295,
  eta_min: '2026-08-04T04:00:00.000Z', eta_max: '2026-08-06T04:00:00.000Z', eta_source: 'estimated' })

test('packing slip: a plain letter gets one quiet line and no block', () => {
  const html = LR.packingSlipHTML({ ...O1, postage: POST() })
  assert.match(html, /POSTAGE/)
  assert.match(html, /Standard delivery/)
  assert.doesNotMatch(html, /class="pblock"/)          // no bordered block
  assert.doesNotMatch(html, /class="postage t-standard up"/)  // no heavy left rule either
})

test('packing slip: the $1.70 band prints its amount and STILL gets no ink', () => {
  // The inversion this guards against: every card order is paid postage now, so keying emphasis on
  // "the buyer paid something" would put a bordered block on every slip we ever print.
  const html = LR.packingSlipHTML({ ...O1, postage: LETTER })
  assert.match(html, /Regular letter &middot; A\$1\.70/)
  assert.doesNotMatch(html, /class="pblock"/)
  assert.doesNotMatch(html, / up"/)
  assert.doesNotMatch(html, /, free/, 'nothing is free postage any more')
})

test('packing slip: the tracked band DOES earn the block and the rule', () => {
  const html = LR.packingSlipHTML({ ...O1, postage: TRACKED })
  assert.match(html, /class="postage t-tracked up"/)
  assert.match(html, /<div class="pblock">TRACKED<\/div>/)
  assert.match(html, /Tracked letter &middot; A\$8\.26/)
})

test('packing slip: a signature note reaches the bench', () => {
  // The top band needs a physical thing doing that tracking alone does not imply.
  const html = LR.packingSlipHTML({ ...O1, postage: POST({ tier: 'tracked', upgrade: true, tracked: true, label: 'Tracked letter', paid_cents: 1520, note: 'signature required on delivery' }) })
  assert.match(html, /class="pnote">signature required on delivery</)
})

test('packing slip: an express order gets a bordered EXPRESS block, what they paid and the window', () => {
  const html = LR.packingSlipHTML({ ...O1, postage: EXPRESS })
  assert.match(html, /class="postage t-express up"/)
  assert.match(html, /<div class="pblock">EXPRESS<\/div>/)
  assert.match(html, /Express Post &middot; A\$12\.95/)
  assert.match(html, /Estimated arrival 4–6 Aug/)
})

test('packing slip: once the parcel is moving, the wording stops hedging and the tracking shows', () => {
  const html = LR.packingSlipHTML({ ...O1, postage: POST({
    tier: 'tracked', upgrade: true, tracked: true, label: 'Parcel Post', paid_cents: 945,
    eta_min: '2026-08-04T04:00:00.000Z', eta_max: '2026-08-04T08:00:00.000Z', eta_source: 'scheduled',
    tracking: '36LB1234567890', carrier: 'Australia Post' }) })
  assert.match(html, /Arriving 4 Aug/)
  assert.doesNotMatch(html, /Estimated arrival/)
  assert.match(html, /Tracking &middot; <b>36LB1234567890<\/b> \(Australia Post\)/)
})

test('packing slip: an order with no postage data renders exactly as it did before', () => {
  const html = LR.packingSlipHTML(O1)
  assert.doesNotMatch(html, /<section class="postage/)
  assert.match(html, /SHIP TO/)
})

test('combined slip: mixed tiers get a per-order marker so one Express cannot vouch for the others', () => {
  const html = LR.packingSlipHTML([{ ...O1, postage: EXPRESS }, { ...O2, postage: POST() }])
  assert.match(html, /class="postage t-express up"/)                 // strongest tier leads the block
  assert.equal((html.match(/class="otier t-express"/g) || []).length, 1)
  assert.match(html, /class="opost"/)
})

test('combined slip: when every order is the same tier there is no per-order noise', () => {
  const html = LR.packingSlipHTML([{ ...O1, postage: POST() }, { ...O2, postage: POST() }])
  assert.doesNotMatch(html, /class="otier/)
})

test('pick sheet: a normal run looks exactly as it always has — no banner, empty tier cells', () => {
  const groups = [{ location: 'Box AAB', items: [{ sku: 'AAB-012', quantity: 1, title: 'Dreepy 247/217', order_id: '27-1', postage_tier: 'standard' }] }]
  const html = LR.pickSheetHTML(groups, { order_count: 1, item_count: 1, unit_count: 1, upgrades: [] })
  assert.doesNotMatch(html, /class="upg"/)
  assert.match(html, /<td class="tc"><\/td>/)          // the column exists and is deliberately blank
  assert.doesNotMatch(html, /class="tier/)
})

test('pick sheet: an upgrade run leads with the banner and marks the line at the shelf', () => {
  const groups = [{ location: 'Box AAB', items: [
    { sku: 'AAB-012', quantity: 1, title: 'Dreepy', order_id: '27-1', postage_tier: 'express' },
    { sku: 'AAB-013', quantity: 1, title: 'Blitzle', order_id: '27-2', postage_tier: 'standard' },
  ] }]
  const html = LR.pickSheetHTML(groups, { order_count: 14, item_count: 2, unit_count: 2, upgrades: [
    { order_id: '27-1', buyer_username: 'archaon', tier: 'express', label: 'Express Post', paid_cents: 1295, currency: 'AUD', tracked: true },
  ] })
  assert.match(html, /1 OF 14 ORDERS NEED A POSTAGE UPGRADE|1 of 14 orders need a postage upgrade/i)
  assert.match(html, /Buy the label on eBay/)          // eBay's AU labels have no API — say whose job it is
  assert.match(html, /Express Post · A\$12\.95/)
  assert.equal((html.match(/class="tier t-express"/g) || []).length, 2)   // banner row + the shelf line
  // the banner sits above the first box, where it is read before anyone walks off
  assert.ok(html.indexOf('class="upg"') < html.indexOf('Box AAB'))
})

test('pick sheet: once the label is bought the banner says so instead of repeating the instruction', () => {
  const html = LR.pickSheetHTML([], { order_count: 1, upgrades: [
    { order_id: '27-1', tier: 'express', label: 'Express Post', tracked: true, tracking: '36LB1234567890' },
  ] })
  assert.match(html, /Label bought · 36LB1234567890/)
  assert.doesNotMatch(html, /Buy the label on eBay/)
})

test('no tier marker relies on a printed background fill', () => {
  // If "Background graphics" is off, a reversed block prints as white text on white paper.
  for (const css of [LR.pickSheetHTML([], {}), LR.packingSlipHTML(O1)]) {
    const tierRules = css.match(/\.t-(?:express|tracked|paid)\s*(?:\.pblock\s*)?\{[^}]*\}/g) || []
    // Two, not three: `paid` no longer gets a bordered block on the packing slip. It is the normal
    // band now, and a box that appears on every slip is a box nobody reads.
    assert.ok(tierRules.length >= 2, 'tier rules should be present')
    for (const rule of tierRules) {
      assert.doesNotMatch(rule, /background/, rule)
      assert.doesNotMatch(rule, /color:\s*#fff/i, rule)
    }
  }
})

/* ---------- print nudge (offXmm/offYmm) ----------
   Both address-label callers depend on this: shipping-label.html passes the calibrated nudge into
   renderLinesToJob, and orders.html passes the same value into renderAddressLabel so a given
   address lands in the same place from either page. The shift is applied in rasterizeLayout, which
   needs a canvas — so re-instantiate the classic script against a recording 2d context and read
   back the fillText coordinates. dpi 254 makes 1mm exactly 10 dots, so the expected shift is exact
   and no rounding slack is needed. */
function loadLRWithCanvas() {
  const calls = []
  const ctx = {
    fillStyle: '', textBaseline: '', font: '', textAlign: '',
    fillRect() {},
    measureText: (s) => ({ width: String(s).length * 6 }),
    fillText: (t, x, y) => calls.push({ t, x, y }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  }
  const cv = { width: 0, height: 0, getContext: () => ctx }
  const win = {}
  new Function('window', 'document', src)(win, { createElement: () => cv })
  return { LR: win.LR, calls }
}
const NUDGE_ORDER = {
  ship_name: 'Jerilee McLaughlin', ship_street1: '43 Westminster Drive',
  ship_city: 'Werribee', ship_state: 'VIC', ship_postal: '3030', ship_country: 'AU',
}

test('print nudge: no offset draws at the layout position', () => {
  const a = loadLRWithCanvas()
  a.LR.renderAddressLabel(NUDGE_ORDER, { dpi: 254 })
  const b = loadLRWithCanvas()
  b.LR.renderAddressLabel(NUDGE_ORDER, { dpi: 254, offXmm: 0, offYmm: 0 })
  assert.ok(a.calls.length >= 3, 'expected one draw per address line')
  assert.deepEqual(a.calls, b.calls)   // an explicit zero nudge is the same as none
})

test('print nudge: offXmm/offYmm shift every draw by exactly that many mm', () => {
  const plain = loadLRWithCanvas()
  plain.LR.renderAddressLabel(NUDGE_ORDER, { dpi: 254 })
  const nudged = loadLRWithCanvas()
  nudged.LR.renderAddressLabel(NUDGE_ORDER, { dpi: 254, offXmm: -4, offYmm: 2 })

  assert.equal(nudged.calls.length, plain.calls.length)
  for (let i = 0; i < plain.calls.length; i++) {
    assert.equal(nudged.calls[i].t, plain.calls[i].t)        // same text, only moved
    assert.equal(nudged.calls[i].x, plain.calls[i].x - 40)   // -4mm at 10 dots/mm
    assert.equal(nudged.calls[i].y, plain.calls[i].y + 20)   // +2mm
  }
})

test('print nudge: the job still reports the stock size, so TSPL SIZE is unaffected', () => {
  const { LR: lr } = loadLRWithCanvas()
  const job = lr.renderAddressLabel(NUDGE_ORDER, { dpi: 254, offXmm: -4 })
  assert.equal(job.wmm, 100)
  assert.equal(job.hmm, 50)
  assert.equal(job.widthDots, 1000)
  assert.equal(job.heightDots, 500)
})

// The packing slip must be ONE page, and the way it used to fail was subtle: the sheet's min-height
// and the fit pass's ceiling were both 297mm, so the ladder's best possible outcome was a sheet
// occupying exactly 100% of the page. Print-engine rounding tips that onto a second page, and so does
// any browser drawing its own header and footer. The floor and the ceiling have to be the same number
// as each other AND smaller than A4 -- these pin both halves, because moving one alone fixes nothing.
test('packing slip: the height floor and the fit ceiling agree, and both sit under A4', () => {
  const html = LR.packingSlipHTML({ order_id: '10-1-1', buyer_username: 'amy', items: [] })
  const floor = html.match(/\.sheet\{[^}]*min-height:(\d+)mm/)
  const ceiling = html.match(/height:(\d+)mm;";document\.body\.appendChild\(p\)/)
  assert.ok(floor, 'the sheet must declare a min-height')
  assert.ok(ceiling, 'the fit pass must probe a page height')
  assert.equal(floor[1], ceiling[1], 'a fit target the sheet cannot shrink below is not a target')
  assert.ok(Number(floor[1]) < 297, 'exactly A4 is the one height guaranteed to spill')
  // Enough slack to survive print chrome, without throwing away so much page that type shrinks for it.
  const slack = 297 - Number(floor[1])
  assert.ok(slack >= 8 && slack <= 25, `slack should be 8-25mm, got ${slack}mm`)
})

test('packing slip: a batch breaks BEFORE each sheet, never after the last', () => {
  // A break-after on the final sheet is the other way to produce a blank trailing page.
  const html = LR.packingSlipBatchHTML([
    [{ order_id: 'a', buyer_username: 'amy', items: [] }],
    [{ order_id: 'b', buyer_username: 'bob', items: [] }],
  ])
  assert.match(html, /\.sheet \+ \.sheet\{break-before:page/)
  assert.doesNotMatch(html, /break-after:\s*page/)
  assert.doesNotMatch(html, /page-break-after:\s*always/)
})
