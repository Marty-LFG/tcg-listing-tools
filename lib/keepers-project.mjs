// lib/keepers-project.mjs — the ledger, projected onto Shopify customer metafields.
//
// The metafields are DERIVED, DISPOSABLE AND REBUILDABLE. Nothing here reads one to compute a new
// value; every value is a SUM over keepers_events. The `*_written` columns record what we last WROTE,
// never what is true, and exist only so an unchanged customer can be skipped.
//
// A CONSEQUENCE MARTY NEEDS TOLD, and it belongs on the admin page: editing keepers.xp in the Shopify
// admin does nothing durable. The reconcile pass will overwrite it within hours. That is not a bug —
// it is what "projection" means — but it will look like one to anyone who tries it.
//
// LOST UPDATES. metafieldsSet is last-write-wins with no compare-and-swap, so the only defence is that
// exactly ONE thing writes. Two guards, because they fail differently:
//
//   in-process   a single-flight promise, so one instance cannot overlap itself.
//   cross-process a LEASE row in keepers_meta. A second instance of this tool on the same box — which
//                 is precisely what a development worktree is — refuses rather than duels.
//
// FAIL CLOSED ON CONFIG. If the rank table cannot be read, this refuses to project at all. Writing
// level 1 to everyone because a config read failed would silently demote every Keeper on the store,
// and would look exactly like success.
import { shopifyGraphQL } from './channels/shopify-admin.mjs';
import { ledgerTotals, ledgerBadges, getCustomer, getMeta, setMeta } from './keepers-db.mjs';
import { levelForXp, rankTableProblem } from './keepers-levels.mjs';
import { evaluateBadges } from './keepers-badges.mjs';

export const LEASE_KEY = 'projection_lease';
export const NAMESPACE = 'keepers';

export const METAFIELDS_SET = `
mutation($mf: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $mf) {
    metafields { namespace key }
    userErrors { field message code }
  }
}`;

/**
 * acquireLease(db, holderId, ttlSec)
 *
 * A second writer must REFUSE, not wait and then also write. Returns true if this holder owns the
 * lease. Expiry rather than release-on-exit, because the failure this guards against is a process
 * that died without cleaning up.
 */
export function acquireLease(db, holderId, { ttlSec = 300, nowMs = Date.now() } = {}) {
  const now = new Date(nowMs).toISOString();
  const until = new Date(nowMs + ttlSec * 1000).toISOString();
  let cur = null;
  try { cur = JSON.parse(getMeta(db, LEASE_KEY) || 'null'); } catch { cur = null; }
  if (cur && cur.holder !== holderId && cur.until > now) return false;   // someone else holds it
  setMeta(db, LEASE_KEY, JSON.stringify({ holder: holderId, until }));
  return true;
}

export function releaseLease(db, holderId) {
  let cur = null;
  try { cur = JSON.parse(getMeta(db, LEASE_KEY) || 'null'); } catch { cur = null; }
  if (cur && cur.holder === holderId) setMeta(db, LEASE_KEY, null);
}

/**
 * projectionFor(db, customerGid, { rankTable, badges, rules })
 *
 * Pure-ish: reads the ledger, returns what SHOULD be on the customer. No network.
 *
 * Returns null when the customer has no ledger events at all — and that null is load-bearing. Writing
 * zeroes to a customer who has never earned anything would flip the storefront from its "not started
 * yet" state into a dashboard of zeroes, which reads as a broken programme rather than an unstarted
 * one. No events means no metafields means the theme's own graceful state.
 */
export function projectionFor(db, customerGid, { rankTable, badges = [], rules = {} }) {
  const problem = rankTableProblem(rankTable);
  if (problem) throw new Error(`cannot project: ${problem}`);

  const totals = ledgerTotals(db, customerGid);
  const row = getCustomer(db, customerGid);
  if (!row || totals.events === 0) return null;

  // The ledger may be negative — spend points, then refund the order that earned them. The customer
  // sees zero and earns their way back; the shortfall stays visible in the ledger and in the admin.
  const xp = Math.max(0, totals.xp);
  const points = Math.max(0, totals.points);
  const lvl = levelForXp(xp, rankTable);

  const facts = factsFor(db, customerGid, { level: lvl.level });
  const { earned } = evaluateBadges(facts, { badges, rules });
  // Badges already awarded in the ledger are never withdrawn, so the projected set is the union.
  const all = [...new Set([...ledgerBadges(db, customerGid), ...earned])].sort();

  return {
    customerGid,
    xp, points, level: lvl.level, badges: all,
    joinedAt: row.joined_at || null,
    rankName: lvl.rankName,
    negativeShortfall: totals.points < 0 ? -totals.points : 0,
  };
}

