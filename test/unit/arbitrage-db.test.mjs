// test/unit/arbitrage-db.test.mjs — the arbitrage tables (lib/db.mjs migrateArbitrage) and the
// per-day eBay call budget (lib/arbitrage.mjs budgetState / reserveCall).
//
// The budget is the one thing in this feature that can hurt the rest of the app: comps, the repricer
// and the testbed share the same Browse token, so a counter that under-counts or forgets to refuse
// spends their day too. Pinned on a fresh non-cached handle (openDbAt) so nothing here can touch
// data/tracker.db.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { budgetState, reserveCall, utcDay, referenceFor } from '../../lib/arbitrage.mjs';
import { tmpFile } from '../helpers/tmp.mjs';

const db = openDbAt(tmpFile('arb-test.db'));
after(() => { try { db.close(); } catch { /* teardown must never throw */ } });

describe('migrateArbitrage', () => {
  it('creates the four tables and the hit indexes', () => {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'arb_%' OR name LIKE 'idx_arb_%'`).all().map((r) => r.name);
    for (const t of ['arb_watch', 'arb_hits', 'arb_scans', 'arb_budget', 'arb_sweep_sets', 'arb_market_snapshots', 'arb_reference_prices', 'idx_arb_hits_status', 'idx_arb_hits_card', 'idx_arb_snap_day']) assert.ok(names.includes(t), 'missing ' + t);
    assert.ok(db.prepare('PRAGMA table_info(arb_hits)').all().some((c) => c.name === 'source'), 'source column, added by addColumnIfMissing so an existing table gets it too');
  });
  it('money columns are integer cents beside a currency column (GR3)', () => {
    const cols = db.prepare('PRAGMA table_info(arb_hits)').all();
    const col = (n) => cols.find((c) => c.name === n);
    for (const n of ['price_cents', 'ship_cents', 'fee_cents', 'delivered_cents', 'market_usd_cents', 'buyer_aud_cents', 'profit_cents']) assert.equal(col(n).type, 'INTEGER', n);
    assert.equal(col('market_usd_cents').notnull, 0, 'a reference-priced hit may have no live market');
    for (const n of ['buyer_basis', 'ref_market_usd_cents', 'ref_date', 'ref_source', 'store_factor']) assert.ok(col(n), 'missing ' + n);
    assert.equal(col('price_currency').dflt_value, "'AUD'");
    assert.equal(col('market_currency').dflt_value, "'USD'");
    assert.equal(col('fx_usd_aud').notnull, 1, 'the rate that joined the two currencies is mandatory');
  });
  it('one row per listing per card+printing, and a watch row per card+printing', () => {
    const ins = db.prepare(`INSERT INTO arb_hits (set_id, card_id, number, name, printing_key, item_id, price_cents, ship_cents, delivered_cents, market_usd_cents, fx_usd_aud, buyer_pct, buyer_aud_cents, profit_cents, first_seen, last_seen)
                            VALUES ('sv3','sv3-125','125','Charizard ex','holofoil',?,999,0,1109,546,1.39,0.8,607,-502,'t','t')`);
    ins.run('v1|1|0');
    assert.throws(() => ins.run('v1|1|0'), /UNIQUE/);
    const w = db.prepare(`INSERT INTO arb_watch (set_id, card_id, number, name, printing_key) VALUES ('sv3','sv3-125','125','Charizard ex',?)`);
    w.run('holofoil');
    assert.throws(() => w.run('holofoil'), /UNIQUE/);
    w.run('reverseHolofoil');   // a different printing of the same card is a different watch
  });
});

describe('the daily call budget', () => {
  const cfg = { daily_call_budget: 3 };
  it('starts at zero for today and counts attempts', () => {
    assert.deepEqual(budgetState(db, cfg), { day: utcDay(), used: 0, cap: 3, remaining: 3 });
    assert.equal(reserveCall(db, cfg), true);
    assert.equal(reserveCall(db, cfg), true);
    assert.equal(budgetState(db, cfg).remaining, 1);
  });
  it('refuses at the cap WITHOUT recording the refused attempt', () => {
    assert.equal(reserveCall(db, cfg), true);
    assert.equal(reserveCall(db, cfg), false);
    assert.equal(reserveCall(db, cfg), false);
    assert.deepEqual(budgetState(db, cfg), { day: utcDay(), used: 3, cap: 3, remaining: 0 });
  });
  it('a bigger reservation is refused when it would overrun, even with calls left', () => {
    const wide = { daily_call_budget: 10 };
    assert.equal(budgetState(db, wide).remaining, 7);
    assert.equal(reserveCall(db, wide, 8), false);
    assert.equal(reserveCall(db, wide, 7), true);
    assert.equal(budgetState(db, wide).remaining, 0);
  });
  it('the day is UTC, and yesterday\'s spend does not count', () => {
    db.prepare(`INSERT INTO arb_budget (day, calls, updated_at) VALUES ('2000-01-01', 999, 't')`).run();
    assert.equal(budgetState(db, { daily_call_budget: 10 }).used, 10, 'only today');
    assert.match(utcDay(new Date('2026-09-12T23:30:00+10:00')), /^2026-09-12$/, '23:30 in Sydney is 13:30 UTC — still the 12th');
    assert.equal(utcDay(new Date('2026-09-13T09:30:00+10:00')), '2026-09-12', '09:30 Sydney on the 13th is still the 12th in UTC');
  });
});

describe('the buyer\'s reference — sources and the one-time hits rebuild', () => {
  it('a day-one arb_hits with NOT NULL market_usd_cents is rebuilt nullable on the next open, rows and indexes intact', () => {
    const path = tmpFile('arb-rebuild.db');
    const d1 = openDbAt(path);
    // Recreate the table the way the first day of this feature shipped it.
    d1.exec('DROP TABLE arb_hits');
    d1.exec(`CREATE TABLE arb_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, set_id TEXT NOT NULL, card_id TEXT NOT NULL, number TEXT NOT NULL, name TEXT NOT NULL, printing_key TEXT NOT NULL, item_id TEXT NOT NULL,
      price_cents INTEGER NOT NULL, ship_cents INTEGER NOT NULL, delivered_cents INTEGER NOT NULL, market_usd_cents INTEGER NOT NULL, fx_usd_aud REAL NOT NULL, buyer_pct REAL NOT NULL, buyer_aud_cents INTEGER NOT NULL, profit_cents INTEGER NOT NULL,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', UNIQUE(card_id, printing_key, item_id))`);
    d1.exec(`INSERT INTO arb_hits (set_id, card_id, number, name, printing_key, item_id, price_cents, ship_cents, delivered_cents, market_usd_cents, fx_usd_aud, buyer_pct, buyer_aud_cents, profit_cents, first_seen, last_seen) VALUES ('sv3','sv3-1','1','Oddish','normal','v1|9|0',100,0,100,50,1.4,0.8,56,-44,'t','t')`);
    d1.close();
    const d2 = openDbAt(path);
    const col = d2.prepare('PRAGMA table_info(arb_hits)').all().find((c) => c.name === 'market_usd_cents');
    assert.equal(col.notnull, 0);
    assert.equal(d2.prepare('SELECT COUNT(*) AS n FROM arb_hits').get().n, 1, 'the row survived');
    assert.ok(d2.prepare('PRAGMA table_info(arb_hits)').all().some((c) => c.name === 'buyer_basis'), 'the new columns were added after the rebuild');
    const idx = d2.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'arb_hits'").all().map((r) => r.name);
    assert.ok(idx.includes('idx_arb_hits_status') && idx.includes('idx_arb_hits_card'));
    assert.throws(() => d2.prepare(`INSERT INTO arb_hits (set_id, card_id, number, name, printing_key, item_id, price_cents, ship_cents, delivered_cents, market_usd_cents, fx_usd_aud, buyer_pct, buyer_aud_cents, profit_cents, first_seen, last_seen) VALUES ('sv3','sv3-1','1','Oddish','normal','v1|9|0',100,0,100,50,1.4,0.8,56,-44,'t','t')`).run(), /UNIQUE/, 'the unique key survived');
    d2.prepare(`INSERT INTO arb_hits (set_id, card_id, number, name, printing_key, item_id, price_cents, ship_cents, delivered_cents, market_usd_cents, fx_usd_aud, buyer_pct, buyer_aud_cents, profit_cents, first_seen, last_seen) VALUES ('me5','me5-116','116','Mega Darkrai ex','holofoil','v1|10|0',30000,0,30000,NULL,1.4,0.8,33680,3680,'t','t')`).run();
    d2.close();
  });
  it('referenceFor: manual beats snapshot beats tracker, holo variants match holo printings, and gaps are honoured', () => {
    db.prepare(`INSERT INTO arb_market_snapshots (day, card_id, printing_key, market_usd_cents) VALUES ('2026-07-20','sv3-125','holofoil',27500), ('2026-08-30','sv3-125','holofoil',20000)`).run();
    let r = referenceFor(db, 'sv3-125', 'holofoil', '2026-07-24', 7);
    assert.equal(r.source, 'snapshot'); assert.equal(r.market_usd_cents, 27500); assert.equal(r.gap_days, 4);
    db.prepare(`INSERT INTO arb_reference_prices (card_id, printing_key, ref_date, market_usd_cents) VALUES ('sv3-125','holofoil','2026-07-24',28067)`).run();
    r = referenceFor(db, 'sv3-125', 'holofoil', '2026-07-24', 7);
    assert.equal(r.source, 'manual'); assert.equal(r.market_usd_cents, 28067);
    // The tracker: a Holo watch row with July snapshots stands for the holofoil printing, not the normal one.
    const wid = db.prepare(`INSERT INTO watchlist (game, identity_key, name, variant) VALUES ('pokemon','sv3-130','Umbreon','Holo')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO price_snapshots (card_id, ts, market, low, currency, source) VALUES (?, '2026-07-23 10:00:00', 3.10, 2, 'USD', 'pokemontcg')`).run(wid);
    assert.equal(referenceFor(db, 'sv3-130', 'reverseHolofoil', '2026-07-24', 7).market_usd_cents, 310);
    assert.equal(referenceFor(db, 'sv3-130', 'normal', '2026-07-24', 7), null, 'a Holo watch row says nothing about the normal printing');
    assert.equal(referenceFor(db, 'sv3-130', 'reverseHolofoil', '2026-09-01', 7), null, 'outside the gap');
    assert.equal(referenceFor(db, 'sv3-999', 'holofoil', '2026-07-24', 7), null);
  });
});
