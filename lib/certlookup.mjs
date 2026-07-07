// lib/certlookup.mjs — multi-company cert-lookup registry behind /api/cert.
//
// Reality (researched 2026-07): only PSA exposes an official public cert-verification API.
// Beckett/CGC/SGC/TAG/PCG offer a cert page but no public JSON API, and ARK is NFC/QR-only —
// so for every non-PSA company we return matched:false plus a `verifyUrl` (the official cert
// page, cert pre-filled where the format is known) and let the inventory form fall back to
// MANUAL entry (Golden Rule 7). This is the single extension point: when a company ships a
// usable API/scrape, add a `lookup` fn to PROVIDERS below — the route and UI need no changes.
//
// Company metadata (label / scale / certUrl / lookup flag) lives in data/grading-companies.json
// so the server (verifyUrl) and client (dropdowns) share one source of truth.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupCert as psaLookup, scrapeCert as psaScrape } from './psa.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(path.resolve(__dirname, '..'), 'data', 'grading-companies.json');

// Re-read the registry when the file changes (so edits don't need a restart).
let _cache = null, _mtime = 0;
export function certProviders() {
  try {
    const st = fs.statSync(REGISTRY_PATH);
    if (!_cache || st.mtimeMs !== _mtime) { _cache = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); _mtime = st.mtimeMs; }
    return _cache;
  } catch { return { companies: [] }; }
}
function providerFor(code) {
  return (certProviders().companies || []).find((c) => c.code === String(code || '').toUpperCase()) || null;
}
function buildVerifyUrl(p, cert) {
  if (!p || !p.certUrl) return null;
  return p.certUrl.includes('{cert}') ? p.certUrl.replace('{cert}', encodeURIComponent(cert)) : p.certUrl;
}

// Real per-company auto-fill lookups. PSA is the only one today; add more here as APIs appear.
const PROVIDERS = {
  // PSA's JSON API is quota-capped (~1 call/day on the public tier), so try it but fall back to
  // the public cert-page scrape (no quota) whenever it can't answer — token-less, rate-limited
  // (429), or a genuine miss. Set PSA_CERT_SCRAPE=false to disable the scrape (API-only).
  PSA: async (cert, env) => {
    const api = await psaLookup(cert, (env.PSA_API_TOKEN || '').trim());
    if (api && api.matched) return api;
    if (String(env.PSA_CERT_SCRAPE ?? 'true').toLowerCase() === 'false') return api;
    const scraped = await psaScrape(cert);
    if (scraped && scraped.matched) return scraped;
    return api;   // neither worked — keep the API result so the UI shows the real reason (e.g. 429)
  },
};

// certLookup(company, cert, env) -> normalized shape.
//   PSA (or any company with a PROVIDERS fn) -> { matched, identity, grade, grade_label, ... }
//   everyone else                            -> { matched:false, manual:true, verifyUrl, reason }
// Always carries `company` + `verifyUrl` so the UI can deep-link out even when it can't auto-fill.
export async function certLookup(company, cert, env) {
  const code = String(company || '').toUpperCase();
  const c = String(cert == null ? '' : cert).trim();
  const p = providerFor(code);
  const verifyUrl = buildVerifyUrl(p, c);
  if (!c) return { matched: false, reason: 'no_cert', company: code, verifyUrl: null };
  const fn = PROVIDERS[code];
  if (fn) {
    try {
      const out = await fn(c, env);
      return Object.assign({ company: code, verifyUrl }, out);
    } catch (e) {
      return { matched: false, reason: String((e && e.message) || e), company: code, verifyUrl, manual: true };
    }
  }
  // No auto-fill provider — link out + manual entry.
  return { matched: false, reason: p ? 'no_api' : 'unknown_company', company: code, verifyUrl, manual: true };
}
