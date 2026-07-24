import { defineConfig, loadEnv } from 'vite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackerPlugin } from './lib/tracker.mjs'
import { inventoryPlugin } from './lib/inventory.mjs'
import { sealedPlugin } from './lib/sealed.mjs'
import { bulkPlugin } from './lib/bulk.mjs'
import { repricerPlugin } from './lib/repricer.mjs'
import { postsalePlugin } from './lib/postsale.mjs'
import { listingsPlugin } from './lib/listings.mjs'
import { statusPlugin } from './lib/status.mjs'
import { catalogPlugin } from './lib/catalog.mjs'
import { lookup as pcLookup, enumerateConsole as pcEnumerate, listPokemonConsoles as pcConsoles } from './lib/pricecharting.mjs'
import { certLookup, certProviders } from './lib/certlookup.mjs'
import { analyzeCard } from './lib/grader.mjs'
import { printConfig, buildJob, sendToPrinter } from './lib/labelprint.mjs'
import { bricklinkAuthHeader } from './lib/bricklink.mjs'
import { ebayToken, ebayInsightsToken } from './lib/ebay-token.mjs'
import { readJsonBody } from './lib/req-body.mjs'

// Streams any remote image through the dev server (so the browser can blob-download it — cross-origin
// <a download> is blocked otherwise) AND caches it on disk (data/img-cache/) keyed by URL hash. Card
// images are content-addressed / stable, so cached forever; repeat display + download is then served
// locally (faster, and resilient if the upstream CDN URL ever changes).
const IMG_CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'img-cache')
const IMG_TTL_MS = 30 * 24 * 60 * 60 * 1000   // 30d — images are near-immutable; re-fetch monthly in case one is replaced at the same URL
const IMG_CT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' }
function imgCacheFile(u) {
  const ext = ((u.match(/\.(png|jpe?g|webp|avif|gif)(?:[?#]|$)/i) || [])[1] || '').toLowerCase()
  const name = crypto.createHash('sha1').update(u).digest('hex') + (ext ? '.' + ext : '')
  return { file: path.join(IMG_CACHE_DIR, name), ext }
}
const imgProxy = {
  name: 'img-proxy',
  configureServer(server) {
    server.middlewares.use('/api/img', async (req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost').searchParams.get('u')
        if (!u) { res.statusCode = 400; return res.end('missing u') }
        const { file, ext } = imgCacheFile(u)
        res.setHeader('access-control-allow-origin', '*')
        res.setHeader('cache-control', 'public, max-age=86400')   // browser re-checks daily; served from our disk
        try {                                                     // disk cache hit — only while within TTL
          if (Date.now() - fs.statSync(file).mtimeMs < IMG_TTL_MS) {
            res.setHeader('content-type', IMG_CT[ext] || 'image/jpeg')
            res.setHeader('x-img-cache', 'HIT')
            return res.end(fs.readFileSync(file))
          }
        } catch {}
        const r = await fetch(u).catch(() => null)               // miss/expired → refetch
        const ct = (r && r.headers.get('content-type')) || ''
        if (r && r.ok && /^image\//i.test(ct)) {                 // only cache a REAL image (never an error page)
          const buf = Buffer.from(await r.arrayBuffer())
          try { fs.mkdirSync(IMG_CACHE_DIR, { recursive: true }); fs.writeFileSync(file, buf) } catch {}
          res.setHeader('content-type', ct)
          res.setHeader('x-img-cache', 'MISS')
          return res.end(buf)
        }
        // Refetch failed / not an image → serve the expired-but-present disk copy rather than break.
        try {
          const buf = fs.readFileSync(file)
          res.setHeader('content-type', IMG_CT[ext] || 'image/jpeg')
          res.setHeader('x-img-cache', 'STALE')
          return res.end(buf)
        } catch {}
        res.statusCode = r ? r.status : 502
        res.end('img unavailable')
      } catch (e) { res.statusCode = 502; res.end('img fetch failed') }
    })
  },
}

// BrickLink OAuth 1.0a request signing lives in lib/bricklink.mjs (pctEncode / oauthBaseString /
// bricklinkAuthHeader). The bricklinkProxy middleware below stays here — it wires server.middlewares
// and is dev-server-only (GR1). Per-request HMAC-SHA1 signing is why this is a middleware, not a
// static-header proxy entry; the dev server's outbound IP must be registered in the BrickLink console.
function bricklinkProxy(env) {
  return {
    name: 'bricklink-proxy',
    configureServer(server) {
      server.middlewares.use('/api/lego/bricklink', async (req, res) => {
        res.setHeader('content-type', 'application/json')
        res.setHeader('access-control-allow-origin', '*')
        try {
          const cred = {
            consumerKey: env.BRICKLINK_CONSUMER_KEY, consumerSecret: env.BRICKLINK_CONSUMER_SECRET,
            token: env.BRICKLINK_TOKEN, tokenSecret: env.BRICKLINK_TOKEN_SECRET,
          }
          if (!cred.consumerKey || !cred.token) {
            res.statusCode = 503
            return res.end(JSON.stringify({ error: 'BrickLink keys not set in .env (BRICKLINK_CONSUMER_KEY/SECRET, BRICKLINK_TOKEN/SECRET)' }))
          }
          const target = new URL('https://api.bricklink.com/api/store/v1' + req.url)
          const auth = bricklinkAuthHeader(req.method || 'GET', target, cred)
          console.log('[api/lego/bricklink]', req.url)
          const r = await fetch(target, { method: 'GET', headers: { Authorization: auth } })
          res.statusCode = r.status
          res.end(await r.text())
        } catch (e) {
          res.statusCode = 502
          res.end(JSON.stringify({ error: 'bricklink proxy failed: ' + e.message }))
        }
      })
    },
  }
}

// eBay OAuth2 client-credentials APP-token minting (Browse/Taxonomy + the isolated Marketplace
// Insights scope), with the module-level caches, TTL/early-refresh, SBX guard and error mapping,
// lives in lib/ebay-token.mjs (ebayToken / ebayInsightsToken). The ebayProxy middleware below stays
// here (server.middlewares, dev-server-only, GR1) and imports those. Do not confuse this app token
// with the USER token in lib/ebay-oauth.mjs (repricer).
function ebayProxy(env) {
  return {
    name: 'ebay-proxy',
    configureServer(server) {
      server.middlewares.use('/api/ebay', async (req, res) => {
        res.setHeader('content-type', 'application/json')
        res.setHeader('access-control-allow-origin', '*')
        try {
          if (!(env.EBAY_APP_ID || '').trim() || !(env.EBAY_CERT_ID || '').trim()) {
            res.statusCode = 503
            return res.end(JSON.stringify({ error: 'eBay keys not set in .env (EBAY_APP_ID, EBAY_CERT_ID)' }))
          }
          // Sold-price (Marketplace Insights) calls use their own scoped token; if that
          // scope isn't granted, return a soft 403 so the client falls back to asking.
          const isInsights = req.url.indexOf('/buy/marketplace_insights/') >= 0
          let tok
          try { tok = isInsights ? await ebayInsightsToken(env) : await ebayToken(env) }
          catch (e) {
            if (isInsights) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'insights_unavailable', detail: e.message })) }
            throw e
          }
          console.log('[api/ebay]', req.url)
          const r = await fetch('https://api.ebay.com' + req.url, {
            headers: {
              Authorization: 'Bearer ' + tok,
              'X-EBAY-C-MARKETPLACE-ID': (env.EBAY_MARKETPLACE || 'EBAY_AU').trim(),
              'Content-Type': 'application/json',
            },
          })
          const body = await r.text()
          // A non-2xx from the search itself (e.g. 400 bad filter, 401 scope) is
          // passed through verbatim — log it so it's visible in journalctl.
          if (!r.ok) console.error('[api/ebay] upstream HTTP ' + r.status + ' for ' + req.url + ' — ' + body.slice(0, 300))
          res.statusCode = r.status
          res.end(body)
        } catch (e) {
          // Token-mint / network failures land here. Log the real reason (so it
          // shows in `journalctl -u tcg-tools`) and return it to the browser
          // instead of an opaque 502 the client can't explain.
          console.error('[api/ebay] proxy error:', e.message)
          res.statusCode = 502
          res.end(JSON.stringify({ error: 'eBay proxy failed', detail: e.message }))
        }
      })
    },
  }
}

