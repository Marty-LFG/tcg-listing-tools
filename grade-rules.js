/* grade-rules.js — pure, transparent grade-prediction engine, shared by the pre-grading tool.
   Loaded like extras.js (<script src="/grade-rules.js">) and attaches window.GradeRules.

   Inputs are the four pillars (centering, corners, edges, surface), scored front AND back.
   Centering comes from a geometric measurement (most reliable); corners/edges/surface come
   from an AI vision pass (advisory). Everything is driven by data/grading.config.json so the
   tolerances and weights are editable, never hardcoded into logic.

   This is an ESTIMATE. The real algorithms (esp. BGS's weighted subgrade combination) are
   proprietary; what follows is a documented approximation, not the companies' actual math. */
(function () {
  'use strict';
  var GR = (window.GradeRules = window.GradeRules || {});

  // round a value to a company's grade step (1 for PSA, 0.5 otherwise), clamped 1..10
  function roundToStep(v, step) {
    step = step || 0.5;
    var r = Math.round(v / step) * step;
    return Math.max(1, Math.min(10, Math.round(r * 100) / 100));
  }
  GR.roundToStep = roundToStep;

  // larger-side percentage on each axis from raw border widths {l,r,t,b} (any unit).
  // Returns the worst (most off-centre) axis as `worst` — that's what caps the grade.
  // Labels: the AXIS labels are physical order (left/top share first) so they read true against
  // a physical T/B/L/R mm line; the WORST label is larger-side-first, the way tolerances are
  // quoted ("55/45 or better"). One decimal everywhere — integer display rounded 54.5 and 55.4
  // to the same "55/45" while the bands graded them differently, and the human must see the
  // digit the decision used.
  GR.centeringPct = function (b) {
    if (!b) return null;
    var l = Math.max(0, b.l), r = Math.max(0, b.r), t = Math.max(0, b.t), bo = Math.max(0, b.b);
    var lr = (l + r) > 0 ? (Math.max(l, r) / (l + r)) * 100 : 50;
    var tb = (t + bo) > 0 ? (Math.max(t, bo) / (t + bo)) * 100 : 50;
    var lShare = (l + r) > 0 ? (l / (l + r)) * 100 : 50;
    var tShare = (t + bo) > 0 ? (t / (t + bo)) * 100 : 50;
    function fmt1(hi) { var h = Math.round(hi * 10) / 10; var lo = Math.round((100 - h) * 10) / 10; return h.toFixed(1) + '/' + lo.toFixed(1); }
    var worst = Math.max(lr, tb);
    return {
      lr: lr, tb: tb, worst: worst,
      lrLabel: fmt1(lShare), tbLabel: fmt1(tShare),
      label: fmt1(worst),
      worstAxis: lr >= tb ? 'L/R' : 'T/B'
    };
  };

  // Which band the measurement landed in, AND the tighter one it just missed. centeringGrade says
  // what grade centering allows; this says why, so a caller can print "10 wants <= 55 front" off the
  // SAME ladder walk. A second, independent walk is exactly how the old hardcoded 55/60 pills drifted
  // away from the editable config (docs/PRE_GRADING_PLAN.md, centering-math audit).
  // backWorst may be null (back not photographed / a front-only company) -> back is not constrained.
  // frontWorst null means NO measurement — that is null out, never a passing grade.
  GR.centeringBand = function (company, frontWorst, backWorst, cfg) {
    if (frontWorst == null) return null;
    var bands = ((cfg || {}).centering || {})[company] || [];
    function frontFits(band) { return frontWorst <= band.front + 1e-9; }
    function backFits(band) { return band.back == null || backWorst == null || backWorst <= band.back + 1e-9; }
    for (var i = 0; i < bands.length; i++) {
      if (!frontFits(bands[i]) || !backFits(bands[i])) continue;
      var missed = i > 0 ? bands[i - 1] : null;   // null at the top band: nothing better to reach
      return {
        grade: bands[i].grade, band: bands[i], index: i, missed: missed,
        missedFront: missed ? !frontFits(missed) : false,
        missedBack: missed ? !backFits(missed) : false
      };
    }
    // Worse than the lowest listed band -> fall a step below the last band's grade.
    var last = bands[bands.length - 1];
    if (!last) return { grade: 5, band: null, index: -1, missed: null, missedFront: false, missedBack: false };
    return {
      grade: Math.max(1, last.grade - 1), band: null, index: bands.length, missed: last,
      missedFront: !frontFits(last), missedBack: !backFits(last)
    };
  };

  // The ONE phrasing of "what the next band up would take", over a centeringBand hit — e.g.
  // "10 wants <= 55.0 front". Shared by every surface that shows a centering cap (the dashboard
  // rows, the grader's pill, the printed report) so the two screens and the paper cannot word the
  // same fact differently. null means the top band was already cleared: there is nothing to want,
  // and each caller decides how to say so.
  // `le` overrides the "<=" glyph. The screens pass U+2264; the PDF must NOT — jsPDF's core fonts
  // are WinAnsi, which has no math operators, so a real "<=" sign prints as rubbish.
  GR.centeringWants = function (hit, le) {
    if (!hit || !hit.missed) return null;
    var op = le == null ? '≤' : le;
    var bits = [];
    if (hit.missedFront) bits.push(op + ' ' + hit.missed.front.toFixed(1) + ' front');
    if (hit.missedBack && hit.missed.back != null) bits.push(op + ' ' + hit.missed.back.toFixed(1) + ' back');
    if (!bits.length) return null;
    var g = hit.missed.grade;
    return (g % 1 === 0 ? String(g) : g.toFixed(1)) + ' wants ' + bits.join(' + ');
  };

  // Highest grade whose centering tolerance the measured worst-axis % satisfies (<= band).
  GR.centeringGrade = function (company, frontWorst, backWorst, cfg) {
    var hit = GR.centeringBand(company, frontWorst, backWorst, cfg);
    return hit ? hit.grade : null;
  };

  // Effective per-pillar subgrade from front + back (front weighted heavier — AGS uses 0.6/0.4).
  GR.pillarEffective = function (front, back, step) {
    if (back == null) return roundToStep(front, step || 0.5);
    return roundToStep(front * 0.6 + back * 0.4, step || 0.5);
  };

  // Collapse a per-corner AI reading into one pillar input (companion to the per-corner schema).
  // Each of the four values is 1-10 or null/undefined (= not assessable in the photo). Grading
  // companies subgrade to the WORST corner/edge, so `value` is the min of the non-null readings;
  // `mean` is display-only context and `count` says how many were readable. All null -> null so
  // the caller can degrade to its single-number path instead of inventing a grade.
  function sideFromParts(parts, keys) {
    if (!parts) return null;
    var vals = [];
    for (var i = 0; i < keys.length; i++) {
      var v = parts[keys[i]];
      if (v != null) vals.push(v);
    }
    if (!vals.length) return null;
    var sum = 0;
    for (var j = 0; j < vals.length; j++) sum += vals[j];
    return { value: Math.min.apply(null, vals), mean: sum / vals.length, count: vals.length };
  }
  GR.sideFromCorners = function (c) { return sideFromParts(c, ['tl', 'tr', 'bl', 'br']); };
  GR.sideFromEdges = function (e) { return sideFromParts(e, ['top', 'right', 'bottom', 'left']); };

  // BGS-style label from the final grade + the four subgrades.
  function bgsLabel(grade, subs) {
    if (grade >= 10 && subs && subs.centering >= 10 && subs.corners >= 10 && subs.edges >= 10 && subs.surface >= 10)
      return 'Pristine 10 · Black Label';
    if (grade >= 10) return 'Pristine 10 · Gold Label';
    if (grade >= 9.5) return 'Gem Mint';
    if (grade >= 9) return 'Mint';
    if (grade >= 8.5) return 'NM-MT+';
    if (grade >= 8) return 'NM-MT';
    if (grade >= 7) return 'NM';
    return 'EX or below';
  }

  function genericLabel(company, grade) {
    if (grade >= 10) return company === 'PSA' ? 'Gem Mint' : (company === 'TAG' ? 'Pristine 10' : 'Pristine 10');
    if (grade >= 9.5) return 'Gem Mint+';
    if (grade >= 9) return 'Mint';
    if (grade >= 8) return 'NM-MT';
    if (grade >= 7) return 'NM';
    if (grade >= 6) return 'EX-MT';
    return 'EX or below';
  }

  // Probability distribution over the candidate grades nearest the continuous `raw` score.
  // sigma widens as confidence drops, flattening the distribution (honest uncertainty).
  function distribution(raw, step, has95, confidence) {
    var sigma = 0.32 + (1 - clamp01(confidence)) * 0.6; // 0.32 (sure) .. ~0.92 (unsure)
    // candidate grades: a small window around raw, on the company's step grid
    var cands = [];
    var lo = Math.max(1, roundToStep(raw - step * 2, step));
    var hi = Math.min(10, roundToStep(raw + step * 2, step));
    for (var g = lo; g <= hi + 1e-9; g += step) {
      var gg = Math.round(g * 100) / 100;
      if (!has95 && gg > 9 && gg < 10) continue; // PSA/TAG: no 9.5
      cands.push(gg);
    }
    if (!cands.length) cands = [roundToStep(raw, step)];
    var weights = cands.map(function (g) {
      var d = (g - raw) / sigma;
      return Math.exp(-0.5 * d * d);
    });
    var sum = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
    return cands.map(function (g, i) { return { grade: g, p: weights[i] / sum }; })
      .filter(function (x) { return x.p >= 0.04; })
      .sort(function (a, b) { return b.p - a.p; });
  }

  function clamp01(x) { return x == null ? 0.6 : Math.max(0, Math.min(1, x)); }

  // Some companies award more than one KIND of 10 (PCG: Gem Mint -> Pristine -> Flawless).
  // The tier is a LABEL refinement over a final grade of 10, driven by the company's published
  // centering requirements (ctx carries the measured worst-axis %s) and, for the top tier,
  // quad-10 subgrades. Tiers are config data (tenTiers, best first), never hardcoded here.
  // A tier can demand centering (front/back caps — PCG publishes these), subgrades (quadTen,
  // or minTenSubs + minOtherSub — Beckett's ladder), or both. A tier that demands a FRONT
  // measurement nobody supplied is refused, never guessed; an unmeasured BACK is unconstrained,
  // the same convention centeringGrade uses everywhere else.
  function tenTierLabel(meta, grade, subgrades, ctx) {
    if (!(grade >= 10) || !meta.tenTiers) return null;
    for (var i = 0; i < meta.tenTiers.length; i++) {
      var t = meta.tenTiers[i];
      var frontOk = t.front == null || (ctx && ctx.frontWorst != null && ctx.frontWorst <= t.front + 1e-9);
      var backOk = t.back == null || ctx == null || ctx.backWorst == null || ctx.backWorst <= t.back + 1e-9;
      var subsOk = true;
      if (t.quadTen || t.minTenSubs) {
        if (!subgrades) subsOk = false;
        else {
          var arr = [subgrades.centering, subgrades.corners, subgrades.edges, subgrades.surface];
          var tens = arr.filter(function (v) { return v >= 10; }).length;
          var minSub = Math.min.apply(null, arr);
          subsOk = t.quadTen ? tens === 4
            : (tens >= t.minTenSubs && minSub >= (t.minOtherSub == null ? 0 : t.minOtherSub));
        }
      }
      if (frontOk && backOk && subsOk) return t.label;
    }
    return null;
  }

  // Published subgrade-combination gates (config gradeGates): Beckett's final 10 requires
  // three 10 subgrades with the fourth no lower than 9.5, and a Gem Mint 9.5 requires three
  // 9.5s with the fourth no lower than 9 — a weighted average alone can award grades the
  // company's own rules refuse. Gates run best-first so a demotion cascades honestly.
  function applyGradeGates(meta, grade, subgrades, step) {
    if (!meta.gradeGates || !subgrades) return grade;
    var arr = [subgrades.centering, subgrades.corners, subgrades.edges, subgrades.surface];
    var gates = meta.gradeGates.slice().sort(function (a, b) { return b.grade - a.grade; });
    for (var i = 0; i < gates.length; i++) {
      var g = gates[i];
      if (grade < g.grade) continue;
      var n = arr.filter(function (v) { return v >= g.at; }).length;
      var min = Math.min.apply(null, arr);
      if (!(n >= g.need && min >= (g.othersAt == null ? 0 : g.othersAt))) grade = roundToStep(g.grade - step, step);
    }
    return grade;
  }

  // Four subgrades or none: a slab prints all four, so a partial assessment yields no subgrades.
  function subgradesOf(pillars, step) {
    var k = ['centering', 'corners', 'edges', 'surface'];
    for (var i = 0; i < k.length; i++) if (pillars[k[i]] == null) return null;
    return {
      centering: roundToStep(pillars.centering, step), corners: roundToStep(pillars.corners, step),
      edges: roundToStep(pillars.edges, step), surface: roundToStep(pillars.surface, step)
    };
  }

  // Per-pillar -> a single company's prediction.
  // pillars = { centering, corners, edges, surface } as numeric grades (1..10).
  // confidence 0..1 is the overall input confidence (AI + centering certainty).
  // ctx (optional) = { frontWorst, backWorst } — the measured centering %s, needed only by
  // companies whose 10 has tiers (see tenTierLabel).
  GR.predictCompany = function (company, pillars, cfg, confidence, ctx) {
    var meta = (cfg.companies || {})[company] || { step: 0.5, lowestPlusCap: 1, has95: true, pillarWeights: {} };
    var step = meta.step || 0.5;
    var w = meta.pillarWeights || { centering: 0.3, corners: 0.3, edges: 0.2, surface: 0.2 };
    // A null pillar means NOBODY LOOKED — a card scanned front-only, or an AI pass that answered
    // "cannot see that corner". Treating it as a 9 (the slider's resting position) invents 30% of
    // the grade out of nothing, in the expensive direction. Drop it and renormalise the rest, so
    // the prediction is honestly "what the assessed pillars support" rather than a fabrication.
    var KEYS = ['centering', 'corners', 'edges', 'surface'];
    var assessed = KEYS.filter(function (k) { return pillars[k] != null; });
    if (!assessed.length) return null;
    var wSum = assessed.reduce(function (a, k) { return a + (w[k] || 0); }, 0) || 1;
    var vals = assessed.map(function (k) { return pillars[k]; });
    var lowest = Math.min.apply(null, vals);
    var weighted = assessed.reduce(function (a, k) { return a + pillars[k] * (w[k] || 0); }, 0) / wSum;
    // weakest-link cap: final rarely exceeds lowest + companyCap (PSA ~1, BGS ~2).
    var cap = lowest + (meta.lowestPlusCap == null ? 1 : meta.lowestPlusCap);
    var raw = Math.min(weighted, cap);
    var grade = roundToStep(raw, step);
    if (!meta.has95) { if (grade > 9 && grade < 10) grade = 9; } // PSA/TAG binary 9/10

    var subgrades = null, label;
    if (company === 'BGS') {
      subgrades = subgradesOf(pillars, 0.5);
      // A slab carries four subgrades, so a partial assessment cannot produce one. Anchoring and
      // the published gates both need the full set; without it, only the weighted grade stands.
      if (subgrades) {
        // BGS final is anchored by the lowest subgrade (and rarely > lowest + 2).
        var bgsLow = Math.min(subgrades.centering, subgrades.corners, subgrades.edges, subgrades.surface);
        grade = roundToStep(Math.min(grade, bgsLow + 2), 0.5);
        grade = applyGradeGates(meta, grade, subgrades, 0.5);
      }
      label = tenTierLabel(meta, grade, subgrades, ctx) || bgsLabel(grade, subgrades);
    } else {
      // any other slab that PRINTS subgrades (PCG, TAG) gets them in the prediction too —
      // no extra anchoring, that formula is BGS's own
      if (meta.subgradesOnSlab) subgrades = subgradesOf(pillars, 0.5);
      if (subgrades) grade = applyGradeGates(meta, grade, subgrades, step);
      label = tenTierLabel(meta, grade, subgrades, ctx) || genericLabel(company, grade);
    }

    var dist = distribution(raw, step, meta.has95, confidence);
    // per-company confidence: lower near a grade boundary (the .5 line) and with flat distros
    var topP = dist.length ? dist[0].p : 0.5;
    var confLevel = topP >= 0.66 ? 'high' : topP >= 0.45 ? 'medium' : 'low';

    var out = {
      company: company,
      grade: grade,
      gradeLabel: label,
      raw: Math.round(raw * 100) / 100,
      probabilities: dist,
      confidence: confLevel,
      pillars: {
        centering: pillars.centering == null ? null : roundToStep(pillars.centering, step),
        corners: pillars.corners == null ? null : roundToStep(pillars.corners, step),
        edges: pillars.edges == null ? null : roundToStep(pillars.edges, step),
        surface: pillars.surface == null ? null : roundToStep(pillars.surface, step)
      },
      assessed: assessed.slice(),                       // which pillars actually had a value
      partial: assessed.length < KEYS.length            // the report must say so out loud
    };
    if (subgrades) out.subgrades = subgrades;
    if (company === 'TAG') out.tagScore = Math.max(100, Math.min(1000, Math.round(grade * 100))); // 1st digit ~ grade
    return out;
  };

  // Full prediction across every company in the config.
  // input = {
  //   centeringFrontWorst, centeringBackWorst,  // larger-side % (back may be null)
  //   corners:{front,back}, edges:{front,back}, surface:{front,back},  // AI condition 1..10
  //   confidence  // 0..1 overall
  // }
  GR.predictAll = function (input, cfg) {
    if (input == null || input.centeringFrontWorst == null) return null; // measure first — a missing front is not a 10
    var conf = input.confidence == null ? 0.6 : input.confidence;
    var companies = Object.keys(cfg.companies || {});
    var perCompany = {};
    companies.forEach(function (co) {
      var step = (cfg.companies[co] || {}).step || 0.5;
      var centerGrade = GR.centeringGrade(co, input.centeringFrontWorst, input.centeringBackWorst, cfg);
      // null in, null through: pillarEffective must not turn "not assessed" into a number
      function eff(p) {
        if (!p || (p.front == null && p.back == null)) return null;
        return GR.pillarEffective(p.front == null ? p.back : p.front, p.front == null ? null : p.back, step);
      }
      var pillars = {
        centering: centerGrade,
        corners: eff(input.corners), edges: eff(input.edges), surface: eff(input.surface)
      };
      perCompany[co] = GR.predictCompany(co, pillars, cfg, conf,
        { frontWorst: input.centeringFrontWorst, backWorst: input.centeringBackWorst });
    });
    return { perCompany: perCompany };
  };

  // "Should I grade this?" economics for one company, given value-at-grade lookups (in AUD or any
  // single currency — keep consistent). values = { '10':n, '9':n, '9.5':n, raw:n }. fee in same unit.
  // Returns expected value, ROI ratio and a 0-100 capital score + verdict.
  GR.gradeEconomics = function (prediction, values, fee, rawValue, marketplaceFeePct) {
    var mkt = (marketplaceFeePct == null ? 13 : marketplaceFeePct) / 100;
    var dist = prediction.probabilities || [];
    var ev = 0, haveAny = false;
    dist.forEach(function (d) {
      var key = String(d.grade);
      var v = values[key];
      if (v == null && d.grade === 10) v = values['10'];
      if (v == null) return;
      haveAny = true;
      ev += d.p * v * (1 - mkt);
    });
    if (!haveAny) return { ok: false, reason: 'no graded comps for predicted grades' };
    var netRaw = (rawValue || 0) * (1 - mkt);
    var profit = ev - fee - netRaw;       // vs selling raw today
    var roi = fee > 0 ? ev / fee : null;
    // capital score: scale profit into 0..100 with a soft curve
    var score = Math.round(Math.max(0, Math.min(100, 50 + (profit / Math.max(20, fee)) * 25)));
    var verdict = score >= 70 ? 'Submit' : score < 50 ? "Don't grade" : 'Borderline';
    return {
      ok: true, expectedValue: ev, profitVsRaw: profit, roi: roi,
      capitalScore: score, verdict: verdict, fee: fee, netRawValue: netRaw
    };
  };

})();
