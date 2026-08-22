// Guards the printed pre-grading report (grade-report-pdf.js).
//
// The module is a browser classic script, so the repo idiom applies: read the source and run it
// through `new Function('window','document',src)` against a shim. The wrinkle here is jsPDF — the
// real vendored UMD build DOES run headless, but only inside a vm context that carries window/self/
// document/navigator, so that is how it is loaded. Building against the real engine is worth the
// setup: it catches bad primitive arguments (a NaN coordinate, an unknown font style) that a hand
// written stub would happily swallow.
//
// What is asserted:
//   - the module loads and exposes exactly build()
//   - a full report renders, is multi-page, and carries the headline answer + every disclaimer
//   - the degenerate cases (no data at all, no images, no AI pass, no pricing) still resolve with a
//     valid PDF instead of throwing, which is the GR7 promise the click handler relies on
//   - text goes out in the three mapped fonts, and every number is Courier
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = new URL('../../', import.meta.url)
const jspdfSrc = readFileSync(new URL('vendor/jspdf.umd.min.js', ROOT), 'utf8')
const moduleSrc = readFileSync(new URL('grade-report-pdf.js', ROOT), 'utf8')

// A real 8x11 JPEG. jsPDF parses the SOF marker for dimensions, so a fake data URL would be
// rejected — this is the smallest thing that genuinely embeds.
const JPEG_B64 =
  '/9j/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+' +
  'gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8' +
  'fHz/wAARCAALAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QA' +
  'FQEBAQAAAAAAAAAAAAAAAAAAAQP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC4AuX/2Q=='
const JPEG_URL = 'data:image/jpeg;base64,' + JPEG_B64

/** Build a sandbox holding a working jsPDF plus whatever browser surface the test wants.
 *  `opts.canvas` turns on the Image + canvas pair the annotated plates need. */
function sandbox(opts = {}) {
  const ctx = {
    console, setTimeout, clearTimeout, Math, Date, JSON, Promise, Error, RegExp,
    Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, parseFloat, parseInt, isFinite,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary')
  }
  ctx.window = ctx
  ctx.self = ctx
  ctx.globalThis = ctx
  ctx.navigator = { userAgent: 'node', language: 'en' }
  ctx.document = {
    createElementNS: () => ({}),
    documentElement: { style: {} },
    addEventListener() {},
    createElement(tag) {
      if (tag === 'canvas' && opts.canvas) {
        return {
          width: 0, height: 0,
          getContext: () => ({
            drawImage() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, fillText() {},
            set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set font(v) {},
            set textAlign(v) {}, set textBaseline(v) {}
          }),
          toDataURL: () => JPEG_URL
        }
      }
      return { getContext: () => null, style: {} }
    }
  }
  if (opts.canvas) {
    // The real <img> decodes asynchronously; the module must await it. Resolving on a timer is the
    // only faithful stand-in, and it is also what proves build() waits.
    ctx.Image = function Image() {
      let src = ''
      const self = this
      Object.defineProperty(this, 'src', {
        get: () => src,
        set(v) { src = v; setTimeout(() => { self.width = 8; self.height = 11; if (self.onload) self.onload() }, 1) }
      })
    }
  }
  createContext(ctx)
  runInContext(jspdfSrc, ctx)
  runInContext(moduleSrc, ctx)
  return ctx
}

/** Pull the readable text out of a finished PDF: every page's content stream, inflated. */
function pdfText(doc) {
  const raw = Buffer.from(doc.output('arraybuffer'))
  let out = ''
  const re = /stream\r?\n/g
  let m
  while ((m = re.exec(raw.toString('latin1'))) !== null) {
    const start = m.index + m[0].length
    const end = raw.toString('latin1').indexOf('endstream', start)
    if (end < 0) continue
    const chunk = raw.subarray(start, end)
    try { out += inflateSync(chunk).toString('latin1') } catch { out += chunk.toString('latin1') }
  }
  return out
}

