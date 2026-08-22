// test/unit/shelf-label.test.mjs — the channel-neutral half of shelf-label allocation
// (lib/shelf-label.mjs), extracted from runPublish so the label is spent by the first real publish on
// ANY channel rather than by the eBay one specifically.
//
// The eBay end-to-end behaviour is already locked down by test/integration/deferred-label.test.mjs and
// is unchanged by that extraction. What is tested here is what the extraction ADDS: the same rules
// hold for a second channel, a dry run on any channel spends nothing, and committing twice is a no-op.
//
// No network, no eBay stack — openDbAt only, per the singleton rule.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { reserveShelfLabel, commitShelfLabel, isProvisionalSku } from '../../lib/shelf-label.mjs';
import { nextProvisionalSku, seedStockLabels, stockLabelState } from '../../lib/inventory.mjs';
import { seqForLabel } from '../../lib/sku-labels.mjs';
import { tmpFile } from '../helpers/tmp.mjs';

let db;
const counter = () => stockLabelState(db).seq;

function addItem(sku, over = {}) {
  db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity) VALUES (?,?,?,?)`)
    .run(sku, over.game || 'pokemon', over.name || 'Iono', over.quantity == null ? 1 : over.quantity);
  const id = db.prepare('SELECT id FROM inventory_items WHERE sku = ?').get(sku).id;
  return { id, sku, ...over };
}

beforeEach(() => {
  db = openDbAt(tmpFile('shelf-label-' + Math.random().toString(36).slice(2) + '.db'));
  seedStockLabels(db, seqForLabel('AAC-084'));        // the last one SPENT, so AAC-085 is next out
});

describe('a dry run on ANY channel spends nothing', () => {
  for (const channel of ['ebay', 'shopify']) {
    it(`${channel}: keeps the placeholder and leaves the series where it was`, () => {
      const before = counter();
      const item = addItem(nextProvisionalSku(db));
      const r = reserveShelfLabel(db, item, { dryRun: true, channel });
      assert.equal(r.ok, true);
      assert.ok(isProvisionalSku(r.sku), 'a dry run must publish under the placeholder');
      assert.equal(r.reservation, null);
      // …and committing a null reservation is simply nothing happening.
      assert.deepEqual(commitShelfLabel(db, item, r.reservation, { channel }),
        { committed: false, label: null, provisional: null, error: null });
      assert.equal(counter(), before, 'the counter moved on a dry run');
      assert.ok(isProvisionalSku(item.sku));
    });
  }
});

describe('a real publish on ANY channel spends the label', () => {
  for (const channel of ['ebay', 'shopify']) {
    it(`${channel}: reserves, then commits, then the row owns a real label`, () => {
      const before = counter();
      const item = addItem(nextProvisionalSku(db));

      const r = reserveShelfLabel(db, item, { channel });
      assert.equal(r.ok, true);
      assert.equal(r.sku, 'AAC-085', 'the next free label follows the last one spent');
      assert.equal(counter(), before, 'reserving must be read-only — that is what makes a retry safe');

      const c = commitShelfLabel(db, item, r.reservation, { channel });
      assert.equal(c.committed, true);
      assert.equal(c.label, 'AAC-085');
      assert.ok(isProvisionalSku(c.provisional), 'the displaced sku is handed back for channel cleanup');
      assert.equal(item.sku, 'AAC-085', 'item.sku must be mutated — the audit row and write-back key off it');
      assert.equal(db.prepare('SELECT sku FROM inventory_items WHERE id = ?').get(item.id).sku, 'AAC-085');
      assert.equal(counter(), before + 1);
    });
  }
});

describe('the label survives one channel and is not re-spent by the next', () => {
  it('Shopify commits it; eBay days later reserves nothing and commits nothing', () => {
    // This is the whole reason the commit moved out of runPublish. Shopify publishes first — possibly
    // a week before eBay, possibly instead of it — so by the time eBay runs, the row already owns a
    // real label and must pass straight through.
    const item = addItem(nextProvisionalSku(db));

    const shopify = reserveShelfLabel(db, item, { channel: 'shopify' });
    commitShelfLabel(db, item, shopify.reservation, { channel: 'shopify' });
    const after = counter();
    assert.equal(item.sku, 'AAC-085');

    const ebay = reserveShelfLabel(db, item, { channel: 'ebay' });
    assert.equal(ebay.ok, true);
    assert.equal(ebay.sku, 'AAC-085', 'eBay must publish under the label Shopify already committed');
    assert.equal(ebay.reservation, null, 'there is nothing left to reserve');

    const second = commitShelfLabel(db, item, ebay.reservation, { channel: 'ebay' });
    assert.equal(second.committed, false, 'a second commit must be a no-op, not a second number');
    assert.equal(counter(), after, 'the series moved twice for one card');
    assert.equal(item.sku, 'AAC-085');
  });

  it('a row that already owns a real label is untouched, however many times it publishes', () => {
    const before = counter();
    const item = addItem('AAB-012');
    for (const channel of ['shopify', 'ebay', 'shopify']) {
      const r = reserveShelfLabel(db, item, { channel });
      assert.equal(r.sku, 'AAB-012');
      assert.equal(r.reservation, null);
      commitShelfLabel(db, item, r.reservation, { channel });
    }
    assert.equal(counter(), before);
    assert.equal(item.sku, 'AAB-012');
  });
});

describe('refusals and failures', () => {
  it('refuses when the series is unseeded rather than starting at AAA-001', () => {
    // A fresh DB with no seeding at all. Publishing under the provisional would bind it to the listing
    // for life, which is the bug this whole mechanism replaces.
    db = openDbAt(tmpFile('shelf-label-unseeded.db'));
    const item = addItem(nextProvisionalSku(db));
    const r = reserveShelfLabel(db, item, { channel: 'shopify' });
    assert.equal(r.ok, false);
    assert.match(r.error, /not seeded/);
    assert.match(r.error, /shopify/, 'the refusal should say which channel was refused');
    assert.equal(r.reservation, null);
  });

  it('a failed commit never throws, and leaves the row on its placeholder', () => {
    // Forced by pointing a reservation at a label another row already holds: inventory_items.sku is
    // UNIQUE, so the UPDATE throws. That constraint is deliberately the thing that catches a
    // double-allocation.
    const item = addItem(nextProvisionalSku(db));
    addItem('AAC-085');                                   // somebody else already has it
    const provisional = item.sku;

    const c = commitShelfLabel(db, item, { label: 'AAC-085', seq: 999 }, { channel: 'shopify' });
    assert.equal(c.committed, false);
    assert.equal(c.label, 'AAC-085');
    assert.equal(item.sku, provisional, 'the row must stay on the placeholder when the commit failed');
    assert.ok(c.error, 'the failure is reported rather than swallowed');
    assert.equal(db.prepare('SELECT sku FROM inventory_items WHERE id = ?').get(item.id).sku, provisional);
  });

  it('a reserve that is never committed leaves the next attempt the SAME label', () => {
    const item = addItem(nextProvisionalSku(db));
    const first = reserveShelfLabel(db, item, { channel: 'shopify' });
    const second = reserveShelfLabel(db, item, { channel: 'ebay' });
    assert.equal(first.sku, second.sku, 'a failed publish must not consume the number');
    assert.equal(first.sku, 'AAC-085');
  });
});
