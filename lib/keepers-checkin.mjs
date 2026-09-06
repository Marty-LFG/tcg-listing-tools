// lib/keepers-checkin.mjs — say g'day at a show, get 50 XP. The app-proxy half of the engine.
//
// One printed QR code, forever. It points at /pages/checkin on the storefront; the page renders the
// join pitch to a stranger and a claim button to a Keeper; the button posts through the App Proxy to
// this handler.
//
// WHY THE QR CARRIES NO SHOW ID. Liquid cannot read a query string — `request` exposes seven
// properties and none of them is the query (D-028). So a `?show=` parameter is invisible to the page
// that would have to render it. The alternative, a page per show, means reprinting the QR every time.
//
// Instead the SERVER infers the show from the clock: a configured list of shows with date windows,
// and a check-in outside every window is refused. One QR, printed once, works at every show and
// nowhere else. It also means a code photographed at a show cannot be used from the couch the
// following week, which a show id in the URL would happily allow.
//
// ⚠ THE IDENTITY CAVEAT THAT SHAPES EVERYTHING HERE. logged_in_customer_id has an acknowledged
// Shopify internal investigation (2026-08-04, no fix, no timeline) into being empty for genuinely
// logged-in customers on NEW customer accounts, which is what this store uses. The receiver already
// refuses the request when it is absent, and this handler never sees an unidentified caller. So the
// failure mode is "tap again", which a 50 XP hospitality reward can absorb — and it is exactly why
// nothing that SPENDS value is built on this path.
import { appendEvent, upsertCustomer, withTransaction, getCustomer } from './keepers-db.mjs';

/**
 * activeShow(shows, nowMs) — which show, if any, is on right now.
 *
 * A show is { slug, name, starts_at, ends_at }. Windows are inclusive of both ends and are compared
 * as ISO strings, which sorts correctly for UTC timestamps.
 *
 * Returns null outside every window, and null is a REFUSAL — never a fallback to "the most recent
 * show", which would turn the printed QR into a permanent 50 XP button.
 */
// Compare instants, NEVER ISO strings. new Date().toISOString() carries milliseconds
// ("...T22:00:00.000Z") while a hand-written config almost never does ("...T22:00:00Z") — and
// character-by-character, 'Z' (90) sorts after '.' (46). So a string comparison makes a show dead for
// the first second after it opens and alive for a second after it closes, in opposite directions.
// Parsing also makes the config tolerant of an offset ("+11:00") instead of Z, which someone writing
// Sydney show times by hand will eventually do.
//
// An unparseable date makes the show unusable rather than always-on: a typo must not open a
// permanent 50 XP button.
const instant = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null; };

export function activeShow(shows, nowMs = Date.now()) {
  const list = Array.isArray(shows) ? shows : [];
  const open = list.filter((s) => {
    if (!s || !s.slug) return false;
    const a = instant(s.starts_at); const b = instant(s.ends_at);
    return a !== null && b !== null && a <= nowMs && nowMs <= b;
  });
  if (!open.length) return null;
  // Overlapping windows are a config mistake rather than a scenario; take the one that started most
  // recently so the answer is at least deterministic.
  open.sort((x, y) => instant(y.starts_at) - instant(x.starts_at));
  return open[0];
}

/** The next show, purely so a refusal can say when to come back rather than just "no". */
export function nextShow(shows, nowMs = Date.now()) {
  const upcoming = (Array.isArray(shows) ? shows : [])
    .filter((s) => { const a = s && s.slug ? instant(s.starts_at) : null; return a !== null && a > nowMs; })
    .sort((a, b) => instant(a.starts_at) - instant(b.starts_at));
  return upcoming[0] || null;
}

/**
 * checkIn — award the XP, once per customer per show.
 *
 * Idempotency is the (source, source_ref, kind) unique index with source_ref `<slug>:<numericId>`, so
 * a double-tap, a page refresh and a retry after a dropped connection all land on the same row. The
 * SECOND tap is not an error — it returns the same cheerful answer as the first, because telling
 * someone their check-in failed when it plainly worked is worse than saying it twice.
 *
 * The caller supplies the transaction.
 */
