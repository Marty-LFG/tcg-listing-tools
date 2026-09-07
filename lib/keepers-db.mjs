// lib/keepers-db.mjs — The Keepers ledger (Node 24 built-in `node:sqlite`, zero dependencies).
//
// Deliberately a SEPARATE database file (data/keepers.db) from tracker.db, postsale.db and
// repricer.db — its own domain, own WAL, own writer. Same reasoning postsale-db.mjs states for
// itself, and it lands harder here: this subsystem owns the link between a Shopify customer and
// everything they have earned, so isolating it keeps the redaction surface small. If the D-022
// protected-customer-data question ever resolves against us, there is exactly one file to redact.
//
// THE MODEL. keepers_events is the truth. The five customer metafields on Shopify are a PROJECTION of
// it — derived, disposable, rebuildable from this table alone. Nothing ever reads a metafield to
// compute a new value; every value is a SUM over the ledger. The `*_written` columns on
// keepers_customers are a record of what we last WROTE, never of what is true, and exist only so the
// projection can skip a customer whose numbers have not moved.
//
// That is the same relationship lib/stock-ledger.mjs has with inventory_items.quantity, and the same
// discipline applies: the cache is reconciled, not trusted.
//
// THE CANONICAL KEY IS customer_gid AND NOTHING ELSE. Never email, never name, never address. Not out
// of caution — under the unresolved D-022 reading we may simply not be permitted to read them, and a
// linkage that works only when PII is readable is one that passes on dev and fails on live. An order
// we cannot link yet gets an event with a NULL customer_gid, which is honest: nobody has earned it
// yet. It is never guessed at from a hashed email.
//
// THIS MODULE DOES NOT MANAGE TRANSACTIONS. Same contract as lib/stock-ledger.mjs: the caller supplies
// the transaction. An event and the dirty flag it implies must land together, so a caller that is not
// already inside a BEGIN has to open one. withTransaction() below is provided for callers that are not.
//
// GR3: all money is INTEGER CENTS, parsed with moneyToCents from lib/channels/shopify-admin.mjs.
// parseFloat is banned there and the reason applies doubly here — the points economy is an
// accumulating sum, and float drift only ever shows up in aggregate, long after it is traceable.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// TCG_KEEPERS_DB overrides the location so the test suite — and a development worktree running a
// second instance of this tool — can never touch the real ledger. Matches TCG_POSTSALE_DB.
export const KEEPERS_DB_PATH = process.env.TCG_KEEPERS_DB || path.join(ROOT, 'data', 'keepers.db');

// The event vocabulary, and the whole point of having one. An XP change nobody can name the cause of
// is the state this table exists to prevent, so `kind` is a CHECK constraint in the schema and this is
// its readable half. Following the shape of stock-ledger's REASONS: `manual_grant` and `correction`
// are the escape hatches and are deliberately last — reaching for one should feel like reaching for one.
export const KINDS = Object.freeze({
  join: 'became a Keeper',
  order_accrual: 'earned from an order',
  order_reversal: 'reversed because an order was refunded or cancelled',
  review: 'left a review on something they bought',
  referral_referrer: 'referred someone who ordered',
  referral_referee: 'was referred by someone',
  checkin: 'said g\'day at a show',
  badge_award: 'earned a badge',
  redemption_debit: 'spent points on a reward',
  redemption_refund: 'points returned because a reward expired or failed to mint',
  manual_grant: 'granted by hand',
  correction: 'a correction to an earlier event',
});

// Where the event came from. Paired with source_ref, this is what makes every earn action idempotent
// in the SCHEMA rather than in a caller — see uq_kev_source below.
export const SOURCES = Object.freeze({
  shopify_order: 'a Shopify order',
  shopify_refund: 'a Shopify refund',
  shopify_order_cancel: 'a cancelled Shopify order',
  judgeme: 'a published Judge.me review',
  referral: 'a referral that cleared its hold',
  checkin: 'a show check-in',
  runs: 'a verified mystery bundle',
  redemption: 'a reward redemption',
  admin: 'a person, through the admin',
  derive: 'derived from the ledger itself (badges, levels)',
});

export const EVENT_STATUS = Object.freeze({
  applied: 'counts towards the balance',
  held: 'earned but not yet counted — waiting out a refund window',
  void: 'cancelled before it ever counted',
});

