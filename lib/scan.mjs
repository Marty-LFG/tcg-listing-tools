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
// Measured on the live unit: 600dpi/160×220mm ≈ 23s · 1200dpi/160×220mm ≈ 83s (7559×10394 px).
// Those two points size every timeout in this file (scanTimeoutMs) rather than a hand-picked
// constant, because POST /sheet scans the WHOLE platen and a constant tuned for a card-sized window
// is not a timeout there, it is a kill switch.
//
// Two lanes, one pipeline: POST / returns one card, POST /sheet returns the 4–6 cards an A4 platen
// holds as separate cropped JPEGs. Both run the identical per-card finish (auto-rotate → deskew →
// crop → JPEG) through finishCard, because two copies of that sequence would drift the moment one
// of them is fixed.

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
  // 1200 default is the owner's call: max quality, storage is explicitly not a concern.
  // 1200 is also the CEILING — the V39 II hardware claims 4800dpi optical but its WIA driver
  // exposes SubTypeMax 1200 (measured live), and Epson Scan 2's higher modes have no CLI.
  let dpi = parseInt(env.SCANNER_DPI_DEFAULT || '1200', 10)
  if (!DPI_OPTIONS.includes(dpi)) dpi = 1200
  return {
    allowed: String(env.SCANNER_ENABLED == null ? 'true' : env.SCANNER_ENABLED).trim().toLowerCase() !== 'false',
    defaultDpi: dpi,
    // 160×220 is deliberately forgiving: the first live test card was placed ~35mm off the
    // platen corner and a 110×140 region cut it off. The region is big so placement is casual;
    // the response stays small because the route crops to the detected card below.
    wmm: parseFloat(env.SCANNER_REGION_W_MM || '160'),
    hmm: parseFloat(env.SCANNER_REGION_H_MM || '220'),
    // The sheet lane's window is the whole platen (A4), because the point of it is "put six cards
    // down and press once" — a window sized for one card defeats the feature before it starts.
    sheetWmm: parseFloat(env.SCANNER_SHEET_W_MM || '210'),
    sheetHmm: parseFloat(env.SCANNER_SHEET_H_MM || '297'),
  }
}

// How long to allow one scan. Flatbed time is dominated by PIXELS, not millimetres: the two live
// V39 II measurements (160×220mm — 600dpi 3780×5197px in ~23s, 1200dpi 7559×10394px in ~83s) work
// out at 1.17 and 1.06 µs per pixel, close enough that one constant covers both stops.
//
//   t ≈ 3s spin-up + 1.2µs × pixels,  timeout = 2.5×t, floored at 60s
//
// The floor is for a cold lamp on a fast scan; the 2.5× is for a driver having a bad day. Sanity
// check: the old hand-picked 240s for 1200dpi/160×220mm comes back out as 242s, so this replaces
// that constant without moving it. Extended to the platen it predicts A4 at 600dpi ≈ 45s (4961×7015
// = 34.8Mpx) and at 1200dpi ≈ 170s (139Mpx). Both are DERIVED from the 160×220 measurements, not
// measured at A4 — nobody has run a full-platen pass on the live unit yet, and the number should be
// re-derived from a real one when they do.
const SCAN_MS_PER_PX = 0.0012
const SCAN_SPINUP_MS = 3000
export function scanTimeoutMs(wmm, hmm, dpi) {
  const pixels = (wmm / 25.4 * dpi) * (hmm / 25.4 * dpi)
  return Math.max(60_000, Math.min(600_000, Math.round((SCAN_SPINUP_MS + pixels * SCAN_MS_PER_PX) * 2.5)))
}

