// lib/repricer-propose.mjs — turning a scan's `raise` verdicts into approvable proposals.
//
// The scan is read-only by contract (lib/repricer-scan.mjs writes price_checks and stops). This is
// the step that commits: a proposal is a promise to change a real price the moment someone taps
// Approve, so everything here is about making sure the promise is still true when it is made.
//
// All I/O is INJECTED (getLive / getImage / sendCard). That is not ceremony — it means the lifecycle
// rules below can be tested against a stub with no eBay and no Telegram, which is the only way to
// exercise the paths that matter: a price that moved, a duplicate, a strand left by a crash.
//
// Three lifecycle hazards drive the shape:
//
//   1. A proposal outliving its evidence. The card carries a price computed from comps that were
//      fresh at scan time; approving it hours later writes that stale number. `from_price_cents` is
//      the apply precondition (reviseTradingListing refuses on mismatch), and promotion re-reads eBay
//      so the precondition is true at the moment the card is SENT, not merely when it was computed.
//
//   2. Two open proposals for the same listing. Approving both writes twice, and the second write
//      fails its precondition in a way that reads as a bug. The database refuses this via a UNIQUE
//      partial index, so it holds even if two scans race — the check here is for a clean message.
//
//   3. A row stranded in 'applying'. The approve path claims the row, then talks to eBay. A restart
//      in between leaves a proposal that is neither pending nor applied, and nothing would ever look
//      at it again. reconcileApplying asks eBay what actually happened rather than guessing.

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const money = (c) => 'A$' + (Math.round(c) / 100).toFixed(2);

// How long a proposal stays approvable. Clamped to the scan cadence when the loop is running, so a
// card can never outlive the scan that would supersede it — otherwise a 24h TTL on a 4h cadence
// leaves the previous pass's price sitting in the chat while five newer reads have happened since.
// With scanning off there is no next pass, so the owner's TTL stands as written.
export function effectiveTtlHours(cfg = {}) {
  const ttl = Number((cfg.guardrails && cfg.guardrails.proposal_ttl_hours) || 24);
  const cadence = Number(cfg.cadence_hours || 0);
  if (cfg.scan_enabled === true && cadence > 0) return Math.max(1, Math.min(ttl, cadence));
  return Math.max(1, ttl);
}

// What the Telegram card says about WHY. Reads off the price_checks row so the card and the audit
// trail can never disagree, and names the anchor in the owner's own terms rather than in jargon.
export function evidenceSummary(check, cfg = {}) {
  const g = cfg.guardrails || {};
  const bits = [];
  if (g.target_anchor === 'cluster') {
    bits.push('Undercuts the cheapest listing in the main price band');
  } else {
    const n = g.anchor_n || 3;
    bits.push(`Undercuts the ${n === 1 ? 'cheapest' : n + (n === 2 ? 'nd' : n === 3 ? 'rd' : 'th') + ' cheapest'} Australian listing`);
  }
  if (check.target_delivered_cents != null) bits.push(`target ${money(check.target_delivered_cents)} delivered`);
  if (check.n_comparable != null) bits.push(`${check.n_comparable} comparable`);
  if (check.confidence) bits.push(`${check.confidence} confidence`);
  if (check.mode) bits.push(check.mode === 'sold' ? 'sold prices' : 'asking prices');
  return bits.join(' · ');
}

// Pending proposals past their expiry become 'expired'. Runs FIRST in a pass: an expired row still
// counts as open against the uniqueness rule, so sweeping late would make a listing look busy and
// silently skip it for another whole cycle.
export function expireProposals(db, now = nowSql()) {
  return db.prepare(`UPDATE reprice_proposals SET status='expired'
                     WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < ?`).run(now).changes;
}

