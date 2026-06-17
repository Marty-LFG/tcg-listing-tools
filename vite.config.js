import { defineConfig, loadEnv } from 'vite'

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

export default defineConfig(({ mode }) => {
  // loads .env (and .env.local) from the project root
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [imgProxy],
    server: {
      host: true,        // listen on 0.0.0.0 so the LAN can reach it
      port: 5173,
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
      },
    },
  }
})