/* ---------------------------------- fixtures ---------------------------------- */
const CFG = {
  asOf: '2026-06-24',
  marketplaceFeePct: 13,
  companies: {
    PSA: { label: 'PSA', step: 1, topLabel: 'Gem Mint 10', pillarWeights: { centering: 0.3, corners: 0.3, edges: 0.2, surface: 0.2 } },
    BGS: { label: 'BGS (Beckett)', step: 0.5, topLabel: 'Pristine 10 (Black Label)', pillarWeights: { centering: 0.3, corners: 0.3, edges: 0.2, surface: 0.2 } }
  },
  // The real config disclaimers are written with em-dashes and curly quotes, which is exactly the
  // input that used to lose characters on the page, so the fixture keeps them.
  disclaimers: [
    'Estimate only — this is NOT an official grade or a guarantee.',
    'Surface and the card back are systematically under-assessed from photos.',
    'No authentication. This tool predicts grade, not genuineness. Charizard’s worst enemy is a fake.'
  ]
}

function centering(lr, tb, worst, axis) {
  return { lr, tb, worst, lrLabel: lr, tbLabel: tb, label: worst, worstAxis: axis }
}

function fullData() {
  return {
    card: { name: 'Charizard ex', number: '199/165', set: 'SV151', rarity: 'Special Illustration Rare', finish: 'Holo', language: 'EN' },
    cfg: CFG,
    pred: {
      perCompany: {
        PSA: {
          grade: 10, gradeLabel: 'Gem Mint 10', raw: 9.6, confidence: 'high',
          probabilities: [{ grade: 10, p: 0.61 }, { grade: 9, p: 0.3 }, { grade: 8, p: 0.09 }],
          pillars: { centering: 10, corners: 9.5, edges: 10, surface: 9 }
        },
        BGS: {
          grade: 9.5, gradeLabel: 'Pristine 10 · Black Label', raw: 9.4, confidence: 'medium',
          probabilities: [{ grade: 9.5, p: 0.52 }, { grade: 9, p: 0.4 }, { grade: 10, p: 0.08 }],
          pillars: { centering: 9.5, corners: 9.5, edges: 10, surface: 9 },
          subgrades: { centering: 9.5, corners: 9.5, edges: 10, surface: 9 }
        }
      }
    },
    econ: {
      PSA: { ok: true, fee: 79.99, tier: { tier: 'Regular', turnaroundDays: 25 }, expectedValue: 412.5, profitVsRaw: 233.1, capitalScore: 82, verdict: 'Submit' },
      BGS: { ok: false, reason: 'no graded comps' }
    },
    bestCo: 'PSA',
    centering: {
      front: centering(52.4, 50.9, '52.4/47.6', 'L/R'),
      back: centering(61.2, 55.0, '61.2/38.8', 'L/R'),
      frontMm: { l: 3.1, r: 2.8, t: 3.4, b: 3.3 },
      backMm: null,
      psaCap: 9
    },
    ai: {
      provider: 'anthropic', model: 'claude-opus-5', confidence: 0.78,
      reasoning: 'Front corners are sharp under magnification. A short print line runs through the lower art.',
      defects: [],
      granular: {
        corners: { front: { tl: 10, tr: 9.5, bl: 8, br: 10 }, back: { tl: 9, tr: 9, bl: 9.5, br: 9 } },
        edges: { front: { top: 10, right: 9.5, bottom: 9, left: 10 }, back: { top: 9, right: 9, bottom: 9, left: 9 } }
      },
      surface: { front: 9, back: 9.5 }
    },
    shots: {
      'scan-front': { dataUrl: JPEG_URL, w: 8, h: 11, dpi: 600, kind: 'scan' },
      'scan-back': { dataUrl: JPEG_URL, w: 8, h: 11, dpi: 600, kind: 'scan' }
    },
    defects: [
      { n: 1, pinned: true, pillar: 'surface', side: 'front', imageRef: 'scan-front', x: 0.4, y: 0.62, location: 'lower art', severity: 'moderate', gradeSignificant: true, note: 'short print line' },
      { n: 2, pinned: false, pillar: 'corners', side: 'back', imageRef: null, x: null, y: null, location: 'bottom-left', severity: 'minor', gradeSignificant: false, note: 'faint whitening' }
    ],
    pricing: { rawUSD: 180.0, valueAtGrade: (co, g) => (g >= 10 ? 640 : g >= 9.5 ? 380 : 240) },
    meta: { generatedAt: '2026-08-23T04:00:00Z', reportId: 41 }
  }
}

