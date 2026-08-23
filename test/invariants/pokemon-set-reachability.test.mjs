// EVERY baked Pokémon set must be reachable from the stock tools.
//
// This is the invariant M6 Storm Emeralda violated for three weeks while every individual piece
// looked healthy: the set was in the index, PriceCharting had all its cards, catalog.html rendered
// them — and the batch runner still said "no cards returned", because the URL it built pinned the
// server to a single source that happened not to have the set.
//
// So the check is deliberately END-TO-END over REAL baked data: take each set exactly as the bake
// wrote it, build the URL exactly as the client builds it, and resolve the source chain exactly as
// the server resolves it. A set that survives that has somewhere to get cards from. No network.
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOCK_GAME_ADAPTERS } from '../../lib/stock-games.mjs';
import { cardSourceChain } from '../../lib/catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETS = path.join(ROOT, 'data', 'pokemon-intl-sets.json');
const P = STOCK_GAME_ADAPTERS.pokemon;
const LANG_CODE = { ja: 'JP', 'zh-cn': 'CN', 'zh-tw': 'TW', ko: 'KO' };

// The exact round trip: baked record -> client URL -> server chain.
function chainFor(lang, rec) {
  const url = new URL(P.setCardsUrl(rec.code || rec.pcSlug, false, LANG_CODE[lang], rec), 'http://x');
  return cardSourceChain(url.searchParams.get('lang'), {
    tcgdexId: url.searchParams.get('tcgdexId') || '',
    pcSlug: url.searchParams.get('pcSlug') || '',
  });
}

const index = (() => { try { return JSON.parse(fs.readFileSync(SETS, 'utf8')); } catch { return null; } })();

describe('every baked Pokémon set can actually be loaded', { skip: index ? false : 'no baked index — run scripts/build-pokemon-intl-sets.mjs' }, () => {
  const all = [];
  for (const lang of Object.keys(index || {})) for (const r of (index[lang] || [])) all.push({ lang, r });

  it('has sets to check at all', () => {
    assert.ok(all.length > 100, `expected a populated index, got ${all.length} sets`);
  });

  it('gives every set at least one source to try', () => {
    const stranded = all.filter(({ lang, r }) => chainFor(lang, r).length === 0)
      .map(({ lang, r }) => `${lang}:${r.code || r.pcSlug || '(blank)'} ${r.name_en || r.name_native || ''}`);
    assert.deepEqual(stranded, [], 'these sets are pickable in the tools and have nowhere to fetch cards from');
  });

  it('never strands a set that HAS a PriceCharting console — the M6 failure exactly', () => {
    const unreachable = all
      .filter(({ lang, r }) => r.pcSlug && !chainFor(lang, r).some((s) => s.kind === 'pc'))
      .map(({ lang, r }) => `${lang}:${r.code || r.pcSlug}`);
    assert.deepEqual(unreachable, [], 'a set with a console must always be able to reach it');
  });

  it('the client never claims a TCGdex id the record does not have', () => {
    const lying = all
      .filter(({ lang, r }) => !r.tcgdexId && chainFor(lang, r).some((s) => s.kind === 'tcgdex'))
      .map(({ lang, r }) => `${lang}:${r.code || r.pcSlug}`);
    assert.deepEqual(lying, []);
  });

  // The above only catches a MISSING id being invented. It cannot catch a WRONG one — and a wrong
  // one is what actually happened: the bake defaulted a seeded set's tcgdexId to its printed code,
  // so M6 carried tcgdexId "M6" for a set TCGdex has never held. The id was present and useless,
  // which is why nothing flagged it. A seeded set is BY DEFINITION one TCGdex's brief list lacks
  // (that is the branch that creates it), so its id must be blank unless the seed pinned a real one.
  it('a seeded set never carries a TCGdex id the seed did not pin', () => {
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pokemon-intl-seed.json'), 'utf8'));
    const fabricated = all
      .filter(({ lang, r }) => {
        if (!r.seeded || !r.tcgdexId) return false;
        const pinned = ((seed[lang] || {})[r.code] || (seed[lang] || {})[String(r.code).toLowerCase()] || {}).tcgdexId;
        return r.tcgdexId !== pinned;
      })
      .map(({ lang, r }) => `${lang}:${r.code} carries tcgdexId "${r.tcgdexId}" that the seed never pinned`);
    assert.deepEqual(fabricated, []);
  });

  it('keeps TCGdex ahead of PriceCharting wherever both exist', () => {
    const both = all.filter(({ r }) => r.tcgdexId && r.pcSlug);
    assert.ok(both.length > 20, 'expected plenty of dual-source sets');
    for (const { lang, r } of both.slice(0, 200)) {
      assert.deepEqual(chainFor(lang, r).map((s) => s.kind), ['tcgdex', 'pc'],
        `${lang}:${r.code} — native names and the printing matrix must still win`);
    }
  });

  it('routes the seeded sets TCGdex has never ingested straight to PriceCharting', () => {
    const seeded = all.filter(({ r }) => r.seeded);
    assert.ok(seeded.length, 'the overlay should be injecting at least one set');
    for (const { lang, r } of seeded) {
      const kinds = chainFor(lang, r).map((s) => s.kind);
      assert.ok(kinds.length, `${lang}:${r.code} is seeded with no way to look it up`);
      assert.ok(!kinds.includes('tcgdex') || r.tcgdexId,
        `${lang}:${r.code} — seeding a set must not invent a TCGdex id for it`);
    }
  });
});
