// lib/request-guard.mjs — the one gate in front of every route on the dev server (audit S1 + S2,
// 2026-10-16).
//
// WHY THIS HAS TO BE A PLUGIN, AND THE FIRST ONE. Vite does have a host check (against DNS
// rebinding) and a CORS middleware, but it installs both AFTER the plugins' configureServer
// middleware. Every /api/* route in lib/ is one of those plugin middlewares and ends the response
// itself, so not one of them ever reached Vite's checks. Measured on ALCSERVER before this landed:
// `Host: evil.example` got a 200 from /api/status, and most routes answered a preflight with
// `access-control-allow-origin: *`. Put together, any web page open on any LAN or tailnet device
// could POST to publish or withdraw eBay listings, message buyers, mark orders shipped, publish to
// the live Shopify store or rewrite settings. The body readers ignore Content-Type, so a plain
// text/plain form post (no preflight at all) was enough.
//
// TWO RULES, applied to every request before any other middleware sees it:
//
//   1. HOST. The Host header must name this machine: loopback, one of its own interface addresses
//      (LAN and Tailscale IPs both show up there), its hostname, or a name in TCG_ALLOWED_HOSTS.
//      That is what defeats DNS rebinding, where a hostile domain is re-pointed at 192.168.4.200 and
//      the browser then treats our server as same-origin with the attacker's page.
//   2. NO CROSS-SITE WRITES. A non-GET/HEAD request that carries a foreign Origin, Origin `null`, or
//      `Sec-Fetch-Site: cross-site` is refused. A browser always sends Origin on a non-GET fetch or
//      form post, so a missing Origin means a non-browser caller (curl, the collector's self-fetch,
//      the headless price analyst), and those are let through exactly as before.
//
// What this is NOT: authentication. Anything that can open a TCP connection to port 5273 and send
// its own headers still gets in. A write token is a separate, later owner decision; this closes the
// browser-borne path, which is the one a stranger can reach without being on the LAN.
//
// The loopback receivers in lib/ebay-notify.mjs and lib/shopify-hooks.mjs are their own
// http.createServer() on their own ports, so this middleware never sees their traffic and the
// Cloudflare tunnels are unaffected.
import os from 'node:os';
import net from 'node:net';

// ---- S1: what Vite's static server must never hand out ---------------------------------------
//
// Vite's own defaults for server.fs.deny. Setting the option REPLACES them, so they are re-listed
// here; dropping one would quietly re-expose .env.
export const VITE_FS_DENY_DEFAULTS = Object.freeze(['.env', '.env.*', '*.{crt,pem}', '**/.git/**']);

// Vite matches a pattern containing '/' against the ABSOLUTE file path (picomatch, matchBase off —
// see fsDenyGlob in vite's resolveConfig), so a root-relative 'data/backups/**' would match nothing
// and deny nothing. Hence the leading '**/' on every path pattern.
export const FS_DENY = Object.freeze([
  ...VITE_FS_DENY_DEFAULTS,
  // Every SQLite store and its WAL sidecars: postsale (buyer names and addresses), keepers
  // (customer points), tracker (all stock and cost basis), repricer. A live -wal file holds the
  // most recent writes, so denying the .db alone is not enough.
  '**/*.db', '**/*.db-wal', '**/*.db-shm',
  // Full copies of all of the above, and possibly .env (see lib/backup.mjs).
  '**/data/backups/**',
  // The eBay refresh token, encrypted under a key derived from EBAY_CERT_ID.
  '**/data/ebay-oauth.json',
  // Owner photographs and grading captures: the only non-regenerable bytes under data/, served
  // through their own API routes, never as static files.
  '**/data/photo-originals/**',
  '**/data/pregrade-images/**',
  // Service and job logs (NSSM's stdout/stderr per scripts/WINDOWS_SERVICE.md, run-claude-analysis):
  // only the in-memory ring buffer behind /api/status/logs is secret-scrubbed, these files are not.
  '**/logs/**',
]);

// ---- S2 rule 1: the Host allowlist -----------------------------------------------------------

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1'];

/** Lower-case, no brackets, no trailing dot ("ALCSERVER." and "[::1]" both normalise). */
export function normHost(h) {
  let s = String(h == null ? '' : h).trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  s = s.replace(/%.*$/, '');          // an IPv6 zone id never reaches a Host header; strip it from our own list
  return s.replace(/\.+$/, '');
}

/**
 * The hostname out of a Host header, or null when the header is not one a browser could send.
 * "a.b:5273" -> "a.b", "[::1]:5273" -> "::1". An unbracketed IPv6 or a non-numeric port is refused.
 */
export function hostnameOf(hostHeader) {
  const raw = String(hostHeader == null ? '' : hostHeader).trim();
  if (!raw) return null;
  let name, rest;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return null;
    name = raw.slice(1, end);
    rest = raw.slice(end + 1);
    if (net.isIP(name) !== 6) return null;
  } else {
    const colon = raw.indexOf(':');
    name = colon < 0 ? raw : raw.slice(0, colon);
    rest = colon < 0 ? '' : raw.slice(colon);
  }
  if (rest && !/^:\d{1,5}$/.test(rest)) return null;
  const h = normHost(name);
  return h || null;
}

