import { defineConfig, loadEnv } from 'vite'
import crypto from 'node:crypto'

// Streams any remote image through the dev server so the browser can blob-download
// it (cross-origin <a download> is blocked otherwise).
const imgProxy = {
  name: 'img-proxy',
  configureServer(server) {
    server.middlewares.use('/api/img', async (req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost').searchParams.get('u')
        if (!u) { res.statusCode = 400; return res.end('missing u') }
        const r = await fetch(u)
        res.setHeader('content-type', r.headers.get('content-type') || 'image/png')
        res.setHeader('access-control-allow-origin', '*')
        res.end(Buffer.from(await r.arrayBuffer()))
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
          const tok = await ebayToken(env)
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

export default defineConfig(({ mode }) => {
  // loads .env (and .env.local) from the project root
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [imgProxy, bricklinkProxy(env), ebayProxy(env)],
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
