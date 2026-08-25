// lib/riftbound-cards.mjs — the Riftbound catalogue over HTTP, for the two STOCK tools.
//
// This is a SERVING module, not a fetching one, and that is the whole difference from its four
// siblings. Pokemon, Magic, Lorcana and One Piece each have a live upstream and a disk cache in
// front of it; Riftbound has no keyless card API the server can rely on (Scrydex needs a key and
// answers 402 SUBSCRIPTION_INACTIVE), so data/riftbound.json IS the source — baked from Riot's own
// card gallery by scripts/build-riftbound-data.mjs and re-baked daily by lib/refresh.mjs. There is
// nothing to cache, nothing to collapse, and no upstream that could be down.
//
// What it still owes the pages is the ENVELOPE. stock-runner.html asks its adapter for a URL and
// then parses one shape — { cards, cachedAt, stale, partial } — whatever the game, so this answers
// in exactly the form lib/pkm-cards-cache.mjs and lib/lorcana-cards-cache.mjs do.
//
// WHY NOT just serve data/riftbound.json statically (the way pokemon-intl reads
// /data/pokemon-intl-sets.json): it is 314 KB of all five sets for one set pick, it carries no
// price join, and it cannot produce the envelope the page parses.
//
// ROUTE PREFIX. These live under /api/riftbound/ and NOT under /api/rb…, for the reason
// lib/riftbound-prices.mjs already records: vite.config.js declares an '/api/rb' proxy to
// api.scrydex.com, Vite matches proxy contexts by startsWith in declaration order, and its rewrite
// would turn '/api/rbound/sets' into '/riftbound/v1ound/sets'.
//
// PLUGIN ORDER. lib/riftbound-prices.mjs mounts at the BARE '/api/riftbound' prefix and always
// ends the response — it never calls next(). So this plugin must be registered BEFORE it in
// vite.config.js, or every route here comes back as that plugin's
// 404 { usage: 'GET /api/riftbound/prices/:identityKey' }. Pinned by
// test/invariants/riftbound-route-order.test.mjs, which asserts the order AND proves the reason.
import fs from 'node:fs';
import { isSetId, sendJson } from './set-cache.mjs';
import {
  dataPathDefault, loadRiftboundData, loadRiftboundSets, iterateRiftboundSet, resolveRiftboundCard, normNum,
} from './riftbound-data.mjs';
import { loadRiftboundPrices, priceFor } from './riftbound-prices.mjs';

const LABEL = 'riftbound-cards';

// The bake's own mtime is the honest `cachedAt`: it is when this data was last true, and it is what
// the refresh timer moves. Null when the file is not there at all.
function bakedAt(dataPath = dataPathDefault()) {
  try { return new Date(fs.statSync(dataPath).mtimeMs).toISOString(); } catch { return null; }
}

// loadRiftboundData returns {} for a missing OR mid-rename file, so an empty catalog is the state
// to report — never an empty set list, which reads as "this game has no sets" (GR4).
const catalogMissing = () => Object.keys(loadRiftboundData()).length === 0;

const MISSING = {
  error: 'riftbound catalog not baked yet',
  code: 'catalog_missing',
  hint: 'node scripts/build-riftbound-data.mjs (or POST /api/status/refresh)',
};

// One card on the wire: everything cardToCanonical derives, plus the two identity fields the
// canonical shape does not carry, plus the price join.
//
// `k` IS MANDATORY. identity_key is SETCODE + '-' + k (lib/enumerate.mjs ENUMERATORS.riftbound) and
// k is the normNum key — lowercase, zero-stripped ('27a', '299*', 'sp1') — where `number` is the
// printed string ('027a/298'). A client deriving the key from the printed number would build one
// that the price index, the watchlist and data/riftbound-prices.json have never seen.
function wireCard(canonical, k, setCode, prices) {
  const row = priceFor(setCode + '-' + k, prices);
  return {
    ...canonical,
    k,
    setCode,
    // The batch runner's disagreement detector (flagsFor, lib/runner-core.mjs) is Riftbound's ONLY
    // independent second opinion — every eBay comp we have is an ASKING price, and there is no
    // other market feed. Without this join every row would come back `unverified`, which is a
    // hundred flags that mean nothing. Both files are local, so the join costs one lookup per card.
    marketUsd: row && typeof row.market === 'number' ? row.market : null,
    marketCurrency: (row && row.currency) || null,
  };
}