/**
 * The NAMES allowed beyond loopback and this machine's own addresses: os.hostname() plus every
 * entry in TCG_ALLOWED_HOSTS (comma or space separated). An entry with a leading dot allows that
 * domain and its subdomains, the same syntax as Vite's server.allowedHosts — which is fed this same
 * list, so the pages, the HMR socket and the API all agree on who is allowed.
 *
 * '*' is dropped on purpose: a wildcard here would switch the whole guard off from a .env line.
 */
export function configuredHosts(env = {}) {
  // A pasted "name:5273" loses its port; a ".suffix" entry stays a suffix.
  const fromEnv = String(env.TCG_ALLOWED_HOSTS || '').split(/[\s,]+/)
    .map((e) => (e.trim().startsWith('.') ? normHost(e) : hostnameOf(e) || normHost(e)));
  const out = [];
  for (const h of [normHost(os.hostname()), ...fromEnv]) {
    if (!h || h === '*' || h === '.' || out.includes(h)) continue;
    out.push(h);
  }
  return out;
}

/** Every address on this machine's interfaces — LAN, Tailscale, loopback, Hyper-V — normalised. */
export function machineAddresses(ifaces = os.networkInterfaces()) {
  const set = new Set();
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) if (a && a.address) set.add(normHost(a.address));
  }
  return set;
}

/** Pure decision, so the unit tests can drive it without a server. */
export function isHostAllowed(hostname, { names = [], addresses = new Set() } = {}) {
  if (!hostname) return false;
  if (LOOPBACK_NAMES.includes(hostname) || hostname.endsWith('.localhost')) return true;
  if (names.includes(hostname)) return true;          // an IP listed in TCG_ALLOWED_HOSTS counts too
  if (net.isIP(hostname)) return addresses.has(hostname);
  return names.some((n) => n[0] === '.' && (hostname === n.slice(1) || hostname.endsWith(n)));
}

// ---- S2 rule 2: no cross-site writes ---------------------------------------------------------

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** True when an Origin header names exactly the server this Host header names. */
export function sameOrigin(origin, hostHeader) {
  try {
    const o = new URL(String(origin));
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
    return o.host === new URL('http://' + String(hostHeader)).host;
  } catch {
    return false;                     // includes Origin: null (sandboxed iframe, file://, data:)
  }
}

/** Why this request is a cross-site write, or null when it is not one. */
export function crossSiteWriteReason(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return null;
  const h = req.headers || {};
  if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 'Sec-Fetch-Site: cross-site';
  if (h.origin == null) return null;  // no Origin: not a browser (curl, node fetch, the price analyst)
  if (!sameOrigin(h.origin, h.host)) return 'Origin ' + String(h.origin).slice(0, 120) + ' is not this server';
  return null;
}

// ---- the plugin ------------------------------------------------------------------------------

function refuse(res, code, error) {
  res.statusCode = 403;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ error, code }));
}

// How often a Host that names an IP we do not recognise may trigger a re-read of the interfaces
// (DHCP lease change, Tailscale coming up after the server). A refusal costs one os call at most
// this often, so a hostile page spamming requests cannot turn it into load.
const REREAD_MS = 5000;

export function requestGuard(env = {}) {
  const names = configuredHosts(env);
  let addresses = machineAddresses();
  let readAt = Date.now();
  const allowed = (hostname) => {
    if (isHostAllowed(hostname, { names, addresses })) return true;
    if (net.isIP(hostname) && Date.now() - readAt > REREAD_MS) {
      addresses = machineAddresses();
      readAt = Date.now();
      return isHostAllowed(hostname, { names, addresses });
    }
    return false;
  };

  return {
    name: 'request-guard',
    // Ahead of any other user plugin even if one later declares enforce:'pre' and is listed first;
    // test/invariants/request-guard.test.mjs also pins it as the first entry of the plugins array.
    enforce: 'pre',
    configureServer(server) {
      // Registered DIRECTLY (not returned as a post hook), so it runs before every other plugin's
      // middleware and before Vite's own internal stack.
      server.middlewares.use(function requestGuardMiddleware(req, res, next) {
        const hostname = hostnameOf(req.headers.host);
        if (!allowed(hostname)) {
          console.warn('[request-guard] refused Host', JSON.stringify(String(req.headers.host || '')), req.method, String(req.url || '').slice(0, 120));
          return refuse(res, 'forbidden_host',
            `Host ${JSON.stringify(String(req.headers.host || ''))} is not this server. If that is a name you use to reach it ` +
            '(a Tailscale MagicDNS name, say), add it to TCG_ALLOWED_HOSTS in .env and restart.');
        }
        const why = crossSiteWriteReason(req);
        if (why) {
          console.warn('[request-guard] refused cross-site', req.method, String(req.url || '').slice(0, 120), '-', why);
          return refuse(res, 'cross_site_write',
            `${why}. Writes are only accepted from this server's own pages.`);
        }
        return next();
      });
    },
  };
}