const DDL = `
-- One row per Shopify customer we have ever seen. customer_gid is the only identity here.
CREATE TABLE IF NOT EXISTS keepers_customers (
  customer_gid   TEXT PRIMARY KEY,                  -- gid://shopify/Customer/123
  numeric_id     INTEGER,                           -- the same id as a number, for the check-in code
  handle         TEXT NOT NULL UNIQUE,              -- 'shopify:123' — the postsale-db namespacing convention
  joined_at      TEXT,                              -- written once, never rewritten
  first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT,
  -- D-022 evidence, accumulated from real traffic rather than argued about: did the last read of this
  -- customer actually return a name? 1/0/NULL. The ledger works either way; this is how we find out.
  pii_readable   INTEGER,
  referral_code  TEXT UNIQUE,
  referred_by_gid TEXT,
  -- What we last WROTE to Shopify. Never what is true. Only used to skip an unchanged projection.
  xp_written INTEGER, points_written INTEGER, level_written INTEGER,
  badges_written TEXT, joined_at_written TEXT,
  written_at TEXT,
  write_attempt INTEGER NOT NULL DEFAULT 0,
  next_write_at TEXT,
  write_error TEXT,
  dirty INTEGER NOT NULL DEFAULT 0
);

-- THE LEDGER. Append-only: nothing in here is ever UPDATEd to change what it says happened, and
-- nothing is ever DELETEd. A refund appends a negative event carrying reverses_event_id.
CREATE TABLE IF NOT EXISTS keepers_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_gid   TEXT,                              -- NULL while unlinked. Never guessed.
  kind           TEXT NOT NULL CHECK (kind IN (
                   'join','order_accrual','order_reversal','review','referral_referrer',
                   'referral_referee','checkin','badge_award','redemption_debit',
                   'redemption_refund','manual_grant','correction')),
  xp_delta       INTEGER NOT NULL DEFAULT 0,
  points_delta   INTEGER NOT NULL DEFAULT 0,
  badge_id       TEXT,
  source         TEXT NOT NULL CHECK (source IN (
                   'shopify_order','shopify_refund','shopify_order_cancel','judgeme',
                   'referral','checkin','runs','redemption','admin','derive')),
  source_ref     TEXT,                              -- the natural key of the upstream event
  basis_cents    INTEGER,                           -- the money this was computed from (GR3)
  -- THE RATE AT THE TIME. This is the structural fix for the storefront restating history: an order's
  -- XP is a fact recorded once, not an expression re-evaluated whenever the config moves. Without it,
  -- changing xp_per_dollar silently rewrites what every past order claims to have earned.
  rate_xp_per_dollar     REAL,
  rate_points_per_dollar REAL,
  reverses_event_id INTEGER REFERENCES keepers_events(id),
  -- Shopify's clock (processedAt / X-Shopify-Triggered-At). Delivery is unordered, so arrival order
  -- means nothing — same note notify_events.event_date carries for eBay.
  occurred_at    TEXT,
  recorded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','held','void')),
  hold_until     TEXT,                              -- for status='held': when it may become applied
  note           TEXT,
  -- Badge inputs SNAPSHOTTED at accrual: languages, preorder flag, channel, keepers discount.
  -- Load-bearing: bkc.release_status flips from pre-order to in-stock the week a set drops, so a badge
  -- evaluator that re-read the product would make preorder-pioneer permanently unwinnable.
  evidence       TEXT
);

-- IDEMPOTENCY LIVES IN THE SCHEMA, NOT THE CALLER.
--
-- The webhook and the reconcile sweep can discover the same order milliseconds apart, and a
-- check-then-insert lets both through. Same reasoning, and the same shape, as uq_deal_open_order in
-- lib/postsale-db.mjs. kind is in the key so a referrer and a referee award can share one source_ref.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kev_source
  ON keepers_events(source, source_ref, kind)
  WHERE source_ref IS NOT NULL AND source <> 'derive';

-- Badges get their own index because customer_gid is NULLABLE and SQLite treats NULLs as distinct —
-- a (customer_gid, badge_id) unique index would silently permit duplicate unlinked rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kev_badge
  ON keepers_events(customer_gid, badge_id)
  WHERE badge_id IS NOT NULL AND customer_gid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kev_cust     ON keepers_events(customer_gid, id);
CREATE INDEX IF NOT EXISTS idx_kev_unlinked ON keepers_events(customer_gid) WHERE customer_gid IS NULL;
CREATE INDEX IF NOT EXISTS idx_kev_held     ON keepers_events(status, hold_until) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS idx_kev_order    ON keepers_events(source_ref) WHERE source_ref IS NOT NULL;

-- The fact table the reconciler diffs against: what Shopify says about an order, last time we looked.
CREATE TABLE IF NOT EXISTS keepers_orders (
  order_gid      TEXT PRIMARY KEY,
  order_number   TEXT,
  customer_gid   TEXT,
  channel        TEXT,
  accrues        INTEGER,                           -- the channel decision, recorded so it is auditable
  financial_status TEXT,
  cancelled_at   TEXT,
  processed_at   TEXT,
  updated_at     TEXT,
  net_cents      INTEGER,
  refunded_cents INTEGER,
  keepers_discount_cents INTEGER,
  currency       TEXT,
  pii_present    INTEGER,
  last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  raw            TEXT
);
CREATE INDEX IF NOT EXISTS idx_kord_cust    ON keepers_orders(customer_gid);
CREATE INDEX IF NOT EXISTS idx_kord_updated ON keepers_orders(updated_at);

-- Byte-for-byte the notify_events vocabulary, because it earned it.
CREATE TABLE IF NOT EXISTS keepers_webhooks (
  webhook_id     TEXT PRIMARY KEY,                  -- X-Shopify-Webhook-Id: the dedupe key IS the key
  topic          TEXT NOT NULL,
  shop_domain    TEXT,
  api_version    TEXT,
  triggered_at   TEXT,                              -- their clock, not ours
  ref_id         TEXT,
  received_at    TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'received',  -- received|handled|skipped|ignored|failed
  attempt        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  handled_at     TEXT,
  action         TEXT,
  error          TEXT,
  payload        TEXT,
  observation    TEXT                               -- what the ledger WOULD have said, during the soak
);
CREATE INDEX IF NOT EXISTS idx_kw_due   ON keepers_webhooks(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_kw_topic ON keepers_webhooks(topic, received_at);

CREATE TABLE IF NOT EXISTS keepers_redemptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_gid   TEXT NOT NULL,
  tier_handle    TEXT,
  points_cost    INTEGER NOT NULL,
  percent_off    REAL NOT NULL,
  code           TEXT UNIQUE,
  discount_gid   TEXT,
  status         TEXT NOT NULL DEFAULT 'requested', -- requested|minting|active|used|expired|failed|revoked
  requested_at   TEXT NOT NULL DEFAULT (datetime('now')),
  minted_at      TEXT, expires_at TEXT, used_at TEXT,
  used_order_gid TEXT,
  error          TEXT
);
-- One open redemption per customer, enforced by the database rather than a check-then-insert in a
-- route. A double-clicked approve button is otherwise two codes for one debit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kr_open
  ON keepers_redemptions(customer_gid) WHERE status IN ('requested','minting');
CREATE INDEX IF NOT EXISTS idx_kr_status ON keepers_redemptions(status);

-- ONE REFERRER PER REFEREE, FOREVER. The primary key is the whole control: a second claim on the same
-- referee cannot be inserted, whatever a caller believes.
CREATE TABLE IF NOT EXISTS keepers_referral_claims (
  referee_gid    TEXT PRIMARY KEY,
  referrer_gid   TEXT NOT NULL,
  code           TEXT,
  order_gid      TEXT,
  claimed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  hold_until     TEXT,
  status         TEXT NOT NULL DEFAULT 'held',      -- held|paid|rejected
  reject_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_krc_referrer ON keepers_referral_claims(referrer_gid, claimed_at);
CREATE INDEX IF NOT EXISTS idx_krc_hold     ON keepers_referral_claims(status, hold_until);

CREATE TABLE IF NOT EXISTS keepers_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

// node:sqlite has no ADD COLUMN IF NOT EXISTS — guard with PRAGMA table_info so the migration is
// idempotent and metadata-only. Mirrors addColumnIfMissing in lib/postsale-db.mjs and lib/db.mjs.
function addColumnIfMissing(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.length && !cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function migrateKeepers(db) {
  // Additive columns that ship after the tables exist go here. Empty on first release, and that is
  // the point: the pattern is in place before it is needed, so the first person to need it does not
  // have to invent it under pressure.
  addColumnIfMissing(db, 'keepers_customers', 'pii_readable', 'INTEGER');
  // What we last WROTE to Shopify for the referral code. Without it isUnchanged cannot tell a
  // code that has been pushed from one that has only ever existed here, so the code would ride
  // along only on a pass where some OTHER value happened to change.
  addColumnIfMissing(db, 'keepers_customers', 'referral_code_written', 'TEXT');
}

let _kdb = null;

function initKeepersDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(DDL);
  try { migrateKeepers(db); } catch (e) { console.error('[keepers-db] migration:', e?.message || e); }
  return db;
}

export function openKeepersDb(dbPath = KEEPERS_DB_PATH) {
  if (_kdb) return _kdb;
  _kdb = initKeepersDb(dbPath);
  return _kdb;
}

// Fresh, non-cached DB — tests ONLY (never the process singleton / real data/keepers.db).
export function openKeepersDbAt(dbPath) { return initKeepersDb(dbPath); }

/**
 * Closes the process singleton and forgets it, so a later openKeepersDb() opens a fresh handle.
 *
 * FOR TEARDOWN. An open SQLite handle is what makes rmSync fail EPERM on Windows, so a test that
 * leaves this database open leaves its whole temp directory behind — and with WAL on, the -wal and
 * -shm sidecars too. That is how 16,646 directories and 8.5GB accumulated in temp; see f409b32 and
 * e530986 for the flake that the same open-handle problem eventually caused.
 *
 * Clearing _kdb is the part that matters. Closing the handle without it would leave every later
 * openKeepersDb() returning a CLOSED database, which fails in a way nobody would connect to a teardown.
 */
export function closeKeepersDb() {
  if (!_kdb) return false;
  try { _kdb.close(); } catch { /* already closed */ }
  _kdb = null;
  return true;
}


// --- meta (cursors, the cached rank table, the projection lease) ---

export function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM keepers_meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO keepers_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value === null || value === undefined ? null : String(value));
}

/**
 * withTransaction(db, fn) — for callers that are not already inside one. Nested BEGINs are an error in
 * SQLite, so this is deliberately not re-entrant; a caller already in a transaction calls fn directly.
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* the original error is the interesting one */ }
    throw e;
  }
}

// --- customers ---

export const gidToNumeric = (gid) => {
  const m = /(\d+)\s*$/.exec(String(gid ?? ''));
  return m ? Number(m[1]) : null;
};
export const numericToGid = (id) => `gid://shopify/Customer/${Number(id)}`;

