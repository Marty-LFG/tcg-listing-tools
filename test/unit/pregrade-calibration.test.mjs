// test/unit/pregrade-calibration.test.mjs — the calibration maths (lib/pregrade.mjs
// buildCalibration), tested as the pure function it is: joined rows in, honest analytics out.
//
// The point of these tests is not "does it compute a mean" — it is that it REFUSES to, on the
// sample sizes this tool will really have. A pre-grader that has been running for a month has
// n=3, and a confident bias figure over three cards is exactly the kind of number that gets acted
// on and shouldn't be (Golden Rule 4 applied to our own accuracy, not just to grades).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalibration } from '../../lib/pregrade.mjs';

// One joined row as CALIBRATION_SQL hands it over: report columns + the linked submission's
// result. `predictions` is the grader page's own shape (GR.predictAll).
let seq = 0;
function row({ company = 'PSA', predicted = 9, actual = 9, subgrades = null, predSubgrades = null,
  predPillars = null, dirty = null, name = null, gradedAt = null } = {}) {
  const id = ++seq;
  const entry = { company, grade: predicted, gradeLabel: 'x' };
  if (predSubgrades) entry.subgrades = predSubgrades;
  if (predPillars) entry.pillars = predPillars;
  return {
    id, name: name || `Card ${id}`, predictions: JSON.stringify({ perCompany: { [company]: entry } }),
    frozen_dirty_at: dirty, locked_at: '2026-08-01 00:00:00',
    submission_id: 1000 + id, company, result_grade: actual,
    result_subgrades: subgrades ? JSON.stringify(subgrades) : null,
    graded_at: gradedAt || `2026-08-${String(id % 28 + 1).padStart(2, '0')} 00:00:00`,
  };
}
// n rows of one company with a fixed delta, which makes the expected statistics obvious by hand.
const rowsWith = (n, opts) => Array.from({ length: n }, () => row(opts));

describe('the empty and near-empty cases — the ones this tool lives in', () => {
  it('n=0 on an empty DB: ok:true, zeroes, no statistics, and a note that says empty ≠ zero', () => {
    const c = buildCalibration([]);
    assert.equal(c.ok, true);
    assert.equal(c.n, 0);
    assert.deepEqual(c.byCompany, {});
    assert.deepEqual(c.recent, []);
    assert.equal(c.confidence, 'none');
    assert.equal(c.overall.meanError, null);
    assert.equal(c.overall.medianError, null);
    assert.equal(c.overall.mae, null);
    assert.match(c.note, /not a score of zero/i);
  });

  it('a null/garbage rows argument degrades to the empty answer rather than throwing (GR7)', () => {
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      const c = buildCalibration(bad);
      assert.equal(c.n, 0, `${bad} should read as no rows`);
      assert.equal(c.ok, true);
    }
  });

  it('n=1: the card is listed and counted, but NOTHING is averaged', () => {
    const c = buildCalibration([row({ predicted: 9.5, actual: 9 })]);
    assert.equal(c.n, 1);
    assert.equal(c.confidence, 'none');
    const psa = c.byCompany.PSA;
    assert.equal(psa.n, 1);
    assert.equal(psa.meanError, null);
    assert.equal(psa.medianError, null, 'a median of one card is that card wearing a statistic');
    assert.equal(psa.mae, null);
    assert.equal(psa.meanErrorCi95, null);
    assert.equal(psa.overPredicted, 1);            // counts still work — they claim nothing
    assert.equal(psa.within0_5, 1);
    assert.match(psa.note, /counts only/i);
    assert.equal(c.recent.length, 1);
    assert.deepEqual(
      { predicted: c.recent[0].predicted, actual: c.recent[0].actual, delta: c.recent[0].delta },
      { predicted: 9.5, actual: 9, delta: 0.5 });
  });

  it('tiny n (3..7): median + MAE appear, the MEAN stays withheld', () => {
    const rows = [row({ predicted: 10, actual: 9 }), row({ predicted: 9, actual: 9 }), row({ predicted: 9, actual: 9.5 })];
    const c = buildCalibration(rows);
    assert.equal(c.n, 3);
    assert.equal(c.confidence, 'weak');
    const psa = c.byCompany.PSA;
    assert.equal(psa.medianError, 0);              // deltas: +1, 0, -0.5 -> median 0
    assert.equal(psa.mae, 0.5);                    // (1 + 0 + 0.5) / 3
    assert.equal(psa.meanError, null, 'the mean is the bias figure and 3 cards cannot support it');
    assert.equal(psa.meanErrorCi95, null);
    assert.equal(psa.biasPerPillar, null);
    assert.equal(psa.overPredicted, 1);
    assert.equal(psa.underPredicted, 1);
    assert.equal(psa.exact, 1);
    assert.match(psa.note, /withheld below n=8/);
  });

  it('the threshold is a boundary, not a vibe: n=7 withholds, n=8 reports', () => {
    const seven = buildCalibration(rowsWith(7, { predicted: 9.5, actual: 9 }));
    assert.equal(seven.overall.meanError, null);
    assert.equal(seven.confidence, 'weak');
    const eight = buildCalibration(rowsWith(8, { predicted: 9.5, actual: 9 }));
    assert.equal(eight.overall.meanError, 0.5);
    assert.equal(eight.confidence, 'usable');
  });
});