/**
 * factsFor — the badge evaluator's inputs, assembled from the ledger and the order table.
 *
 * Everything here comes from what was RECORDED, not from re-reading Shopify. That is the snapshot
 * discipline keepers-ingest establishes: re-reading a product's release status later would make
 * preorder-pioneer permanently unwinnable.
 */
export function factsFor(db, customerGid, { level = 1 } = {}) {
  const gid = String(customerGid);
  const orders = db.prepare(`
    SELECT occurred_at, evidence FROM keepers_events
    WHERE customer_gid = ? AND kind = 'order_accrual' AND status = 'applied'
    ORDER BY id
  `).all(gid);

  const languages = new Set();
  const skus = new Set();
  let hasPreorder = false;
  const orderDates = [];
  for (const o of orders) {
    if (o.occurred_at) orderDates.push(o.occurred_at);
    let e = null;
    try { e = o.evidence ? JSON.parse(o.evidence) : null; } catch { e = null; }
    if (!e) continue;
    for (const l of e.languages || []) languages.add(l);
    for (const s of e.skus || []) skus.add(s);
    if (e.preorder) hasPreorder = true;
  }

  const referralCount = Number(db.prepare(`
    SELECT COUNT(*) n FROM keepers_events
    WHERE customer_gid = ? AND kind = 'referral_referrer' AND status = 'applied'
  `).get(gid)?.n) || 0;

  const runsVerified = Number(db.prepare(`
    SELECT COUNT(*) n FROM keepers_events WHERE customer_gid = ? AND source = 'runs' AND status = 'applied'
  `).get(gid)?.n) > 0;

  return {
    orderCount: orders.length,
    level,
    languages: [...languages],
    skus: [...skus],
    hasPreorder,
    orderDates,
    referralCount,
    runsVerified,
  };
}

/** Has anything actually changed since the last write? Skipping is the common case. */
export function isUnchanged(row, projection) {
  if (!row || !projection) return false;
  return Number(row.xp_written) === projection.xp
    && Number(row.points_written) === projection.points
    && Number(row.level_written) === projection.level
    && String(row.badges_written || '') === projection.badges.join(',')
    && String(row.joined_at_written || '') === String(projection.joinedAt || '');
}

/** The five metafields, in the shape metafieldsSet wants. Every value is a string. */
export function metafieldInputs(projection) {
  const mf = [
    { key: 'xp', type: 'number_integer', value: String(projection.xp) },
    { key: 'points', type: 'number_integer', value: String(projection.points) },
    { key: 'level', type: 'number_integer', value: String(projection.level) },
    { key: 'badges', type: 'list.single_line_text_field', value: JSON.stringify(projection.badges) },
  ];
  // joined_at is written once and never rewritten — it is what the storefront tests to decide whether
  // someone is a Keeper at all, so moving it would restate their history.
  if (projection.joinedAt) {
    mf.push({ key: 'joined_at', type: 'date_time', value: new Date(projection.joinedAt).toISOString() });
  }
  return mf.map((m) => ({ ...m, namespace: NAMESPACE, ownerId: projection.customerGid }));
}

/**
 * projectDirty — write the customers whose numbers have moved.
 *
 * `writer` is injectable so the decision logic is testable without a network. In production it is the
 * metafieldsSet call below.
 *
 * Pacing comes from shopify-admin's cost-bucket throttle, which reads the real numbers off
 * extensions.cost. DO NOT add a second rate limiter here — two throttles disagreeing is worse than
 * one, and the existing one already reserves headroom.
 */
