// Unit tests for the EN early/pre-release set pipeline (Phases 1–2): the PriceCharting console
// directory's English bucket + the corroborated discovery/graduation core. All pure — no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConsoleDirectory } from '../../lib/pricecharting.mjs';
import { enConsoleResolver, computeEnEarly } from '../../scripts/build-pokemon-en-early.mjs';

describe('parseConsoleDirectory — English bucket', () => {
  const html = [
    '/console/pokemon-japanese-abyss-eye',
    '/console/pokemon-chinese-csv4c',
    '/console/pokemon-korean-mega-brave',
    '/console/pokemon-pitch-black',            // English set (no lang token)
    '/console/pokemon-mega-evolution',         // English set
    '/console/pokemon-promo',                  // skip: generic promo bucket
    '/console/pokemon-scarlet-',               // skip: trailing-dash artifact (& in real slug)
    '/console/pokemon-151-sealed',             // skip: sealed aggregate
  ].map((h) => `<a href="https://www.pricecharting.com${h}?sort=x">x</a>`).join('\n');
  const dir = parseConsoleDirectory(html);

  it('still buckets JP/CN/KO by language token', () => {
    assert.deepEqual(dir.japanese, ['pokemon-japanese-abyss-eye']);
    assert.deepEqual(dir.chinese, ['pokemon-chinese-csv4c']);
    assert.deepEqual(dir.korean, ['pokemon-korean-mega-brave']);
  });
  it('captures English (no-lang) consoles', () => {
    assert.ok(dir.english.includes('pokemon-pitch-black'));
    assert.ok(dir.english.includes('pokemon-mega-evolution'));
  });
  it('filters non-set English consoles (promo, trailing-dash, sealed)', () => {
    assert.ok(!dir.english.includes('pokemon-promo'));
    assert.ok(!dir.english.includes('pokemon-scarlet-'));
    assert.ok(!dir.english.includes('pokemon-151-sealed'));
  });
  it('never puts a JP/CN/KO slug in the english bucket', () => {
    assert.ok(!dir.english.some((s) => /-(japanese|chinese|korean)-|^pokemon-(japanese|chinese|korean)-/.test(s)));
  });
});

describe('enConsoleResolver', () => {
  const resolve = enConsoleResolver(['pokemon-pitch-black', 'pokemon-storm-emeralda', 'pokemon-scarlet-and-violet-151']);
  it('exact slugified match (incl. & -> and)', () => {
    assert.equal(resolve('Pitch Black'), 'pokemon-pitch-black');
    assert.equal(resolve('Storm Emeralda'), 'pokemon-storm-emeralda');
    assert.equal(resolve('Scarlet & Violet 151'), 'pokemon-scarlet-and-violet-151');
  });
  it('suffix-tolerant match when a console name embeds the set name', () => {
    const r = enConsoleResolver(['pokemon-mega-evolution-pitch-black']);
    assert.equal(r('Pitch Black'), 'pokemon-mega-evolution-pitch-black');
  });
  it('guards against too-short (ambiguous) names', () => {
    assert.equal(resolve('151'), '');   // length < 4 -> no fuzzy match
  });
  it('returns empty when nothing resolves', () => {
    assert.equal(resolve('Totally Unknown Set'), '');
  });
});

describe('computeEnEarly — discovery + graduation', () => {
  const english = ['pokemon-pitch-black', 'pokemon-storm-emeralda', 'pokemon-mega-evolution'];
  const intl = {
    ja: [
      { code: 'M5', serie: 'MEGA', enEquivalent: { id: '', name: 'Pitch Black' } },
      { code: 'M6', serie: 'MEGA', enEquivalent: { id: '', name: 'Storm Emeralda' } },
      { code: 'M1L', serie: 'MEGA', enEquivalent: { id: 'me1', name: 'Mega Evolution' } },   // already live
      { code: 'M7', serie: 'MEGA', enEquivalent: { id: '', name: 'No Console Yet' } },        // no PC console
    ],
  };

  it('auto-discovers upcoming sets, excludes already-live, requires a PC console', () => {
    const known = new Set(['megaevolution']);   // pokemontcg.io already has Mega Evolution
    const { sets, newSets } = computeEnEarly({ known, english, seed: { sets: [] }, intl, prior: { sets: [] } });
    const names = sets.map((s) => s.name).sort();
    assert.deepEqual(names, ['Pitch Black', 'Storm Emeralda']);   // M1L live -> out; M7 has no console -> out
    assert.equal(sets.find((s) => s.name === 'Storm Emeralda').source, 'auto');
    assert.equal(sets.find((s) => s.name === 'Storm Emeralda').pcSlug, 'pokemon-storm-emeralda');
    assert.equal(newSets.length, 2);
  });

  it('manual seed wins on a name collision (pins code/date/source)', () => {
    const known = new Set();
    const seed = { sets: [{ code: 'ME05', name: 'Pitch Black', pcSlug: 'pokemon-pitch-black', releaseDate: '2026-07-17', jpEquivalent: 'M5' }] };
    const { sets } = computeEnEarly({ known, english, seed, intl, prior: { sets: [] } });
    const pb = sets.find((s) => s.name === 'Pitch Black');
    assert.equal(pb.source, 'manual');
    assert.equal(pb.code, 'ME05');
    assert.equal(pb.releaseDate, '2026-07-17');
  });

  it('graduates a set the moment pokemontcg.io lists it (dropped + reported)', () => {
    const known = new Set(['pitchblack']);   // pokemontcg.io now has Pitch Black
    const seed = { sets: [{ code: 'ME05', name: 'Pitch Black', pcSlug: 'pokemon-pitch-black' }] };
    const prior = { sets: [{ name: 'Pitch Black', code: 'ME05' }] };
    const { sets, graduated } = computeEnEarly({ known, english, seed, intl: { ja: [] }, prior });
    assert.ok(!sets.some((s) => s.name === 'Pitch Black'));
    assert.deepEqual(graduated.map((s) => s.name), ['Pitch Black']);
  });

  it('drops a candidate with no resolvable PC console', () => {
    const known = new Set();
    const seed = { sets: [{ code: 'X', name: 'No Console Set' }] };   // no pcSlug, no matching english console
    const { sets } = computeEnEarly({ known, english, seed, intl: { ja: [] }, prior: { sets: [] } });
    assert.equal(sets.length, 0);
  });
});
