// lib/scan.mjs — flatbed-scanner route for the card pre-grader (Epson Perfection V39 II via WIA).
//
// The browser asks POST /api/scan for a card face; this shells out to scripts/wia-scan.ps1
// (Windows PowerShell 5.1 + WIA COM — the only headless automation surface the V39 II driver
// offers; the script drives the device item directly because WIA.CommonDialog pops vendor UI).
// The protocol is one compact JSON line on stdout; the PNG lands in a temp file (never stdout),
// is read + base64'd here, and the temp is always unlinked. There is nothing to configure —
// presence is auto-detected by live WIA enumeration, so an unplugged (or non-Windows) box
// simply answers enabled:false and the pre-grader degrades to photo upload (Golden Rule 7).
//
// Measured on the live unit (110×140mm region): 300dpi ≈ 9s / 0.9MB · 600dpi ≈ 15.7s / 4.6MB ·
// 1200dpi extrapolates to 35–60s — hence the 90s execFile timeout on a scan.

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readJsonBody } from './req-body.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'wia-scan.ps1')
// Windows PowerShell 5.1 on purpose: WIA COM was spike-verified there (powershell.exe is STA by
// default, which WIA needs); pwsh 7 is untested for this and may not even be installed.
const PS_EXE = 'powershell.exe'
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT]

// The driver accepts 50–1200; these are the three that make sense for grading. 300 = fast
// preview, 600 = the sweet spot (surface defects resolve, ~5–7MB of base64 stays well under
// the 28MB body cap), 1200 = slow forensic close-up.
const DPI_OPTIONS = Object.freeze([300, 600, 1200])

// Parse the scanner block out of the Vite-loaded env. Unlike the printer there is no address to
// set — SCANNER_ENABLED=false is a kill switch (answer disabled WITHOUT ever spawning powershell),
// everything else is a default the client can override per request.
export function scanConfig(env) {
  let dpi = parseInt(env.SCANNER_DPI_DEFAULT || '600', 10)
  if (!DPI_OPTIONS.includes(dpi)) dpi = 600
  return {
    allowed: String(env.SCANNER_ENABLED == null ? 'true' : env.SCANNER_ENABLED).trim().toLowerCase() !== 'false',
    defaultDpi: dpi,
    // 160×220 is deliberately forgiving: the first live test card was placed ~35mm off the
    // platen corner and a 110×140 region cut it off. The region is big so placement is casual;
    // the response stays small because the route crops to the detected card below.
    wmm: parseFloat(env.SCANNER_REGION_W_MM || '160'),
    hmm: parseFloat(env.SCANNER_REGION_H_MM || '220'),
  }
}

// Crop the scan down to the detected card before it leaves the server. A 160×220mm 600dpi PNG
// is ~28MB — too big for the client to ever POST back through the 28MB save path — while the
// card itself is ~5MB. Margin is 12% of the card's width per side: generous enough that even
// the analyzer's known white-lid failure mode (locking one border-width inside the true edge)
// still keeps the real card edge in frame. Coordinates in the analysis are shifted so they
// stay valid for the CROPPED image the client receives. Any failure returns the original.
async function cropToCard(png, analysis) {
  const conf = analysis && analysis.confidence ? analysis.confidence.outer : 0
  if (!analysis || !analysis.outer || !(conf >= 0.5)) return null
  try {
    const sharp = (await import('sharp')).default
    const meta = await sharp(png).metadata()
    const o = analysis.outer
    const margin = Math.round((o.r - o.l) * 0.12)
    const x = Math.max(0, o.l - margin), y = Math.max(0, o.t - margin)
    const w = Math.min(meta.width, o.r + margin) - x
    const h = Math.min(meta.height, o.b + margin) - y
    if (w < 100 || h < 100 || (w >= meta.width && h >= meta.height)) return null
    // JPEG q92, not PNG: holo art is PNG's worst case (a live 600dpi card came out 11.5MB PNG
    // vs ~1.5MB JPEG), and at 1200dpi the PNG's base64 would blow the 28MB save-path body cap.
    // q92 is visually lossless at these resolutions; sub-pixel detail is the microscope's job.
    const buf = await sharp(png).extract({ left: x, top: y, width: w, height: h }).jpeg({ quality: 92 }).toBuffer()
    const shift = (r) => (r ? { l: r.l - x, t: r.t - y, r: r.r - x, b: r.b - y } : r)
    return {
      buf, w, h, mediaType: 'image/jpeg',
      analysis: { ...analysis, outer: shift(analysis.outer), inner: shift(analysis.inner) },
    }
  } catch { return null }
}

