// lib/cross-channel.mjs — the Vite plugin that wires cross-channel sale handling together.
//
//   /api/channels/*        the in-person sale (per card and batch), the lookup, the sync worker's state,
//                          retry, and the drift report
//   the `stock` consumer   on the shared Shopify webhook receiver (lib/shopify-hooks.mjs)
//   two timers             the channel-sync worker (every minute) and the Shopify order poll (every 10)
//
// It holds no rules. The refusals and the queue live in lib/channel-presence.mjs, the writes in
// lib/channel-sync.mjs, the Shopify ingest in lib/shopify-stock-orders.mjs and the sale itself in
// lib/in-person-sales.mjs — so each can be read, and tested, without a server.
import crypto from 'node:crypto';
import { openDb, DB_PATH } from './db.mjs';
import { openPostsaleDb } from './postsale-db.mjs';
import { migrateChannelSync, channelPresence, scanMovements, pinMovementCursor, getSyncMeta, setSyncMeta } from './channel-presence.mjs';
import {
  defaultDeps, drainJobs, runChannelSyncTick, channelSyncState, retryJob, driftReport, applyDrift,
  startChannelSync, stopChannelSync, syncArmed, SYNC_OFF_MESSAGE,
} from './channel-sync.mjs';
import {
  registerStockConsumer, processStockEvents, pollShopifyOrders, shopifyStockState, liveStoreConfigured, ensureEpoch,
} from './shopify-stock-orders.mjs';
import { recordInPersonSale, previewInPerson, recentInPersonSales, lookupStock } from './in-person-sales.mjs';
import {
  listEvents, openEvents, createEvent, eventDetail, addToTakeList, removeFromTakeList, setReturned, takeOffline,
  scanBack, closeOutPreview, closeOut, addAcquisition, markAcquisitionPublished, backOnline,
} from './events.mjs';
import { ndjsonStart } from './ndjson.mjs';
import { escapeHtml } from './telegram.mjs';

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) b = b.slice(0, 1e6); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function diagOk(env, req, url) {
  const token = String(env.DIAG_TOKEN || process.env.DIAG_TOKEN || '').trim();
  if (!token) return { ok: false, code: 503, error: 'diagnostics disabled (no DIAG_TOKEN on server)' };
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (url.searchParams.get('token') || '').trim();
  if (!bearer) return { ok: false, code: 401, error: 'missing DIAG_TOKEN' };
  const a = Buffer.from(bearer), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, code: 403, error: 'bad DIAG_TOKEN' };
}

// --- the Shopify ingest, single-flight ------------------------------------------------------------
//
// The webhook dispatch and the 10-minute poll can both want to ingest at once. Ingest is idempotent, so
// overlapping would not double-sell, but it would read the same orders twice and race to the same
// decrement — one runner at a time, parked on globalThis so a Vite re-evaluation shares it.
function shopifyLock() { return globalThis.__shopifyStockLock || (globalThis.__shopifyStockLock = { running: null }); }
async function single(fn) {
  const L = shopifyLock();
  while (L.running) { try { await L.running; } catch { /* the previous run's failure is its own */ } }
  const run = fn();
  L.running = run;
  try { return await run; } finally { if (L.running === run) L.running = null; }
}

/**
 * makeChannelsRouter — the /api/channels surface over injected handles, so a test can drive it with a
 * temp database and stubbed channels without booting the dev server (the shape makeShopifyRouter uses).
 */
