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
