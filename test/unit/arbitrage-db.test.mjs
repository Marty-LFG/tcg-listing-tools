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
import { budgetState, reserveCall, utcDay } from '../../lib/arbitrage.mjs';
import { tmpFile } from '../helpers/tmp.mjs';

const db = openDbAt(tmpFile('arb-test.db'));
after(() => { try { db.close(); } catch { /* teardown must never throw */ } });

describe('migrateArbitrage', () => {
  it('creates the four tables and the hit indexes', () => {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'arb_%' OR name LIKE 'idx_arb_%'`).all().map((r) => r.name);
    for (const t of ['arb_watch', 'arb_hits', 'arb_scans', 'arb_budget', 'idx_arb_hits_status', 'idx_arb_hits_card']) assert.ok(names.includes(t), 'missing ' + t);
  });
  it('money columns are integer cents beside a currency column (GR3)', () => {
    const cols = db.prepare('PRAGMA table_info(arb_hits)').all();
    const col = (n) => cols.find((c) => c.name === n);
    for (const n of ['price_cents', 'ship_cents', 'fee_cents', 'delivered_cents', 'market_usd_cents', 'buyer_aud_cents', 'profit_cents']) assert.equal(col(n).type, 'INTEGER', n);
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