export function makeChannelsRouter({ env = {}, db, pdb = null, deps = null } = {}) {
  const syncCtx = () => ({ db, env, deps: deps || defaultDeps() });
  const shopCtx = () => ({
    pdb: pdb || openPostsaleDb(), tdb: db, fetchImpl: (deps && deps.fetchImpl) || undefined,
    graphql: (deps && deps.graphql) || null,
    alert: (msg) => (deps || defaultDeps()).alert(env, '⚠️ <b>Double sale</b>\n' + escapeHtml(msg)),
  });

  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      migrateChannelSync(db);

      // GET /lookup?q= — the phone's search: an exact label first, then names, with where each is live.
      if (p === '/lookup' && method === 'GET') {
        return send(res, 200, { results: lookupStock(db, url.searchParams.get('q') || '', { limit: 20 }) });
      }

      // GET /presence?kind=&id= — where one row is for sale right now.
      if (p === '/presence' && method === 'GET') {
        const kind = url.searchParams.get('kind') === 'sealed' ? 'sealed' : 'inventory';
        return send(res, 200, channelPresence(db, kind, { itemId: +url.searchParams.get('id') }));
      }

      // POST /in-person/preview { lines } — resolve and check, write NOTHING. The end-of-day paste is
      // checked here first so a mistyped label is caught before any card leaves any channel.
      if (p === '/in-person/preview' && method === 'POST') {
        const b = await readJson(req);
        const rows = previewInPerson(db, Array.isArray(b.lines) ? b.lines : []);
        return send(res, 200, { rows, ok: rows.filter((r) => r.ok).length, refused: rows.filter((r) => !r.ok).length });
      }

      // POST /in-person { lines:[{sku|kind+id, qty, unit_price_cents, location}], event, note, actor }
      //
      // ONE LINE answers as JSON once its channels have been brought down (or the ~20 s budget runs
      // out — the worker finishes the rest). SEVERAL LINES stream NDJSON: every sale is recorded first,
      // which is fast and local, then each card's channels, so a slow eBay never holds up writing the
      // day's sales down.
      if (p === '/in-person' && method === 'POST') {
        const b = await readJson(req);
        const lines = Array.isArray(b.lines) ? b.lines : (b.sku || b.id ? [b] : []);
        if (!lines.length) return send(res, 400, { error: 'pass lines: [{ sku, qty, unit_price_cents }]' });
        if (lines.length > 500) return send(res, 400, { error: 'at most 500 lines per batch' });
        // event_id: the show the sale belongs to (sell.html's picker). Absent, a card on an open show's
        // take-list is still counted against that show — recordInPersonSale finds it.
        const opts = { event: b.event || null, note: b.note || null, actor: b.actor || null, eventId: b.event_id != null && b.event_id !== '' ? +b.event_id : null };
        const ctx = syncCtx();

        if (lines.length === 1 && !b.stream) {
          const sale = recordInPersonSale(db, lines[0], opts);
          if (!sale.ok) return send(res, sale.code === 'not_found' ? 404 : 409, sale);
          const channels = await drainJobs(ctx, sale.jobs.map((j) => j.id), { budgetMs: Number(b.budget_ms) || 20_000 });
          return send(res, 201, { sale, channels, unreached: channels.filter((c) => !c.ok), sync_armed: syncArmed(env), ...(syncArmed(env) ? {} : { sync_note: SYNC_OFF_MESSAGE }) });
        }

        const write = ndjsonStart(res);
        let closed = false; res.on('close', () => { closed = true; });
        const batchRef = 'b-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex');
        write({ start: { lines: lines.length, batch_ref: batchRef, sync_armed: syncArmed(env), ...(syncArmed(env) ? {} : { sync_note: SYNC_OFF_MESSAGE }) } });
        const recorded = [];
        let refused = 0;
        for (let i = 0; i < lines.length; i++) {
          const sale = recordInPersonSale(db, lines[i], { ...opts, batchRef });
          if (sale.ok) recorded.push({ index: i, sale }); else refused++;
          write({ recorded: { index: i, ...sale } });
        }
        // The channels, card by card. The response closing does NOT undo anything — every job is in the
        // outbox already, so a dropped phone connection only drops the view.
        let channelsOk = 0, channelsBad = 0, pending = 0;
        const started = Date.now();
        for (const r of recorded) {
          if (closed) break;
          if (!r.sale.jobs.length) { write({ channels: { index: r.index, sale_id: r.sale.sale_id, sku: r.sale.item?.sku, results: [], note: r.sale.already ? 'already recorded — not written again' : 'not listed anywhere online' } }); continue; }
          const left = Math.max(2_000, 120_000 - (Date.now() - started));
          const results = await drainJobs(ctx, r.sale.jobs.map((j) => j.id), { budgetMs: left });
          for (const x of results) { if (x.ok) channelsOk++; else if (x.pending || x.state === 'blocked') pending++; else channelsBad++; }
          write({ channels: { index: r.index, sale_id: r.sale.sale_id, sku: r.sale.item?.sku, results } });
        }
        write({ summary: { batch_ref: batchRef, lines: lines.length, recorded: recorded.length, refused, channels_ok: channelsOk, channels_failed: channelsBad, pending } });
        return res.end();
      }

      // GET /in-person?limit=&since= — what was sold over the table, newest first.
      if (p === '/in-person' && method === 'GET') {
        return send(res, 200, { sales: recentInPersonSales(db, { limit: +url.searchParams.get('limit') || 50, since: url.searchParams.get('since') }) });
      }

      // GET /state — the worker, its queue, what failed and what gave up, plus the Shopify order feed.
      if (p === '/state' && method === 'GET') {
        let shopify = null;
        try { shopify = { configured: liveStoreConfigured(env), ...shopifyStockState(pdb || openPostsaleDb()) }; }
        catch (e) { shopify = { error: String(e?.message || e) }; }
        return send(res, 200, { sync: channelSyncState(db, env), shopify });
      }

      // POST /sync — run one pass now (the page's "Retry now"). Only ever lowers a channel.
      if (p === '/sync' && method === 'POST') {
        const r = await runChannelSyncTick(syncCtx(), { trigger: 'manual' });
        return send(res, 200, r);
      }

      // POST /jobs/:id/retry — put a failed or dead job back on the queue now.
      let m;
      if ((m = p.match(/^\/jobs\/(\d+)\/retry$/)) && method === 'POST') {
        const r = retryJob(db, +m[1]);
        if (!r.ok) return send(res, 409, r);
        const results = await drainJobs(syncCtx(), r.requeued, { budgetMs: 20_000 });
        return send(res, 200, { ...r, results });
      }

      // --- shows and markets (lib/events.mjs) -----------------------------------------------------
      if (p === '/events' && method === 'GET') {
        return send(res, 200, { events: listEvents(db, { status: url.searchParams.get('status') || null }), open: openEvents(db) });
      }
      if (p === '/events' && method === 'POST') {
        const r = createEvent(db, await readJson(req));
        return send(res, r.ok ? 201 : 400, r);
      }
      let em;
      if ((em = p.match(/^\/events\/(\d+)(\/.*)?$/))) {
        const eid = +em[1], sub = em[2] || '';
        const status = (r) => (r.ok ? 200 : r.code === 'not_found' ? 404 : 409);
        if (!sub && method === 'GET') {
          const d = eventDetail(db, eid);
          return d ? send(res, 200, d) : send(res, 404, { error: 'no such event' });
        }
        if (sub === '/items' && method === 'POST') {
          const r = addToTakeList(db, eid, await readJson(req));
          // An item added to an OFFLINE show goes through take-offline again, so it meets the same canary
          // rules as everything else: hidden at once on an eBay path the show has proved, held behind a
          // fresh canary on one it has not (or after a canary failed). Never sent blind.
          if (r.ok && r.needs_offline) r.offline = await takeOffline(syncCtx(), eid);
          return send(res, status(r), r);
        }
        let im;
        if ((im = sub.match(/^\/items\/(\d+)$/)) && method === 'DELETE') { const r = removeFromTakeList(db, eid, +im[1]); return send(res, status(r), r); }
        if ((im = sub.match(/^\/items\/(\d+)\/returned$/)) && method === 'POST') {
          const b = await readJson(req); const r = setReturned(db, eid, +im[1], b.qty); return send(res, status(r), r);
        }
        if (sub === '/offline' && method === 'POST') {
          const b = await readJson(req);
          const r = await takeOffline(syncCtx(), eid, { confirmed: !!b.confirm });
          return send(res, r.ok ? 200 : (r.report && r.code !== 'confirm_retry' ? 200 : status(r)), r);
        }
        if (sub === '/return' && method === 'POST') { const r = scanBack(db, eid, await readJson(req)); return send(res, status(r), r); }
        if (sub === '/close-out/preview' && method === 'POST') { const r = closeOutPreview(db, eid, await readJson(req)); return send(res, status(r), r); }
        if (sub === '/close-out' && method === 'POST') { const r = await closeOut(syncCtx(), eid, await readJson(req)); return send(res, status(r), r); }
        if (sub === '/acquisitions' && method === 'POST') { const r = addAcquisition(db, eid, await readJson(req)); return send(res, r.ok ? 201 : status(r), r); }
        if ((im = sub.match(/^\/acquisitions\/(\d+)\/published$/)) && method === 'POST') {
          const r = markAcquisitionPublished(db, eid, +im[1], await readJson(req)); return send(res, status(r), r);
        }
        if (sub === '/back-online' && method === 'POST') { const r = await backOnline(syncCtx(), eid); return send(res, status(r), r); }
        return send(res, 404, { error: 'unknown event route ' + sub });
      }

      // GET /drift — every channel offering more than the shelf holds. REPORT-ONLY.
      if (p === '/drift' && method === 'GET') return send(res, 200, driftReport(db));

      // POST /drift/apply { items:[{kind, item_id}|{kind:'sealed', pool_sku}] } — bring NAMED rows down.
      // Takes ids rather than "everything", because pre-existing drift is exactly where a wrong local
      // row would end a live listing, and a person should have looked at each one.
      if (p === '/drift/apply' && method === 'POST') {
        const b = await readJson(req);
        const items = Array.isArray(b.items) ? b.items : [];
        if (!items.length) return send(res, 400, { error: 'name the rows: items: [{ kind, item_id }]' });
        const q = applyDrift(db, { items });
        const results = await drainJobs(syncCtx(), q.queued, { budgetMs: 30_000 });
        return send(res, 200, { ...q, results });
      }

      // POST /shopify/poll { since? } — read the live store's orders now. DIAG-gated like every manual
      // trigger that can move stock. `since` (ISO) is the deliberate BACKFILL: the poll never reaches
      // back before its first run by itself, so orders paid before this was deployed are only ingested
      // when someone asks for them, having looked at what they are.
      if (p === '/shopify/poll' && method === 'POST') {
        const d = diagOk(env, req, url);
        if (!d.ok) return send(res, d.code, { error: d.error });
        if (!liveStoreConfigured(env)) return send(res, 409, { error: 'the live Shopify store is not configured on this box', code: 'not_connected' });
        if (!syncArmed(env)) return send(res, 409, { error: SYNC_OFF_MESSAGE, code: 'sync_off' });
        const b = await readJson(req);
        const r = await single(() => pollShopifyOrders(env, shopCtx(), { since: b.since || null }));
        await runChannelSyncTick(syncCtx(), { trigger: 'shopify-poll' });
        return send(res, 200, r);
      }

      return send(res, 404, { error: 'unknown /api/channels route ' + p });
    } catch (e) {
      console.error('[cross-channel] route failed —', e?.message || e);
      if (!res.headersSent) return send(res, 500, { error: String(e?.message || e) });
      try { res.end(); } catch { /* already closed */ }
    }
  };
}

