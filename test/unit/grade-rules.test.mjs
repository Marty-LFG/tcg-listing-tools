// Guards window.GradeRules — the pure grade-prediction engine behind the pre-grading tool.
// grade-rules.js is a browser classic-script that assigns window.GradeRules and touches only
// `window` at load, so a bare-object shim is enough (same idiom as label-render.test.mjs).
// Expectations that encode tolerances/weights are driven from the REAL data/grading.config.json,
// so editing a band or a cap updates the tests instead of silently diverging from them.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const src = readFileSync(new URL('../../grade-rules.js', import.meta.url), 'utf8')
const window = {}
new Function('window', src)(window)
const GR = window.GradeRules
const cfg = JSON.parse(readFileSync(new URL('../../data/grading.config.json', import.meta.url), 'utf8'))

// float-tolerant equality — the engine's weighted sums carry IEEE dust (8.600000000000001 etc.)
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} !~ ${b}`)

test('GradeRules loaded from the classic script', () => {
  assert.ok(GR && typeof GR.centeringPct === 'function' && typeof GR.predictCompany === 'function')
})

// ---------------------------------------------------------------- centeringPct

test('centeringPct: symmetric, off-centre and zero-sum borders', () => {
  const sym = GR.centeringPct({ l: 5, r: 5, t: 5, b: 5 })
  assert.equal(sym.worst, 50)
  assert.equal(sym.label, '50.0/50.0')   // one-decimal labels since the boundary audit

  const off = GR.centeringPct({ l: 6, r: 4, t: 5, b: 5 })
  close(off.lr, 60)
  close(off.tb, 50)
  close(off.worst, 60)             // worst axis is what caps the grade
  assert.equal(off.lrLabel, '60.0/40.0')  // physical order: left share first
  assert.equal(off.label, '60.0/40.0')

  // a zero-sum axis (border not measurable) degrades to a neutral 50, never NaN
  const zero = GR.centeringPct({ l: 0, r: 0, t: 3, b: 1 })
  close(zero.lr, 50)
  close(zero.tb, 75)

  assert.equal(GR.centeringPct(null), null)
})

// -------------------------------------------------------------- centeringGrade

test('centeringGrade: a worst-% exactly on a band boundary earns that band (<= semantics)', () => {
  for (const [co, bands] of Object.entries(cfg.centering)) {
    if (co.startsWith('_')) continue
    for (const band of bands) {
      // expected = the FIRST (best) band this % satisfies — matters where two bands share a
      // front tolerance (SGC lists 55 for both 10 and 9.5, so 55 earns the 10)
      const expected = bands.find(b => band.front <= b.front + 1e-9).grade
      assert.equal(GR.centeringGrade(co, band.front, null, cfg), expected, `${co} @ ${band.front}`)
    }
    // one past the loosest listed band falls a step below it, floored at 1
    const last = bands[bands.length - 1]
    assert.equal(GR.centeringGrade(co, last.front + 1, null, cfg), Math.max(1, last.grade - 1), `${co} past last band`)
  }
})

test('centeringGrade: the +1e-9 epsilon absorbs float noise sitting on the boundary', () => {
  const top = cfg.centering.PSA[0]
  assert.equal(GR.centeringGrade('PSA', top.front + 5e-10, null, cfg), top.grade)
})

test('centeringGrade: back constrains only when measured and only where the band lists it', () => {
  const psa = cfg.centering.PSA
  // a back worse than the top band's tolerance pushes down to the next band...
  assert.equal(GR.centeringGrade('PSA', psa[0].front, psa[0].back + 1, cfg), psa[1].grade)
  // ...but a null back (not photographed) never constrains
  assert.equal(GR.centeringGrade('PSA', psa[0].front, null, cfg), psa[0].grade)
  // a band WITHOUT a `back` key ignores even a terrible back (SGC used this shape before it
  // left the matrix for PCG, 2026-08-22; the mechanism outlives any one company's data)
  const backless = { centering: { X: [{ grade: 10, front: 55 }, { grade: 9, front: 60 }] } }
  assert.equal(GR.centeringGrade('X', 55, 99, backless), 10)
  // PCG's PUBLISHED bands: 10 and 9 share 55/60 on a worst-axis model, so a 56 front skips
  // both and lands on the 8.5 band — their top tiers separate on other pillars, not centering
  assert.equal(GR.centeringGrade('PCG', 55, 60, cfg), 10)
  assert.equal(GR.centeringGrade('PCG', 56, 60, cfg), 8.5)
  assert.equal(GR.centeringGrade('PCG', 55, 61, cfg), 8.5)  // back 61 fails 10 AND 9 (both cap at 60)
})

// -------------------------------------------------------------- pillarEffective

test('pillarEffective: back-null passthrough and the 0.6/0.4 blend, rounded to company step', () => {
  assert.equal(GR.pillarEffective(9.3, null, cfg.companies.PSA.step), 9)    // PSA whole steps
  assert.equal(GR.pillarEffective(9.3, null, cfg.companies.BGS.step), 9.5)  // BGS half steps
  // 9 front / 8 back -> 8.6 blended, then snapped to the grid
  assert.equal(GR.pillarEffective(9, 8, cfg.companies.PSA.step), 9)
  assert.equal(GR.pillarEffective(9, 8, cfg.companies.BGS.step), 8.5)
})

// -------------------------------------------------------------- predictCompany

test('predictCompany: weakest-link cap holds the final at lowest pillar + company cap', () => {
  const out = GR.predictCompany('PSA', { centering: 10, corners: 10, edges: 10, surface: 7 }, cfg, 0.9)
  const meta = cfg.companies.PSA
  const w = meta.pillarWeights
  const weighted = 10 * w.centering + 10 * w.corners + 10 * w.edges + 7 * w.surface
  const cap = 7 + meta.lowestPlusCap
  assert.ok(weighted > cap, 'fixture must weight above the cap so the cap decides')
  assert.equal(out.grade, GR.roundToStep(cap, meta.step))   // 8 with the shipped cap of 1
  close(out.raw, cap)
})

test('predictCompany: companies without a 9.5 collapse a 9.x result to 9', () => {
  // TAG runs a half-point step but lists no 9.5 — all-9.5 pillars land raw 9.5,
  // which must collapse DOWN to 9, not round up to 10
  assert.equal(cfg.companies.TAG.has95, false)
  const tag = GR.predictCompany('TAG', { centering: 9.5, corners: 9.5, edges: 9.5, surface: 9.5 }, cfg, 0.9)
  assert.equal(tag.raw, 9.5)
  assert.equal(tag.grade, 9)
  // PSA's whole-point step already rounds 9.4 to 9 before the collapse is needed
  const psa = GR.predictCompany('PSA', { centering: 9.4, corners: 9.4, edges: 9.4, surface: 9.4 }, cfg, 0.9)
  assert.equal(psa.raw, 9.4)
  assert.equal(psa.grade, 9)
})

test('predictCompany: BGS carries subgrades and anchors the final to lowest subgrade + 2', () => {
  const out = GR.predictCompany('BGS', { centering: 9.5, corners: 6, edges: 9.5, surface: 9.5 }, cfg, 0.9)
  assert.deepEqual(out.subgrades, { centering: 9.5, corners: 6, edges: 9.5, surface: 9.5 })
  assert.ok(out.grade <= 6 + 2)
  const w = cfg.companies.BGS.pillarWeights
  const weighted = 9.5 * w.centering + 6 * w.corners + 9.5 * w.edges + 9.5 * w.surface
  const capped = Math.min(weighted, 6 + cfg.companies.BGS.lowestPlusCap)
  assert.equal(out.grade, GR.roundToStep(Math.min(capped, 6 + 2), 0.5))   // 8 with the shipped config
  // non-BGS predictions carry no subgrades
  assert.equal('subgrades' in GR.predictCompany('PSA', { centering: 9, corners: 9, edges: 9, surface: 9 }, cfg, 0.9), false)
})

test('predictCompany: BGS label ladder — Black needs all four 10s, Gold a 10 final over a lesser sub', () => {
  const black = GR.predictCompany('BGS', { centering: 10, corners: 10, edges: 10, surface: 10 }, cfg, 0.9)
  assert.equal(black.grade, 10)
  assert.equal(black.gradeLabel, 'Pristine 10 · Black Label')
  // a lone 9.5 surface still weights up to a 10 final -> Gold, not Black
  const gold = GR.predictCompany('BGS', { centering: 10, corners: 10, edges: 10, surface: 9.5 }, cfg, 0.9)
  assert.equal(gold.grade, 10)
  assert.equal(gold.gradeLabel, 'Pristine 10 · Gold Label')
  const gem = GR.predictCompany('BGS', { centering: 9.5, corners: 9.5, edges: 9.5, surface: 9.5 }, cfg, 0.9)
  assert.equal(gem.grade, 9.5)
  assert.equal(gem.gradeLabel, 'Gem Mint')
})

// ---------------------------------------------------------------- distribution

test('distribution: <4% tail is filtered and NOT renormalized; low confidence flattens the peak', () => {
  const pillars = { centering: 8, corners: 8, edges: 8, surface: 8 }
  const sure = GR.predictCompany('PSA', pillars, cfg, 0.95)
  const unsure = GR.predictCompany('PSA', pillars, cfg, 0.1)
  for (const out of [sure, unsure]) {
    const sum = out.probabilities.reduce((a, x) => a + x.p, 0)
    // the p>=0.04 filter drops tail candidates without redistributing their mass,
    // so the shown probabilities sum a little UNDER 1 — that is the intended behavior
    assert.ok(sum > 0.9 && sum < 1, `sum ${sum}`)
    assert.ok(out.probabilities.every(x => x.p >= 0.04))
    for (let i = 1; i < out.probabilities.length; i++)
      assert.ok(out.probabilities[i - 1].p >= out.probabilities[i].p, 'sorted most-likely first')
  }
  assert.equal(sure.probabilities[0].grade, 8)
  assert.equal(unsure.probabilities[0].grade, 8)
  assert.ok(sure.probabilities[0].p > unsure.probabilities[0].p)
  // per-company confidence label follows the peak probability
  assert.equal(sure.confidence, 'high')
  assert.equal(unsure.confidence, 'medium')
})

// -------------------------------------------------------------------- tagScore

test('tagScore: TAG-only, grade x 100, clamped 100..1000', () => {
  const ten = GR.predictCompany('TAG', { centering: 10, corners: 10, edges: 10, surface: 10 }, cfg, 0.9)
  assert.equal(ten.grade, 10)
  assert.equal(ten.tagScore, 1000)
  const one = GR.predictCompany('TAG', { centering: 1, corners: 1, edges: 1, surface: 1 }, cfg, 0.9)
  assert.equal(one.tagScore, 100)
  assert.equal('tagScore' in GR.predictCompany('PSA', { centering: 10, corners: 10, edges: 10, surface: 10 }, cfg, 0.9), false)
})

// -------------------------------------------------------------- gradeEconomics

test('gradeEconomics: string-keyed values resolve for half and whole grades; 13% default fee', () => {
  const pred = { probabilities: [{ grade: 9.5, p: 0.5 }, { grade: 10, p: 0.5 }] }
  const out = GR.gradeEconomics(pred, { '9.5': 100, '10': 400 }, 50, 20)
  assert.ok(out.ok)
  close(out.expectedValue, 0.5 * 100 * 0.87 + 0.5 * 400 * 0.87)   // marketplaceFeePct defaults to 13
  close(out.netRawValue, 20 * 0.87)
  close(out.profitVsRaw, out.expectedValue - 50 - out.netRawValue)
  close(out.roi, out.expectedValue / 50)
  // an explicit 0% is honoured, not mistaken for "use the default"
  const noFee = GR.gradeEconomics(pred, { '9.5': 100, '10': 400 }, 50, 20, 0)
  close(noFee.expectedValue, 250)
  close(noFee.netRawValue, 20)
})

test('gradeEconomics: degrades to ok:false when no predicted grade has a comp', () => {
  const out = GR.gradeEconomics({ probabilities: [{ grade: 9, p: 1 }] }, {}, 50, 20)
  assert.equal(out.ok, false)
  assert.ok(out.reason)
})

test("gradeEconomics: verdict thresholds — >=70 Submit, <50 Don't grade, else Borderline", () => {
  const one = g => ({ probabilities: [{ grade: g, p: 1 }] })
  const submit = GR.gradeEconomics(one(10), { '10': 400 }, 50, 0)
  assert.equal(submit.verdict, 'Submit')
  assert.ok(submit.capitalScore >= 70)
  const dont = GR.gradeEconomics(one(9), { '9': 10 }, 50, 0)
  assert.equal(dont.verdict, "Don't grade")
  assert.ok(dont.capitalScore < 50)
  const border = GR.gradeEconomics(one(10), { '10': 80 }, 50, 0)   // lands score 60
  assert.equal(border.verdict, 'Borderline')
  assert.ok(border.capitalScore >= 50 && border.capitalScore < 70)
})

// --------------------------------------------- sideFromCorners / sideFromEdges

test('sideFromCorners / sideFromEdges: min drives value (worst corner grades), mean is display-only', () => {
  assert.equal(GR.sideFromCorners(null), null)
  assert.equal(GR.sideFromCorners({ tl: null, tr: null, bl: null, br: null }), null)
  assert.deepEqual(GR.sideFromCorners({ tl: 9 }), { value: 9, mean: 9, count: 1 })
  assert.deepEqual(GR.sideFromCorners({ tl: 9, tr: 10, bl: null, br: 8 }), { value: 8, mean: 9, count: 3 })
  assert.equal(GR.sideFromEdges(null), null)
  assert.equal(GR.sideFromEdges({ top: null, right: null, bottom: null, left: null }), null)
  assert.deepEqual(GR.sideFromEdges({ top: 10, right: 9.5, bottom: null, left: null }), { value: 9.5, mean: 9.75, count: 2 })
  assert.deepEqual(GR.sideFromEdges({ top: 7, right: 8, bottom: 9, left: 10 }), { value: 7, mean: 8.5, count: 4 })
})

// ---------------------------------- centering percentages sum to 100 (property)
// LOCKS the owner's spec: "centering must be a percentage adding to 100 based on the
// thickness L/R, T/B." Numerics: each axis reports larger-side% = max/(l+r or t+b) * 100.
// Labels (post-audit): AXIS labels are PHYSICAL order at one decimal — left/top share first,
// so "L/R 40.0/60.0" means the left border is the thin one — while the WORST label stays
// larger-side-first, the way tolerances are quoted ("55/45 or better").
import { describe } from 'node:test' // hoisted by ESM — declared here to keep the file append-only

describe('centering percentages sum to 100 (property)', () => {
  const GRID = [0.5, 1, 2, 2.3, 2.5, 3.7, 5, 6.2, 9.3, 12]

  const d1 = (x) => Math.round(x * 10) / 10

  // "40.0/60.0" -> [40, 60]; fails loudly on anything that is not 1dp/1dp
  function parseLabel(label, tag) {
    const m = /^(\d+(?:\.\d)?)\/(\d+(?:\.\d)?)$/.exec(label)
    assert.ok(m, `${tag}: label ${JSON.stringify(label)} must be one-decimal/one-decimal`)
    return [Number(m[1]), Number(m[2])]
  }

  function checkAxis(pct, label, first, second, tag) {
    close(pct, Math.max(first, second) / (first + second) * 100, `${tag}: pct ${pct}`)
    assert.ok(pct >= 50, `${tag}: larger-side % ${pct} is never under 50`)
    const [a, b] = parseLabel(label, tag)
    assert.ok(Math.abs(a + b - 100) < 1e-9, `${tag}: label ${label} must sum to 100`)
    // physical order: the first number is the LEFT (or TOP) border's share
    close(a, d1(first / (first + second) * 100), `${tag}: label ${label} first number is the l/t share`)
  }

  test('sweep: every (l,r) x (t,b) grid combo yields max/sum axes and 100-sum physical labels', () => {
    for (const l of GRID) for (const r of GRID) for (const t of GRID) for (const b of GRID) {
      const out = GR.centeringPct({ l, r, t, b })
      const tag = `l=${l} r=${r} t=${t} b=${b}`
      checkAxis(out.lr, out.lrLabel, l, r, tag)
      checkAxis(out.tb, out.tbLabel, t, b, tag)
      assert.equal(out.worst, Math.max(out.lr, out.tb), `${tag}: worst is the max axis`)
      // worst label is larger-side-first and belongs to the axis worstAxis names
      const [hi, lo] = parseLabel(out.label, tag + ' worst')
      assert.ok(Math.abs(hi + lo - 100) < 1e-9, `${tag}: worst label sums to 100`)
      close(hi, d1(out.worst), `${tag}: worst label leads with the worst percentage`)
      assert.equal(out.worstAxis, out.lr >= out.tb ? 'L/R' : 'T/B', `${tag}: worstAxis names the max axis`)
    }
  })

  test('anchors: 6/4 leads left; 4/6 flips the axis label but not the worst; near-50 shows its decimal', () => {
    const a = GR.centeringPct({ l: 6, r: 4, t: 5, b: 5 })
    close(a.lr, 60) // exactly 60, not 60-ish
    assert.equal(a.lrLabel, '60.0/40.0')   // left is the fat side, physical = worst-first here

    const flipped = GR.centeringPct({ l: 4, r: 6, t: 5, b: 5 })
    close(flipped.lr, 60)                  // same magnitude of off-centre…
    assert.equal(flipped.lrLabel, '40.0/60.0') // …but the label shows WHICH side is thin
    assert.equal(flipped.label, '60.0/40.0')   // while the worst quote stays larger-side-first
    assert.equal(flipped.worstAxis, 'L/R')

    const b = GR.centeringPct({ l: 5, r: 5, t: 2.3, b: 2.5 })
    close(b.tb, 2.5 / 4.8 * 100) // 52.083…
    assert.equal(b.tbLabel, '47.9/52.1')   // top share first, physical order

    const c = GR.centeringPct({ l: 7.0, r: 7.1, t: 5, b: 5 })
    close(c.lr, 7.1 / 14.1 * 100) // 50.354…
    assert.equal(c.lrLabel, '49.6/50.4')   // one decimal keeps the not-quite-centred visible
  })

  test('degenerates: zero-sum axis is a neutral 50; one-sided is 100/0; negatives clamp to 0', () => {
    const zz = GR.centeringPct({ l: 0, r: 0, t: 0, b: 0 })
    close(zz.lr, 50)
    close(zz.tb, 50)
    assert.equal(zz.label, '50.0/50.0')

    const oneSided = GR.centeringPct({ l: 0, r: 3, t: 5, b: 5 })
    close(oneSided.lr, 100)
    assert.equal(oneSided.lrLabel, '0.0/100.0') // physical: the LEFT border is the missing one
    assert.equal(oneSided.label, '100.0/0.0')

    // negative thickness clamps to 0 — a public-API caller can no longer coax out "125/-25"
    const neg = GR.centeringPct({ l: -1, r: 5, t: 5, b: 5 })
    close(neg.lr, 100)
    assert.equal(neg.lrLabel, '0.0/100.0')
  })

  test('unit invariance: the same borders in px, mm or any consistent unit give identical percentages', () => {
    const K = 3.7
    for (const l of GRID) for (const r of GRID) {
      const base = GR.centeringPct({ l, r, t: r, b: l })
      const scaled = GR.centeringPct({ l: l * K, r: r * K, t: r * K, b: l * K })
      const tag = `l=${l} r=${r} x${K}`
      close(base.lr, scaled.lr, `${tag}: lr`)
      close(base.tb, scaled.tb, `${tag}: tb`)
      close(base.worst, scaled.worst, `${tag}: worst`)
      assert.equal(base.label, scaled.label, `${tag}: label`)
    }
  })

  test('rounding boundary FIXED: 54.5 and 55.4 now display differently, matching their grades', () => {
    // Before the audit, integer labels showed BOTH of these as "55/45" while centeringGrade
    // (which consumes the unrounded worst) put them in different bands. One-decimal labels
    // make the digit the decision uses visible; residual divergence shrinks to the second
    // decimal (55.04 shows "55.0" and barely fails <=55), which is beneath measurement noise.
    const justUnder = GR.centeringPct({ l: 54.5, r: 45.5, t: 50, b: 50 }) // worst 54.5 (+IEEE dust)
    const justOver = GR.centeringPct({ l: 55.4, r: 44.6, t: 50, b: 50 }) // worst 55.4 (-IEEE dust)
    close(justUnder.worst, 54.5)
    close(justOver.worst, 55.4)
    assert.equal(justUnder.label, '54.5/45.5')
    assert.equal(justOver.label, '55.4/44.6')
    assert.notEqual(justUnder.label, justOver.label, 'different grades must not share a display')
    const psa = cfg.centering.PSA
    assert.equal(psa[0].front, 55, 'boundary anchor assumes the shipped PSA top band of 55')
    assert.equal(GR.centeringGrade('PSA', justUnder.worst, null, cfg), psa[0].grade) // 54.5 passes 55
    assert.equal(GR.centeringGrade('PSA', justOver.worst, null, cfg), psa[1].grade) // 55.4 falls to the next band
  })

  test('no-measurement guards: null front is null out, never a passing grade', () => {
    assert.equal(GR.centeringGrade('PSA', null, null, cfg), null)
    assert.equal(GR.predictAll(null, cfg), null)
    assert.equal(GR.predictAll({ centeringFrontWorst: null, corners: { front: 9 }, edges: { front: 9 }, surface: { front: 9 } }, cfg), null)
  })
})