/**
 * upsertCustomer — first sight of a customer, and every sight after.
 *
 * joined_at is written ONCE and never rewritten: it is the field the storefront uses to decide whether
 * someone is a Keeper at all, so moving it would restate their history. Note the storefront tests
 * joined_at rather than xp for exactly this reason — a Keeper who refunded back to zero XP is still a
 * Keeper, and must not fall back to the "not started yet" state.
 */
export function upsertCustomer(db, { customerGid, joinedAt = null, referralCode = null } = {}) {
  const gid = String(customerGid ?? '').trim();
  if (!gid) throw new Error('keepers-db: upsertCustomer needs a customer_gid');
  const numeric = gidToNumeric(gid);
  db.prepare(`
    INSERT INTO keepers_customers (customer_gid, numeric_id, handle, joined_at, last_seen_at, referral_code)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(customer_gid) DO UPDATE SET
      last_seen_at  = datetime('now'),
      joined_at     = COALESCE(keepers_customers.joined_at, excluded.joined_at),
      referral_code = COALESCE(keepers_customers.referral_code, excluded.referral_code)
  `).run(gid, numeric, `shopify:${numeric ?? gid}`, joinedAt, referralCode);
  return getCustomer(db, gid);
}

export function getCustomer(db, customerGid) {
  return db.prepare('SELECT * FROM keepers_customers WHERE customer_gid = ?').get(String(customerGid)) || null;
}