// ---- PriceCharting: keyless public-page scrape (Pokémon graded/raw/pop) ----
// No free API exists, so lib/pricecharting.mjs parses the public card + pop pages server-side
// (browser can't — CORS + Cloudflare). Returns graded (Grade 9 / PSA 10 / BGS 10) + a raw anchor
// + PSA/CGC population. A failure ALWAYS returns {matched:false} so a card lookup never breaks
// (Golden Rule 7). If PRICECHARTING_TOKEN is set, the module uses the official API instead.
function pcProxy(env) {
  return {
    name: 'pricecharting-proxy',
    configureServer(server) {
      server.middlewares.use('/api/pc', async (req, res) => {
        res.setHeader('content-type', 'application/json')
        res.setHeader('access-control-allow-origin', '*')
        try {
          if (String(env.PRICECHARTING_ENABLED || 'true').toLowerCase() === 'false') {
            return res.end(JSON.stringify({ matched: false, disabled: true }))
          }
          const u = new URL(req.url, 'http://localhost')
          // Console directory (JP/CN/KO set slugs) + per-set card enumeration (name + number + image).
          if (/\/consoles(\?|$)/.test(u.pathname)) {
            return res.end(JSON.stringify(await pcConsoles()))
          }
          if (/\/console(\?|$)/.test(u.pathname)) {
            const slug = (u.searchParams.get('slug') || '').trim()
            if (!slug) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'slug required' })) }
            console.log('[api/pc] console', slug)
            const e = await pcEnumerate(slug)
            return res.end(JSON.stringify({ slug, cards: e.cards, stale: e.stale, cachedAt: e.at }))
          }
          const name = (u.searchParams.get('name') || '').trim()
          const number = (u.searchParams.get('number') || '').trim()
          const set = (u.searchParams.get('set') || '').trim()
          const cardId = (u.searchParams.get('id') || '').trim()
          const lang = (u.searchParams.get('lang') || '').trim().toLowerCase()
          const pcUrl = (u.searchParams.get('url') || '').trim()
          if (!pcUrl && (!name || !number)) {
            res.statusCode = 400
            return res.end(JSON.stringify({ matched: false, error: 'name and number (or url) required' }))
          }
          console.log('[api/pc]', pcUrl || (name + ' #' + number), set ? '(' + set + ')' : '', lang ? '[' + lang + ']' : '')
          const result = await pcLookup({
            name, number, setName: set, cardId, lang, url: pcUrl,
            token: (env.PRICECHARTING_TOKEN || '').trim(),
          })
          res.end(JSON.stringify(result))
        } catch (e) {
          // Belt-and-suspenders: lib already swallows errors, but never 500 the lookup.
          res.end(JSON.stringify({ matched: false, error: String((e && e.message) || e) }))
        }
      })
    },
  }
}

