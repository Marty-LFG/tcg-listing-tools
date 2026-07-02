// scripts/check-collectr.mjs — Collectr CSV parser harness against the REAL export
// fixtures in data/samples/ (AGENTS.md §8).
// Run: node --disable-warning=ExperimentalWarning scripts/check-collectr.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseCollectr, parseVariance, parseGrade, normalizeNumber, cleanProductName, parseMoney, gameFor, importCollectr } from '../lib/collectr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = fs.readFileSync(path.join(ROOT, 'data', 'samples', 'collectr-30th-vintage-raw.csv'), 'utf8');
const graded = fs.readFileSync(path.join(ROOT, 'data', 'samples', 'collectr-30th-vintage-graded.csv'), 'utf8');

let failures = 0;
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log('  ok  ' + label);
  else { failures++; console.error('FAIL  ' + label + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function assert(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\n[csv mechanics]');
{
  const rows = parseCsv('a,"b,c",d\n"x""y",z,');
  eq('embedded comma survives', rows[0], ['a', 'b,c', 'd']);
  eq('escaped quote survives', rows[1][0], 'x"y');
  eq('parseMoney "4,051.73"', parseMoney('"4,051.73"'), 4051.73);
  eq('parseMoney "252,962.07"', parseMoney('252,962.07'), 252962.07);
  eq('parseMoney 0 → null', parseMoney('0'), null);
  eq('parseMoney empty → null', parseMoney(''), null);
}

console.log('\n[real fixture: raw export]');
{
  const p = parseCollectr(raw);
  eq('30 rows parsed', p.rows.length, 30);
  const lugia = p.rows.find((r) => r.product_name === 'Lugia');
  assert('Lugia found', !!lugia);
  eq('Lugia market survives thousands-comma', parseMoney(lugia.market_price), 4051.73);
  eq('price date extracted from header', lugia.market_price_date, '2026-07-01');
  eq('game mapping', gameFor(lugia.category), 'pokemon');
}

console.log('\n[Variance — all observed values split]');
{
  eq('Normal', parseVariance('Normal'), { edition: null, finish: 'Normal', variant: 'Base' });
  eq('Holofoil', parseVariance('Holofoil'), { edition: null, finish: 'Holofoil', variant: 'Holo' });
  eq('Reverse Holofoil', parseVariance('Reverse Holofoil'), { edition: null, finish: 'Reverse Holofoil', variant: 'Reverse Holo' });
  eq('1st Edition', parseVariance('1st Edition'), { edition: '1st Edition', finish: 'Normal', variant: '1st Edition' });
  eq('Unlimited Holofoil', parseVariance('Unlimited Holofoil'), { edition: 'Unlimited', finish: 'Holofoil', variant: 'Holo' });
  eq('1st Edition Holofoil', parseVariance('1st Edition Holofoil'), { edition: '1st Edition', finish: 'Holofoil', variant: '1st Edition Holo' });
  eq('unknown degrades to Base + no throw', parseVariance('Foil Etched Weirdness').variant.length > 0, true);
}

console.log('\n[number formats]');
{
  eq('bare 4', normalizeNumber('4'), { display: '4', lookupNum: '4' });
  eq('123/172', normalizeNumber('123/172'), { display: '123/172', lookupNum: '123' });
  eq('050/185 strips zeros for lookup', normalizeNumber('050/185'), { display: '050/185', lookupNum: '50' });
  eq('203/193 (secret above total)', normalizeNumber('203/193'), { display: '203/193', lookupNum: '203' });
}

console.log('\n[product-name cleanup]');
{
  eq('Misty (18) + 18 → Misty', cleanProductName('Misty (18)', '18'), 'Misty');
  eq('Dark Tyranitar (19) + 19 → Dark Tyranitar', cleanProductName('Dark Tyranitar (19)', '19'), 'Dark Tyranitar');
  eq('(Full Art) kept', cleanProductName('N (Supporter) (Full Art)', '101'), 'N (Supporter) (Full Art)');
  eq('(Team Plasma) kept', cleanProductName('Genesect EX (Team Plasma)', '11'), 'Genesect EX (Team Plasma)');
  eq('(Bottom) kept', cleanProductName('Darkrai & Cresselia Legend (Bottom)', '100'), 'Darkrai & Cresselia Legend (Bottom)');
}

console.log('\n[Grade — real graded strings]');
{
  eq('Ungraded', parseGrade('Ungraded'), { graded: false });
  eq('PSA 10.0 GEM - MT', parseGrade('PSA 10.0 GEM - MT'), { graded: true, grading_company: 'PSA', grade: 10, grade_label: 'PSA 10.0 GEM - MT' });
  eq('BGS 10.0 Black Label', parseGrade('BGS 10.0 Black Label'), { graded: true, grading_company: 'BGS', grade: 10, grade_label: 'BGS 10.0 Black Label' });
  eq('TAG 10.0 Pristine', parseGrade('TAG 10.0 Pristine'), { graded: true, grading_company: 'TAG', grade: 10, grade_label: 'TAG 10.0 Pristine' });
  eq('CGC 9.5', parseGrade('CGC 9.5 Gem Mint').grade, 9.5);
  assert('garbage degrades to raw + warning', parseGrade('???').graded === false && !!parseGrade('???').warning);
}

console.log('\n[real fixture: graded export end-to-end map]');
{
  const out = importCollectr(graded, { marketCurrency: 'AUD' });
  eq('33 rows', out.rows.length, 33);
  eq('portfolio', out.portfolios, ['30th Vintage']);
  const slabs = out.rows.filter((r) => r.graded);
  eq('3 graded rows', slabs.length, 3);
  const pika = slabs.find((r) => /Pikachu Gold Star/.test(r.name));
  assert('PSA slab has AUD market', pika && pika.market_aud === 252962.07 && pika.market_usd === null, JSON.stringify(pika && { aud: pika.market_aud, usd: pika.market_usd }));
  const tag = slabs.find((r) => r.grading_company === 'TAG');
  assert('TAG slab market null (Collectr 0)', tag && tag.market_aud === null && tag.market_source_value === null);
  const charizardRaw = out.rows.find((r) => /Charizard/.test(r.name) && !r.graded);
  const charizardTag = out.rows.find((r) => /Charizard/.test(r.name) && r.graded);
  assert('same card raw+graded both present', !!charizardRaw && !!charizardTag);
  const firstEd = out.rows.find((r) => r.edition === '1st Edition' && r.finish === 'Holofoil');
  assert('1st Edition Holofoil row (Shining Celebi)', firstEd && /Celebi/.test(firstEd.name), firstEd && firstEd.name);
  eq('quantity int', out.rows[0].quantity, 1);
  const misty = out.rows.find((r) => r.number === '18');
  eq('Misty (18) name cleaned', misty && misty.name, 'Misty');
  eq('USD mode maps to market_usd', importCollectr(graded, { marketCurrency: 'USD' }).rows.find((r) => /Lugia/.test(r.name)).market_usd, 4051.73);
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL COLLECTR CHECKS PASSED');
process.exit(failures ? 1 : 0);
