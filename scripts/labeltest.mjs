#!/usr/bin/env node
// Raw-9100 thermal-printer test + calibration harness for the AUSPRINT PRO (rebadged
// Rongta RP4xx). Sends a minimal label straight to the printer's raw socket so we can
// (a) confirm which command language the firmware speaks (TSPL vs ZPL) and (b) eyeball
// label size / position / orientation on the loaded landscape stock. No deps — pure node:net.
//
// Usage:
//   node scripts/labeltest.mjs                      # TSPL test to 192.168.4.220:9100
//   node scripts/labeltest.mjs --lang zpl           # ZPL test (if TSPL prints nothing)
//   node scripts/labeltest.mjs --ip 192.168.4.220 --port 9100 --lang tspl
//   node scripts/labeltest.mjs --dpi 203            # box width fits 203dpi heads too
//
// A label popping out of the AUSPRINT confirms the IP, the unit's identity, and the
// dialect. Record the winner as LABEL_PRINTER_LANG in .env.

import net from 'node:net'

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split(/\s+--/).filter(Boolean).map((s) => {
    const t = s.replace(/^--/, '').split(/\s+/)
    return [t[0], t[1] ?? true]
  })
)

const IP = args.ip || '192.168.4.220'
const PORT = parseInt(args.port || '9100', 10)
const LANG = String(args.lang || 'tspl').toLowerCase()
const DPI = parseInt(args.dpi || '300', 10)

// Keep all coordinates inside the narrower 203dpi head (≈800 dots) so the same test
// renders (clipped at worst, never errored) on both 203 and 300 dpi units.
function tsplTest() {
  // Font-INDEPENDENT first: a solid BAR inks even if the firmware lacks the named
  // bitmap fonts. If the bar prints but the TEXT lines don't, it's a font-name issue,
  // not a dialect/polarity one. No DIRECTION/DENSITY (defaults) to rule those out.
  const lines = [
    'SIZE 100 mm, 50 mm',
    'GAP 3 mm, 0 mm',
    'CLS',
    'BAR 40,40,720,90',                                   // solid black block — must ink
    'TEXT 40,180,"3",0,1,1,"AUSPRINT TSPL TEST"',         // internal font "3"
    'TEXT 40,240,"2",0,1,1,"raw 9100 + TSPL works."',     // internal font "2"
    'BOX 20,20,760,520,4',
    'PRINT 1,1',
  ]
  return Buffer.from(lines.join('\r\n') + '\r\n', 'latin1')
}

function zplTest() {
  // ^GB with border thickness == height draws a SOLID block (font-independent ink test).
  const z = [
    '^XA',
    '^PW780',
    '^FO40,40^GB300,90,90^FS',                            // solid black block — must ink
    '^FO40,170^A0N,44,44^FDAUSPRINT ZPL TEST^FS',
    '^FO40,230^A0N,30,30^FDraw 9100 + ZPL works.^FS',
    '^FO20,20^GB740,320,3^FS',                            // outline box
    '^XZ',
  ]
  return Buffer.from(z.join('\n'), 'latin1')
}

// TSPL BITMAP test — validates the ACTUAL production path (rasterized label sent as
// a BITMAP, like the AUSPRINT app does) and settles bit polarity: prints an all-0x00
// block next to an all-0xFF block. Whichever inks black tells us the correct fill byte.
function bitmapTest() {
  const wBytes = 10, h = 80                              // 80 dots wide (10 bytes) x 80 tall
  const zeros = Buffer.alloc(wBytes * h, 0x00)
  const ones = Buffer.alloc(wBytes * h, 0xff)
  const head = Buffer.from(
    'SIZE 100 mm, 50 mm\r\nGAP 3 mm, 0 mm\r\nDENSITY 10\r\nCLS\r\n', 'latin1')
  const blkA = Buffer.from(`BITMAP 40,40,${wBytes},${h},0,`, 'latin1')   // label "00"
  const blkB = Buffer.from(`\r\nBITMAP 280,40,${wBytes},${h},0,`, 'latin1') // label "FF"
  const tail = Buffer.from('\r\nTEXT 40,160,"3",0,1,1,"L=00  R=FF"\r\nPRINT 1,1\r\n', 'latin1')
  return Buffer.concat([head, blkA, zeros, blkB, ones, tail])
}

// TSPL SELFTEST: the printer prints its own configuration page using its internal
// engine + stored darkness, independent of any content we send. Inks => printhead /
// paper / darkness are all fine and the problem is our command content. Blank =>
// hardware (paper upside-down / darkness 0) or a non-TSPL/proprietary firmware.
function selfTest() { return Buffer.from('SELFTEST\r\n', 'latin1') }

const payload =
  LANG === 'self' ? selfTest() :
  LANG === 'bitmap' ? bitmapTest() :
  LANG === 'zpl' ? zplTest() : tsplTest()

console.log(`[labeltest] → ${IP}:${PORT}  lang=${LANG}  dpi=${DPI}  (${payload.length} bytes)`)
console.log('[labeltest] make sure the printer is ON with your landscape labels loaded, then watch it…')

const sock = new net.Socket()
sock.setTimeout(8000)
sock.on('timeout', () => { console.error('[labeltest] TIMEOUT — no socket activity (printer off / wrong IP?)'); sock.destroy(); process.exit(2) })
sock.on('error', (e) => { console.error('[labeltest] SOCKET ERROR:', e.message); process.exit(2) })
sock.connect(PORT, IP, () => {
  console.log('[labeltest] connected, sending…')
  sock.write(payload, () => {
    // brief grace period so the printer drains the buffer before we close
    setTimeout(() => { sock.end(); console.log('[labeltest] sent + closed. Did a label print? (y → TSPL/ZPL confirmed)'); process.exit(0) }, 600)
  })
})