/* ---------------------------------- tests ---------------------------------- */

test('module loads from the classic script and exposes build()', () => {
  const ctx = sandbox()
  assert.ok(ctx.GradeReportPDF, 'window.GradeReportPDF assigned')
  assert.equal(typeof ctx.GradeReportPDF.build, 'function')
  assert.deepEqual(Object.keys(ctx.GradeReportPDF), ['build'], 'one entry point, no leaked internals')
})

test('build() resolves a real jsPDF doc and never saves it for you', async () => {
  const ctx = sandbox()
  const doc = await ctx.GradeReportPDF.build(fullData())
  assert.ok(doc && typeof doc.output === 'function', 'a jsPDF doc came back')
  assert.ok(doc.getNumberOfPages() >= 2, 'a full report runs past one page')
  const bytes = Buffer.from(doc.output('arraybuffer'))
  assert.ok(bytes.length > 2000, 'the PDF has real content')
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'it is a PDF')
})

test('the headline answer, the measurements and the money all reach the page', async () => {
  const ctx = sandbox()
  const doc = await ctx.GradeReportPDF.build(fullData())
  const text = pdfText(doc)
  assert.match(text, /Card Pre-Grading Report/)
  assert.match(text, /Charizard ex/)
  assert.match(text, /BEST FIT/i)
  assert.match(text, /Gem Mint 10/)
  assert.match(text, /52\.4\/47\.6/, 'the measured worst axis is printed')
  assert.match(text, /\$412\.50/, 'expected value')
  assert.match(text, /\+\$233\.10/, 'profit against selling raw, signed')
  assert.match(text, /Submit/)
  assert.match(text, /1 of \d/, 'page n of m footer')
})

test('every configured disclaimer is printed, and the not-a-grade line is on every page', async () => {
  const ctx = sandbox()
  const doc = await ctx.GradeReportPDF.build(fullData())
  const text = pdfText(doc)
  for (const d of CFG.disclaimers) {
    // splitTextToSize wraps, so match on a distinctive opening fragment of each line. The fragment
    // is folded the same way the module folds it, because the page prints Latin-1.
    const head = d.replace(/—/g, '-').replace(/’/g, "'").split(/[.,]/)[0].slice(0, 24)
    assert.ok(text.includes(head), 'disclaimer present: ' + head)
  }
  const pages = doc.getNumberOfPages()
  const hits = text.split('This is not an official grade').length - 1
  assert.equal(hits, pages, 'the footer honesty line appears once per page')
  assert.match(text, /2026-06-24/, 'the asOf date is carried')
})

