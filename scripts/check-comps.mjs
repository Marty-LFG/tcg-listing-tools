// scripts/check-comps.mjs — GR9 parity + behaviour harness for the server singles comps engine
// (lib/comps-singles.mjs), the headless twin of extras.js TCG.analyzeComps. Two guards:
//   (1) JUNK_RE is byte-identical to the browser JUNK_RE in extras.js (they must never drift).
//   (2) buildNumberRe / classifyLang / singlesFilter / recommendedFromCluster behave per the
//       documented rules on a fixture set.
// Wrapped by test/invariants/check-harnesses.test.mjs, so `pnpm test` enforces it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUNK_RE, buildNumberRe, classifyLang, singlesFilter, recommendedFromCluster, isGraded, snapToEnding, ASK_ENDINGS } from '../lib/comps-singles.mjs';
import { clusterValue } from '../lib/comps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let fails = 0;
const assert = (name, cond, extra) => { console.log((cond ? '  ok  ' : '  XX  ') + name + (cond ? '' : '  <<< ' + (extra ?? ''))); if (!cond) fails++; };

console.log('\n[JUNK_RE parity with extras.js (GR9)]');
// Extract the JUNK_RE literal from extras.js and compare its source to the ported one.
const extras = read('extras.js');
const m = extras.match(/var JUNK_RE = (\/.*?\/i);/);
assert('extras.js JUNK_RE literal found', !!m, 'regex not located');
if (m) assert('server JUNK_RE === browser JUNK_RE (byte-identical)', m[1] === JUNK_RE.toString(), 'browser=' + m[1] + '\n           server=' + JUNK_RE.toString());

console.log('\n[buildNumberRe — padding tolerant both sides]');
{
  const re = buildNumberRe('032/091');
  assert('032/091 matches 32/91', re.test('Charizard 32/91 Base'));
  assert('032/091 matches 032/091', re.test('Charizard 032/091'));
  assert('032/091 does NOT match 33/91', !re.test('Pikachu 33/91'));
  const bare = buildNumberRe('SWSH039');
  assert('bare number matches on word boundary (39)', bare.test('Promo 39 holo') && !bare.test('Promo 390'));
  assert('empty number → null', buildNumberRe('') === null);
}

console.log('\n[classifyLang]');
assert('kana ⇒ jp', classifyLang('リザードン Charizard') === 'jp');
assert('hangul ⇒ ko', classifyLang('리자몽 Charizard') === 'ko');
assert('"Japanese" keyword ⇒ jp', classifyLang('Charizard Japanese Holo') === 'jp');
assert('French keyword ⇒ eu', classifyLang('Dracaufeu Holo Français') === 'eu');
assert('plain English ⇒ en', classifyLang('Charizard Base Set Holo 4/102') === 'en');
assert('bare Han ⇒ jp (default CJK)', classifyLang('喷火龙 卡') === 'jp' || classifyLang('喷火龙 卡') === 'cn');

console.log('\n[singlesFilter — number + junk + language + finish]');
{
  const rows = [
    { title: 'Charizard 4/102 Base Set Holo NM' },              // keep
    { title: 'Charizard 4/102 Base Set — TOPLOADER lot' },       // junk (toploader + lot)
    { title: 'Pikachu 58/102 Base Set' },                        // wrong number
    { title: 'Charizard 4/102 Japanese Holo' },                  // wrong language for EN
    { title: 'Charizard 4/102 custom proxy' },                   // junk (custom/proxy)
  ];
  const kept = singlesFilter(rows, { numberMatch: '4/102', lang: 'en', finish: null });
  assert('keeps only the clean EN 4/102 single', kept.length === 1 && /NM/.test(kept[0].title), JSON.stringify(kept.map((r) => r.title)));
  // finish split
  const foilRows = [{ title: 'Moonbreon 215/203 alt art foil' }, { title: 'Moonbreon 215/203 non-foil' }];
  assert('finish=foil drops the non-foil', singlesFilter(foilRows, { numberMatch: '215/203', lang: 'en', finish: 'foil' }).length === 1);
}

console.log('\n[isGraded — conditionId first]');
assert('condId 2750 ⇒ graded', isGraded({ condId: '2750', title: 'x' }) === true);
assert('condId 4000 ⇒ not graded even if title says PSA', isGraded({ condId: '4000', title: 'not PSA graded, raw' }) === false);
assert('no condId, "PSA 10" in title ⇒ graded', isGraded({ title: 'Charizard PSA 10 Gem Mint' }) === true);

console.log('\n[ASK_ENDINGS parity with extras.js (GR9)]');
{
  const me = extras.match(/TCG\.ASK_ENDINGS = (\[[^\]]*\]);/);
  assert('extras.js ASK_ENDINGS literal found', !!me, 'literal not located');
  if (me) assert('server ASK_ENDINGS === browser ASK_ENDINGS', me[1] === '[' + ASK_ENDINGS.join(', ') + ']',
    'browser=' + me[1] + '\n           server=[' + ASK_ENDINGS.join(', ') + ']');
}

console.log('\n[snapToEnding — down never goes up, nearest picks the closer side]');
{
  // Down: the undercut direction. Landing ON an ending must be a no-op, or repeated pricing walks
  // a card down a dollar at a time.
  const down = [[10.99, 10.98], [10.49, 10.48], [10.98, 10.98], [10.48, 10.48], [10.29, 9.98], [10.00, 9.98], [1.30, 0.98]];
  for (const [inp, want] of down) assert('down ' + inp + ' → ' + want, snapToEnding(inp, 'down') === want, 'got ' + snapToEnding(inp, 'down'));
  for (const [inp] of down) assert('down never rounds up (' + inp + ')', snapToEnding(inp, 'down') <= inp);
  const near = [[10.29, 10.48], [10.10, 9.98], [10.75, 10.98], [10.70, 10.48]];
  for (const [inp, want] of near) assert('nearest ' + inp + ' → ' + want, snapToEnding(inp, 'nearest') === want, 'got ' + snapToEnding(inp, 'nearest'));
  assert('null/0 pass through untouched', snapToEnding(null) === null && snapToEnding(0) === 0);
}

console.log('\n[recommendedFromCluster — undercut cheapest in-cluster, on a price ending, floor $0.50]');
{
  const c = clusterValue([18.5, 19.0, 19.0, 19.5, 20.0, 55.0]);   // cheapest-in-cluster ~18.5
  const rec = recommendedFromCluster(c);
  assert('never above the cheapest in-cluster', rec < c.cheapestInCluster, 'rec=' + rec + ' clusterLo=' + c.cheapestInCluster);
  assert('lands on a price ending', ASK_ENDINGS.some((e) => Math.abs((rec % 1) - e) < 1e-9), 'rec=' + rec);
  // 18.50 → undercut 18.49 → snapped down to the .48 ending.
  assert('18.50 cluster ⇒ 18.48', rec === 18.48, 'rec=' + rec);
  assert('floors at $0.50', recommendedFromCluster({ cheapestInCluster: 0.2 }) === 0.5);
}

console.log(fails ? `\nCOMPS PARITY: ${fails} FAILURE(S)` : '\nALL COMPS CHECKS PASSED');
process.exit(fails ? 1 : 0);