export function markDirty(db, customerGid) {
  if (!customerGid) return;
  db.prepare('UPDATE keepers_customers SET dirty = 1, next_write_at = NULL WHERE customer_gid = ?')
    .run(String(customerGid));
}

// --- the ledger ---

/**
 * appendEvent — the only way anything enters the ledger.
 *
 * Returns { id, inserted }. `inserted` is false when the unique index refused a duplicate, which is
 * the NORMAL case rather than an error: at-least-once webhook delivery plus a reconcile sweep means
 * the same order is discovered more than once by design. A caller that treats false as a failure will
 * spend its retry budget re-doing work that already succeeded.
 *
 * The caller supplies the transaction. This appends and marks the customer dirty; those two must land
 * together or the projection never learns there is anything to write.
 */
export function appendEvent(db, {
  customerGid = null, kind, xpDelta = 0, pointsDelta = 0, badgeId = null,
  source, sourceRef = null, basisCents = null,
  rateXpPerDollar = null, ratePointsPerDollar = null,
  reversesEventId = null, occurredAt = null, status = 'applied', holdUntil = null,
  note = null, evidence = null,
} = {}) {
  if (!KINDS[kind]) throw new Error(`keepers-db: unknown kind '${kind}' (want ${Object.keys(KINDS).join('|')})`);
  if (!SOURCES[source]) throw new Error(`keepers-db: unknown source '${source}' (want ${Object.keys(SOURCES).join('|')})`);
  if (!EVENT_STATUS[status]) throw new Error(`keepers-db: unknown status '${status}'`);
  if (!Number.isInteger(xpDelta) || !Number.isInteger(pointsDelta)) {
    // A fractional XP would round differently every time it was summed and displayed. Refuse at the
    // door rather than let it into an accumulating total.
    throw new Error(`keepers-db: xpDelta and pointsDelta must be whole numbers, got ${xpDelta}/${pointsDelta}`);
  }

  const info = db.prepare(`
    INSERT INTO keepers_events (
      customer_gid, kind, xp_delta, points_delta, badge_id, source, source_ref, basis_cents,
      rate_xp_per_dollar, rate_points_per_dollar, reverses_event_id, occurred_at, status, hold_until,
      note, evidence
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT DO NOTHING
  `).run(
    customerGid, kind, xpDelta, pointsDelta, badgeId, source, sourceRef, basisCents,
    rateXpPerDollar, ratePointsPerDollar, reversesEventId, occurredAt, status, holdUntil,
    note, evidence === null || typeof evidence === 'string' ? evidence : JSON.stringify(evidence),
  );

  const inserted = Number(info.changes) > 0;
  if (inserted && customerGid) markDirty(db, customerGid);
  return { id: inserted ? Number(info.lastInsertRowid) : null, inserted };
}