describe('the statistics themselves', () => {
  it('n>=8 reports mean, median, MAE and a 95% interval that brackets the mean', () => {
    // Seven at +0.5 and one at -1: mean 0.3125, median +0.5 — the median is the robust one.
    const rows = [...rowsWith(7, { predicted: 9.5, actual: 9 }), row({ predicted: 9, actual: 10 })];
    const c = buildCalibration(rows);
    const psa = c.byCompany.PSA;
    assert.equal(psa.n, 8);
    assert.equal(psa.confidence, 'usable');
    assert.equal(psa.meanError, 0.31);
    assert.equal(psa.medianError, 0.5);
    assert.equal(psa.mae, 0.56);                    // (7*0.5 + 1) / 8 = 0.5625
    const [lo, hi] = psa.meanErrorCi95;
    assert.ok(lo < psa.meanError && psa.meanError < hi, 'the interval must bracket its own mean');
    assert.ok(lo < 0, 'with one outlier in eight the interval must admit "no bias at all"');
    assert.match(psa.note, /95% interval/);
    assert.match(psa.note, /not entirely/, 'the note must own up to the independence assumption');
  });

  it('a zero-variance sample gets a degenerate interval, not a divide-by-zero', () => {
    const c = buildCalibration(rowsWith(8, { predicted: 9, actual: 9 }));
    assert.equal(c.overall.meanError, 0);
    assert.deepEqual(c.overall.meanErrorCi95, [0, 0]);
    assert.equal(c.overall.exact, 8);
    assert.equal(c.overall.within0_5, 8);
  });

  it('counts are counts, never percentages, and the sign convention is stated', () => {
    const c = buildCalibration([
      row({ predicted: 10, actual: 9 }),      // +1  over
      row({ predicted: 9, actual: 9.5 }),     // -0.5 under
      row({ predicted: 8, actual: 10 }),      // -2  under, outside both bands
    ]);
    const psa = c.byCompany.PSA;
    assert.equal(psa.within0_5, 1);
    assert.equal(psa.within1, 2);
    assert.equal(psa.overPredicted, 1);
    assert.equal(psa.underPredicted, 2);
    for (const k of ['within0_5', 'within1', 'overPredicted', 'underPredicted']) {
      assert.ok(Number.isInteger(psa[k]), `${k} must be a count`);
    }
    assert.match(c.thresholds.deltaSign, /predicted HIGH/);
  });
});

