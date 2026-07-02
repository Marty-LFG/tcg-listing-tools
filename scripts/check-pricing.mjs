// scripts/check-pricing.mjs — hybrid pricing engine + fee math harness (AGENTS.md §8).
// Run: node --disable-warning=ExperimentalWarning scripts/check-pricing.mjs
import { resolvePrice, roundAU, tierFloor, rarityClass, loadBulkConfig } from '../lib/pricing.mjs';
import { feeAU, totalFromList, listForTarget, pcSolve } from '../lib/fees.mjs';

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

const cfg = loadBulkConfig();
const rates = { USD: 1, AUD: 1.52 };

console.log('\n[roundAU]');
eq('3.10 → 3.49', roundAU(3.10, cfg), 3.49);
eq('3.60 → 3.99', roundAU(3.60, cfg), 3.99);
eq('3.49 stays 3.49', roundAU(3.49, cfg), 3.49);
eq('0.30 floors to min', roundAU(0.30, cfg), cfg.min_price_aud);
eq('null → null', roundAU(null, cfg), null);

console.log('\n[rarity/tier]');
eq('uncommon before common', rarityClass('Uncommon'), 'uncommon');
eq('common', rarityClass('Common'), 'common');
assert('pokemon common base floor < RH floor', tierFloor(cfg, 'pokemon', 'Common', 'Normal') < tierFloor(cfg, 'pokemon', 'Common', 'Reverse Holofoil'));

console.log('\n[precedence — raw]');
{
  const over = resolvePrice({ game: 'pokemon', rarity: 'Common', finish: 'Normal', override_aud: 5.5, market_aud: 20 }, cfg, rates);
  eq('override wins', [over.value_source, over.price_cents], ['override', 550]);
  const mkt = resolvePrice({ game: 'pokemon', rarity: 'Common', finish: 'Normal', market_aud: 10.58 }, cfg, rates);
  eq('market ≥ threshold → market (rounded up to ending)', [mkt.value_source, mkt.price_cents], ['market', 1099]);
  const tier = resolvePrice({ game: 'pokemon', rarity: 'Common', finish: 'Normal', market_aud: 0.80 }, cfg, rates);
  eq('below threshold → tier floor', [tier.value_source, tier.price_cents], ['bulk_tier', Math.round(tierFloor(cfg, 'pokemon', 'Common', 'Normal') * 100)]);
  assert('tier keeps market_cents for audit', tier.market_cents === 80, String(tier.market_cents));
  const usd = resolvePrice({ game: 'pokemon', rarity: 'Rare', finish: 'Holofoil', market_usd: 10 }, cfg, rates);
  eq('USD converts once (10 USD @1.52 → 15.20 → 15.49)', [usd.value_source, usd.price_cents], ['market', 1549]);
  const none = resolvePrice({ game: 'pokemon', rarity: 'Common', finish: 'Normal' }, cfg, rates);
  eq('no market → tier (never fabricated market)', none.value_source, 'bulk_tier');
}

console.log('\n[precedence — graded (GR4: never fabricate)]');
{
  const collectr = resolvePrice({ game: 'pokemon', graded: true, market_aud: 252962.07 }, cfg, rates);
  eq('Collectr market > 0 wins', collectr.value_source, 'market');
  const pc = resolvePrice({ game: 'pokemon', graded: true, pc_value_usd: 1500 }, cfg, rates);
  eq('market 0/absent → PriceCharting rung', pc.value_source, 'pricecharting');
  assert('PC USD → AUD converted (1500*1.52=2280 → 2280.49)', pc.price_cents === 228049, String(pc.price_cents));
  const nothing = resolvePrice({ game: 'pokemon', graded: true }, cfg, rates);
  eq('nothing usable → needs_price, price null', [nothing.value_source, nothing.price_cents], ['needs_price', null]);
  const over = resolvePrice({ game: 'pokemon', graded: true, override_aud: 999, pc_value_usd: 1 }, cfg, rates);
  eq('override beats PC', [over.value_source, over.price_cents], ['override', 99900]);
}

console.log('\n[fees round-trip (lib/fees.mjs — verbatim lift)]');
for (const target of [5, 21.90, 50, 530.70, 1000, 5210.70]) {
  const r = pcSolve(target);
  assert('pcSolve(' + target + ') diff ≤ 4c', r && Math.abs(r.diff) <= 4, JSON.stringify(r));
  const L = listForTarget(target);
  assert('forward(inverse(' + target + ')) ≈ target', Math.abs(totalFromList(Math.round(L * 100) / 100) - target) < 0.05);
}
assert('feeAU(0) = 0', feeAU(0) === 0);
assert('feeAU monotonic', feeAU(10) < feeAU(100) && feeAU(100) < feeAU(1000));

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PRICING CHECKS PASSED');
process.exit(failures ? 1 : 0);