/**
 * ledgerTotals — the authority. Every projected value is this, and nothing else.
 *
 * Only status='applied' counts. A 'held' referral award is earned but not yet countable (it is waiting
 * out the referee's refund window), and a 'void' one never counted at all.
 */
export function ledgerTotals(db, customerGid) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(xp_delta), 0) AS xp, COALESCE(SUM(points_delta), 0) AS points, COUNT(*) AS events
    FROM keepers_events WHERE customer_gid = ? AND status = 'applied'
  `).get(String(customerGid));
  return { xp: Number(r?.xp) || 0, points: Number(r?.points) || 0, events: Number(r?.events) || 0 };
}

/** Badges are their own thing — awarded once, never revoked, never summed. */
export function ledgerBadges(db, customerGid) {
  return db.prepare(`
    SELECT badge_id FROM keepers_events
    WHERE customer_gid = ? AND badge_id IS NOT NULL AND status = 'applied'
    ORDER BY id
  `).all(String(customerGid)).map((r) => r.badge_id);
}

/**
 * orderLedger(db, orderGid) — everything the ledger holds about one order, and the clamp that keeps a
 * reversal from exceeding its accrual.
 *
 * The failure this prevents: an order is refunded in two parts and then cancelled. Three separate
 * events each want to reverse it, and nothing but this sum stops the customer losing three times what
 * they earned. Computed inside the caller's transaction so a concurrent second reversal cannot read a
 * stale total.
 */
export function orderLedger(db, orderGid) {
  const ref = String(orderGid);
  const accrual = db.prepare(`
    SELECT COALESCE(SUM(xp_delta),0) AS xp, COALESCE(SUM(points_delta),0) AS points,
           MAX(rate_xp_per_dollar) AS rate_xp, MAX(rate_points_per_dollar) AS rate_points,
           MIN(id) AS event_id
    FROM keepers_events
    WHERE source_ref = ? AND kind = 'order_accrual' AND status = 'applied'
  `).get(ref);
  const reversed = db.prepare(`
    SELECT COALESCE(SUM(xp_delta),0) AS xp, COALESCE(SUM(points_delta),0) AS points
    FROM keepers_events
    WHERE kind = 'order_reversal' AND status = 'applied' AND reverses_event_id = ?
  `).get(accrual?.event_id ?? -1);

  const accruedXp = Number(accrual?.xp) || 0;
  const accruedPoints = Number(accrual?.points) || 0;
  // Reversals are stored negative, so their sum is <= 0. Flip it to a positive "already taken back".
  const takenXp = -(Number(reversed?.xp) || 0);
  const takenPoints = -(Number(reversed?.points) || 0);

  return {
    eventId: accrual?.event_id ?? null,
    accruedXp,
    accruedPoints,
    rateXpPerDollar: accrual?.rate_xp ?? null,
    ratePointsPerDollar: accrual?.rate_points ?? null,
    reversedXp: takenXp,
    reversedPoints: takenPoints,
    // What is still reversible. Never negative, so a third reversal on a fully-reversed order is a
    // no-op rather than a gift in the wrong direction.
    reversibleXp: Math.max(0, accruedXp - takenXp),
    reversiblePoints: Math.max(0, accruedPoints - takenPoints),
  };
}

/**
 * clampReversal — how much of a requested reversal may actually be applied.
 *
 * Returns { xpDelta, pointsDelta } as NEGATIVE numbers ready to append, clamped so cumulative
 * reversals can never exceed the original accrual.
 */
export function clampReversal(db, orderGid, { xp, points }) {
  const l = orderLedger(db, orderGid);
  const wantXp = Math.max(0, Math.trunc(Number(xp) || 0));
  const wantPoints = Math.max(0, Math.trunc(Number(points) || 0));
  // Negate without producing -0. `-Math.min(0, 0)` is negative zero, which survives into the row and
  // makes `Object.is(delta, 0)` false for a caller reasonably checking "did this reverse anything".
  const negate = (n) => (n === 0 ? 0 : -n);
  return {
    xpDelta: negate(Math.min(wantXp, l.reversibleXp)),
    pointsDelta: negate(Math.min(wantPoints, l.reversiblePoints)),
    reversesEventId: l.eventId,
    ledger: l,
  };
}

/**
 * releaseHeldEvents — a held award whose hold_until has passed becomes applied.
 *
 * This is what makes the referral hold work: the award is written the moment it is earned, so it is
 * visible and auditable immediately, but it does not COUNT until the referee's order has survived the
 * refund window. Without the hold, buy -> refund -> repeat mints a full referral award every cycle,
 * and the referral award is by far the largest in the economy.
 */
export function releaseHeldEvents(db, { now = null, limit = 500 } = {}) {
  const rows = db.prepare(`
    SELECT id, customer_gid FROM keepers_events
    WHERE status = 'held' AND hold_until IS NOT NULL AND hold_until <= COALESCE(?, datetime('now'))
    ORDER BY id LIMIT ?
  `).all(now, limit);
  const upd = db.prepare("UPDATE keepers_events SET status = 'applied' WHERE id = ? AND status = 'held'");
  let released = 0;
  for (const r of rows) {
    if (Number(upd.run(r.id).changes) > 0) {
      released++;
      markDirty(db, r.customer_gid);
    }
  }
  return released;
}

/**
 * linkUnlinkedEvents — attach events that arrived before we knew whose they were.
 *
 * A guest order, or one whose customer block came back redacted, lands with customer_gid NULL. When
 * the reconcile sweep later resolves the order to a customer through a DIFFERENT surface (a GraphQL
 * read rather than a webhook body), those events get their owner. This is the only way an event ever
 * acquires a customer, and it is never inferred from an email or an address.
 */
export function linkUnlinkedEvents(db, sourceRef, customerGid) {
  const gid = String(customerGid ?? '').trim();
  if (!gid || !sourceRef) return 0;
  const n = Number(db.prepare(
    'UPDATE keepers_events SET customer_gid = ? WHERE source_ref = ? AND customer_gid IS NULL',
  ).run(gid, String(sourceRef)).changes);
  if (n > 0) markDirty(db, gid);
  return n;
}

export function unlinkedCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM keepers_events WHERE customer_gid IS NULL').get()?.n) || 0;
}

/**
 * forgetCustomer — the customers/redact compliance handler's data half.
 *
 * The events STAY, with their owner removed. That is the correct reading of the obligation and it is
 * also the only one that keeps the ledger honest: the aggregate history of what the store awarded
 * still reconciles, while the person is no longer in it. Deleting the events instead would silently
 * change every total the business has ever reported.
 */
export function forgetCustomer(db, customerGid) {
  const gid = String(customerGid ?? '').trim();
  if (!gid) return { events: 0, customer: 0 };
  const events = Number(db.prepare('UPDATE keepers_events SET customer_gid = NULL WHERE customer_gid = ?').run(gid).changes);
  const customer = Number(db.prepare('DELETE FROM keepers_customers WHERE customer_gid = ?').run(gid).changes);
  db.prepare('UPDATE keepers_orders SET customer_gid = NULL WHERE customer_gid = ?').run(gid);
  return { events, customer };
}
