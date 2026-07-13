// test/unit/collector.test.mjs — the signal engine (lib/collector.mjs computeSignals). Seeds a
// throwaway node:sqlite DB (never touches data/*.db); offline. Covers the tier-agnostic computed
// path (pctFromHistory), the Scrydex percent_change path, and the null-AUD opportunity gate.
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../lib/db.mjs';
import { computeSignals, getThresholds, setThresholds } from '../../lib/collector.mjs';
import { tmpFile } from '../helpers/tmp.mjs';

const DEF = getThresholds();   // { opportunity_drop_pct:-10, momentum_rise_pct:15, downtrend_drop_pct:-8, min_price_aud:2 }
let db, seq = 0;
before(() => { db = openDb(tmpFile('collector-test.db')); });
afterEach(() => setThresholds(DEF));   // THRESHOLDS is module-global — restore after any mutation

function seedCard({ game = 'mtg', source = 'claude', name = 'C' } = {}) {
  const r = db.prepare(`INSERT INTO watchlist (game, identity_key, name, source) VALUES (?,?,?,?)`)
    .run(game, 'k' + (++seq), name, source);
  return Number(r.lastInsertRowid);
}
// agoDays backdates the snapshot so pctFromHistory can find a base older than the window.
function snap(cardId, { market, market_aud = null, currency = 'USD', pct_7d = null, pct_30d = null, agoDays = 0 } = {}) {
  db.prepare(`INSERT INTO price_snapshots (card_id, ts, market, currency, market_aud, source, pct_7d, pct_30d)
    VALUES (?, datetime('now', ?), ?, ?, ?, 'manual', ?, ?)`).run(cardId, `-${agoDays} days`, market, currency, market_aud, pct_7d, pct_30d);
}
const kinds = (arr) => arr.map((s) => s.kind).sort();

describe('computeSignals — computed path (pctFromHistory)', () => {
  it('watched (non-held) card down ≥10% with AUD ≥ min → opportunity', () => {
    const id = seedCard({ name: 'Drop' });
    snap(id, { market: 100, agoDays: 10 });               // base
    snap(id, { market: 88, market_aud: 50 });             // current: -12%
    const sig = computeSignals(db, id);
    assert.deepEqual(kinds(sig), ['opportunity']);
    assert.equal(sig[0].window, '7d');
  });
  it('card up ≥15% → momentum', () => {
    const id = seedCard({ name: 'Rise' });
    snap(id, { market: 100, agoDays: 10 });
    snap(id, { market: 120, market_aud: 200 });           // +20%
    assert.deepEqual(kinds(computeSignals(db, id)), ['momentum']);
  });
  it('HELD card down ≥8% → downtrend', () => {
    const id = seedCard({ source: 'user', name: 'Held' });
    snap(id, { market: 100, agoDays: 10 });
    snap(id, { market: 90, market_aud: 50 });             // -10%
    assert.deepEqual(kinds(computeSignals(db, id)), ['downtrend']);
  });
  it('boundary: exactly -10% fires opportunity; -9.9% is quiet', () => {
    const a = seedCard(); snap(a, { market: 100, agoDays: 10 }); snap(a, { market: 90, market_aud: 50 });
    assert.deepEqual(kinds(computeSignals(db, a)), ['opportunity']);
    const b = seedCard(); snap(b, { market: 100, agoDays: 10 }); snap(b, { market: 90.1, market_aud: 50 });
    assert.deepEqual(computeSignals(db, b), []);
  });
});

describe('computeSignals — Scrydex percent_change path (riftbound pct_7d)', () => {
  it('uses pct_7d directly (no history needed)', () => {
    const id = seedCard({ game: 'riftbound', name: 'RB' });
    snap(id, { market: 20, market_aud: 30, pct_7d: -12 });
    assert.deepEqual(kinds(computeSignals(db, id)), ['opportunity']);
  });
});

describe('computeSignals — null-AUD opportunity gate (the fix)', () => {
  it('null AUD (FX down at snapshot) FAILS the gate → no opportunity', () => {
    const id = seedCard({ game: 'riftbound', name: 'NoFx' });
    snap(id, { market: 1.5, market_aud: null, pct_7d: -12 });   // -12% but AUD unknown
    assert.deepEqual(computeSignals(db, id), []);
  });
  it('same drop WITH AUD ≥ min → opportunity fires (contrast)', () => {
    const id = seedCard({ game: 'riftbound', name: 'HasFx' });
    snap(id, { market: 1.5, market_aud: 5, pct_7d: -12 });
    assert.deepEqual(kinds(computeSignals(db, id)), ['opportunity']);
  });
  it('null AUD still allows momentum (price gate only applies to opportunity)', () => {
    const id = seedCard({ game: 'riftbound', name: 'MomNoFx' });
    snap(id, { market: 5, market_aud: null, pct_7d: 20 });
    assert.deepEqual(kinds(computeSignals(db, id)), ['momentum']);
  });
});
