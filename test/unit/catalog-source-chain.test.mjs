// The source chain, the coverage watchdog, and the bake's new-set diff — the three pieces that
// together answer "why was M6 Storm Emeralda unlistable for three weeks, and what stops the next one".
//
// The failure was not missing data. The set was in the baked index, PriceCharting had all 115 rows,
// and catalog.html rendered them fine. The batch runner sent `src=indexed`, the server treated
// source selection as mutually exclusive, TCGdex 404'd a set it had never ingested, and the
// PriceCharting branch on the next line was unreachable. Everything below pins one part of that shut.
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cardSourceChain, runCardSourceChain, coverageTargets, classifyCoverage } from '../../lib/catalog.mjs';
import { diffNewSets, restorePcFromPrior, setDiffKey } from '../../scripts/build-pokemon-intl-sets.mjs';

const sources = (c) => c.map((s) => s.source);

describe('cardSourceChain — the server decides, and never on one source only', () => {
  it('puts pokemontcg first on the English lane and PriceCharting behind it', () => {
    assert.deepEqual(sources(cardSourceChain('en', { pcSlug: 'pokemon-pitch-black' })),
      ['pokemontcg', 'pricecharting-early']);
    // No console known yet — pokemontcg is the whole chain, exactly as before.
    assert.deepEqual(sources(cardSourceChain('en', {})), ['pokemontcg']);
  });

  it('puts TCGdex first on the intl lanes, so native names and the printing matrix still win', () => {
    assert.deepEqual(sources(cardSourceChain('ja', { tcgdexId: 'M5', pcSlug: 'pokemon-japanese-abyss-eye' })),
      ['tcgdex', 'pricecharting']);
  });

  it('falls to PriceCharting alone for a set TCGdex has never had — the M6 shape', () => {
    assert.deepEqual(sources(cardSourceChain('ja', { tcgdexId: '', pcSlug: 'pokemon-japanese-storm-emeralda' })),
      ['pricecharting']);
  });

  it('reports an empty chain rather than inventing a source', () => {
    assert.deepEqual(cardSourceChain('ja', {}), [], 'a set with no route is a state worth naming');
  });
});

describe('runCardSourceChain — a throwing step means "not here", not "give up"', () => {
  const chain = cardSourceChain('ja', { tcgdexId: 'M6', pcSlug: 'pokemon-japanese-storm-emeralda' });

  it('walks past a 404 to the next source (this IS the M6 bug)', async () => {
    const got = await runCardSourceChain(chain, (s) => {
      if (s.kind === 'tcgdex') throw new Error('HTTP 404');
      return [{ name: 'Heracross', numRaw: '1' }];
    });
    assert.equal(got.source, 'pricecharting');
    assert.equal(got.cards.length, 1);
    assert.equal(got.error, null, 'a recovered-from error is not an error');
  });

  it('walks past an empty-but-OK step too', async () => {
    const got = await runCardSourceChain(chain, (s) => (s.kind === 'tcgdex' ? [] : [{ name: 'x' }]));
    assert.equal(got.source, 'pricecharting');
  });

  it('stops at the first source that answers, so the better source still wins', async () => {
    const got = await runCardSourceChain(chain, (s) => {
      if (s.kind === 'pc') throw new Error('should never be reached');
      return [{ name: 'アビスアイ card' }];
    });
    assert.equal(got.source, 'tcgdex');
  });

  it('surfaces the last error only when everything failed', async () => {
    const got = await runCardSourceChain(chain, () => { throw new Error('everything down'); });
    assert.deepEqual(got.cards, []);
    assert.equal(got.source, 'none');
    assert.match(String(got.error.message), /everything down/);
    assert.deepEqual(got.errors, ['everything down', 'everything down'], 'every step reports, not just the last');
  });

  it('an empty chain is a clean empty answer, not a crash', async () => {
    const got = await runCardSourceChain([], () => { throw new Error('unreachable'); });
    assert.deepEqual(got, { cards: [], source: 'none', error: null, errors: [] });
  });
});