test('typographic punctuation is folded to Latin-1 instead of vanishing', async () => {
  // jsPDF core fonts are WinAnsi and drop anything above U+00FF silently. Before the fold, an
  // em-dash in a disclaimer left a two-space hole in the middle of the sentence.
  const ctx = sandbox()
  const doc = await ctx.GradeReportPDF.build(fullData())
  const text = pdfText(doc)
  assert.match(text, /Estimate only - this is NOT an official grade/, 'em-dash became a hyphen')
  assert.match(text, /Charizard's worst enemy/, 'curly apostrophe became a straight one')
  assert.doesNotMatch(text, /Estimate only {2}this/, 'no silent hole where the dash was')
})

test('the three-font mapping holds, and numbers are Courier', async () => {
  const ctx = sandbox()
  const doc = await ctx.GradeReportPDF.build(fullData())
  const raw = Buffer.from(doc.output('arraybuffer')).toString('latin1')
  assert.match(raw, /Times-Bold/, 'display serif is used')
  assert.match(raw, /Helvetica/, 'body sans is used')
  assert.match(raw, /Courier/, 'mono is used for numbers')
  // The Courier text objects should carry the figures.
  const text = pdfText(doc)
  const courierRuns = text.split(/\/F\d+ /).filter((s) => /\d/.test(s))
  assert.ok(courierRuns.length > 5, 'numbers were actually drawn')
})

test('annotated plates are composited and embedded when a canvas exists', async () => {
  const bare = sandbox()
  const plain = await bare.GradeReportPDF.build(fullData())
  const withCanvas = sandbox({ canvas: true })
  const plated = await withCanvas.GradeReportPDF.build(fullData())
  assert.ok(plated.getNumberOfPages() > plain.getNumberOfPages(),
    'front and back plates add pages that the canvas-less run cannot produce')
  const text = pdfText(plated)
  assert.match(text, /Annotated plate, front/)
  assert.match(text, /Annotated plate, back/)
  assert.match(text, /short print line/, 'the pinned flaw is listed under its plate')
})

test('no canvas and no Image degrade to a still-valid PDF instead of hanging', async () => {
  const ctx = sandbox() // no Image constructor at all
  const doc = await ctx.GradeReportPDF.build(fullData())
  assert.ok(doc.getNumberOfPages() >= 2)
  assert.doesNotMatch(pdfText(doc), /Annotated plate/, 'plates are skipped, not faked')
})

test('degenerate inputs never throw', async () => {
  const cases = {
    'empty object': {},
    'nulls throughout': { card: null, cfg: null, pred: null, econ: null, centering: null, ai: null, shots: null, defects: null, pricing: null, meta: null },
    'config but no prediction': { cfg: CFG },
    'prediction but no config': { pred: fullData().pred, bestCo: 'PSA' },
    'no pricing (PriceCharting miss)': (() => { const d = fullData(); d.pricing = {}; d.econ = { PSA: { ok: false, reason: 'no graded comps' } }; return d })(),
    'no AI pass': (() => { const d = fullData(); d.ai = null; d.defects = []; return d })(),
    'no back scan': (() => { const d = fullData(); delete d.shots['scan-back']; d.centering.back = null; d.centering.backMm = null; return d })(),
    'no images at all': (() => { const d = fullData(); d.shots = {}; return d })(),
    'garbage numbers': (() => {
      const d = fullData()
      d.pred.perCompany.PSA.grade = NaN
      d.pred.perCompany.PSA.pillars = { centering: null, corners: undefined, edges: 'x', surface: NaN }
      d.pred.perCompany.PSA.probabilities = [{ grade: null, p: NaN }]
      d.centering.front = centering(NaN, NaN, undefined, undefined)
      d.centering.frontMm = { l: -50, r: 900, t: NaN, b: null }
      d.econ.PSA = { ok: true, fee: null, expectedValue: undefined, profitVsRaw: NaN, verdict: null }
      return d
    })(),
    'legacy pinnedDefects rows': (() => {
      const d = fullData()
      d.defects = [{ n: 1, pinned: true, d: { pillar: 'edges', side: 'front', imageRef: 'scan-front', x: 0.2, y: 0.2, location: 'top', severity: 'major', note: 'nick' } }]
      return d
    })()
  }
  for (const [name, data] of Object.entries(cases)) {
    const ctx = sandbox({ canvas: true })
    const doc = await ctx.GradeReportPDF.build(data)
    assert.ok(doc && doc.getNumberOfPages() >= 1, name + ' produced a document')
    const bytes = Buffer.from(doc.output('arraybuffer'))
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', name + ' produced a valid PDF')
  }
})

test('build() rejects clearly when jsPDF itself is missing', async () => {
  const ctx = sandbox()
  // The delete has to happen inside the context: removing it from the outer sandbox object does not
  // reach the contextified global the module closed over.
  runInContext('delete window.jspdf; delete this.jspdf;', ctx)
  await assert.rejects(() => ctx.GradeReportPDF.build(fullData()), /jsPDF/)
})