// ---- Cert lookup: multi-company graded-slab lookup for the inventory add form ----
// GET /api/cert?company=PSA&cert=12345678 -> { matched, identity, grade, grade_label, company,
//   verifyUrl, ... } via lib/certlookup.mjs. PSA auto-fills (needs PSA_API_TOKEN); every other
//   company (any non-PSA company in data/grading-companies.json) returns matched:false + a verifyUrl deep-link so the form
//   degrades to manual entry (Golden Rule 7).
// GET /api/cert/providers -> the data/grading-companies.json registry (company dropdown source).
function certProxy(env) {
  return {
    name: 'cert-proxy',
    configureServer(server) {
      server.middlewares.use('/api/cert', async (req, res) => {
        res.setHeader('content-type', 'application/json')
        res.setHeader('access-control-allow-origin', '*')
        try {
          const u = new URL(req.url, 'http://localhost')
          if (u.pathname.replace(/\/+$/, '').endsWith('/providers')) return res.end(JSON.stringify(certProviders()))
          const company = u.searchParams.get('company') || 'PSA'
          const cert = u.searchParams.get('cert') || ''
          if (!cert) { res.statusCode = 400; return res.end(JSON.stringify({ matched: false, error: 'cert required' })) }
          const out = await certLookup(company, cert, env)
          res.end(JSON.stringify(out))
        } catch (e) {
          res.end(JSON.stringify({ matched: false, error: String((e && e.message) || e) }))
        }
      })
    },
  }
}

