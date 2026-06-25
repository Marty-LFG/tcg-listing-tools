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
  GR.centeringPct = function (b) {
    if (!b) return null;
    var lr = (b.l + b.r) > 0 ? (Math.max(b.l, b.r) / (b.l + b.r)) * 100 : 50;
    var tb = (b.t + b.b) > 0 ? (Math.max(b.t, b.b) / (b.t + b.b)) * 100 : 50;
    function fmt(x) { var hi = Math.round(x); return hi + '/' + (100 - hi); }
    return {
      lr: lr, tb: tb,
      worst: Math.max(lr, tb),
      lrLabel: fmt(lr), tbLabel: fmt(tb),
      label: fmt(Math.max(lr, tb))
    };
  };

  // Highest grade whose centering tolerance the measured worst-axis % satisfies (<= band).
  // backWorst may be null (back not photographed / SGC front-only) -> back is not constrained.
  GR.centeringGrade = function (company, frontWorst, backWorst, cfg) {
    var bands = (cfg.centering || {})[company] || [];
    for (var i = 0; i < bands.length; i++) {
      var band = bands[i];
      var frontOk = frontWorst == null || frontWorst <= band.front + 1e-9;
      var backOk = band.back == null || backWorst == null || backWorst <= band.back + 1e-9;
      if (frontOk && backOk) return band.grade;
    }
    // Worse than the lowest listed band -> fall a step below the last band's grade.
    var last = bands[bands.length - 1];
    return last ? Math.max(1, last.grade - 1) : 5;
  };

  // Effective per-pillar subgrade from front + back (front weighted heavier — AGS uses 0.6/0.4).
  GR.pillarEffective = function (front, back, step) {
    if (back == null) return roundToStep(front, step || 0.5);
    return roundToStep(front * 0.6 + back * 0.4, step || 0.5);
  };

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
      if (!has95 && gg % 1 === 0.5 && gg > 8.5) continue; // no half grades above 8.5 for whole-step-ish
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

  // Per-pillar -> a single company's prediction.
  // pillars = { centering, corners, edges, surface } as numeric grades (1..10).
  // confidence 0..1 is the overall input confidence (AI + centering certainty).
  GR.predictCompany = function (company, pillars, cfg, confidence) {
    var meta = (cfg.companies || {})[company] || { step: 0.5, lowestPlusCap: 1, has95: true, pillarWeights: {} };
    var step = meta.step || 0.5;
    var w = meta.pillarWeights || { centering: 0.3, corners: 0.3, edges: 0.2, surface: 0.2 };
    var vals = [pillars.centering, pillars.corners, pillars.edges, pillars.surface];
    var lowest = Math.min.apply(null, vals);
    var weighted = pillars.centering * w.centering + pillars.corners * w.corners +
      pillars.edges * w.edges + pillars.surface * w.surface;
    // weakest-link cap: final rarely exceeds lowest + companyCap (PSA ~1, BGS ~2).
    var cap = lowest + (meta.lowestPlusCap == null ? 1 : meta.lowestPlusCap);
    var raw = Math.min(weighted, cap);
    var grade = roundToStep(raw, step);
    if (!meta.has95) { if (grade > 9 && grade < 10) grade = 9; } // PSA/TAG binary 9/10

    var subgrades = null, label;
    if (company === 'BGS') {
      subgrades = {
        centering: roundToStep(pillars.centering, 0.5),
        corners: roundToStep(pillars.corners, 0.5),
        edges: roundToStep(pillars.edges, 0.5),
        surface: roundToStep(pillars.surface, 0.5)
      };
      // BGS final is anchored by the lowest subgrade (and rarely > lowest + 2).
      var bgsLow = Math.min(subgrades.centering, subgrades.corners, subgrades.edges, subgrades.surface);
      grade = roundToStep(Math.min(grade, bgsLow + 2), 0.5);
      label = bgsLabel(grade, subgrades);
    } else if (company === 'TAG') {
      label = genericLabel(company, grade);
    } else {
      label = genericLabel(company, grade);
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
        centering: roundToStep(pillars.centering, step),
        corners: roundToStep(pillars.corners, step),
        edges: roundToStep(pillars.edges, step),
        surface: roundToStep(pillars.surface, step)
      }
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
    var conf = input.confidence == null ? 0.6 : input.confidence;
    var companies = Object.keys(cfg.companies || {});
    var perCompany = {};
    companies.forEach(function (co) {
      var step = (cfg.companies[co] || {}).step || 0.5;
      var centerGrade = GR.centeringGrade(co, input.centeringFrontWorst, input.centeringBackWorst, cfg);
      var pillars = {
        centering: centerGrade,
        corners: GR.pillarEffective(input.corners.front, input.corners.back, step),
        edges: GR.pillarEffective(input.edges.front, input.edges.back, step),
        surface: GR.pillarEffective(input.surface.front, input.surface.back, step)
      };
      perCompany[co] = GR.predictCompany(co, pillars, cfg, conf);
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
      var key = (d.grade % 1 === 0) ? String(d.grade) : String(d.grade);
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
