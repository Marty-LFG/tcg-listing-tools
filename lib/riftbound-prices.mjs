// lib/riftbound-prices.mjs — serve the keyless Riftbound price index at /api/riftbound/prices.
//
// Companion to scripts/build-riftbound-prices.mjs (which explains WHY this lane exists: the
// Scrydex subscription lapsed with a 402, and it was the only Riftbound source carrying prices).
// This half is read-only — it loads the baked index and answers one card at a time, so the
// collector keeps its uniform `jfetch(base + path)` shape and needs no special case.
//
// Why an HTTP hop for a local file: collectCard() fetches every game through a local path so that
// proxy auth injection and error classification stay in one place. Reading the index inline in the
// collector would make riftbound the one game that behaves differently.
//
// ⚠ Why NOT /api/rbp: Vite matches proxy contexts by startsWith in declaration order, and
// vite.config.js declares an '/api/rb' proxy to api.scrydex.com. Any '/api/rb…' route is swallowed
// by it before a plugin middleware sees the request — the same trap vite.config.js already calls
// out for '/api/rbs'. '/api/riftbound/…' shares no prefix with it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRICES_PATH = path.join(ROOT, 'data', 'riftbound-prices.json');

// Memoised by file mtime, matching loadRiftboundData() — the bake rewrites this file (atomic
// temp+rename), and a permanently memoised copy would serve yesterday's prices until restart.
let _cache = null;   // { mtimeMs, path, data }
export function loadRiftboundPrices(dataPath = PRICES_PATH) {
  try {
    const st = fs.statSync(dataPath);
    if (_cache && _cache.mtimeMs === st.mtimeMs && _cache.path === dataPath) return _cache.data;
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    _cache = { mtimeMs: st.mtimeMs, path: dataPath, data };
    return data;
  } catch { return null; }   // never baked / mid-rename — the caller reports "no index", not a crash
}

/**
 * One card by tracker identity_key ('OGN-27a'). Returns the price row or null.
 * Case-insensitive on the set code, since identity keys are written uppercase but the number half
 * is normNum()'d lowercase ('OGN-27A' and 'ogn-27a' both resolve).
 */
export function priceFor(identityKey, data = loadRiftboundPrices()) {
  const cards = data && data.cards;
  if (!cards) return null;
  const k = String(identityKey == null ? '' : identityKey).trim();
  if (!k) return null;
  if (cards[k]) return cards[k];
  const i = k.indexOf('-');
  if (i < 0) return null;
  return cards[k.slice(0, i).toUpperCase() + '-' + k.slice(i + 1).toLowerCase()] || null;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * GET /api/riftbound/prices/:identityKey
 *   -> { market, low, currency, source, name, rarity, set, number, generatedAt }
 *
 * Status codes are chosen so collectCard() classifies them correctly without a riftbound branch:
 *   200 → priced card
 *   404 → the index is fine but has no price for this card (collector records 'http_404', not an
 *         outage — a Vendetta alt-art with no sales yet genuinely has no market price)
 *   503 → the index has never been baked (a real "source unavailable", not a missing card)
 */
export function riftboundPricesPlugin() {
  return {
    name: 'riftbound-prices',
    configureServer(server) {
      server.middlewares.use('/api/riftbound', (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const m = url.pathname.replace(/\/+$/, '').match(/^\/prices\/(.+)$/);
          if (!m) return send(res, 404, { error: 'not found', usage: 'GET /api/riftbound/prices/:identityKey' });
          const data = loadRiftboundPrices();
          if (!data) {
            return send(res, 503, {
              error: 'riftbound price index not baked yet',
              code: 'index_missing',
              hint: 'node scripts/build-riftbound-prices.mjs (or POST /api/status/refresh)',
            });
          }
          const key = decodeURIComponent(m[1]);
          const row = priceFor(key, data);
          if (!row) return send(res, 404, { error: 'no price for ' + key, code: 'no_price', generatedAt: data.generatedAt || null });
          return send(res, 200, { ...row, source: 'tcgplayer', generatedAt: data.generatedAt || null });
        } catch (e) { return send(res, 500, { error: String(e?.message || e) }); }
      });
      console.log('[riftbound-prices] API /api/riftbound/prices/:key · keyless TCGplayer market prices (data/riftbound-prices.json)');
    },
  };
}