export function checkIn(db, { customerGid, show, rules = {}, nowMs = Date.now() }) {
  if (!customerGid) return { ok: false, reason: 'not_signed_in' };
  if (!show || !show.slug) return { ok: false, reason: 'no_active_show' };

  const xp = Math.trunc(Number(rules.checkin_xp));
  // A misconfigured or zero award must not produce a cheerful "you earned 0 XP".
  if (!Number.isFinite(xp) || xp <= 0) return { ok: false, reason: 'checkin_disabled' };

  const numeric = (/(\d+)\s*$/.exec(String(customerGid)) || [])[1] || String(customerGid);
  const sourceRef = `${show.slug}:${numeric}`;

  upsertCustomer(db, { customerGid });
  const ev = appendEvent(db, {
    customerGid, kind: 'checkin', xpDelta: xp, pointsDelta: 0,
    source: 'checkin', sourceRef,
    occurredAt: new Date(nowMs).toISOString(),
    note: `check-in at ${show.name || show.slug}`,
    evidence: { show: show.slug, name: show.name || null },
  });

  return {
    ok: true,
    // `already` distinguishes the two for the admin and the soak table, while the customer-facing
    // message below stays the same either way.
    already: !ev.inserted,
    xp,
    show: show.slug,
    showName: show.name || show.slug,
  };
}

/**
 * makeCheckinHandler(getConfig) — the proxy handler the receiver calls.
 *
 * `getConfig()` returns { rules, shows } so the handler stays testable with no Shopify and no config
 * files. The receiver has already verified the signature, enforced timestamp freshness and refused
 * an unidentified caller before this runs, so everything here is about the show and the award.
 *
 * The copy is customer-facing and is written to be read on a phone, standing at a table, by someone
 * who has just scanned a code — short, warm, and never blaming them for a refusal that is ours.
 */
export function makeCheckinHandler(getConfig) {
  return async function handleCheckin(env, { customerGid, url, method }) {
    const path = String(url?.pathname || '');
    // The proxy path root is a status read; /checkin is the claim. A GET never awards anything.
    const claiming = method === 'POST' && /\/checkin\/?$/.test(path);

    let cfg;
    try { cfg = await getConfig(); }
    catch (e) { return { status: 503, body: { ok: false, reason: 'config_unavailable', message: 'We could not check that just now. Try again in a moment.' } }; }

    const { rules = {}, shows = [] } = cfg || {};
    const now = Date.now();
    const show = activeShow(shows, now);

    if (!show) {
      const next = nextShow(shows, now);
      return {
        status: 200,
        body: {
          ok: false,
          reason: 'no_active_show',
          message: next
            ? `No show on right now — catch us at ${next.name || next.slug}.`
            : 'No show on right now. Catch us at the next one!',
          next: next ? { slug: next.slug, name: next.name || next.slug, starts_at: next.starts_at } : null,
        },
      };
    }

    if (!claiming) {
      return { status: 200, body: { ok: true, ready: true, show: show.slug, showName: show.name || show.slug, xp: Math.trunc(Number(rules.checkin_xp)) || 0 } };
    }

    let out;
    try {
      const { openKeepersDb } = await import('./keepers-db.mjs');
      const db = openKeepersDb();
      withTransaction(db, () => { out = checkIn(db, { customerGid, show, rules, nowMs: now }); });
    } catch (e) {
      return { status: 500, body: { ok: false, reason: 'checkin_failed', message: 'Something went wrong on our side — grab us at the table and we will sort it.' } };
    }

    if (!out.ok) {
      return {
        status: 200,
        body: {
          ok: false, reason: out.reason,
          message: out.reason === 'checkin_disabled'
            ? 'Check-ins are not switched on right now.'
            : 'We could not check you in just now.',
        },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        xp: out.xp,
        already: out.already,
        show: out.show,
        showName: out.showName,
        // Deliberately the same words whether it is the first tap or the fifth. Someone who taps
        // twice has done nothing wrong, and "you already checked in" reads as a telling-off.
        message: `G'day! ${out.xp} XP added at ${out.showName}.`,
      },
    };
  };
}