// Resolve rows stranded in 'applying' by a restart between the claim and the write.
//
// It asks eBay what the price actually is rather than assuming either outcome. Assuming failure
// would re-open a proposal whose write DID land and raise the price a second time; assuming success
// would record a change that never happened. `graceMin` keeps it away from a write that is merely
// still in flight.
export async function reconcileApplying(db, { getLive, graceMin = 10, now = nowSql() } = {}) {
  const cutoff = new Date(Date.parse(now.replace(' ', 'T') + 'Z') - graceMin * 60_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare("SELECT * FROM reprice_proposals WHERE status='applying' AND decided_at < ?").all(cutoff);
  const out = { checked: rows.length, applied: 0, stranded: 0, unknown: 0 };
  for (const r of rows) {
    let live = null;
    try { live = await getLive(r.item_id); } catch { live = null; }
    if (!live || !live.ok || live.price_cents == null) { out.unknown++; continue; }   // try again next pass
    if (live.price_cents === r.to_price_cents) {
      db.prepare("UPDATE reprice_proposals SET status='applied', applied_at=datetime('now'), error=? WHERE id=?")
        .run('recovered: eBay already carried the new price after an interrupted apply', r.id);
      out.applied++;
    } else {
      db.prepare("UPDATE reprice_proposals SET status='stranded', error=? WHERE id=?")
        .run(`interrupted before the write landed — eBay still says ${money(live.price_cents)}`, r.id);
      out.stranded++;
    }
  }
  return out;
}

export function openProposalFor(db, itemId) {
  return db.prepare("SELECT * FROM reprice_proposals WHERE item_id=? AND status IN ('pending','applying')").get(itemId) || null;
}

// Promote a scan's `raise` rows into pending proposals, newest scan first, biggest uplift first.
//
// Returns a per-listing account of what happened — including the refusals, because "why did only one
// card arrive" is the question this will be asked most often.
export async function promoteFromScan({
  db, cfg = {}, scanId = null, chatId = null, max = 5,
  getLive, getImage = async () => null, sendCard,
  now = nowSql(),
} = {}) {
  const result = { scan_id: scanId, expired: 0, promoted: [], refused: [], sent: 0 };

  result.expired = expireProposals(db, now);

  const sid = scanId || (db.prepare("SELECT scan_id FROM price_checks WHERE verdict='raise' ORDER BY id DESC LIMIT 1").get() || {}).scan_id;
  if (!sid) return { ...result, error: 'no scan with a raise verdict to promote from' };
  result.scan_id = sid;

  const raises = db.prepare(`SELECT * FROM price_checks WHERE scan_id=? AND verdict='raise'
                             ORDER BY uplift_cents DESC`).all(sid);
  const ttlH = effectiveTtlHours(cfg);
  const refuse = (c, code, detail) => result.refused.push({ item_id: c.item_id, code, detail: detail || null });

  for (const c of raises) {
    if (result.promoted.length >= max) { refuse(c, 'over_max_cards_per_run'); continue; }
    if (openProposalFor(db, c.item_id)) { refuse(c, 'open_proposal'); continue; }
    if (!(c.target_cents > 0) || !(c.our_price_cents > 0)) { refuse(c, 'no_price'); continue; }

    // Hazard 1. The decision was made against `our_price_cents`; if eBay no longer agrees, the
    // evidence describes a listing that no longer exists. Refuse rather than carry the old number —
    // the apply would refuse it anyway, but much later and from inside a tap.
    let live = null;
    try { live = await getLive(c.item_id); } catch (e) { live = { ok: false, error: String(e && e.message || e) }; }
    if (!live || !live.ok) { refuse(c, 'listing_read_failed', live && live.error); continue; }
    if (live.listing_status && live.listing_status !== 'Active') { refuse(c, 'not_active', live.listing_status); continue; }
    if (live.price_cents !== c.our_price_cents) {
      refuse(c, 'stale_price', `scanned at ${money(c.our_price_cents)}, eBay now says ${money(live.price_cents)}`);
      continue;
    }
    // Up-only re-check at promotion, not only at the tap (AGENTS.md §15).
    if (!(c.target_cents > live.price_cents)) { refuse(c, 'not_an_increase'); continue; }

    let imageUrl = null;
    try { imageUrl = await getImage(c.item_id); } catch { /* a card without a picture is still a card */ }

    const evidence = JSON.stringify({
      summary: evidenceSummary(c, cfg),
      image_url: imageUrl,
      scan_id: sid,
      price_check_id: c.id,
      comparable: c.n_comparable, confidence: c.confidence, mode: c.mode, query: c.query,
      cluster_lo_cents: c.cluster_lo_cents, cluster_hi_cents: c.cluster_hi_cents,
      target_delivered_cents: c.target_delivered_cents, our_postage_cents: c.our_postage_cents,
    });

    // Hazard 2. The UNIQUE partial index is the real guard; this catch turns the constraint error
    // into a refusal line instead of aborting the whole promotion pass (GR7).
    let id;
    try {
      id = db.prepare(`INSERT INTO reprice_proposals
        (kind, item_id, title, from_price_cents, to_price_cents, currency, evidence, status, telegram_chat_id, expires_at)
        VALUES ('reprice', ?, ?, ?, ?, 'AUD', ?, 'pending', ?, datetime('now', ?))`)
        .run(c.item_id, live.title || c.item_id, live.price_cents, c.target_cents, evidence,
          chatId == null ? null : String(chatId), `+${ttlH} hours`).lastInsertRowid;
    } catch (e) {
      refuse(c, 'duplicate_open_proposal', String(e && e.message || e));
      continue;
    }

    db.prepare('UPDATE price_checks SET proposal_id=? WHERE id=?').run(id, c.id);
    const row = db.prepare('SELECT * FROM reprice_proposals WHERE id=?').get(id);
    result.promoted.push({ id, item_id: c.item_id, title: row.title, from_price_cents: row.from_price_cents, to_price_cents: row.to_price_cents });

    // A proposal nobody can see is worse than none — it holds the uniqueness slot while being
    // invisible — so a send failure marks the row failed and frees the listing for the next pass.
    if (!sendCard) continue;
    let sent = null;
    try { sent = await sendCard(row); } catch (e) { sent = { ok: false, description: String(e && e.message || e) }; }
    if (sent && sent.ok) {
      db.prepare('UPDATE reprice_proposals SET telegram_message_id=? WHERE id=?').run(sent.message_id, id);
      result.sent++;
    } else {
      db.prepare("UPDATE reprice_proposals SET status='failed', error=? WHERE id=?")
        .run('Telegram send failed: ' + ((sent && sent.description) || 'unknown'), id);
      result.promoted[result.promoted.length - 1].send_failed = true;
    }
  }
  return result;
}