describe('classifyCoverage — "no cards" and "could not ask" are different facts', () => {
  // Learned the hard way on the first live run: a keyless pass at pokemontcg.io drew 108 HTTP
  // 500/502s, and the first cut of the watchdog reported all 108 as unlistable sets. An alert that
  // cries wolf on its first upstream wobble is worse than no alert, because it teaches you to
  // ignore the one that matters.
  it('treats a 5xx, a 429 and a dead socket as unavailable, never as a gap', () => {
    for (const e of ['HTTP 500', 'HTTP 502', 'HTTP 503', 'HTTP 429', 'fetch failed', 'ETIMEDOUT', 'socket hang up'])
      assert.equal(classifyCoverage(0, [e]), 'unavailable', e);
  });

  it('treats a 404 and an empty-but-OK answer as a real gap', () => {
    assert.equal(classifyCoverage(0, ['HTTP 404']), 'gap', 'the upstream answered: it does not have this set');
    assert.equal(classifyCoverage(0, []), 'gap', 'HTTP 200 with no cards is a genuine hole');
  });

  it('any transient failure in the chain is enough to withhold the verdict', () => {
    assert.equal(classifyCoverage(0, ['HTTP 404', 'HTTP 500']), 'unavailable',
      'TCGdex genuinely lacks it AND PriceCharting was down — we still cannot say the set is unlistable');
  });

  it('cards beat everything', () => {
    assert.equal(classifyCoverage(113, ['HTTP 404']), 'ok');
  });
});

describe('coverageTargets — bounded, ranked, and never quietly complete', () => {
  const NOW = Date.parse('2026-08-23T00:00:00Z');
  const intl = {
    ja: [
      { code: 'M6', name_en: 'Storm Emeralda', releaseDate: '2026-07-31', tcgdexId: '', pcSlug: 'pokemon-japanese-storm-emeralda' },
      { code: 'OLD', name_en: 'Old Set', releaseDate: '2001-01-01', cardCount: 10, tcgdexId: 'OLD' },
      { code: 'NOROUTE', name_en: 'Stranded', releaseDate: '2001-01-01', tcgdexId: '', pcSlug: '' },
      { code: '', name_en: 'New Stub', releaseDate: '', pcSlug: 'pokemon-japanese-new-stub' },
    ],
  };

  it('ranks a stranded set first — it is the worst state and costs no request', () => {
    const { targets } = coverageTargets({ intl, priorRows: [] }, NOW, { max: 50 });
    assert.equal(targets[0].setCode, 'NOROUTE');
    assert.equal(targets[0].rank, 0);
    assert.equal(targets[0].noRoute, true);
  });

  it('checks a recently-released set, and a never-seen one with no release date at all', () => {
    const { targets } = coverageTargets({ intl, priorRows: [] }, NOW, { max: 50 });
    const codes = targets.map((t) => t.setCode);
    assert.ok(codes.includes('M6'), 'recent release');
    // A PriceCharting-only set arrives with a blank releaseDate, so a date rule alone would never
    // look at it — and that is precisely the shape a brand-new set has.
    assert.ok(codes.includes('pokemon-japanese-new-stub'), 'never checked before');
  });

  it('leaves alone a set it proved good recently', () => {
    const priorRows = [{ lang: 'ja', code: 'OLD', ok: true, checkedAt: new Date(NOW - 2 * 86400000).toISOString() }];
    const { targets } = coverageTargets({ intl, priorRows }, NOW, { max: 50 });
    assert.ok(!targets.some((t) => t.setCode === 'OLD'));
  });

  it('re-checks a set that was a gap last run, however old it is', () => {
    const priorRows = [{ lang: 'ja', code: 'OLD', ok: false, checkedAt: new Date(NOW - 1000).toISOString() }];
    const { targets } = coverageTargets({ intl, priorRows }, NOW, { max: 50 });
    const old = targets.find((t) => t.setCode === 'OLD');
    assert.ok(old, 'a gap gets another look — did it heal?');
    assert.equal(old.rank, 2);
  });

  it('defers past the cap instead of dropping, and free checks never spend budget', () => {
    const { targets, deferred } = coverageTargets({ intl, priorRows: [] }, NOW, { max: 1 });
    assert.deepEqual(targets.map((t) => t.setCode), ['NOROUTE', 'M6'],
      'the no-request check rides free; the single paid slot goes to the most urgent');
    // Both never-checked sets fall past the single paid slot, and both are RETURNED — a bounded run
    // that reports 'all clear' while having skipped work is the failure mode this replaces.
    assert.deepEqual(deferred.map((t) => t.setCode), ['OLD', 'pokemon-japanese-new-stub']);
  });

  it('de-dupes an early-EN set that has graduated to pokemontcg.io', () => {
    const { targets } = coverageTargets({
      intl: {}, enSets: [{ id: 'me5', name: 'Pitch Black', releaseDate: '2026/07/17' }],
      earlyEn: [{ code: 'me5', name: 'Pitch Black', pcSlug: 'pokemon-pitch-black' }], priorRows: [],
    }, NOW, { max: 50 });
    assert.equal(targets.filter((t) => t.setCode === 'me5').length, 1);
  });
});

