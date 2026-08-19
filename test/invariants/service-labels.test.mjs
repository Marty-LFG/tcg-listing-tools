// test/invariants/service-labels.test.mjs — one canonical source for buyer-facing postage service names.
//
// A live eBay listing rendered "AUP 500 G SATCHEL SIG" in its postage options table, because the only
// thing between an eBay service CODE and the buyer was prettifyServiceCode(). SERVICE_LABELS in
// lib/postage.mjs is now that source. These pins stop it drifting from the two files that also carry
// the names on disk, and stop a retired Australia Post product name being printed to a buyer.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_LABELS, isDerivedServiceLabel, prettifyServiceCode } from '../../lib/postage.mjs';
import { DEFAULT_BANDS } from '../../lib/shipping-bands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const servicesOf = (bands) => (bands || []).flatMap((b) => (b.services || []));

describe('SERVICE_LABELS is the single source for a postage service name', () => {
  it('every service DEFAULT_BANDS names uses the canonical label', () => {
    const svcs = servicesOf(DEFAULT_BANDS);
    assert.ok(svcs.length >= 4, 'DEFAULT_BANDS should still carry its service tables');
    for (const s of svcs) {
      assert.ok(SERVICE_LABELS[s.code], `${s.code} is offered by a band but has no canonical label`);
      assert.equal(s.label, SERVICE_LABELS[s.code], `${s.code} label drifted from SERVICE_LABELS`);
    }
  });

  it('the shipped example config agrees, so a fresh install starts correct', () => {
    for (const s of servicesOf(readJson('data/ebay-listing.config.example.json').shipping.bands)) {
      assert.equal(s.label, SERVICE_LABELS[s.code], `${s.code} label drifted in the example config`);
    }
  });

  it('no canonical label is one a machine would have derived', () => {
    // The whole failure mode was a prettified code masquerading as a name. If a curated label ever
    // equals its own prettify output, the heal cannot tell it from the bug it exists to repair.
    for (const [code, label] of Object.entries(SERVICE_LABELS)) {
      assert.equal(isDerivedServiceLabel(code, label), false,
        `${code}: "${label}" is indistinguishable from prettifyServiceCode() output`);
    }
  });

  it('never prints a weight tier Australia Post has retired', () => {
    // Prepaid Parcel Post satchels are Extra small..Extra large, all 5kg. The "500g satchel" product
    // no longer exists, so naming it would be a confidently wrong product name rather than an ugly one.
    for (const [code, label] of Object.entries(SERVICE_LABELS)) {
      assert.ok(!/\d\s*(g|kg)\b/i.test(label), `${code}: "${label}" names a weight tier`);
    }
  });

  it('describes tracking honestly — the label is part of the service claim (GR6)', () => {
    // A label saying "tracked" on an untracked service is an item-not-as-described claim on every
    // listing in that band. These four are pinned against what the account's policies really post.
    const tracked = ['AU_AusPostPriorityLetterWithTracking', 'AU_Regular', 'AUP_500G_SATCHEL_SIG'];
    for (const code of tracked) {
      assert.match(SERVICE_LABELS[code], /track/i, `${code} is a tracked service and should say so`);
    }
    assert.ok(!/track/i.test(SERVICE_LABELS.AU_AusPostStandardLetter),
      'the untracked letter must not claim tracking');
  });

  it('quotes no delivery estimate — Australia Post and eBay disagree on the same service', () => {
    for (const [code, label] of Object.entries(SERVICE_LABELS)) {
      assert.ok(!/\bday/i.test(label), `${code}: "${label}" quotes a delivery estimate`);
    }
  });

  it('prettifyServiceCode still produces the exact strings the heal has to recognise', () => {
    // If prettify ever changes, the heuristic that identifies already-poisoned live labels goes blind
    // and those listings keep their codes forever. Pinned to the strings read off the live config.
    assert.equal(prettifyServiceCode('AU_AusPostStandardLetter'), 'Aus Post Standard Letter');
    assert.equal(prettifyServiceCode('AU_AusPostPriorityLetterWithTracking'), 'Aus Post Priority Letter With Tracking');
    assert.equal(prettifyServiceCode('AU_Regular'), 'Regular');
    assert.equal(prettifyServiceCode('AUP_500G_SATCHEL_SIG'), 'AUP 500 G SATCHEL SIG');
  });
});
