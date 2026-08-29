// lib/postsale-db.mjs — the post-sale automation store (Node 24 built-in `node:sqlite`).
//
// Deliberately a SEPARATE database file (data/postsale.db) from the card-price tracker
// (data/tracker.db) and the repricer (data/repricer.db). This subsystem owns eBay order
// ingestion + buyer CRM + the post-purchase message state machine — its own domain, own
// WAL, own writer, and it holds buyer PII (shipping addresses) so isolating it keeps the
// money/PII surface small for backup + redaction. Same zero-dependency `node:sqlite`
// approach and singleton/WAL conventions as lib/repricer-db.mjs.
//
// GR3: all money is INTEGER CENTS. Buyer email is NEVER stored (eBay masks it); we key
// buyers by eBay username / opaque UserID and message through the platform.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// TCG_POSTSALE_DB overrides the location so the integration suite never touches the real DB.
export const POSTSALE_DB_PATH = process.env.TCG_POSTSALE_DB || path.join(ROOT, 'data', 'postsale.db');

const DDL = `
-- Mini-CRM: one row per eBay buyer. Keyed by username (what GetOrders returns as BuyerUserID
-- and what AddMemberMessageAAQToPartner needs as RecipientID). buyer_user_id holds the opaque
-- immutable id when eBay provides one (GetMemberMessages SenderID is moving to that).
CREATE TABLE IF NOT EXISTS buyers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ebay_username TEXT NOT NULL UNIQUE,
  buyer_user_id TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  order_count   INTEGER NOT NULL DEFAULT 0,
  total_spent_cents INTEGER NOT NULL DEFAULT 0,   -- GR3
  notes TEXT
);

-- One row per eBay OrderID (idempotent ingest key). Carries the shipping address the seller
-- receives for fulfilment (email stays masked) — powers sale alerts + label queue.
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  buyer_username TEXT,
  order_status TEXT,                     -- eBay OrderStatus (Active|Completed|Cancelled|...)
  checkout_status TEXT,                  -- CheckoutStatus.Status (Complete|Incomplete)
  paid_status TEXT,                      -- CheckoutStatus.eBayPaymentStatus
  created_time TEXT, paid_time TEXT, shipped_time TEXT,
  currency TEXT NOT NULL DEFAULT 'AUD',
  total_cents INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER, shipping_cents INTEGER,
  ship_service TEXT,
  -- Order.ShippingAddress (AddressType)
  ship_name TEXT, ship_street1 TEXT, ship_street2 TEXT, ship_city TEXT,
  ship_state TEXT, ship_postal TEXT, ship_country TEXT, ship_country_name TEXT, ship_phone TEXT,
  shipped_status TEXT NOT NULL DEFAULT 'unshipped',   -- unshipped|shipped
  tracking_number TEXT, carrier TEXT,
  fees_cents INTEGER, fees_synced_at TEXT,            -- SUM of fee_transactions (C); NULL until fees-sync
  label_status TEXT,                                  -- null|queued|printed|skipped (G)
  sale_alert_sent_at TEXT, pack_digest_date TEXT,     -- alert dedupe
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw TEXT                                            -- JSON order snapshot (audit)
);

-- One row per Transaction / OrderLineItem; carries the reconciliation link to our stock.
CREATE TABLE IF NOT EXISTS order_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  order_line_item_id TEXT, transaction_id TEXT,
  ebay_item_id TEXT, sku TEXT, title TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  line_fee_cents INTEGER,                             -- from Finances marketplaceFees (C)
  matched_kind TEXT,                                  -- 'inventory'|'sealed'|null
  matched_item_id INTEGER,                            -- tracker.db inventory_items.id / sealed_items.id
  match_method TEXT,                                  -- 'sku'|'item_id'|'manual'|null
  reconciled_at TEXT
);

-- The buyer-message state machine (modeled on repricer's reprice_proposals).
-- One message per order PER KIND (unique index on order_id+kind) = idempotency: an order is never
-- thanked twice, never told twice that it shipped, never asked twice whether it arrived.
CREATE TABLE IF NOT EXISTS postsale_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'purchase',              -- purchase|dispatch|delivered
  buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  ebay_item_id TEXT,                                  -- representative ItemID used for the send
  is_repeat_buyer INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
     -- pending|drafted|awaiting_approval|sent|skipped|failed|replied|closed
  subject TEXT, body TEXT, model TEXT,
  telegram_chat_id TEXT, telegram_message_id INTEGER,
  decided_by TEXT, decided_at TEXT,
  sent_at TEXT, reply_detected_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Buyer questions + reply detection (F). GetMemberMessages returns buyer-sent messages only.
CREATE TABLE IF NOT EXISTS member_messages (
  message_id TEXT PRIMARY KEY,
  message_type TEXT,                                  -- 'AskSellerQuestion'|...
  sender_id TEXT, ebay_item_id TEXT, order_id TEXT,
  subject TEXT, body TEXT,
  status TEXT,                                        -- 'Answered'|'Unanswered'
  creation_time TEXT, seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  alert_sent_at TEXT, raw TEXT
);

-- Finances ledger (C) — idempotent by Finances transactionId; SALE + NON_SALE_CHARGE both land here.
CREATE TABLE IF NOT EXISTS fee_transactions (
  transaction_id TEXT PRIMARY KEY,
  order_id TEXT, transaction_type TEXT,               -- SALE|NON_SALE_CHARGE|REFUND|CREDIT
  fee_type TEXT,                                      -- FINAL_VALUE_FEE|FINAL_VALUE_FEE_FIXED_PER_ORDER|...
  amount_cents INTEGER, currency TEXT NOT NULL DEFAULT 'AUD',
  booking_date TEXT, raw TEXT
);

-- Open returns / INR inquiries / cancellations / (future) payment disputes (F).
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,                           -- namespaced: return:{id}|inquiry:{id}|cancel:{id}|dispute:{id}
  case_type TEXT,                                     -- 'return'|'inquiry'|'cancellation'|'payment_dispute'
  order_id TEXT, ebay_item_id TEXT, transaction_id TEXT, buyer_user_id TEXT,
  status TEXT, reason TEXT, open_close TEXT,          -- open|closed (derived)
  amount_cents INTEGER, currency TEXT,
  creation_date TEXT, respond_by_date TEXT,           -- SLA deadline for the alert
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT, status_changed_at TEXT, alert_sent_at TEXT, raw TEXT
);

-- One row per SENT pack digest, and the exact orders it listed.
--
-- The digest's buttons dispatch real orders on eBay from a phone, so "which orders" cannot be a query
-- evaluated at tap time — by then more orders have landed, and none of them were on the message. The
-- membership is frozen here when the message is sent, and the buttons carry this row's id.
CREATE TABLE IF NOT EXISTS pack_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_date TEXT NOT NULL,                          -- local date, for the once-a-day gate + display
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  chat_id TEXT, pull_message_id INTEGER, dispatch_message_id INTEGER,
  picked_at TEXT, picked_by TEXT,
  dispatch_started_at TEXT,                           -- the atomic claim: set once, guards a double tap
  dispatched_at TEXT, dispatched_by TEXT
);
CREATE TABLE IF NOT EXISTS pack_digest_orders (
  digest_id INTEGER NOT NULL REFERENCES pack_digests(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  PRIMARY KEY (digest_id, order_id)
);

-- eBay push notifications (Commerce Notification API).
--
-- A row here is a TRIGGER and an audit trail, never a source of business data. eBay's own payload for
-- a sale carries an orderId and nothing else useful — no price, no buyer, no address, no SKU — so the
-- pipeline re-reads the order from the Trading API by id and the payload is kept only so a delivery
-- can be explained afterwards. Not trusting it for content is also what makes eBay's delivery
-- guarantees survivable: at-least-once, in no particular order, and abandoned after three attempts.
--
-- notification_id is the dedupe key. eBay retries, and the safety poll deliberately re-reads windows a
-- notification already covered, so a redelivery must be a no-op INSERT rather than a second nudge.
CREATE TABLE IF NOT EXISTS notify_events (
  notification_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,                                -- ORDER_CONFIRMATION|NEW_MESSAGE|...
  schema_version TEXT,
  event_date TEXT,                                    -- eBay's clock, not ours: arrival order means nothing
  publish_date TEXT,
  publish_attempt_count INTEGER,                      -- >1 means we failed to ack an earlier attempt
  ref_id TEXT,                                        -- best-effort subject id (orderId/itemId) for the UI
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'received',            -- received|handled|skipped|ignored|failed
  attempt INTEGER NOT NULL DEFAULT 0,                 -- OUR retries, distinct from publish_attempt_count
  next_attempt_at TEXT,
  handled_at TEXT,
  action TEXT,                                        -- order_by_id|message_poll|deal_request|record_only|postsale_disabled
  error TEXT,
  payload TEXT                                        -- raw envelope, audit only
);

-- Deal requests (F) — a buyer asking for a keener price, or for one lot of postage on several cards.
--
-- SELF-CONTAINED ON PURPOSE, and this is the load-bearing design decision in the whole feature.
-- SendInvoice only acts on an UNPAID order, so the obvious shape was to start ingesting unpaid orders
-- into "orders" and add a payment filter to everything downstream. An audit of that priced it at
-- roughly forty call sites across seven predicate pairs, the dashboards and three Telegram surfaces —
-- a guarantee that has to be re-earned by every future query anybody writes against "orders".
--
-- So a quote request carries its OWN snapshot instead, and "orders" keeps meaning exactly what it has
-- always meant: an order that has been paid for. pollOrders' paid gate is untouched, every predicate
-- downstream is untouched, and the order appears in "orders" the moment PaidTime does, through the
-- same path it uses today. Nothing about the pack queue had to learn a new state.
--
-- The cost of that choice is the duplication below: buyer, item and money columns that also exist on
-- orders/order_line_items. It is worth it. The alternative is a safety property maintained by
-- vigilance forever, and the thing being guarded is cards leaving the building against money that has
-- not arrived.
CREATE TABLE IF NOT EXISTS deal_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'message'      — classifyDealAsk fired on a member message
  -- 'quote'        — eBay's BUYER_REQUESTED_PURCHASE_QUOTE notification (the cart's Request total)
  -- 'manual'       — the owner started one by hand from the dashboard
  source TEXT NOT NULL,
  buyer_id INTEGER REFERENCES buyers(id),
  ebay_username TEXT,
  -- The eBay order this would invoice, when there is one. NOT a foreign key to "orders": the whole
  -- point is that the order is unpaid and therefore deliberately absent from that table. It is the
  -- join key for later, once the buyer pays and the order arrives through the normal poll.
  ebay_order_id TEXT,
  message_id TEXT,                                    -- member_messages.message_id, when source='message'
  detected_kind TEXT,                                 -- 'discount'|'combined_postage'|'both'
  matched_terms TEXT,                                 -- JSON array of classifyDealAsk rule names
  -- Integer cents (GR3), AUD. subtotal + postage are COMPUTED from the snapshot; discount is typed by
  -- the owner. total is stored rather than derived so the row records what was actually sent, even if
  -- the band table or a listing price moves afterwards.
  subtotal_cents INTEGER,
  discount_cents INTEGER,
  postage_cents INTEGER,
  postage_band_id TEXT,                               -- which band's cost postage_cents came from
  total_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'AUD',
  evidence TEXT,                                      -- JSON: per-line band, cost basis, which floor bound
  -- pending|awaiting_approval|sending|sent|skipped|expired|failed.
  -- 'sending' is claimed the instant Send is pressed, BEFORE the eBay round trip, so a double press
  -- changes 0 rows instead of invoicing the buyer twice.
  status TEXT NOT NULL DEFAULT 'pending',
  telegram_chat_id TEXT, telegram_message_id INTEGER,
  decided_by TEXT, decided_at TEXT, sent_at TEXT, expires_at TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The lines a quote covers, snapshotted at detection. unit_price_cents is recorded here rather than
-- read live at send time because the repricer may raise a price in between, and a buyer quoted a total
-- on Monday must not be invoiced a different one on Tuesday without somebody seeing it.
CREATE TABLE IF NOT EXISTS deal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deal_requests(id) ON DELETE CASCADE,
  ebay_item_id TEXT,
  transaction_id TEXT,
  order_line_item_id TEXT,
  sku TEXT,
  title TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER,
  -- Resolved from the line's own price at snapshot time, so combinedPostageCents can take the MAX
  -- across the lines without re-resolving a band table that may have moved.
  postage_band_id TEXT
);

-- Small key/value store — poll cursors + the activation watermark.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE INDEX IF NOT EXISTS idx_orders_buyer   ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_shipped ON orders(shipped_status);
CREATE INDEX IF NOT EXISTS idx_oli_order      ON order_line_items(order_id);
CREATE INDEX IF NOT EXISTS idx_oli_match      ON order_line_items(matched_kind, matched_item_id);
-- idx_ps_order_kind is created by migrateMessageKinds, not here: on a pre-kind database this DDL runs
-- BEFORE the rebuild, and an index over a column that doesn't exist yet fails the whole boot.
CREATE INDEX IF NOT EXISTS idx_ps_status      ON postsale_messages(status);
CREATE INDEX IF NOT EXISTS idx_ps_buyer       ON postsale_messages(buyer_id);
CREATE INDEX IF NOT EXISTS idx_mm_status      ON member_messages(status);
CREATE INDEX IF NOT EXISTS idx_fee_order      ON fee_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_cases_open     ON cases(open_close);
CREATE INDEX IF NOT EXISTS idx_ne_due         ON notify_events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_ne_topic       ON notify_events(topic, received_at);
CREATE INDEX IF NOT EXISTS idx_deal_status    ON deal_requests(status);
CREATE INDEX IF NOT EXISTS idx_deal_lines     ON deal_lines(deal_id);
-- ONE OPEN QUOTE PER ORDER, enforced by the database rather than by a check-then-insert in the
-- caller. The push notification and the message poll can both discover the same request within
-- milliseconds of each other, and a read-then-write would let both through — which means two cards,
-- two Send buttons, and a buyer who gets invoiced twice for one cart. Partial so that closed rows
-- (sent, skipped, expired) accumulate as history without blocking the next request from the same
-- buyer. Same reasoning, and the same shape, as uq_prop_open_item in lib/repricer-db.mjs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_open_order ON deal_requests(ebay_order_id)
  WHERE ebay_order_id IS NOT NULL AND status IN ('pending', 'awaiting_approval', 'sending');
-- The same guard for a request that arrived as a MESSAGE and so has no order id yet. Keyed on the
-- member message, which is already unique, so re-reading one poll window (the cursor overlaps by
-- design) cannot mint a second quote for a message already queued.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_open_message ON deal_requests(message_id)
  WHERE message_id IS NOT NULL AND status IN ('pending', 'awaiting_approval', 'sending');
`;