describe('mixed companies', () => {
  const rows = [
    ...rowsWith(3, { company: 'PSA', predicted: 9.5, actual: 9 }),
    ...rowsWith(2, { company: 'BGS', predicted: 9, actual: 9.5 }),
    row({ company: 'TAG', predicted: 8, actual: 8 }),
  ];
  it('splits per company, each with its own n and its own confidence', () => {
    const c = buildCalibration(rows);
    assert.equal(c.n, 6);
    assert.deepEqual(Object.keys(c.byCompany).sort(), ['BGS', 'PSA', 'TAG']);
    assert.equal(c.byCompany.PSA.n, 3);
    assert.equal(c.byCompany.PSA.confidence, 'weak');
    assert.equal(c.byCompany.BGS.n, 2);
    assert.equal(c.byCompany.BGS.confidence, 'none');
    assert.equal(c.byCompany.BGS.medianError, null, 'BGS has 2 cards: no statistic, whatever PSA has');
    assert.equal(c.byCompany.TAG.n, 1);
    assert.equal(c.overall.n, 6);
    assert.equal(c.overall.confidence, 'weak', 'six cards across three companies is still six cards');
  });

  it('the prediction compared is the one made FOR THE GRADING COMPANY, not the best one', () => {
    // Predicted PSA 9 and BGS 8.5 on the same card; BGS graded it 8.5. The comparison must be
    // against BGS's 8.5 (delta 0), never PSA's 9.
    const both = {
      id: 900, name: 'Two predictions', frozen_dirty_at: null, locked_at: null, submission_id: 9000,
      predictions: JSON.stringify({ perCompany: { PSA: { grade: 9 }, BGS: { grade: 8.5 } } }),
      company: 'BGS', result_grade: 8.5, result_subgrades: null, graded_at: '2026-08-10 00:00:00',
    };
    const c = buildCalibration([both]);
    assert.equal(c.n, 1);
    assert.equal(c.byCompany.BGS.n, 1);
    assert.equal(c.recent[0].predicted, 8.5);
    assert.equal(c.recent[0].delta, 0);
  });

  it('a company key that differs only in case still matches', () => {
    const r = row({ company: 'PSA' });
    r.company = 'psa';
    const c = buildCalibration([r]);
    assert.equal(c.n, 1);
    assert.equal(Object.keys(c.byCompany)[0], 'PSA');
  });

  it('a card graded by a company the report never predicted is EXCLUDED, not guessed at', () => {
    const r = row({ company: 'PSA' });
    r.company = 'SGC';                                    // no SGC prediction in the blob
    const c = buildCalibration([r, ...rowsWith(2, { company: 'PSA' })]);
    assert.equal(c.n, 2);
    assert.equal(c.excluded.noPredictionForCompany, 1);
    assert.equal(c.byCompany.SGC, undefined);
    assert.match(c.note, /no prediction for the company/);
  });

  it('malformed or missing prediction blobs are excluded, never coerced into a zero', () => {
    const rows = [
      { ...row(), predictions: '{not json' },
      { ...row(), predictions: null },
      { ...row(), predictions: JSON.stringify({ perCompany: { PSA: { grade: 'nine' } } }) },
      { ...row(), result_grade: null },
    ];
    const c = buildCalibration(rows);
    assert.equal(c.n, 0);
    assert.equal(c.ok, true);
    assert.equal(c.excluded.noPredictionForCompany, 3);
    assert.equal(c.excluded.unusableResult, 1);
    assert.match(c.note, /No usable comparison/);
  });
});