describe('diffNewSets — what tells you a set landed', () => {
  it('says nothing on a first build', () => {
    assert.deepEqual(diffNewSets({}, { ja: [{ code: 'M6' }] }), [],
      'a first build is not 600 new sets, and an unactionable alert is noise');
  });

  it('reports a genuinely new coded set', () => {
    const got = diffNewSets({ ja: [{ code: 'M5' }] },
      { ja: [{ code: 'M5' }, { code: 'M6', name_en: 'Storm Emeralda', releaseDate: '2026-07-31' }] });
    assert.equal(got.length, 1);
    assert.equal(got[0].code, 'M6');
    assert.equal(got[0].needsCode, false);
  });

  it('reports a code-less PriceCharting set as needing a code, and only once', () => {
    const prior = { ja: [{ code: '', pcSlug: 'pokemon-japanese-a', name_en: 'A' }] };
    assert.deepEqual(diffNewSets(prior, prior), [],
      'code-less sets keyed on the code alone would ALL collapse to "lang:" and re-alert every run');
    const got = diffNewSets(prior, { ja: [...prior.ja, { code: '', pcSlug: 'pokemon-japanese-b', name_en: 'B' }] });
    assert.equal(got.length, 1);
    assert.equal(got[0].needsCode, true);
    assert.equal(got[0].pcSlug, 'pokemon-japanese-b');
  });

  it('keys code-less sets on the slug', () => {
    assert.equal(setDiffKey('ja', { code: 'M6' }), 'ja:M6');
    assert.equal(setDiffKey('ja', { code: '', pcSlug: 'pokemon-japanese-x' }), 'ja:pokemon-japanese-x');
  });
});

describe('restorePcFromPrior — a churning directory must not un-source a set', () => {
  it('fills a missing slug from the previous index', () => {
    // Records are rebuilt from the TCGdex brief list, which knows nothing about PriceCharting. So a
    // failed OR merely churning directory would otherwise strip the card source off ~117 JP sets.
    const result = { ja: [{ code: 'M5', releaseDate: '2026-05-22' }] };
    const stats = restorePcFromPrior(result, { ja: [{ code: 'M5', pcSlug: 'pokemon-japanese-abyss-eye' }] });
    assert.equal(stats.restored, 1);
    assert.equal(result.ja[0].pcSlug, 'pokemon-japanese-abyss-eye');
  });

  it('re-adds a code-less PC-only set, which loadExisting cannot see at all', () => {
    const result = { ja: [] };
    const stats = restorePcFromPrior(result, { ja: [{ code: '', pcSlug: 'pokemon-japanese-orphan', pcOnly: true, name_en: 'Orphan' }] });
    assert.equal(stats.readded, 1);
    assert.equal(result.ja[0].pcSlug, 'pokemon-japanese-orphan');
  });

  it('never overrides a slug the merge just attached', () => {
    const result = { ja: [{ code: 'M5', pcSlug: 'pokemon-japanese-renamed' }] };
    restorePcFromPrior(result, { ja: [{ code: 'M5', pcSlug: 'pokemon-japanese-abyss-eye' }] });
    assert.equal(result.ja[0].pcSlug, 'pokemon-japanese-renamed', 'a real rename still takes effect');
  });
});
