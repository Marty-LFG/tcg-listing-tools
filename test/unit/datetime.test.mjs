// test/unit/datetime.test.mjs — the shared Sydney date/time formatter (datetime.js → window.TZ).
// Loaded via the same tiny window shim used for label-render.js. Locks: values render in Sydney
// (AEST/AEDT auto per DST), a near-UTC-midnight timestamp rolls to the correct Sydney day, and the
// abbreviation flips with daylight saving. (ICU may render month 'short' as "July" under small-icu;
// assertions stay icu-agnostic on the month word.)
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const src = readFileSync(new URL('../../datetime.js', import.meta.url), 'utf8')
const window = {}
const document = {}
new Function('window', 'document', src)(window, document)
const TZ = window.TZ

test('exposes window.TZ with the Sydney zone', () => {
  assert.ok(TZ && TZ.zone === 'Australia/Sydney' && TZ.label === 'Sydney')
})

test('AEST in winter, AEDT in summer', () => {
  assert.equal(TZ.abbr('2026-07-24T05:00:00Z'), 'AEST')   // July = standard time
  assert.equal(TZ.abbr('2026-01-15T05:00:00Z'), 'AEDT')   // January = daylight time
})

test('a near-UTC-midnight timestamp rolls to the correct Sydney day', () => {
  // 24 Jul 14:30 UTC = 25 Jul 00:30 AEST — the raw-ISO-slice bug would show the 24th.
  assert.equal(TZ.date('2026-07-24T14:30:00Z'), '25 Jul 2026')
  assert.equal(TZ.dateTime('2026-07-24T14:30:00Z'), '25 Jul 2026, 12:30 am')
})
test('date/time render deterministically as "24 Jul 2026" regardless of ICU build', () => {
  assert.equal(TZ.date('2026-07-24T01:06:00Z'), '24 Jul 2026')
  assert.equal(TZ.dateTime('2026-07-24T01:06:00Z'), '24 Jul 2026, 11:06 am')
})

test('stamp appends the live zone abbreviation', () => {
  assert.match(TZ.stamp('2026-07-24T05:25:00Z'), / AEST$/)      // 3:25 pm AEST
  assert.match(TZ.stamp('2026-01-15T05:00:00Z'), / AEDT$/)
})

test('clock is 24-hour with seconds (for logs)', () => {
  assert.equal(TZ.clock('2026-07-24T05:25:03Z'), '15:25:03')   // 05:25:03 UTC → 15:25:03 AEST
})

test('empty / invalid inputs return empty string, never throw', () => {
  for (const v of [null, undefined, '', 'not-a-date', NaN]) {
    assert.equal(TZ.date(v), '')
    assert.equal(TZ.dateTime(v), '')
    assert.equal(TZ.stamp(v), '')
    assert.equal(TZ.clock(v), '')
  }
})

test('ago gives relative freshness for recent times', () => {
  assert.equal(TZ.ago(new Date(Date.now() - 5000).toISOString()), 'just now')
  assert.match(TZ.ago(new Date(Date.now() - 3 * 3600e3).toISOString()), /^3h ago$/)
})
