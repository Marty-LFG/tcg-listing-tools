// lib/runs-config.mjs — where the Keeper's Runs module's own switches live.
//
// A separate file from lib/runs.mjs for one structural reason: lib/status.mjs has to validate this
// config for the settings form, and lib/runs.mjs has to import diagTokenCheck FROM lib/status.mjs to
// gate its manifest route. Keeping the config here means those two imports do not form a cycle.
//
// Same server-owned pattern as the Shopify, repricer and refresh configs: the runtime copy is
// gitignored and rewritten in place by a settings PUT, and it is seeded from the tracked
// data/runs.config.example.json so a fresh deploy is never missing it.
//
// The verification constants are deliberately NOT here. Blob entry length, the PBKDF2 iteration count
// and the verification-code length are all inside the published canon: a run's header commits to them
// and every buyer's verifier depends on them, so a setting that could change one would silently
// invalidate every commitment already anchored. They live as constants in the canon module.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFile } from './config-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_PATH = path.join(ROOT, 'data', 'runs.config.example.json');

export const runsConfigPath = () => configFile('runs.config.json');

export const ANCHOR_MODES = ['stub', 'opentimestamps'];
export const PUBLISH_STORES = ['dev', 'live'];

export function ensureRunsConfigSeeded() {
  try {
    if (!fs.existsSync(runsConfigPath()) && fs.existsSync(EXAMPLE_PATH)) {
      fs.copyFileSync(EXAMPLE_PATH, runsConfigPath());
      console.log('[runs] seeded data/runs.config.json from example');
    }
  } catch (e) { console.warn('[runs] config seed failed —', e?.message || e); }
}

// _comment keys are documentation for whoever opens the file. They are not configuration and have no
// business in an API response or in anything that diffs config.
function stripComments(v) {
  if (Array.isArray(v)) return v.map(stripComments);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_comment').map(([k, x]) => [k, stripComments(x)]));
  }
  return v;
}

// DISARMED IS THE FALLBACK. An unreadable or absent config must not read as "armed" — that is how a
// missing file becomes a live publish. Every default below is the safe one.
const DISARMED = {
  publish: { enabled: false, store: 'dev' },
  anchor: { mode: 'stub', calendars: [], upgrade_interval_min: 60 },
  public: { no_prices: true, publish_contents_before_close: false, verify_base_url: '' },
};

let _warned = false;
export function loadRunsConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(runsConfigPath(), 'utf8'));
    const c = stripComments(raw);
    return {
      publish: { ...DISARMED.publish, ...(c.publish || {}) },
      anchor: { ...DISARMED.anchor, ...(c.anchor || {}) },
      // Spread order matters here and nowhere else: the guardrails are read from the file but a
      // MISSING key falls back to the safe value rather than to undefined, which is falsy and would
      // read as "prices are fine".
      public: { ...DISARMED.public, ...(c.public || {}) },
    };
  } catch (e) {
    if (!_warned) { _warned = true; console.warn('[runs] no readable config — running disarmed:', e?.message || e); }
    return structuredClone(DISARMED);
  }
}

// Shared by the settings validator and by anything that wants to explain a refusal. Returns an error
// string or null, matching the shape lib/status.mjs SETTINGS expects.
export function validateRunsConfig(c) {
  // The storefront the printed insert's QR points at. Empty means "use whatever origin the print page
  // is served from", which is right for a rehearsal and wrong for a real parcel — a buyer cannot reach
  // a LAN address. Validated here because a wrong value is discovered on paper, inside a sealed box.
  const base = c && c.public && c.public.verify_base_url;
  if (base != null && base !== '') {
    if (typeof base !== 'string') return 'public.verify_base_url must be a string';
    let u = null;
    try { u = new URL(base); } catch { return `public.verify_base_url "${base}" is not a URL`; }
    if (u.protocol !== 'https:') return 'public.verify_base_url must be https — the code travels in the fragment, and http would expose the whole page';
    if (u.hash) return 'public.verify_base_url must not carry a fragment; the code goes there';
    if (u.search) return 'public.verify_base_url must not carry a query string';
  }
  if (!c || typeof c !== 'object') return 'not an object';
  const p = c.publish, a = c.anchor, pub = c.public;
  if (!p || typeof p !== 'object') return 'publish required';
  if (typeof p.enabled !== 'boolean') return 'publish.enabled must be boolean';
  if (!PUBLISH_STORES.includes(p.store)) return `publish.store must be ${PUBLISH_STORES.join(' or ')}`;

  if (!a || typeof a !== 'object') return 'anchor required';
  if (!ANCHOR_MODES.includes(a.mode)) return `anchor.mode must be ${ANCHOR_MODES.join(' or ')}`;
  if (!Array.isArray(a.calendars)) return 'anchor.calendars must be an array';
  for (const u of a.calendars) {
    if (typeof u !== 'string' || !/^https:\/\//.test(u)) return `anchor.calendars: "${u}" must be an https URL`;
  }
  if (a.mode === 'opentimestamps' && !a.calendars.length) return 'anchor.mode opentimestamps needs at least one calendar';
  if (!(Number.isInteger(a.upgrade_interval_min) && a.upgrade_interval_min >= 5 && a.upgrade_interval_min <= 1440)) {
    return 'anchor.upgrade_interval_min must be a whole number of minutes, 5–1440';
  }

  // The two guardrails from the plan's §2.2, restated as a refusal rather than a comment. Neither has
  // a legitimate "off" — a run that shows a price or publishes contents before close has broken the
  // thing customers were told they were buying — so the validator refuses instead of warning.
  if (!pub || typeof pub !== 'object') return 'public required';
  if (pub.no_prices !== true) return 'public.no_prices must stay true — no monetary value is ever customer-facing';
  if (pub.publish_contents_before_close !== false) {
    return 'public.publish_contents_before_close must stay false — contents are disclosed only once a run closes';
  }

  // A stub anchor is a synthetic receipt. Selling against one would put a run on a real storefront
  // claiming a Bitcoin timestamp that does not exist, which is the one lie the whole product is
  // built to make impossible.
  if (p.enabled && p.store === 'live' && a.mode === 'stub') {
    return 'a stub anchor can never target the live store — set anchor.mode to opentimestamps first';
  }
  return null;
}
