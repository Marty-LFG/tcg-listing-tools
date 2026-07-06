import { defineConfig, loadEnv } from 'vite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackerPlugin } from './lib/tracker.mjs'
import { inventoryPlugin } from './lib/inventory.mjs'
import { bulkPlugin } from './lib/bulk.mjs'
import { repricerPlugin } from './lib/repricer.mjs'
import { statusPlugin } from './lib/status.mjs'
import { lookup as pcLookup, enumerateConsole as pcEnumerate, listPokemonConsoles as pcConsoles } from './lib/pricecharting.mjs'
import { certLookup, certProviders } from './lib/certlookup.mjs'
import { analyzeCard } from './lib/grader.mjs'
import { printConfig, buildJob, sendToPrinter } from './lib/labelprint.mjs'

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

// ---- BrickLink: OAuth 1.0a request signing ---------------------------------
// BrickLink authenticates EVERY request with a per-request HMAC-SHA1 signature
// (consumer key/secret + token/secret). A static header can't express that, so
// this is a signing middleware rather than a plain proxy entry. The dev server's
// outbound IP must also be registered in the BrickLink API console.
function pctEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}
function bricklinkAuthHeader(method, urlObj, cred) {
  const oauth = {
    oauth_consumer_key: cred.consumerKey,
    oauth_token: cred.token,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  }
  const params = []
  for (const [k, v] of urlObj.searchParams) params.push([k, v])
  for (const k in oauth) params.push([k, oauth[k]])
  const baseParams = params
    .map(([k, v]) => [pctEncode(k), pctEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => k + '=' + v).join('&')
  const baseUrl = urlObj.origin + urlObj.pathname
  const base = method.toUpperCase() + '&' + pctEncode(baseUrl) + '&' + pctEncode(baseParams)
  const signingKey = pctEncode(cred.consumerSecret) + '&' + pctEncode(cred.tokenSecret)
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64')
  return 'OAuth ' + Object.keys(oauth).map(k => pctEncode(k) + '="' + pctEncode(oauth[k]) + '"').join(', ')
}
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

// ---- eBay: OAuth2 client-credentials app token (cached) --------------------
// Mints + caches an application token and injects it as a Bearer header, plus the
// AU marketplace header. Fronts the Browse API (Funko pricing) and Taxonomy API
// (item specifics). Token TTL ~2h; refreshed ~60s early.
let ebayTok = { value: '', exp: 0 }
async function ebayToken(env) {
  if (ebayTok.value && Date.now() < ebayTok.exp) return ebayTok.value
  // .trim() defends against a trailing space/newline pasted into .env — a stray
  // char in the Basic header is silently rejected by eBay as invalid_client.
  const appId = (env.EBAY_APP_ID || '').trim()
  const certId = (env.EBAY_CERT_ID || '').trim()
  // #1 cause of a token-mint failure: SANDBOX keys used against the PRODUCTION
  // endpoint (or vice-versa). eBay encodes the environment in the key strings
  // (PRD- = production, SBX- = sandbox); this proxy only ever calls production.
  if (/SBX-/.test(appId) || /SBX-/.test(certId)) {
    throw new Error('these look like SANDBOX keys (contain "SBX-") but the proxy calls the PRODUCTION eBay API. ' +
      'Create a *Production* keyset at developer.ebay.com → Application Keys and use the PRD- App ID + Cert ID.')
  }
  const basic = Buffer.from(appId + ':' + certId).toString('base64')
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  })
  const text = await r.text()
  if (!r.ok) {
    // eBay returns JSON like {"error":"invalid_client","error_description":"client authentication failed"}.
    let detail = text.slice(0, 300)
    try { const e = JSON.parse(text); detail = [e.error, e.error_description].filter(Boolean).join(': ') || detail } catch {}
    const hint = (r.status === 400 || r.status === 401)
      ? ' — verify EBAY_APP_ID is the App ID (Client ID) and EBAY_CERT_ID the Cert ID (Client Secret) from your *Production* keyset, with no extra spaces.'
      : ''
    throw new Error('eBay OAuth token mint failed (HTTP ' + r.status + '): ' + detail + hint)
  }
  let j
  try { j = JSON.parse(text) } catch { throw new Error('eBay OAuth token response was not JSON: ' + text.slice(0, 200)) }
  ebayTok = { value: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 7200) - 60) * 1000 }
  return ebayTok.value
}
// Separate, isolated token for the Marketplace Insights API (true SOLD prices). It needs
// the `buy.marketplace.insights` scope, which eBay grants only to apps approved for that
// limited-release API. We mint it on its own so a denial (invalid_scope) can NEVER break the
// basic Browse/Taxonomy token above. If the app isn't approved, this throws and the proxy
// returns a soft 403 the client treats as "sold unavailable -> fall back to asking".
let ebayInsTok = { value: '', exp: 0 }
async function ebayInsightsToken(env) {
  if (ebayInsTok.value && Date.now() < ebayInsTok.exp) return ebayInsTok.value
  const appId = (env.EBAY_APP_ID || '').trim(), certId = (env.EBAY_CERT_ID || '').trim()
  const basic = Buffer.from(appId + ':' + certId).toString('base64')
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope/buy.marketplace.insights'),
  })
  const text = await r.text()
  if (!r.ok) {
    let detail = text.slice(0, 200)
    try { const e = JSON.parse(text); detail = [e.error, e.error_description].filter(Boolean).join(': ') || detail } catch {}
    throw new Error('Marketplace Insights scope not granted (' + r.status + '): ' + detail +
      ' — apply for the eBay Buy Marketplace Insights API to enable true sold prices.')
  }
  const j = JSON.parse(text)
  ebayInsTok = { value: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 7200) - 60) * 1000 }
  return ebayInsTok.value
}
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
function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limitBytes) { reject(new Error('payload too large (> ' + Math.round(limitBytes / 1e6) + 'MB)')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch (e) { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}
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
          return res.end(JSON.stringify({ enabled: cfg.enabled, dpi: cfg.dpi, ip: cfg.ip, lang: cfg.lang, page: { w: cfg.pageWmm, h: cfg.pageHmm }, offXmm: cfg.offXmm, offYmm: cfg.offYmm }))
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
          const buf = buildJob(jobs, cfg)
          console.log('[api/print]', jobs.length, 'label(s) ->', cfg.ip + ':' + cfg.port, cfg.lang, buf.length + 'B')
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
    plugins: [imgProxy, bricklinkProxy(env), ebayProxy(env), pcProxy(env), certProxy(env), graderProxy(env), printProxy(env), trackerPlugin(env), inventoryPlugin(env), bulkPlugin(env), repricerPlugin(env), statusPlugin(env)],
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
