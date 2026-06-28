// Server-side label-print helper for the AUSPRINT PRO (rebadged Rongta RP4xx, TSPL).
//
// The browser rasterises a label to a 1-bpp bitmap (1 = ink/black, MSB-first, each row
// padded to a whole byte) and POSTs it to /api/print. This module wraps that bitmap in
// the printer's command language and streams it to the raw 9100 socket. Confirmed by the
// scripts/labeltest.mjs spike: this unit speaks TSPL, renders BITMAP, and uses 0 = black
// dot — so for TSPL we invert the client's 1-is-ink bytes (a LABEL_PRINTER_INVERT flag
// covers any unit wired the other way). No external deps — pure node:net.

import net from 'node:net'

// Parse the printer block out of the Vite-loaded env. `enabled` is false when no IP is
// set, so the tool degrades cleanly to download-only (Golden Rule 7).
export function printConfig(env) {
  const ip = String(env.LABEL_PRINTER_IP || '').trim()
  return {
    enabled: !!ip,
    ip,
    port: parseInt(env.LABEL_PRINTER_PORT || '9100', 10),
    lang: String(env.LABEL_PRINTER_LANG || 'tspl').toLowerCase(),
    dpi: parseInt(env.LABEL_PRINTER_DPI || '300', 10), // AUSPRINT PRO = 300; base AUSPRINT = 203
    pageWmm: parseFloat(env.LABEL_PRINTER_PAGE_W_MM || '100'),
    pageHmm: parseFloat(env.LABEL_PRINTER_PAGE_H_MM || '50'),   // landscape fallback; app sends the real size
    gapMm: parseFloat(env.LABEL_PRINTER_GAP_MM || '3'),
    offXmm: parseFloat(env.LABEL_PRINTER_OFFX_MM || '0'),
    offYmm: parseFloat(env.LABEL_PRINTER_OFFY_MM || '0'),
    density: parseInt(env.LABEL_PRINTER_DENSITY || '10', 10),
    // false = correct for this AUSPRINT (we invert client bits to TSPL's 0=black). Set true
    // only if prints come out as a photo-negative.
    invert: String(env.LABEL_PRINTER_INVERT || 'false').toLowerCase() === 'true',
  }
}

function invertBits(buf) {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ 0xff
  return out
}

// jobs: [{ data: Buffer (1bpp, 1=ink, MSB-first, row-padded), widthDots, heightDots, copies? }]
export function buildTSPL(jobs, cfg) {
  const parts = []
  for (const j of jobs) {
    const wBytes = Math.ceil(j.widthDots / 8)
    const sizeW = (j.wmm > 0) ? j.wmm : cfg.pageWmm        // label SIZE = the selected label size
    const sizeH = (j.hmm > 0) ? j.hmm : cfg.pageHmm
    // TSPL BITMAP ink bit = 0; client sends 1=ink, so invert unless the unit is reversed.
    const data = cfg.invert ? Buffer.from(j.data) : invertBits(j.data)
    // BITMAP at the label origin (0,0). Any alignment nudge is baked into the raster on the
    // client (so it can shift left/up, which a TSPL BITMAP x/y — clamped to ≥0 — cannot).
    parts.push(Buffer.from(
      `SIZE ${sizeW} mm, ${sizeH} mm\r\n` +
      `GAP ${cfg.gapMm} mm, 0 mm\r\n` +
      `DENSITY ${cfg.density}\r\n` +
      `DIRECTION 0\r\n` +
      `REFERENCE 0,0\r\n` +
      `CLS\r\n` +
      `BITMAP 0,0,${wBytes},${j.heightDots},0,`, 'latin1'))
    parts.push(data)
    parts.push(Buffer.from(`\r\nPRINT ${j.copies || 1},1\r\n`, 'latin1'))
  }
  return Buffer.concat(parts)
}

// ZPL fallback (this unit ignored ZPL in the spike, but the LABEL_PRINTER_LANG=zpl knob is
// real for other Rongta firmware). ZPL ^GF ink bit = 1, matching the client convention.
export function buildZPL(jobs, cfg) {
  const parts = []
  for (const j of jobs) {
    const wBytes = Math.ceil(j.widthDots / 8)
    const total = wBytes * j.heightDots
    const data = cfg.invert ? invertBits(j.data) : Buffer.from(j.data)
    parts.push(
      `^XA\r\n^FO0,0^GFA,${total},${total},${wBytes},` +
      data.toString('hex').toUpperCase() +
      `^FS\r\n^PQ${j.copies || 1}\r\n^XZ\r\n`)
  }
  return Buffer.from(parts.join(''), 'latin1')
}

export function buildJob(jobs, cfg) {
  return cfg.lang === 'zpl' ? buildZPL(jobs, cfg) : buildTSPL(jobs, cfg)
}

// Stream a prepared job to the printer's raw socket. Resolves once the bytes are flushed
// and the socket closed; rejects on connect error / timeout (so the UI can surface it).
export function sendToPrinter(buffer, { ip, port = 9100, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket()
    let done = false
    const finish = (err) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* already gone */ }
      err ? reject(err) : resolve()
    }
    sock.setTimeout(timeoutMs)
    sock.on('timeout', () => finish(new Error(`printer connection timed out (${ip}:${port})`)))
    sock.on('error', (e) => finish(e))
    sock.connect(port, ip, () => {
      sock.write(buffer, () => {
        // brief grace so the firmware drains its buffer before we tear the socket down
        setTimeout(() => { try { sock.end() } catch { /* noop */ }; finish(null) }, 350)
      })
    })
  })
}