// ---- Pre-grading: AI vision condition pass (Anthropic OR OpenAI) ----------
// POST /api/grade { images:[{mediaType,dataB64}], context } -> per-pillar condition scores +
// defects from lib/grader.mjs. The browser measures centering itself; this only scores the
// pillars a camera can't measure geometrically. Provider chosen by GRADER_PROVIDER/keys. A missing
// key or provider error returns ok:false (never 500) so the tool degrades to centering-only.
// readJsonBody (shared by graderProxy + printProxy) moved to lib/req-body.mjs.
function graderProxy(env) {
  return {
    name: 'grader-proxy',
    configureServer(server) {
      server.middlewares.use('/api/grade', async (req, res) => {
        res.setHeader('content-type', 'application/json')
        res.setHeader('access-control-allow-origin', '*')
        if ((req.method || 'GET').toUpperCase() !== 'POST') {
          res.statusCode = 405
          return res.end(JSON.stringify({ ok: false, error: 'method', message: 'POST only' }))
        }
        try {
          const body = await readJsonBody(req, 28 * 1024 * 1024) // ~28MB of base64 images
          console.log('[api/grade]', (body.images || []).length, 'image(s)', body.context ? '· ' + (body.context.name || '') : '')
          const result = await analyzeCard({ images: body.images, context: body.context, env })
          res.end(JSON.stringify(result))
        } catch (e) {
          // Never 500 the grader — degrade to centering-only on the client.
          res.end(JSON.stringify({ ok: false, error: 'request', message: String((e && e.message) || e) }))
        }
      })
    },
  }
}

// ---- Shipping-label printing: raw TCP 9100 to the AUSPRINT PRO (Rongta/TSPL) ----------
// GET  /api/print            -> { enabled, dpi, ip, page:{w,h} } so the client knows whether
//                               to enable the Print button and at what DPI to rasterise.
// POST /api/print { jobs:[{bitmap(base64 1bpp,1=ink), widthDots, heightDots, copies?}], copies? }
//                            -> wraps each bitmap in TSPL/ZPL and streams it to the printer.
// Never throws to a 500 that hides the cause; an unconfigured/unreachable printer returns
// ok:false with a message so the tool degrades to download-only (Golden Rule 7).
// Per-request Speed/Darkness overrides mirror the AUSPRINT vendor app's controls. Clamp to
// the printer's valid range and fall back to the env default on anything non-numeric, so a
// stray value never emits a broken TSPL command or blocks a print.
function clampDensity(v, fb) { const n = Number(v); return Number.isFinite(n) ? Math.min(15, Math.max(0, Math.round(n))) : fb }
function clampSpeed(v, fb) { const n = Number(v); return (Number.isFinite(n) && n > 0) ? Math.min(6, Math.max(1, n)) : fb }

