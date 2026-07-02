// lib/fees.mjs — the ONE home for the eBay AU buyer-protection fee math.
//
// Lifted VERBATIM from the landing-page calculator (index.html) so the forward
// (feeAU) and inverse (listForTarget) stay in sync in a single place (AGENTS.md §7).
// Consumers: index.html (<script type="module"> imports this), lib/pricing.mjs
// (target-net back-out + grid fee footer). Dual-target: no DOM, no fetch, no deps.
//
// NOTE: this is the BUYER-protection fee only (what the buyer pays on top of the
// list price) — NOT the seller's selling fees / insertion fees / store allocation
// (AGENTS.md §10). Label any UI using this accordingly.

// Fee bands (AU buyer-protection): $0.30 flat + 8% to $20 + 6% $20–$500 + 4% $500–$5000.
export const FEE_FLAT = 0.30;
export const BAND1_RATE = 0.08, BAND1_TO = 20;
export const BAND2_RATE = 0.06, BAND2_TO = 500;
export const BAND3_RATE = 0.04, BAND3_TO = 5000;

// Forward: fee the buyer pays for a given list price L (AUD, float).
export function feeAU(L) { if (L <= 0) return 0; var f = 0.30; f += 0.08 * Math.min(L, 20); if (L > 20) f += 0.06 * (Math.min(L, 500) - 20); if (L > 500) f += 0.04 * (Math.min(L, 5000) - 500); return f; }

// Buyer's fee-inclusive total for a list price (cent-rounded).
export function totalFromList(L) { return Math.round((L + feeAU(L)) * 100) / 100; }

// Inverse: list price whose buyer total hits target T (band-inverse; keep in sync with feeAU).
export function listForTarget(T) { if (T <= 21.90) return (T - 0.30) / 1.08; if (T <= 530.70) return (T - 0.70) / 1.06; if (T <= 5210.70) return (T - 10.70) / 1.04; return T - 210.70; }

// Cent-search around the analytic inverse for the closest reachable buyer total.
export function pcSolve(T) { if (!(T > 0)) return null; var Lc = Math.round(listForTarget(T) * 100) / 100; var best = null; for (var d = -4; d <= 4; d++) { var L = Math.round((Lc + d * 0.01) * 100) / 100; if (L <= 0) continue; var tot = totalFromList(L); var diff = Math.round((tot - T) * 100); if (best === null || Math.abs(diff) < Math.abs(best.diff) || (Math.abs(diff) === Math.abs(best.diff) && L < best.L)) best = { L: L, tot: tot, diff: diff }; } return best; }