let _pdb = null;

// node:sqlite has no ADD COLUMN IF NOT EXISTS — guard with PRAGMA table_info so the migration is
// idempotent + metadata-only (existing rows just get NULLs). Mirrors lib/db.mjs addColumnIfMissing.
function addColumnIfMissing(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.length && !cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
// Additive columns that shipped after orders existed (CREATE IF NOT EXISTS won't add them). The
// packing slip renders SalesRecordNumber ("Sales record #") + the buyer's checkout note.
function migratePostsale(db) {
  // What a notification told us, recorded WITHOUT acting on it. The push path runs in observe mode
  // first: it re-reads the order from eBay by id and writes down what it found, while the existing
  // poll continues to do every bit of the actual ingesting. That is what makes the soak meaningful —
  // it measures how far ahead of the poll push really is, on real sales, changing nothing.
  addColumnIfMissing(db, 'notify_events', 'observation', 'TEXT');
  addColumnIfMissing(db, 'orders', 'sales_record_number', 'TEXT');
  addColumnIfMissing(db, 'orders', 'buyer_note', 'TEXT');
  // Cached eBay listing image per line item (resolved lazily via GetItem). image_checked_at set once
  // we have a definitive answer (image or none) so we don't re-fetch every load.
  addColumnIfMissing(db, 'order_line_items', 'image_url', 'TEXT');
  addColumnIfMissing(db, 'order_line_items', 'image_checked_at', 'TEXT');
  // Cross-DB stock decrement idempotency key: once a matched paid line has decremented tracker.db
  // stock, this is stamped so a re-poll never double-decrements (the two DBs can't share a txn).
  addColumnIfMissing(db, 'order_line_items', 'stock_applied_at', 'TEXT');
  // "Picked" = the cards are pulled off the shelf and packed, but the parcel hasn't been posted yet
  // (weekend orders that go out Monday). Distinct from shipped_status: the order stays in the pack
  // queue for dispatch, it just drops off the pull list so a re-print doesn't send you hunting for
  // cards already sitting in the satchel. NULL = not picked.
  addColumnIfMissing(db, 'orders', 'picked_at', 'TEXT');
  // --- postage (see lib/postage.mjs) ---
  // Raw signals straight off GetOrders, kept so a tier can be re-derived when the service overrides in
  // settings change, without waiting for eBay to modify the order again.
  addColumnIfMissing(db, 'orders', 'expedited', 'INTEGER');                 // ExpeditedService (0/1/NULL)
  addColumnIfMissing(db, 'orders', 'buyer_selected_shipping', 'INTEGER');   // false = eBay chose it, ignore the cost
  // The classification itself, denormalised so the pack digest and any coarse filter can use SQL.
  // Read paths re-derive it from the raw columns so a settings change applies without a re-poll.
  addColumnIfMissing(db, 'orders', 'postage_tier', 'TEXT');                 // standard|paid|tracked|express
  addColumnIfMissing(db, 'orders', 'postage_label', 'TEXT');
  addColumnIfMissing(db, 'orders', 'postage_tracked', 'INTEGER');
  // Dispatch deadline + delivery window. Scheduled_* only starts arriving after dispatch and beats
  // eta_* from then on; handle_by_time is eBay's committed dispatch deadline and orders the queue.
  addColumnIfMissing(db, 'orders', 'handle_by_time', 'TEXT');
  addColumnIfMissing(db, 'orders', 'eta_min', 'TEXT');
  addColumnIfMissing(db, 'orders', 'eta_max', 'TEXT');
  addColumnIfMissing(db, 'orders', 'scheduled_min', 'TEXT');
  addColumnIfMissing(db, 'orders', 'scheduled_max', 'TEXT');
  addColumnIfMissing(db, 'orders', 'delivered_time', 'TEXT');               // ActualDeliveryTime
  // When WE first saw each event, which is what the dispatch/delivered messages trigger off — eBay's
  // own timestamps can be backdated, and a message must fire on the transition, not on the date.
  addColumnIfMissing(db, 'orders', 'tracking_seen_at', 'TEXT');
  addColumnIfMissing(db, 'orders', 'delivered_seen_at', 'TEXT');
  addColumnIfMissing(db, 'orders', 'dispatch_source', 'TEXT');              // 'ebay' (pulled back) | 'manual'
  // eBay flips an order to "sent" the instant a postage LABEL IS BOUGHT, which is not the same event
  // as the parcel leaving. The cards are usually still on the shelf. Stamped when we see that
  // transition and we were not the ones who dispatched it; it keeps the order in our pack queue until
  // somebody has actually pulled and packed it. See needsPacking() in lib/postsale.mjs.
  //
  // Stamped for the OTHER event that arrives through the same flag too — a bare "mark as dispatched",
  // where the seller bulk-ticks parcels that have already gone. refreshOrder used to tell the two
  // apart by whether a tracking number came with it, but an eBay-bought Australia Post Regular Letter
  // label is untracked, so that test settled exactly the orders it was meant to hold and they vanished
  // off the fulfilment page the moment the label was paid for. Nothing in the payload separates the
  // two, so both are held: a wrongly held order costs one tap, a wrongly settled one goes missing.
  // settleLabelBought clears this column for orders a HUMAN names; it no longer sweeps.
  addColumnIfMissing(db, 'orders', 'label_bought_at', 'TEXT');

  // --- cancellation + payment holds (see cancelState()/paymentState() in lib/postsale.mjs) ---
  //
  // Kept on `orders`, NOT in the `cases` table below. A cancellation is 1:1 with an order and its
  // lifecycle IS the order's, the way label_bought_at is. `cases` is keyed on a case_id that GetOrders
  // does not carry (the Cancel ID only exists in the Post-Order API), so a row there would have to be
  // invented and could never be reconciled with the real one later. And the pack queue is deliberately
  // ONE predicate on ONE table — making it join a second is how the three readers of it start
  // disagreeing about what is left to do.
  addColumnIfMissing(db, 'orders', 'cancel_status', 'TEXT');          // raw eBay CancelStatusCodeType
  addColumnIfMissing(db, 'orders', 'cancel_state', 'TEXT');           // derived: none|requested|cancelled|rejected|unknown
  addColumnIfMissing(db, 'orders', 'cancel_reason', 'TEXT');          // CancelReason (code)
  addColumnIfMissing(db, 'orders', 'cancel_reason_detail', 'TEXT');   // CancelReasonDetails (free text)
  addColumnIfMissing(db, 'orders', 'cancel_initiator', 'TEXT');       // Buyer|Seller|eBay
  addColumnIfMissing(db, 'orders', 'cancel_requested_at', 'TEXT');    // CancelInitiationDate
  addColumnIfMissing(db, 'orders', 'cancel_completed_at', 'TEXT');    // CancelCompleteDate
  // A payment can FAIL after PaidTime is set (bounced eCheck, failed card). The paid gate only asks
  // whether PaidTime exists, so without this an order can be picked, packed and posted for money that
  // never arrived. Same shape as a cancellation hold, so it shares the machinery.
  addColumnIfMissing(db, 'orders', 'payment_state', 'TEXT');          // ok|pending|failed
  // When WE first saw each, same reasoning as tracking_seen_at above.
  addColumnIfMissing(db, 'orders', 'cancel_seen_at', 'TEXT');
  addColumnIfMissing(db, 'orders', 'payment_seen_at', 'TEXT');
  // The live "something is wrong with this order" card: alert dedupe plus the handle the acknowledge
  // button needs to unpin and stamp it. One family for both kinds — an order has at most one such card.
  addColumnIfMissing(db, 'orders', 'hold_alert_kind', 'TEXT');        // 'cancel'|'payment'
  addColumnIfMissing(db, 'orders', 'hold_alert_state', 'TEXT');       // the state the live card renders
  addColumnIfMissing(db, 'orders', 'hold_alert_sent_at', 'TEXT');
  addColumnIfMissing(db, 'orders', 'hold_alert_chat_id', 'TEXT');
  addColumnIfMissing(db, 'orders', 'hold_alert_message_id', 'INTEGER');
  addColumnIfMissing(db, 'orders', 'hold_alert_pinned', 'INTEGER');   // 0/1 — never unpin what never pinned
  addColumnIfMissing(db, 'orders', 'hold_ack_at', 'TEXT');
  addColumnIfMissing(db, 'orders', 'hold_ack_by', 'TEXT');

  // --- stock reversal ---
  // WHAT THE DECREMENT ACTUALLY DID, as JSON, written at decrement time. decrementSealedItem DELETEs a
  // placement row when it empties and records nothing, so after the fact there is no way to know which
  // shelf the units came off. Recording the effect is the only thing that makes a faithful reversal
  // possible — and it is worthless retroactively, which is why it ships alongside the parsing work
  // rather than with the function that reads it.
  addColumnIfMissing(db, 'order_line_items', 'stock_effect', 'TEXT');
  addColumnIfMissing(db, 'order_line_items', 'stock_reversed_at', 'TEXT');   // inverse of stock_applied_at
  // Deliberately NO order-level mirror of stock_reversed_at: the per-line stamp above is what makes the
  // reversal idempotent, and a summary column would be a second copy of that fact for nobody to read.
  // "Has this order been put back?" is EXISTS(... WHERE order_id=? AND stock_reversed_at IS NOT NULL).
  //
  // And no index on cancel_state: every predicate that reads it wraps it in COALESCE (the column is
  // NULL on every row that predates this migration), which SQLite cannot serve from a plain index — so
  // it would cost a write on every ingest and refresh and never once be used.

  // --- second sales channel (see docs/SHOPIFY_CHANNEL_PLAN.md §3.2) ---
  // Shopify orders land in THESE tables rather than parallel ones, and the reason is applyStockDecrements:
  // it is the most carefully-ordered function in the repo (decrement-then-stamp, so a crash under-lists
  // instead of overselling) and writing a second one from memory in another file is the worst trade
  // available. Sharing the tables costs two columns and buys the entire post-sale path unchanged.
  //
  // Verified before committing to this: order_line_items carries no unique index at all and no
  // eBay-specific uniqueness assumption, and orders.order_id is a plain TEXT PRIMARY KEY. So the only
  // requirements are that a Shopify order NAMESPACE its order_id ('shopify:<id>') and its
  // buyers.ebay_username ('shopify:<customerId>', or 'shopify:guest:<orderId>' when the buyer block
  // arrives redacted — orders.buyer_id is NOT NULL, so there must be a row either way).
  //
  // DEFAULT 'ebay' is what keeps every existing row and every existing query correct: the eBay ingest
  // never writes this column and never needs to.
  addColumnIfMissing(db, 'orders', 'channel', "TEXT NOT NULL DEFAULT 'ebay'");
  addColumnIfMissing(db, 'order_line_items', 'channel', "TEXT NOT NULL DEFAULT 'ebay'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(channel)');

  // --- eBay inbox alerts ---
  // member_messages was write-only until now: the poll filled it in and nothing ever read it back.
  // These are what turn a stored message into something the owner is actually told about.
  //
  // my_message_id is the OTHER eBay id for the same message. GetMemberMessages hands us
  // Question.MessageID; ReviseMyMessages (mark read) wants the My Messages id, and the only bridge
  // between the two is GetMyMessages.ExternalMessageID. Null means the header sweep has not seen it
  // yet, which is a real state - the mark-read button says so rather than failing silently.
  addColumnIfMissing(db, 'member_messages', 'my_message_id', 'TEXT');
  addColumnIfMissing(db, 'member_messages', 'is_read', 'INTEGER');       // eBay's own read flag, 0/1/NULL
  // The nag. nag_count is capped by config rather than by the schema so the ceiling can be lowered
  // on a live box without a migration; handled_at is the human off-switch, because 'unanswered' only
  // clears when a reply goes out ON eBay and the owner may well have dealt with it another way.
  addColumnIfMissing(db, 'member_messages', 'nag_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'member_messages', 'nag_sent_at', 'TEXT');
  addColumnIfMissing(db, 'member_messages', 'handled_at', 'TEXT');
  addColumnIfMissing(db, 'member_messages', 'handled_by', 'TEXT');
  addColumnIfMissing(db, 'member_messages', 'marked_read_at', 'TEXT');
  // Where the card went, so a later tap can edit it in place instead of posting a second one
  // (the reprice_proposals / postsale_messages pattern).
  addColumnIfMissing(db, 'member_messages', 'telegram_chat_id', 'TEXT');
  addColumnIfMissing(db, 'member_messages', 'telegram_message_id', 'INTEGER');
  // The nag sweep's whole query: still open, still unanswered, still recent.
  db.exec('CREATE INDEX IF NOT EXISTS idx_mm_open ON member_messages(handled_at, status, creation_time)');

  migrateMessageKinds(db);
}

// postsale_messages was built as one row per order (order_id TEXT NOT NULL UNIQUE) back when the only
// message was the thank-you. Dispatch and delivered notes are a second and third message on the same
// order, so the constraint has to move to (order_id, kind).
//
// SQLite cannot drop a column constraint, so this is the one migration that rebuilds a table: create
// the new shape, copy every row across as kind='purchase', drop, rename. Rowids are copied explicitly
// because Telegram approval callbacks are keyed on postsale_messages.id — an id that shifted here
// would orphan every approval card already sitting in a chat. Guarded on the column so it runs once.
function migrateMessageKinds(db) {
  const cols = db.prepare('PRAGMA table_info(postsale_messages)').all().map((c) => c.name);
  if (!cols.length) return;
  if (cols.includes('kind')) {
    // Already the new shape (a fresh DB, or a second boot). The unique index still has to be ensured
    // here rather than in the DDL, because the DDL also runs against pre-kind databases.
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_order_kind ON postsale_messages(order_id, kind)');
    return;
  }
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE postsale_messages_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'purchase',           -- purchase|dispatch|delivered
      buyer_id INTEGER NOT NULL REFERENCES buyers(id),
      ebay_item_id TEXT,
      is_repeat_buyer INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      subject TEXT, body TEXT, model TEXT,
      telegram_chat_id TEXT, telegram_message_id INTEGER,
      decided_by TEXT, decided_at TEXT,
      sent_at TEXT, reply_detected_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`INSERT INTO postsale_messages_new
      (id, order_id, kind, buyer_id, ebay_item_id, is_repeat_buyer, status, subject, body, model,
       telegram_chat_id, telegram_message_id, decided_by, decided_at, sent_at, reply_detected_at,
       error, created_at, updated_at)
      SELECT id, order_id, 'purchase', buyer_id, ebay_item_id, is_repeat_buyer, status, subject, body, model,
             telegram_chat_id, telegram_message_id, decided_by, decided_at, sent_at, reply_detected_at,
             error, created_at, updated_at FROM postsale_messages`);
    db.exec('DROP TABLE postsale_messages');
    db.exec('ALTER TABLE postsale_messages_new RENAME TO postsale_messages');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_order_kind ON postsale_messages(order_id, kind)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ps_status ON postsale_messages(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ps_buyer  ON postsale_messages(buyer_id)');
    db.exec('COMMIT');
    console.log('[postsale-db] postsale_messages rebuilt with kind (purchase|dispatch|delivered)');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function initPostsaleDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');   // order_line_items / postsale_messages cascade with their order
  db.exec(DDL);
  try { migratePostsale(db); } catch (e) { console.error('[postsale-db] migration:', e?.message || e); }
  return db;
}
export function openPostsaleDb(dbPath = POSTSALE_DB_PATH) {
  if (_pdb) return _pdb;
  _pdb = initPostsaleDb(dbPath);
  return _pdb;
}
// Fresh, non-cached postsale DB — tests ONLY (never the process singleton / real data/postsale.db).
export function openPostsaleDbAt(dbPath) { return initPostsaleDb(dbPath); }

// --- meta helpers (poll cursors + activation watermark live here) ---
export function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
export function setMeta(db, key, value) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}