export async function projectDirty(env, db, {
  rankTable, badges = [], rules = {}, store = 'dev', limit = 50,
  holderId = `pid:${process.pid}`, nowMs = Date.now(), writer = null, allowLive = false,
} = {}) {
  const started = new Date(nowMs).toISOString();

  // guardLiveStore's shape: reaching production takes a second, deliberate switch.
  // `!== true`, not `!allowLive`. This is the last gate before real customer metafields, and it must
  // not treat a truthy 1 or "false" as consent — guardLiveStore's discipline, applied here.
  if (store === 'live' && allowLive !== true) {
    return { ok: false, at: started, error: 'live_not_allowed', written: 0, skipped: 0 };
  }
  const problem = rankTableProblem(rankTable);
  if (problem) return { ok: false, at: started, error: 'rank_table_unusable', detail: problem, written: 0, skipped: 0 };

  if (!acquireLease(db, holderId, { nowMs })) {
    return { ok: true, at: started, skippedRun: 'lease_held_elsewhere', written: 0, skipped: 0 };
  }

  const due = db.prepare(`
    SELECT customer_gid FROM keepers_customers
    WHERE dirty = 1 AND (next_write_at IS NULL OR next_write_at <= ?)
    ORDER BY next_write_at IS NOT NULL, next_write_at
    LIMIT ?
  `).all(started, limit);

  let written = 0; let skipped = 0; let failed = 0;
  const problems = [];

  for (const { customer_gid: gid } of due) {
    let projection;
    try { projection = projectionFor(db, gid, { rankTable, badges, rules }); }
    catch (e) { problems.push({ gid, error: String(e?.message || e) }); failed++; continue; }

    if (!projection) {
      // No events: nothing to write, and the customer must keep the theme's "not started" state.
      db.prepare('UPDATE keepers_customers SET dirty = 0, write_error = NULL WHERE customer_gid = ?').run(gid);
      skipped++;
      continue;
    }

    const row = getCustomer(db, gid);
    if (isUnchanged(row, projection)) {
      db.prepare('UPDATE keepers_customers SET dirty = 0, write_error = NULL WHERE customer_gid = ?').run(gid);
      skipped++;
      continue;
    }

    const mf = metafieldInputs(projection);
    let ok = false; let err = null;
    try {
      const res = writer
        ? await writer(mf, { gid, projection })
        : await shopifyGraphQL(env, METAFIELDS_SET, { mf }, { store });
      // shopifyGraphQL's `ok` already means no top-level errors AND no userErrors anywhere, so a
      // partial write cannot be recorded as success.
      ok = Boolean(res?.ok);
      if (!ok) err = JSON.stringify(res?.userErrors || res?.errors || 'write_failed').slice(0, 500);
    } catch (e) { err = String(e?.message || e); }

    if (ok) {
      db.prepare(`
        UPDATE keepers_customers SET
          xp_written = ?, points_written = ?, level_written = ?, badges_written = ?, joined_at_written = ?,
          written_at = ?, dirty = 0, write_attempt = 0, next_write_at = NULL, write_error = NULL
        WHERE customer_gid = ?
      `).run(projection.xp, projection.points, projection.level, projection.badges.join(','),
        projection.joinedAt || null, started, gid);
      written++;
    } else {
      // Backoff, and dirty is NEVER cleared on failure — the customer stays queued until it lands.
      const attempt = Number(row?.write_attempt || 0) + 1;
      const delayMs = Math.min(2 ** attempt * 30000, 3600000);
      db.prepare(`
        UPDATE keepers_customers SET write_attempt = ?, next_write_at = ?, write_error = ?
        WHERE customer_gid = ?
      `).run(attempt, new Date(nowMs + delayMs).toISOString(), err, gid);
      problems.push({ gid, error: err });
      failed++;
    }
  }

  releaseLease(db, holderId);
  return {
    ok: failed === 0, at: started, due: due.length,
    written, skipped, failed, problems: problems.slice(0, 20),
  };
}

/** Queue depth, for /api/status. A number that only ever grows is the alarm. */
export function projectionQueueDepth(db) {
  return Number(db.prepare('SELECT COUNT(*) n FROM keepers_customers WHERE dirty = 1').get()?.n) || 0;
}