// --- jobs ------------------------------------------------------------------------------------------

export function stopShopifyStockPoll() {
  for (const k of ['__shopifyStockPollTimer', '__shopifyStockPollBoot']) {
    if (globalThis[k]) { clearInterval(globalThis[k]); clearTimeout(globalThis[k]); globalThis[k] = null; }
  }
}

function startShopifyStockPoll(env, shopCtx, syncCtx, { everyMin = 10, bootDelayMs = 90_000 } = {}) {
  stopShopifyStockPoll();
  // Off unless armed: the poll ingests Shopify orders and marks real cards sold here, which is exactly
  // what must not start happening on its own the day this is deployed.
  if (!syncArmed(env)) {
    console.log('[shopify-stock] OFF — CROSS_CHANNEL_SYNC is not on, so Shopify orders are not read for stock');
    return;
  }
  if (!liveStoreConfigured(env)) {
    console.log('[shopify-stock] live store not configured — the order poll is off; webhooks (if any) still queue');
    return;
  }
  const tick = () => single(() => pollShopifyOrders(env, shopCtx()))
    .then(() => runChannelSyncTick(syncCtx(), { trigger: 'shopify-poll' }))
    .catch((e) => console.warn('[shopify-stock] poll failed —', e?.message || e));
  const boot = setTimeout(tick, bootDelayMs); if (boot.unref) boot.unref();
  const timer = setInterval(tick, Math.max(1, everyMin) * 60_000); if (timer.unref) timer.unref();
  globalThis.__shopifyStockPollBoot = boot;
  globalThis.__shopifyStockPollTimer = timer;
}

