// test/unit/repricer-propose.test.mjs — promoting a scan's `raise` rows into approvable proposals.
//
// A proposal is a promise to change a real price the instant someone taps Approve, so nearly every
// test here is about REFUSING to make that promise: the price moved, a card is already open, a
// previous apply died halfway. The happy path is one test; the rest are the hazards.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../lib/repricer-db.mjs';
import {
  promoteFromScan, expireProposals, reconcileApplying, effectiveTtlHours,
  evidenceSummary, openProposalFor,
} from '../../lib/repricer-propose.mjs';

// A real schema, not a hand-rolled one — the UNIQUE partial index is under test, so it has to be the
// index the production DDL actually creates.
const DDL_SRC = await import('node:fs').then((fs) => fs.readFileSync('lib/repricer-db.mjs', 'utf8'));
const DDL = DDL_SRC.split('const DDL = `')[1].split('`;')[0];

const CFG = { scan_enabled: false, cadence_hours: 4, guardrails: { proposal_ttl_hours: 24, target_anchor: 'cheapest_n', anchor_n: 3 } };

function db0() {
  const d = new DatabaseSync(':memory:');
  migrate(d);
  d.exec(DDL);
  return d;
}
function seedRaise(d, over = {}) {
  const c = {
    item_id: '9001', scan_id: 's1', our_price_cents: 3898, our_postage_cents: 0,
    target_delivered_cents: 4498, target_cents: 4498, n_comparable: 9, confidence: 'medium',
    mode: 'asking', query: 'Riftbound Sett - Brawler 164/298', uplift_cents: 600, uplift_pct: 15.4,
    verdict: 'raise', code: null, ...over,
  };
  const cols = Object.keys(c);
  d.prepare(`INSERT INTO price_checks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => c[k]));
  return c;
}
const liveOk = (over = {}) => async () => ({ ok: true, listing_status: 'Active', title: 'Sett - Brawler 164/298', price_cents: 3898, ...over });
const sends = () => { const out = []; return { out, fn: async (row) => { out.push(row); return { ok: true, message_id: 500 + out.length }; } }; };

describe('promoteFromScan — the happy path', () => {
  it('creates a pending proposal from the scan row and sends one card', async () => {
    const d = db0();
    seedRaise(d);
    const s = sends();
    const r = await promoteFromScan({ db: d, cfg: CFG, chatId: '-100', getLive: liveOk(), sendCard: s.fn });
    assert.equal(r.promoted.length, 1);
    assert.equal(r.sent, 1);
    const p = d.prepare('SELECT * FROM reprice_proposals').get();
    assert.equal(p.status, 'pending');
    assert.equal(p.from_price_cents, 3898);
    assert.equal(p.to_price_cents, 4498);
    assert.equal(p.telegram_message_id, 501);
    // The audit trail has to point at what it produced, or a surprising price cannot be traced back
    // to the comps that caused it.
    assert.equal(d.prepare('SELECT proposal_id FROM price_checks').get().proposal_id, p.id);
    const ev = JSON.parse(p.evidence);
    assert.equal(ev.scan_id, 's1');
    assert.match(ev.summary, /3rd cheapest Australian listing/);
  });

  it('takes the biggest uplift first when the cap bites', async () => {
    const d = db0();
    seedRaise(d, { item_id: 'A', uplift_cents: 100 });
    seedRaise(d, { item_id: 'B', uplift_cents: 900 });
    seedRaise(d, { item_id: 'C', uplift_cents: 500 });
    const r = await promoteFromScan({ db: d, cfg: CFG, chatId: '-100', max: 2, getLive: liveOk(), sendCard: sends().fn });
    assert.deepEqual(r.promoted.map((p) => p.item_id), ['B', 'C']);
    assert.deepEqual(r.refused.map((x) => x.code), ['over_max_cards_per_run']);
  });
});

// --- hazard 1: the evidence went stale ----------------------------------------------------------
describe('promoteFromScan — refuses to promise a price that no longer matches eBay', () => {
  it('refuses when the listing moved since the scan', async () => {
    const d = db0();
    seedRaise(d);
    const r = await promoteFromScan({ db: d, cfg: CFG, getLive: liveOk({ price_cents: 4200 }), sendCard: sends().fn });
    assert.equal(r.promoted.length, 0);
    assert.equal(r.refused[0].code, 'stale_price');
    assert.match(r.refused[0].detail, /A\$38\.98.*A\$42\.00/);
    assert.equal(d.prepare('SELECT COUNT(*) c FROM reprice_proposals').get().c, 0, 'nothing may be created');
  });
  it('refuses a listing that has ended', async () => {
    const d = db0();
    seedRaise(d);
    const r = await promoteFromScan({ db: d, cfg: CFG, getLive: liveOk({ listing_status: 'Completed' }), sendCard: sends().fn });
    assert.equal(r.refused[0].code, 'not_active');
  });
  it('refuses when the target is no longer an increase (AGENTS.md §15)', async () => {
    const d = db0();
    seedRaise(d, { our_price_cents: 4498, target_cents: 4498 });
    const r = await promoteFromScan({ db: d, cfg: CFG, getLive: liveOk({ price_cents: 4498 }), sendCard: sends().fn });
    assert.equal(r.refused[0].code, 'not_an_increase');
  });
  it('survives a listing it cannot read at all (GR7)', async () => {
    const d = db0();
    seedRaise(d, { item_id: 'A' });
    seedRaise(d, { item_id: 'B' });
    let n = 0;
    const r = await promoteFromScan({
      db: d, cfg: CFG, chatId: '-100', sendCard: sends().fn,
      getLive: async () => { if (n++ === 0) throw new Error('eBay exploded'); return { ok: true, listing_status: 'Active', title: 'B', price_cents: 3898 }; },
    });
    assert.equal(r.refused[0].code, 'listing_read_failed');
    assert.equal(r.promoted.length, 1, 'one bad listing must not end the pass');
  });
});

// --- hazard 2: two open cards for one listing ---------------------------------------------------
describe('open-proposal uniqueness', () => {
  it('refuses a second proposal while one is open', async () => {
    const d = db0();
    seedRaise(d);
    await promoteFromScan({ db: d, cfg: CFG, chatId: '-100', getLive: liveOk(), sendCard: sends().fn });
    seedRaise(d, { scan_id: 's2' });
    const r = await promoteFromScan({ db: d, cfg: CFG, scanId: 's2', chatId: '-100', getLive: liveOk(), sendCard: sends().fn });
    assert.equal(r.promoted.length, 0);
    assert.equal(r.refused[0].code, 'open_proposal');
  });

  it('the DATABASE refuses it, not just the check — two racing inserts cannot both win', () => {
    const d = db0();
    const ins = () => d.prepare(`INSERT INTO reprice_proposals (item_id, from_price_cents, to_price_cents, status)
                                 VALUES ('9001', 100, 200, 'pending')`).run();
    ins();
    assert.throws(ins, /UNIQUE|constraint/i, 'the partial index is the real guard');
    // …but a DECIDED proposal frees the listing, or one skip would block it forever.
    d.prepare("UPDATE reprice_proposals SET status='skipped'").run();
    assert.doesNotThrow(ins);
  });

  it('an applying row also holds the slot — approving twice is the thing being prevented', () => {
    const d = db0();
    d.prepare("INSERT INTO reprice_proposals (item_id, from_price_cents, to_price_cents, status) VALUES ('9001',100,200,'applying')").run();
    assert.throws(() => d.prepare("INSERT INTO reprice_proposals (item_id, from_price_cents, to_price_cents, status) VALUES ('9001',100,200,'pending')").run(), /UNIQUE|constraint/i);
    assert.ok(openProposalFor(d, '9001'));
    assert.equal(openProposalFor(d, 'nope'), null);
  });

  it('migrate collapses duplicates that predate the index, keeping the newest', () => {
    // A database written before v2 can hold two open rows for one listing; creating the index on it
    // would throw and take the whole server down at boot.
    const raw = new DatabaseSync(':memory:');
    raw.exec(`CREATE TABLE reprice_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT,
              from_price_cents INTEGER, to_price_cents INTEGER, status TEXT, error TEXT)`);
    raw.exec("INSERT INTO reprice_proposals (item_id,status) VALUES ('9001','pending'),('9001','pending'),('9001','applying')");
    migrate(raw);
    assert.doesNotThrow(() => raw.exec(DDL), 'the index must be creatable afterwards');
    const open = raw.prepare("SELECT id FROM reprice_proposals WHERE status IN ('pending','applying')").all();
    assert.equal(open.length, 1);
    assert.equal(open[0].id, 3, 'the newest survives — it carries the most recent evidence');
    assert.equal(raw.prepare('SELECT COUNT(*) c FROM reprice_proposals').get().c, 3, 'nothing is deleted');
  });
});

// --- hazard 3: a row stranded mid-apply ---------------------------------------------------------
describe('reconcileApplying — asks eBay what actually happened', () => {
  const strand = (d, over = {}) => d.prepare(`INSERT INTO reprice_proposals
    (item_id, from_price_cents, to_price_cents, status, decided_at)
    VALUES (?,?,?, 'applying', ?)`).run(over.item_id || '9001', 3898, 4498, over.decided_at || '2026-01-01 00:00:00');

  it('marks it applied when the price DID land', async () => {
    const d = db0(); strand(d);
    const r = await reconcileApplying(d, { getLive: async () => ({ ok: true, price_cents: 4498 }) });
    assert.deepEqual([r.applied, r.stranded], [1, 0]);
    assert.equal(d.prepare('SELECT status FROM reprice_proposals').get().status, 'applied');
  });

  it('marks it stranded when the price did NOT land — never silently re-opens it', async () => {
    // Re-opening would be the dangerous choice: if the write HAD landed, a second approve raises the
    // price twice. Stranded is a dead end a human looks at, which is the right default for money.
    const d = db0(); strand(d);
    const r = await reconcileApplying(d, { getLive: async () => ({ ok: true, price_cents: 3898 }) });
    assert.deepEqual([r.applied, r.stranded], [0, 1]);
    const p = d.prepare('SELECT * FROM reprice_proposals').get();
    assert.equal(p.status, 'stranded');
    assert.match(p.error, /A\$38\.98/);
  });

  it('leaves it alone when eBay cannot be reached — tries again next pass', async () => {
    const d = db0(); strand(d);
    const r = await reconcileApplying(d, { getLive: async () => ({ ok: false, error: 'timeout' }) });
    assert.equal(r.unknown, 1);
    assert.equal(d.prepare('SELECT status FROM reprice_proposals').get().status, 'applying');
  });

  it('does not touch a write that may still be in flight', async () => {
    const d = db0();
    strand(d, { decided_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    const r = await reconcileApplying(d, { getLive: async () => { throw new Error('should not be called'); } });
    assert.equal(r.checked, 0, 'inside the grace window it is not a strand, it is a tap in progress');
  });

  it('frees the listing so the next pass can propose it again', async () => {
    const d = db0(); strand(d);
    await reconcileApplying(d, { getLive: async () => ({ ok: true, price_cents: 3898 }) });
    assert.equal(openProposalFor(d, '9001'), null);
    seedRaise(d);
    const r = await promoteFromScan({ db: d, cfg: CFG, chatId: '-100', getLive: liveOk(), sendCard: sends().fn });
    assert.equal(r.promoted.length, 1);
  });
});

// --- expiry + TTL -------------------------------------------------------------------------------
describe('expiry', () => {
  it('expires a pending proposal past its deadline, and only that one', () => {
    const d = db0();
    d.prepare("INSERT INTO reprice_proposals (item_id,status,expires_at) VALUES ('A','pending','2020-01-01 00:00:00')").run();
    d.prepare("INSERT INTO reprice_proposals (item_id,status,expires_at) VALUES ('B','pending','2999-01-01 00:00:00')").run();
    d.prepare("INSERT INTO reprice_proposals (item_id,status,expires_at) VALUES ('C','applied','2020-01-01 00:00:00')").run();
    assert.equal(expireProposals(d), 1);
    assert.equal(d.prepare("SELECT status FROM reprice_proposals WHERE item_id='C'").get().status, 'applied', 'a decided row is history, not a candidate');
  });

  it('sweeps BEFORE promoting, so an expired card stops blocking its listing', async () => {
    const d = db0();
    d.prepare("INSERT INTO reprice_proposals (item_id,status,expires_at) VALUES ('9001','pending','2020-01-01 00:00:00')").run();
    seedRaise(d);
    const r = await promoteFromScan({ db: d, cfg: CFG, chatId: '-100', getLive: liveOk(), sendCard: sends().fn });
    assert.equal(r.expired, 1);
    assert.equal(r.promoted.length, 1, 'sweeping late would skip this listing for another whole cycle');
  });

  it('a card never outlives the scan that would supersede it', () => {
    // 24h TTL on a 4h cadence would leave five newer reads behind an old price.
    assert.equal(effectiveTtlHours({ scan_enabled: true, cadence_hours: 4, guardrails: { proposal_ttl_hours: 24 } }), 4);
    assert.equal(effectiveTtlHours({ scan_enabled: true, cadence_hours: 48, guardrails: { proposal_ttl_hours: 24 } }), 24, 'the shorter of the two wins');
    // With scanning off there is no next pass, so the owner's number stands.
    assert.equal(effectiveTtlHours({ scan_enabled: false, cadence_hours: 4, guardrails: { proposal_ttl_hours: 24 } }), 24);
    assert.equal(effectiveTtlHours({}), 24);
  });
});

describe('evidenceSummary — the card explains itself in the owner\'s terms', () => {
  it('names the anchor that was actually used', () => {
    const c = { target_delivered_cents: 4498, n_comparable: 9, confidence: 'medium', mode: 'asking' };
    assert.match(evidenceSummary(c, { guardrails: { target_anchor: 'cheapest_n', anchor_n: 3 } }), /3rd cheapest Australian listing/);
    assert.match(evidenceSummary(c, { guardrails: { target_anchor: 'cheapest_n', anchor_n: 1 } }), /cheapest Australian listing/);
    assert.match(evidenceSummary(c, { guardrails: { target_anchor: 'cluster' } }), /main price band/);
  });
  it('carries the numbers a human needs to sanity-check it', () => {
    const s = evidenceSummary({ target_delivered_cents: 4498, n_comparable: 9, confidence: 'medium', mode: 'asking' }, CFG);
    assert.match(s, /A\$44\.98 delivered/);
    assert.match(s, /9 comparable/);
    assert.match(s, /asking prices/);
  });
});