function printProxy(env) {
  return {
    name: 'label-print',
    configureServer(server) {
      server.middlewares.use('/api/print', async (req, res) => {
        res.setHeader('content-type', 'application/json')
        res.setHeader('access-control-allow-origin', '*')
        const cfg = printConfig(env)
        const method = (req.method || 'GET').toUpperCase()
        if (method === 'GET') {
          return res.end(JSON.stringify({ enabled: cfg.enabled, dpi: cfg.dpi, ip: cfg.ip, lang: cfg.lang, page: { w: cfg.pageWmm, h: cfg.pageHmm }, offXmm: cfg.offXmm, offYmm: cfg.offYmm, speed: cfg.speed, density: cfg.density }))
        }
        if (method !== 'POST') {
          res.statusCode = 405
          return res.end(JSON.stringify({ ok: false, error: 'method', message: 'GET or POST only' }))
        }
        try {
          if (!cfg.enabled) {
            res.statusCode = 503
            return res.end(JSON.stringify({ ok: false, error: 'unconfigured', message: 'Set LABEL_PRINTER_IP in .env to enable printing.' }))
          }
          const body = await readJsonBody(req, 16 * 1024 * 1024)
          const jobs = (body.jobs || []).map((j) => ({
            data: Buffer.from(String(j.bitmap || ''), 'base64'),
            widthDots: parseInt(j.widthDots, 10),
            heightDots: parseInt(j.heightDots, 10),
            copies: Math.max(1, parseInt(j.copies || body.copies || 1, 10)),
            wmm: j.wmm != null ? parseFloat(j.wmm) : undefined,   // label SIZE from the in-app size picker
            hmm: j.hmm != null ? parseFloat(j.hmm) : undefined,
          })).filter((j) => j.data.length && j.widthDots > 0 && j.heightDots > 0)
          if (!jobs.length) {
            res.statusCode = 400
            return res.end(JSON.stringify({ ok: false, error: 'empty', message: 'no valid jobs in request' }))
          }
          for (const j of jobs) {
            const need = Math.ceil(j.widthDots / 8) * j.heightDots
            if (j.data.length !== need) {
              res.statusCode = 400
              return res.end(JSON.stringify({ ok: false, error: 'size', message: `bitmap is ${j.data.length} bytes, expected ${need} for ${j.widthDots}×${j.heightDots}` }))
            }
          }
          // Speed/Darkness are one-per-batch (top-level body fields), matching the vendor UI.
          const reqCfg = { ...cfg, speed: clampSpeed(body.speed, cfg.speed), density: clampDensity(body.density, cfg.density) }
          const buf = buildJob(jobs, reqCfg)
          console.log('[api/print]', jobs.length, 'label(s) ->', cfg.ip + ':' + cfg.port, cfg.lang, `spd${reqCfg.speed} dns${reqCfg.density}`, buf.length + 'B')
          await sendToPrinter(buf, { ip: cfg.ip, port: cfg.port })
          res.end(JSON.stringify({ ok: true, printed: jobs.length }))
        } catch (e) {
          res.statusCode = 502
          res.end(JSON.stringify({ ok: false, error: 'print_failed', message: String((e && e.message) || e) }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // loads .env (and .env.local) from the project root
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [imgProxy, bricklinkProxy(env), ebayProxy(env), pcProxy(env), certProxy(env), graderProxy(env), printProxy(env), trackerPlugin(env), inventoryPlugin(env), sealedPlugin(env), bulkPlugin(env), repricerPlugin(env), postsalePlugin(env), listingsPlugin(env), statusPlugin(env), catalogPlugin(env)],
    server: {
      host: true,        // listen on 0.0.0.0 so the LAN can reach it
      port: 5273,
      strictPort: true,
      open: false,
      proxy: {
        // Live FX rates (ECB via Frankfurter) for AUD conversion
        '/api/fx': {
          target: 'https://api.frankfurter.app',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/fx/, ''),
        },
        // Star Wars: Unlimited -> swu-db (no auth, just needs CORS bypass)
        '/api/swu': {
          target: 'https://api.swu-db.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/swu/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) =>
              console.log('[api/swu]', req.url, '-> api.swu-db.com' + proxyReq.path))
          },
        },
        // One Piece Card Game -> OPTCG API (optcgapi.com/api, KEYLESS — CORS bypass + TCGplayer market
        // price). GET-only community API; covers OP-01..OP-15 + starter decks + promos (English).
        '/api/op': {
          target: 'https://optcgapi.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/op/, '/api'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) =>
              console.log('[api/op]', req.url, '-> optcgapi.com' + proxyReq.path))
          },
        },
        // Disney Lorcana -> Lorcast (api.lorcast.com/v0, KEYLESS — CORS bypass + daily prices)
        '/api/lorcana': {
          target: 'https://api.lorcast.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/lorcana/, '/v0'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) =>
              console.log('[api/lorcana]', req.url, '-> api.lorcast.com' + proxyReq.path))
          },
        },
        // Magic: The Gathering -> Scryfall (free, CORS-friendly)
        '/api/mtg': {
          target: 'https://api.scryfall.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/mtg/, ''),
          headers: {
            'User-Agent': 'TCGListingBuilder/1.0',
            'Accept': 'application/json;q=0.9,*/*;q=0.8',
          },
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) =>
              console.log('[api/mtg]', req.url, '-> api.scryfall.com' + proxyReq.path))
          },
        },
        // Pokemon -> pokemontcg.io v2 (free; no key needed for low volume)
        '/api/pkm': {
          target: 'https://api.pokemontcg.io',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/pkm/, '/v2'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              // Optional: raises rate limit to 20k/day. Works keyless without it.
              if (env.POKEMONTCG_API_KEY) proxyReq.setHeader('X-Api-Key', env.POKEMONTCG_API_KEY)
              console.log('[api/pkm]', req.url, '-> api.pokemontcg.io' + proxyReq.path)
            })
            // pokemontcg.io returns intermittent 500s. Logging only the OUTBOUND request made
            // those invisible in /api/status/logs, so a user's "card not found" looked like our
            // bug. The client retries them (extras.js TCG.fetchJson); this makes them diagnosable.
            proxy.on('proxyRes', (proxyRes, req) => {
              if (proxyRes.statusCode >= 400) console.warn('[api/pkm]', proxyRes.statusCode, req.url)
            })
            proxy.on('error', (err, req) => console.warn('[api/pkm] proxy error', req.url, err.message))
          },
        },
        // Pokemon JP/CN/KO -> TCGdex (community REST, KEYLESS, multilingual). English stays on
        // /api/pkm (pokemontcg.io) for pricing; this serves native JP/CN/KO set + card data + images.
        // e.g. /api/tcgdex/ja/cards/SV3-001 -> https://api.tcgdex.net/v2/ja/cards/SV3-001
        '/api/tcgdex': {
          target: 'https://api.tcgdex.net',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/tcgdex/, '/v2'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) =>
              console.log('[api/tcgdex]', req.url, '-> api.tcgdex.net' + proxyReq.path))
          },
        },
        // Riftbound -> riftscribe.gg (community REST API, KEYLESS) — the no-key live
        // alternative to Scrydex. /api/rbs/cards?... -> https://riftscribe.gg/api/cards?...
        // MUST stay ABOVE '/api/rb': Vite matches proxy contexts by startsWith in order,
        // and '/api/rb' is a prefix of '/api/rbs' — if rb were first it would swallow rbs.
        '/api/rbs': {
          target: 'https://riftscribe.gg',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/rbs/, '/api'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) =>
              console.log('[api/rbs]', req.url, '-> riftscribe.gg' + proxyReq.path))
          },
        },
        // Riftbound -> Scrydex (inject key + team headers server-side)
        '/api/rb': {
          target: 'https://api.scrydex.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/rb/, '/riftbound/v1'),
          headers: {
            'X-Api-Key': env.SCRYDEX_API_KEY || '',
            'X-Team-ID': env.SCRYDEX_TEAM_ID || '',
          },
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) =>
              console.log('[api/rb]', req.url, '-> api.scrydex.com' + proxyReq.path))
          },
        },
        // LEGO lookup -> Rebrickable (simple "Authorization: key <KEY>" header)
        '/api/lego/rebrickable': {
          target: 'https://rebrickable.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/lego\/rebrickable/, '/api/v3/lego'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              if (env.REBRICKABLE_API_KEY) proxyReq.setHeader('Authorization', 'key ' + env.REBRICKABLE_API_KEY)
              console.log('[api/lego/rebrickable]', req.url)
            })
          },
        },
        // LEGO enrichment -> Brickset (apiKey is a query PARAM, injected in rewrite,
        // so it never reaches the browser; the client supplies userHash= itself).
        '/api/lego/brickset': {
          target: 'https://brickset.com',
          changeOrigin: true,
          rewrite: (p) => {
            const np = p.replace(/^\/api\/lego\/brickset/, '/api/v3.asmx')
            const sep = np.includes('?') ? '&' : '?'
            return np + sep + 'apiKey=' + encodeURIComponent(env.BRICKSET_API_KEY || '')
          },
          configure: (proxy) => {
            // log the client URL (no key) — never proxyReq.path, which carries the apiKey
            proxy.on('proxyReq', (proxyReq, req) => console.log('[api/lego/brickset]', req.url))
          },
        },
      },
    },
  }
})