describe('per-pillar bias only exists when real subgrades came back', () => {
  const subs = { centering: 8.5, corners: 9, edges: 9, surface: 9 };
  const predSubs = { centering: 9, corners: 9, edges: 9, surface: 9 };

  it('null when the slab printed one number (PSA), whatever the sample size', () => {
    const c = buildCalibration(rowsWith(12, { company: 'PSA', predicted: 9, actual: 9 }));
    assert.equal(c.byCompany.PSA.confidence, 'usable');
    assert.equal(c.byCompany.PSA.biasPerPillar, null);
    assert.deepEqual(c.byCompany.PSA.biasPerPillarN, { centering: 0, corners: 0, edges: 0, surface: 0 });
    assert.match(c.byCompany.PSA.note, /only BGS\/PCG\/TAG print them/);
  });

  it('computed per pillar once BGS subgrades exist at n>=8, and states the paired n', () => {
    const c = buildCalibration(rowsWith(8, {
      company: 'BGS', predicted: 9, actual: 9, subgrades: subs, predSubgrades: predSubs,
    }));
    const bgs = c.byCompany.BGS;
    assert.deepEqual(bgs.biasPerPillar, { centering: 0.5, corners: 0, edges: 0, surface: 0 });
    assert.deepEqual(bgs.biasPerPillarN, { centering: 8, corners: 8, edges: 8, surface: 8 });
    assert.equal(bgs.biasBasis, 'median(predicted - actual)');
  });

  it('a pillar the slab did not report stays null while its siblings compute', () => {
    const partial = { corners: 9, edges: 9, surface: 9 };          // no centering subgrade
    const c = buildCalibration(rowsWith(8, {
      company: 'TAG', predicted: 9, actual: 9, subgrades: partial, predSubgrades: predSubs,
    }));
    assert.equal(c.byCompany.TAG.biasPerPillar.centering, null);
    assert.equal(c.byCompany.TAG.biasPerPillarN.centering, 0);
    assert.equal(c.byCompany.TAG.biasPerPillar.corners, 0);
  });

  it('subgrades below the bias threshold report their count and no figure', () => {
    const c = buildCalibration([
      ...rowsWith(4, { company: 'BGS', predicted: 9, actual: 9, subgrades: subs, predSubgrades: predSubs }),
      ...rowsWith(4, { company: 'BGS', predicted: 9, actual: 9 }),   // no subgrades on these four
    ]);
    const bgs = c.byCompany.BGS;
    assert.equal(bgs.n, 8);
    assert.equal(bgs.meanError, 0, 'the overall figure is fine — 8 whole-grade comparisons exist');
    assert.equal(bgs.biasPerPillar, null, 'only 4 pillar pairs: below the threshold, so no figure');
    assert.equal(bgs.biasPerPillarN.corners, 4, 'and the count says exactly why');
  });

  it('falls back to the predicted PILLARS when the prediction carried no subgrades', () => {
    const c = buildCalibration(rowsWith(8, {
      company: 'PCG', predicted: 9, actual: 9, subgrades: subs, predPillars: predSubs,
    }));
    assert.deepEqual(c.byCompany.PCG.biasPerPillar, { centering: 0.5, corners: 0, edges: 0, surface: 0 });
  });
});

describe('a report edited after linking is suspect', () => {
  it('excluded from every statistic, still listed, and flagged', () => {
    const rows = [
      ...rowsWith(3, { predicted: 9, actual: 9 }),
      row({ predicted: 10, actual: 6, dirty: '2026-08-20 10:00:00', name: 'Rewritten' }),
    ];
    const c = buildCalibration(rows);
    assert.equal(c.n, 3, 'the rewritten prediction must not count');
    assert.equal(c.excluded.suspectEdits, 1);
    assert.equal(c.byCompany.PSA.n, 3);
    assert.equal(c.byCompany.PSA.mae, 0, 'the -4 outlier never reached the maths');
    const flagged = c.recent.find((x) => x.name === 'Rewritten');
    assert.ok(flagged, 'a suspect row must still be visible to the owner');
    assert.equal(flagged.suspect, true);
    assert.match(c.note, /unlock hatch/);
  });

  it('an untouched report is not flagged (an ordinary status PATCH must not taint it)', () => {
    const c = buildCalibration([row({ dirty: null })]);
    assert.equal(c.recent[0].suspect, false);
    assert.equal(c.excluded.suspectEdits, 0);
  });
});

describe('the recent list', () => {
  it('is newest-graded first and capped by recentLimit', () => {
    const rows = [
      row({ name: 'oldest', gradedAt: '2026-01-01 00:00:00' }),
      row({ name: 'newest', gradedAt: '2026-08-22 00:00:00' }),
      row({ name: 'middle', gradedAt: '2026-05-05 00:00:00' }),
    ];
    const c = buildCalibration(rows, { recentLimit: 2 });
    assert.deepEqual(c.recent.map((x) => x.name), ['newest', 'middle']);
  });
  it('carries the fields the dashboard needs, per card', () => {
    const c = buildCalibration([row({ predicted: 9, actual: 8, name: 'Iron Valiant ex' })]);
    const e = c.recent[0];
    for (const k of ['reportId', 'name', 'predicted', 'actual', 'delta', 'gradedAt']) assert.ok(k in e, `recent row missing ${k}`);
    assert.equal(e.name, 'Iron Valiant ex');
    assert.equal(e.delta, 1);
  });
});