/**
 * GET /api/riftbound/sets                      -> { sets: [{ id, code, name, total }], count, cachedAt }
 * GET /api/riftbound/set/:setId/cards          -> { setId, count, cachedAt, source, stale, partial, cards }
 * GET /api/riftbound/cards/:setId/:num         -> one card (404 body carries NO `name`)
 */
export function riftboundCardsPlugin() {
  return {
    name: 'riftbound-cards',
    configureServer(server) {
      // ---- the set roster ------------------------------------------------------------------
      server.middlewares.use('/api/riftbound/sets', (req, res, next) => {
        const urlPath = String(req.url || '/').split('?')[0];
        if (req.method !== 'GET' || (urlPath !== '/' && urlPath !== '')) return next();
        if (catalogMissing()) return sendJson(res, 503, MISSING, 'none');
        const sets = loadRiftboundSets();
        return sendJson(res, 200, { sets, count: sets.length, cachedAt: bakedAt() }, 'disk');
      });

      // ---- a whole set, in ONE request -------------------------------------------------------
      // The batch runner's one structural move. `stale` and `partial` are constant false because
      // there is no upstream that could have half-answered: the bake writes atomically (temp then
      // rename), so what is on disk is always a complete catalog or no catalog.
      server.middlewares.use('/api/riftbound/set', (req, res, next) => {
        // connect strips the mount path, so what arrives here is /:setId/cards.
        const urlPath = String(req.url || '/').split('?')[0];
        const m = /^\/([^/]+)\/cards$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();
        const setId = decodeURIComponent(m[1]);
        if (!isSetId(setId)) return sendJson(res, 400, { error: 'bad set id', code: 'bad_set_id' }, 'none');
        // GR7: no catalog is a real "source unavailable" and has to be said out loud, rather than
        // answered with an empty set — loadSetIndex then reports it and KEEPS the resident index.
        if (catalogMissing()) return sendJson(res, 503, MISSING, 'none');

        // A missing PRICE index is a different thing entirely: the cards still go out, with
        // marketUsd null. Losing the second opinion must never cost you the catalogue.
        const prices = loadRiftboundPrices();
        const cards = [];
        for (const { card, canonical, setMeta } of iterateRiftboundSet(setId)) {
          cards.push(wireCard(canonical, card.k, setMeta.code, prices));
        }
        if (!cards.length) return sendJson(res, 404, { error: 'no such set: ' + setId, code: 'no_set' }, 'none');
        // Rune REPRINTS (R01…R06 on the sets after Origins) are deliberately absent: the bake skips
        // them, so iterateRiftboundSet never yields them — and going through that same iterator is
        // exactly what keeps this route and ENUMERATORS.riftbound incapable of drifting. They are
        // Commons at a median of US$0.08; the single-card route below still resolves one if asked.
        return sendJson(res, 200, {
          setId, count: cards.length, cachedAt: bakedAt(), source: 'bake',
          stale: false, partial: false, cards,
        }, 'disk');
      });

      // ---- one card --------------------------------------------------------------------------
      // The single uploader's lookup path. resolveRiftboundCard handles every printed shape the
      // catch line accepts — 27, 027a, 299*, SP1, and the R##[a] rune reprints.
      server.middlewares.use('/api/riftbound/cards', (req, res, next) => {
        const urlPath = String(req.url || '/').split('?')[0];
        const m = /^\/([^/]+)\/(.+)$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();
        const setId = decodeURIComponent(m[1]), num = decodeURIComponent(m[2]);
        if (!isSetId(setId)) return next();
        if (catalogMissing()) return sendJson(res, 503, MISSING, 'none');
        const canonical = resolveRiftboundCard(setId, num);
        // The 404 body must carry NO `name`: stock-uploader.html tests
        // `!c || c.object === 'error' || !c.name` and would otherwise read an error as a card.
        if (!canonical) {
          return sendJson(res, 404, { object: 'error', error: 'no card ' + num + ' in ' + setId, code: 'no_card' }, 'none');
        }
        const key = String(setId).toLowerCase();
        const meta = loadRiftboundSets().find((s) => s.id === key || s.code.toLowerCase() === key)
          || { code: key.toUpperCase() };
        // normNum of the RESOLVED number, not of what was typed: a rune asked for as R01a resolves
        // to the Origins card printed 007a, and the identity key has to follow the printed number,
        // which is what the price index and the watchlist are keyed on.
        return sendJson(res, 200, wireCard(canonical, normNum(canonical.number), meta.code, loadRiftboundPrices()), 'disk');
      });

      console.log('[' + LABEL + '] API /api/riftbound/sets · /set/:id/cards · /cards/:set/:num — baked catalog + keyless price join');
    },
  };
}