// Run the ps1 and resolve its one-JSON-line stdout protocol. Never rejects: the script prints
// {ok:false,error,message} + exit 1 on its own failures, so parse stdout FIRST and fall back to
// the exec error only when there is no JSON to be had (powershell missing, killed on timeout).
function runPs(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(PS_EXE, [...PS_FLAGS, ...args], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const line = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || ''
      let json = null
      try { json = JSON.parse(line) } catch { /* not our protocol line */ }
      if (json && typeof json === 'object') return resolve(json)
      if (err && err.killed) return resolve({ ok: false, error: 'timeout', message: 'scanner did not respond within ' + Math.round(timeoutMs / 1000) + 's' })
      resolve({ ok: false, error: 'scan_failed', message: err ? String(err.message || err) : 'no JSON from wia-scan.ps1' })
    })
  })
}

// Live enumeration, cached 60s: the pre-grader polls GET /api/scan, and each probe is a full
// powershell + WIA COM spin-up (~1–2s) — cache hits AND misses so a scannerless box is not
// paying that per poll. A scan that fails with no_scanner invalidates the cache immediately.
const DEV_CACHE_MS = 60_000
let devCache = { at: 0, device: null }
async function detectDevice(cfg) {
  if (!cfg.allowed || process.platform !== 'win32') return null
  if (Date.now() - devCache.at < DEV_CACHE_MS) return devCache.device
  const r = await runPs(['-Mode', 'list'], 20_000)
  const d = (r.ok && Array.isArray(r.devices) && r.devices[0])
    ? { id: String(r.devices[0].id || ''), name: String(r.devices[0].name || 'WIA scanner') }
    : null
  devCache = { at: Date.now(), device: d }
  return d
}

// Centering analysis is OPTIONAL twice over: lib/scan-centering.mjs may not exist on this
// checkout yet, and sharp is a native dep that can fail to load. Lazy dynamic import in
// try/catch; a load failure just means analyzeAvailable:false and the scan itself still works.
// Contract (analyzeCardImage(buffer), never throws):
//   {ok:true,analysis:{outer,inner|null,confidence,cardPx,note}}
//   | {ok:false,error:'sharp_unavailable'|'no_card'|'analyze_failed',message}
let analyzeFn = null
async function loadAnalyzer() {
  if (analyzeFn) return analyzeFn
  try {
    await import('sharp')   // probe the native dep separately so a broken install reads as unavailable, not a scan error
    const mod = await import('./scan-centering.mjs')
    if (typeof mod.analyzeCardImage === 'function') analyzeFn = mod.analyzeCardImage
  } catch { /* stays null — retried on the next request in case the module lands mid-session */ }
  return analyzeFn
}

// One scan at a time: the V39 II is a single physical carriage, and a second Transfer() while
// one is moving errors deep inside the driver. Module-level on purpose — the lock must span
// every client of this dev-server process.
let scanning = false