// Crop the scan down to the detected card before it leaves the server. A 160×220mm 600dpi PNG
// is ~28MB — too big for the client to ever POST back through the 28MB save path — while the
// card itself is ~5MB. Margin is 12% of the card's width per side: generous enough that even
// the analyzer's known white-lid failure mode (locking one border-width inside the true edge)
// still keeps the real card edge in frame. Coordinates in the analysis are shifted so they
// stay valid for the CROPPED image the client receives. Any failure returns the original.
async function cropToCard(png, analysis) {
  const conf = analysis && analysis.confidence ? analysis.confidence.outer : 0
  // A sleeve match caps outer confidence at 0.35 (see lib/scan-centering.mjs) and that cap is about
  // TRUSTING THE MEASUREMENT, not about knowing where the object is. The crop only needs the latter:
  // a rect around the sleeve plus a 12% margin contains the card by definition, and refusing to crop
  // here would send the owner's routine case — he scans sleeved — back to full-frame payloads for no
  // gain. The honest confidence still travels to the client untouched.
  const sleeved = !!(analysis && analysis.physical && analysis.physical.match === 'sleeved')
  if (!analysis || !analysis.outer || !(conf >= 0.5 || sleeved)) return null
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

// The per-card finish, lifted out of POST / so POST /sheet can run it per cell: auto-orient a
// sideways card to portrait, straighten a measurable skew, crop to the card, leave as JPEG. Every
// step re-analyzes, because each one moves every coordinate the previous step reported.
//
// `analysis` comes back null when the analyzer could not find a card — the caller decides what that
// means. On a single scan it is "here is your image anyway"; on a sheet cell it is "that was not a
// card", which is precisely the per-cell aspect gate doing its job.
// Exported for tests only: the two lanes both run it, and it is the one piece of the scan path that
// can be exercised without moving a carriage.
export async function finishCard(buf, analyze, { dpi = null, w = 0, h = 0 } = {}) {
  let png = buf
  let imgW = w, imgH = h, mediaType = 'image/png'
  let analysis = null, cropped = false, rotated = false, straightened = 0
  let a = await analyze(png, { dpi })   // contract: never throws; ok:false just means no analysis

  // Auto-orient: a card wider than tall is a sideways card, not a landscape card — rotate to
  // portrait and re-analyze so L/R means left/right and the AI's "top edge" is the top edge.
  // 180° (upside down) is NOT detectable from geometry; the client's per-shot rotate covers that.
  if (a && a.ok && a.analysis.outer) {
    const o = a.analysis.outer
    if ((o.r - o.l) > (o.b - o.t)) {
      try {
        const sharp = (await import('sharp')).default
        png = await sharp(png).rotate(90).png().toBuffer()
        const m = await sharp(png).metadata()
        imgW = m.width; imgH = m.height; rotated = true
        a = await analyze(png, { dpi })
      } catch { /* keep the sideways scan — the client can rotate it */ }
    }
  }

  // Auto-deskew: the analyzer measures the card's tilt from its own edge traces; rotating by
  // -skewDeg makes the sides truly vertical. sharp interpolates properly (the client's canvas bake
  // is the fallback for images that never pass through here).
  if (a && a.ok && a.analysis.skewDeg != null
      && Math.abs(a.analysis.skewDeg) >= 0.05 && Math.abs(a.analysis.skewDeg) <= 3.5
      && (a.analysis.skewConf == null || a.analysis.skewConf >= 0.3)) {
    try {
      const sharp = (await import('sharp')).default
      const B = a.analysis.bgLevel ?? 255
      png = await sharp(png).rotate(-a.analysis.skewDeg, { background: { r: B, g: B, b: B } }).png().toBuffer()
      const m = await sharp(png).metadata()
      imgW = m.width; imgH = m.height
      straightened = a.analysis.skewDeg
      a = await analyze(png, { dpi })
    } catch { /* keep the tilted scan — the editor's manual rotate still works */ }
  }

  if (a && a.ok) {
    analysis = a.analysis
    const c = await cropToCard(png, analysis)
    if (c) { png = c.buf; imgW = c.w; imgH = c.h; mediaType = c.mediaType; analysis = c.analysis; cropped = true }
  }

  // The no-crop fallback ALSO leaves as JPEG: a 1200dpi full-region PNG measured 96MB of base64 —
  // brutal to ship and impossible to save back through the 28MB body cap.
  if (!cropped && mediaType === 'image/png') {
    try {
      const sharp = (await import('sharp')).default
      png = await sharp(png).jpeg({ quality: 92 }).toBuffer()
      mediaType = 'image/jpeg'
    } catch { /* no sharp — the raw PNG is still a valid answer, just a heavy one */ }
  }

  return { buf: png, w: imgW, h: imgH, mediaType, analysis, cropped, rotated, straightened, reason: a && !a.ok ? a : null }
}

// `null`, `7` and `[]` are all valid JSON bodies, and every one of them reaches a `body.side` or
// `body.dpi` read below as a property access on a non-object. On `null` that is a TypeError, which
// GR7 says must not be how a caller learns their body was wrong. Normalise once, at the door, and
// let the field-by-field validation produce the 400 it was written to produce.
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

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
// Contract (analyzeCardImage(buffer, {dpi}), never throws):
//   {ok:true,analysis:{outer,inner|null,confidence,cardPx,physical|null,note}}
//   | {ok:false,error:'sharp_unavailable'|'no_card'|'analyze_failed',message}
// The whole module is cached, not just the one function: the sheet lane needs segmentSheet and
// extractCell from the same import, and a second import site is a second thing to keep in step.
let centering = null
async function loadCentering() {
  if (centering) return centering
  try {
    await import('sharp')   // probe the native dep separately so a broken install reads as unavailable, not a scan error
    const mod = await import('./scan-centering.mjs')
    if (typeof mod.analyzeCardImage === 'function') centering = mod
  } catch { /* stays null — retried on the next request in case the module lands mid-session */ }
  return centering
}
async function loadAnalyzer() {
  const mod = await loadCentering()
  return mod ? mod.analyzeCardImage : null
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
          sheetRegion: { wmm: cfg.sheetWmm, hmm: cfg.sheetHmm },
          sheetAvailable: !!(await loadCentering()),   // segmentation IS the sheet lane; no analyzer, no sheet
          analyzeAvailable: !!(await loadAnalyzer()),
        })
      }

      // POST / {side:'front'|'back', dpi?, analyze?} — run one scan, return the PNG inline.
      if (p === '/' && method === 'POST') {
        let body
        try { body = asObject(await readJsonBody(req, 28 * 1024 * 1024)) } catch (e) {
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
          const r = await runPs(['-Mode', 'scan', '-Dpi', String(dpi), '-Wmm', String(cfg.wmm), '-Hmm', String(cfg.hmm), '-Out', out], scanTimeoutMs(cfg.wmm, cfg.hmm, dpi))
          if (!r.ok) {
            // it was there at detect time and gone at scan time — make the next GET honest now, not in 60s
            if (r.error === 'no_scanner') devCache = { at: Date.now(), device: null }
            return send(502, { ok: false, error: r.error === 'timeout' ? 'timeout' : 'scan_failed', message: r.message || 'scan failed' })
          }
          let png = await fs.readFile(out)
          let imgW = r.w, imgH = r.h, mediaType = 'image/png'
          let analysis = null, cropped = false, rotated = false, straightened = 0
          const analyze = body.analyze === false ? null : await loadAnalyzer()
          if (analyze) {
            // r.dpi is the dpi the DRIVER settled on after its own clamp, not the one we asked for
            // — the physical-size check divides by it, so an assumed 1200 against a 600dpi scan
            // would double every millimetre and call a card a jumbo.
            const f = await finishCard(png, analyze, { dpi: r.dpi, w: imgW, h: imgH })
            png = f.buf; imgW = f.w; imgH = f.h; mediaType = f.mediaType
            analysis = f.analysis; cropped = f.cropped; rotated = f.rotated; straightened = f.straightened
          } else if (mediaType === 'image/png') {
            try {
              const sharp = (await import('sharp')).default
              png = await sharp(png).jpeg({ quality: 92 }).toBuffer()
              mediaType = 'image/jpeg'
            } catch { /* no sharp — the raw PNG is still a valid answer, just a heavy one */ }
          }
          console.log('[api/scan]', side, dpi + 'dpi', imgW + 'x' + imgH, Math.round(png.length / 1024) + 'KB', analysis ? '· analyzed' : '', cropped ? '· cropped' : '', rotated ? '· auto-rotated' : '', straightened ? '· deskewed ' + straightened.toFixed(2) + '°' : '')
          return send(200, {
            ok: true,
            shotId: 'scan-' + side,
            image: { dataB64: png.toString('base64'), mediaType, w: imgW, h: imgH, dpi: r.dpi },
            analysis,
            cropped,
            rotated,
            straightened: straightened || 0,
          })
        } finally {
          scanning = false
          fs.unlink(out).catch(() => {})   // may not exist if the scan failed before SaveFile
        }
      }

      // POST /sheet {dpi?, region?:{wmm,hmm}} — one pass over the WHOLE platen, returning every
      // card on it as its own cropped JPEG. The A4 glass holds 4–6 cards and scanning them one at
      // a time costs a carriage pass each (23s at 600dpi, 83s at 1200); this is that same pass,
      // segmented afterwards.
      //
      // Payload arithmetic, because it is the thing that will bite: six cropped cards at 1200dpi
      // are ~5MB of base64 each — a ~30MB response. That is a LAN dev server so nothing rejects it,
      // but the sheet lane is a triage lane and 300–600dpi is what it is for; 1200 belongs to the
      // single-card lane where one card justifies the bytes. Pass dpi explicitly.
      if (p === '/sheet' && method === 'POST') {
        let body
        try { body = asObject(await readJsonBody(req, 1 * 1024 * 1024)) } catch (e) {   // nothing but knobs comes IN here
          return send(400, { ok: false, error: 'bad_request', message: String((e && e.message) || e) })
        }
        const dpi = body.dpi == null ? cfg.defaultDpi : parseInt(body.dpi, 10)
        if (!DPI_OPTIONS.includes(dpi)) {
          return send(400, { ok: false, error: 'bad_request', message: 'dpi must be one of ' + DPI_OPTIONS.join('/') })
        }
        const reg = body.region || {}
        const wmm = reg.wmm == null ? cfg.sheetWmm : parseFloat(reg.wmm)
        const hmm = reg.hmm == null ? cfg.sheetHmm : parseFloat(reg.hmm)
        // The ps1 clamps to the driver's extent maximum, so oversizing cannot error — but a NaN or
        // a negative would reach it as a broken -Wmm and come back as an opaque COM failure.
        if (!(wmm > 0 && wmm <= 320) || !(hmm > 0 && hmm <= 460)) {
          return send(400, { ok: false, error: 'bad_request', message: 'region must be {wmm,hmm} in millimetres, within the platen (≤320×460)' })
        }
        if (!cfg.allowed) {
          return send(503, { ok: false, error: 'unconfigured', message: 'scanning is disabled (SCANNER_ENABLED=false)' })
        }
        const mod = await loadCentering()
        if (!mod || typeof mod.segmentSheet !== 'function') {
          // Without segmentation a platen scan is one giant image the client cannot use — refuse
          // rather than spend 170s of carriage time producing it.
          return send(503, { ok: false, error: 'unconfigured', message: 'multi-card segmentation is not available on this install (sharp missing)' })
        }
        const device = await detectDevice(cfg)
        if (!device) {
          return send(503, { ok: false, error: 'unconfigured', message: 'no WIA scanner detected' })
        }
        if (scanning) {
          return send(409, { ok: false, error: 'scanner_busy', message: 'a scan is already in progress' })
        }
        scanning = true
        const out = path.join(os.tmpdir(), 'tcg-sheet-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.png')
        try {
          const r = await runPs(['-Mode', 'scan', '-Dpi', String(dpi), '-Wmm', String(wmm), '-Hmm', String(hmm), '-Out', out], scanTimeoutMs(wmm, hmm, dpi))
          if (!r.ok) {
            if (r.error === 'no_scanner') devCache = { at: Date.now(), device: null }
            return send(502, { ok: false, error: r.error === 'timeout' ? 'timeout' : 'scan_failed', message: r.message || 'scan failed' })
          }
          const sheet = await fs.readFile(out)
          const seg = await mod.segmentSheet(sheet, { dpi: r.dpi })
          if (!seg.ok) {
            // An empty platen is an outcome, not a transport failure — 200 with ok:false, the same
            // shape /analyze uses, so the client shows the message instead of a red error box. The
            // scan itself is discarded: shipping a 4.6MB "you look at it" image is not an answer,
            // and the operator's next move is to reposition and press again either way.
            return send(200, {
              ok: false,
              error: seg.error,
              message: seg.message + ' — reposition the cards (3mm+ apart, off the glass edge, matte-black backing) and rescan, or use the single-card scan',
              dpi: r.dpi,
            })
          }
          // One cell at a time, and the sheet buffer is the only large thing held throughout: a
          // 1200dpi A4 PNG is 139Mpx, and keeping six decoded crops alive beside it is how a dev
          // server runs out of heap.
          const cards = []
          const rejected = []
          for (const cell of seg.cells) {
            const cellBuf = await mod.extractCell(sheet, cell.rect)
            if (!cellBuf) { rejected.push(`cell ${cell.row + 1},${cell.col + 1}: could not be cut out`); continue }
            const f = await finishCard(cellBuf, mod.analyzeCardImage, {
              dpi: r.dpi, w: cell.rect.r - cell.rect.l, h: cell.rect.b - cell.rect.t,
            })
            // The aspect gate, doing its real job: per cell it decides "is this a card", and a
            // rejection drops one cell instead of failing the whole sheet the way a global gate did.
            if (!f.analysis) { rejected.push(`cell ${cell.row + 1},${cell.col + 1}: ${(f.reason && f.reason.message) || 'no card found'}`); continue }
            cards.push({
              index: cards.length,
              rect: cell.rect,   // where this card sat on the platen, in the full scan's pixels
              image: { dataB64: f.buf.toString('base64'), mediaType: f.mediaType, w: f.w, h: f.h, dpi: r.dpi },
              analysis: f.analysis,   // coordinates are in THIS card's cropped image, not the sheet's
              cropped: f.cropped,
              rotated: f.rotated,
              straightened: f.straightened || 0,
            })
          }
          if (!cards.length) {
            return send(200, {
              ok: false,
              error: 'no_card',
              message: `scanned ${wmm}×${hmm}mm and segmented ${seg.cells.length} cell(s), but none held a card — ${rejected[0] || 'every cell failed the card check'}`,
              dpi: r.dpi,
            })
          }
          const bytes = cards.reduce((n, c) => n + c.image.dataB64.length, 0)
          console.log('[api/scan/sheet]', dpi + 'dpi', wmm + 'x' + hmm + 'mm', cards.length + ' card(s)', rejected.length ? rejected.length + ' rejected' : '', Math.round(bytes / 1024) + 'KB')
          return send(200, {
            ok: true,
            dpi: r.dpi,
            cards,
            grid: seg.grid,
            rejected,
            note: `${cards.length} card${cards.length === 1 ? '' : 's'} from ${seg.note}`
              + (rejected.length ? `; ${rejected.length} cell${rejected.length === 1 ? '' : 's'} rejected (${rejected[0]})` : ''),
          })
        } finally {
          scanning = false
          fs.unlink(out).catch(() => {})   // may not exist if the scan failed before SaveFile
        }
      }

      // POST /analyze {image:{dataB64,mediaType}, dpi?} — centering analysis for an image the client
      // already holds (an upload, or a re-run on a previous scan). Pass-through of the analyzer's
      // own ok/err shape; its ok:false values are analytic outcomes, not transport errors.
      if (p === '/analyze' && method === 'POST') {
        let body
        try { body = asObject(await readJsonBody(req, 28 * 1024 * 1024)) } catch (e) {   // scans are ~5–7MB of base64; same headroom as /api/grade
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
        // dpi is optional here and usually absent: an upload is a phone photo with no scale, and
        // the analyzer answers physical:null rather than assuming one. A client that DOES know the
        // dpi (a re-run on a previous scan, whose dpi it still holds) gets the sleeve check too.
        const upDpi = Number(body.dpi != null ? body.dpi : (img.dpi != null ? img.dpi : NaN))
        return send(200, await analyze(buf, Number.isFinite(upDpi) && upDpi > 0 ? { dpi: upDpi } : {}))
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