export function crossChannelPlugin(env = {}) {
  return {
    name: 'cross-channel',
    configureServer(server) {
      const db = openDb();
      try { migrateChannelSync(db); } catch (e) { console.error('[cross-channel] could not migrate —', e?.message || e); }
      // DISARMED unless CROSS_CHANNEL_SYNC is on (lib/channel-sync.mjs syncArmed). Off, nothing here reads
      // the ledger, Shopify orders or a live channel: the box behaves as it did before this existed, and
      // an in-person sale records local stock with its channel updates left in the queue.
      //
      // THE FIRST ARMED BOOT IS A MOMENT, and nothing before it is replayed. The ledger cursor is pinned to
      // the current end (so a month of sales made while it was off does not turn into a month of eBay ends
      // the minute it is armed), and the Shopify epoch is set (so an order paid before it is never adopted
      // as a new sale). Both happen synchronously, here, before any tick or delivery can run. Later armed
      // boots just queue whatever the ledger gained while the server was down — no network, the tick sends.
      if (syncArmed(env)) {
        try {
          if (!getSyncMeta(db, 'armed_at')) {
            const top = pinMovementCursor(db);
            setSyncMeta(db, 'armed_at', new Date().toISOString());
            console.log('[channel-sync] ARMED for the first time — ledger cursor pinned at movement #' + top + '; nothing before this is replayed');
          }
          scanMovements(db);
        } catch (e) { console.error('[channel-sync] could not read the ledger cursor —', e?.message || e); }
        try { ensureEpoch(openPostsaleDb()); } catch (e) { console.error('[shopify-stock] could not set the epoch —', e?.message || e); }
      } else {
        console.log('[cross-channel] sync is OFF (CROSS_CHANNEL_SYNC is not on) — in-person sales record locally, nothing is sent to eBay or Shopify');
      }
      const syncCtx = () => ({ db, env, deps: defaultDeps() });
      const shopCtx = () => ({
        pdb: openPostsaleDb(), tdb: db,
        alert: (msg) => defaultDeps().alert(env, '⚠️ <b>Double sale</b>\n' + escapeHtml(msg)),
      });
      server.middlewares.use('/api/channels', makeChannelsRouter({ env, db }));

      // The Shopify `stock` consumer. record() stores the delivery before the receiver acks; schedule()
      // runs after the ack, debounced by the receiver, and is where the slow work goes.
      try {
        registerStockConsumer({
          pdbFn: () => openPostsaleDb(),
          armed: () => syncArmed(env),
          schedule: async () => {
            const r = await single(() => processStockEvents(env, shopCtx()));
            await runChannelSyncTick(syncCtx(), { trigger: 'shopify-webhook' });
            return { ok: true, ...r };
          },
        });
      } catch (e) { console.error('[cross-channel] could not register the Shopify stock consumer —', e?.message || e); }

      try { startChannelSync(syncCtx); } catch (e) { console.error('[channel-sync] could not start —', e?.message || e); }
      try { startShopifyStockPoll(env, shopCtx, syncCtx); } catch (e) { console.error('[shopify-stock] could not start the poll —', e?.message || e); }
      console.log('[cross-channel] DB ' + DB_PATH + ' · API /api/channels');
    },
    closeBundle() { stopChannelSync(); stopShopifyStockPoll(); },
  };
}