export function makeScanRouter(env) {
  const cfg = scanConfig(env)
  return async (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.setHeader('access-control-allow-origin', '*')
    const method = (req.method || 'GET').toUpperCase()
    // connect hands us the sub-path with the /api/scan mount prefix already stripped
    const p = String(req.url || '/').split('?')[0].replace(/\/+$/, '') || '/'
    const send = (status, obj) => { res.statusCode = status; res.end(JSON.stringify(obj)) }
    try {
      // GET / — capability probe for the pre-grader UI. Never throws, never 500s: a box with
      // no scanner (or SCANNER_ENABLED=false) is a normal answer, not an error.
      if (p === '/' && method === 'GET') {
        const device = await detectDevice(cfg)
        return send(200, {
          enabled: !!device,
          device,
          dpiOptions: DPI_OPTIONS,
          defaultDpi: cfg.defaultDpi,
          region: { wmm: cfg.wmm, hmm: cfg.hmm },
          analyzeAvailable: !!(await loadAnalyzer()),
        })
      }

      // POST / {side:'front'|'back', dpi?, analyze?} — run one scan, return the PNG inline.
      if (p === '/' && method === 'POST') {
        let body
        try { body = await readJsonBody(req, 28 * 1024 * 1024) } catch (e) {
          return send(400, { ok: false, error: 'bad_request', message: String((e && e.message) || e) })
        }
        const side = String(body.side || '')
        if (side !== 'front' && side !== 'back') {
          return send(400, { ok: false, error: 'bad_request', message: "side must be 'front' or 'back'" })
        }
        const dpi = body.dpi == null ? cfg.defaultDpi : parseInt(body.dpi, 10)
        if (!DPI_OPTIONS.includes(dpi)) {
          return send(400, { ok: false, error: 'bad_request', message: 'dpi must be one of ' + DPI_OPTIONS.join('/') })
        }
        if (!cfg.allowed) {
          return send(503, { ok: false, error: 'unconfigured', message: 'scanning is disabled (SCANNER_ENABLED=false)' })
        }
        const device = await detectDevice(cfg)
        if (!device) {
          return send(503, { ok: false, error: 'unconfigured', message: 'no WIA scanner detected' })
        }
        if (scanning) {
          return send(409, { ok: false, error: 'scanner_busy', message: 'a scan is already in progress' })
        }
        scanning = true
        const out = path.join(os.tmpdir(), 'tcg-scan-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.png')
        try {
          const r = await runPs(['-Mode', 'scan', '-Dpi', String(dpi), '-Wmm', String(cfg.wmm), '-Hmm', String(cfg.hmm), '-Out', out], 90_000)
          if (!r.ok) {
            // it was there at detect time and gone at scan time — make the next GET honest now, not in 60s
            if (r.error === 'no_scanner') devCache = { at: Date.now(), device: null }
            return send(502, { ok: false, error: r.error === 'timeout' ? 'timeout' : 'scan_failed', message: r.message || 'scan failed' })
          }
          let png = await fs.readFile(out)
          let imgW = r.w, imgH = r.h, mediaType = 'image/png'
          let analysis = null, cropped = false
          if (body.analyze !== false) {
            const analyze = await loadAnalyzer()
            if (analyze) {
              const a = await analyze(png)   // contract: never throws; ok:false just means no analysis
              if (a && a.ok) {
                analysis = a.analysis
                const c = await cropToCard(png, analysis)
                if (c) { png = c.buf; imgW = c.w; imgH = c.h; mediaType = c.mediaType; analysis = c.analysis; cropped = true }
              }
            }
          }
          console.log('[api/scan]', side, dpi + 'dpi', imgW + 'x' + imgH, Math.round(png.length / 1024) + 'KB', analysis ? '· analyzed' : '', cropped ? '· cropped' : '')
          return send(200, {
            ok: true,
            shotId: 'scan-' + side,
            image: { dataB64: png.toString('base64'), mediaType, w: imgW, h: imgH, dpi: r.dpi },
            analysis,
            cropped,
          })
        } finally {
          scanning = false
          fs.unlink(out).catch(() => {})   // may not exist if the scan failed before SaveFile
        }
      }

      // POST /analyze {image:{dataB64,mediaType}} — centering analysis for an image the client
      // already holds (an upload, or a re-run on a previous scan). Pass-through of the analyzer's
      // own ok/err shape; its ok:false values are analytic outcomes, not transport errors.
      if (p === '/analyze' && method === 'POST') {
        let body
        try { body = await readJsonBody(req, 28 * 1024 * 1024) } catch (e) {   // scans are ~5–7MB of base64; same headroom as /api/grade
          return send(400, { ok: false, error: 'bad_request', message: String((e && e.message) || e) })
        }
        const img = body && body.image
        if (!img || typeof img.dataB64 !== 'string' || !img.dataB64) {
          return send(400, { ok: false, error: 'bad_request', message: 'body must be {image:{dataB64,mediaType}}' })
        }
        const analyze = await loadAnalyzer()
        if (!analyze) {
          return send(200, { ok: false, error: 'sharp_unavailable', message: 'centering analysis is not available on this install' })
        }
        const buf = Buffer.from(img.dataB64, 'base64')
        if (!buf.length) {
          return send(400, { ok: false, error: 'bad_request', message: 'dataB64 decoded to zero bytes' })
        }
        return send(200, await analyze(buf))
      }

      return send(404, { ok: false, error: 'unknown', message: 'unknown scan route: ' + method + ' ' + p })
    } catch (e) {
      // Golden Rule 7: an API failure is a JSON body, never a crashed request
      console.error('[api/scan] error:', (e && e.message) || e)
      return send(500, { ok: false, error: 'scan_failed', message: String((e && e.message) || e) })
    }
  }
}

export function scanPlugin(env) {
  return {
    name: 'scan',
    configureServer(server) {
      // ONE mount dispatching sub-paths internally. connect matches mounts by prefix in
      // registration order (same startsWith trap as the proxy table — vite.config.js:487-488),
      // so a separate '/api/scan/analyze' mount would be swallowed by '/api/scan' unless someone
      // remembered to register it first. One mount, zero ordering to remember.
      server.middlewares.use('/api/scan', makeScanRouter(env))
      console.log('[scan] API /api/scan · ' + SCRIPT)
    },
  }
}
