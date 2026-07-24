// lib/ebay-taxonomy.mjs — runtime resolution of eBay AU category metadata: the numeric condition
// DESCRIPTOR value IDs (grader / grade / card-condition) that the Sell APIs require for trading-card
// singles, plus a light required-aspect drift check.
//
// Grading is NOT an aspect on category 183454 (verified live 2026-07-24) — it's condition descriptors
// carried on the item condition, with NUMERIC name+value IDs from the Metadata API
// getItemConditionPolicies. Those IDs are marketplace-specific and can drift, so we resolve them LIVE
// (app/client-credentials token — Metadata accepts it, no user consent) and cache by category-tree
// version, with a baked fallback so a listing still builds offline (Golden Rule 7). We NEVER guess a
// grade ID: an unresolved required descriptor is surfaced so the caller blocks publish (Golden Rule 4).
import { ebayToken } from './ebay-token.mjs';

const TAXO = 'https://api.ebay.com/commerce/taxonomy/v1';
const META = 'https://api.ebay.com/sell/metadata/v1';
const MARKET = 'EBAY_AU';
const TREE_ID = '15';                       // eBay AU (baked; re-confirmed live)

// Stable descriptor NAME ids (the "name" side of a condition descriptor).
export const DESCRIPTOR_NAME_ID = {
  'Professional Grader': '27501',
  'Grade': '27502',
  'Certification Number': '27503',
  'Card Condition': '40001',
};
// Baked VALUE ids (the fallback when the live Metadata call is unavailable). Grader + card-condition
// are well-evidenced; for grade only 10 is baked (275020) — every other grade is live-resolved so we
// never ship a guessed grade id.
const BAKED_GRADER_ID = {
  PSA: '275010', BGS: '275013', CGC: '275015', SGC: '275016', TAG: '2750115',
  PCG: '2750118', CGA: '2750120', TCG: '2750121', ARK: '2750122',
};
const BAKED_GRADER_OTHER = '2750123';
const BAKED_CARDCOND_ID = {
  'Near Mint or Better': '400010',
  'Lightly Played (Excellent)': '400015',
  'Moderately Played (Very Good)': '400016',
  'Heavily Played (Poor)': '400017',
};
const BAKED_GRADE_ID = { '10': '275020' };

// --- app-token GET helper (Taxonomy + Metadata both accept the client-credentials token) ---
async function appGet(env, url) {
  if (!(env && String(env.EBAY_APP_ID || '').trim())) return { ok: false, status: 0, json: null };   // no keys → offline, use baked
  const token = await ebayToken(env);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Accept-Language': 'en-AU' } });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, json };
}

// --- caches (module singleton, TTL) ---
const _condCache = new Map();   // categoryId → { at, data }
const CACHE_TTL_MS = 6 * 3600 * 1000;

// Defensively walk getItemConditionPolicies (field names vary across doc versions). Returns, per
// leaf category: { conditions:Set, grader:{name→valueId}, grade:{name→valueId}, cardCondition:{name→valueId} }.
export function parseConditionPolicies(json, categoryId) {
  const out = { conditions: new Set(), grader: {}, grade: {}, cardCondition: {}, cert: {} };
  const policies = (json && (json.itemConditionPolicies || json.conditionPolicies)) || [];
  const pol = policies.find((p) => String(p.categoryId) === String(categoryId)) || policies[0];
  if (!pol) return out;
  const conditions = pol.itemConditions || pol.conditions || [];
  for (const c of conditions) {
    if (c.conditionId != null) out.conditions.add(String(c.conditionId));
    const descs = c.conditionDescriptors || c.descriptors || [];
    for (const d of descs) {
      const nameId = String(d.name != null ? d.name : (d.conditionDescriptorId || ''));
      const values = d.conditionDescriptorValues || d.values || d.conditionDescriptorValueList || [];
      const bucket = nameId === DESCRIPTOR_NAME_ID['Professional Grader'] ? out.grader
        : nameId === DESCRIPTOR_NAME_ID['Grade'] ? out.grade
        : nameId === DESCRIPTOR_NAME_ID['Card Condition'] ? out.cardCondition
        : nameId === DESCRIPTOR_NAME_ID['Certification Number'] ? out.cert : null;
      if (!bucket) continue;
      for (const v of values) {
        const id = String(v.conditionDescriptorValueId != null ? v.conditionDescriptorValueId : (v.valueId != null ? v.valueId : v.id || ''));
        const label = String(v.conditionDescriptorValueName != null ? v.conditionDescriptorValueName : (v.valueName != null ? v.valueName : v.value || v.name || ''));
        if (id && label) bucket[label] = id;
      }
    }
  }
  return out;
}

async function getConditionPolicies(env, categoryId) {
  const hit = _condCache.get(categoryId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  let data = null;
  try {
    const url = `${META}/marketplace/${MARKET}/get_item_condition_policies?filter=categoryIds:%7B${encodeURIComponent(categoryId)}%7D`;
    const r = await appGet(env, url);
    if (r.ok && r.json) data = parseConditionPolicies(r.json, categoryId);
  } catch { /* offline → baked fallback below */ }
  if (data) _condCache.set(categoryId, { at: Date.now(), data });
  return data;
}

// Match a grade string ('10','9.5') to a live value-name map: exact, then a value whose name contains
// the grade as a standalone number (e.g. 'Gem Mint 10' → '10'). Returns the valueId or null.
function matchGradeId(gradeStr, liveMap) {
  if (!liveMap) return null;
  if (liveMap[gradeStr]) return liveMap[gradeStr];
  const g = String(gradeStr).trim();
  const re = new RegExp('(^|\\D)' + g.replace('.', '\\.') + '(\\D|$)');
  for (const [name, id] of Object.entries(liveMap)) if (re.test(name)) return id;
  return null;
}

// resolveConditionDescriptorIds(env, semanticDescriptors, {graded, categoryId})
// semanticDescriptors: the {name, value}[] from ebay-map.mjs (name ∈ Professional Grader / Grade /
// Certification Number / Card Condition). Returns { descriptors:[{name, value:[id]|.., additionalInfo?}],
// unresolved:[names], source:'live'|'baked'|'mixed' }. Cert number stays free-text (additionalInfo).
export async function resolveConditionDescriptorIds(env, semantic, { graded, categoryId = '183454' } = {}) {
  let live = null;
  try { live = await getConditionPolicies(env, categoryId); } catch {}
  const descriptors = [];
  const unresolved = [];
  let usedLive = false, usedBaked = false;

  for (const d of semantic || []) {
    const nameId = DESCRIPTOR_NAME_ID[d.name];
    if (!nameId) continue;
    if (d.name === 'Certification Number') {
      // free-text: goes in additionalInfo, not a value id
      if (d.value) descriptors.push({ name: nameId, additionalInfo: String(d.value).slice(0, 30) });
      continue;
    }
    let valueId = null;
    if (d.name === 'Professional Grader') {
      const code = String(d.value || '').toUpperCase();
      // live map is keyed by long grader name → id; our baked map is keyed by company code.
      valueId = (live && live.grader && Object.keys(live.grader).length)
        ? (live.grader[longGraderName(code)] || null) : null;
      if (valueId) usedLive = true; else { valueId = BAKED_GRADER_ID[code] || BAKED_GRADER_OTHER; usedBaked = true; }
    } else if (d.name === 'Grade') {
      valueId = live ? matchGradeId(String(d.value), live.grade) : null;
      if (valueId) usedLive = true; else if (BAKED_GRADE_ID[String(d.value)]) { valueId = BAKED_GRADE_ID[String(d.value)]; usedBaked = true; }
    } else if (d.name === 'Card Condition') {
      valueId = (live && live.cardCondition && live.cardCondition[d.value]) || null;
      if (valueId) usedLive = true; else { valueId = BAKED_CARDCOND_ID[d.value] || null; usedBaked = true; }
    }
    if (valueId) descriptors.push({ name: nameId, value: [String(valueId)] });
    else unresolved.push(d.name + (d.value ? ' "' + d.value + '"' : ''));
  }
  return { descriptors, unresolved, source: usedLive && usedBaked ? 'mixed' : usedLive ? 'live' : 'baked' };
}

// The long grader value-name eBay uses (mirror of ebay-map's professionalGrader enum) — used to look
// up the live grader value id, which is keyed by the display name.
const LONG_GRADER = {
  PSA: 'Professional Sports Authenticator (PSA)', BGS: 'Beckett Grading Services (BGS)',
  CGC: 'Certified Guaranty Company (CGC)', SGC: 'Sportscard Guaranty Corporation (SGC)',
  TAG: 'Technical Authentication & Grading (TAG)', ARK: 'ARK Grading (ARK)',
  CGA: 'Card Grading Australia (CGA)', PCG: 'Premier Card Grading (PCG)', TCG: 'Trading Card Grading (TCG)',
};
function longGraderName(code) { return LONG_GRADER[code] || code; }

// Light drift check: is category 183454 still returning 'Game' as its (only) required aspect?
// Returns { ok, requiredAspects:[…], drift:boolean } — used by a settings probe, not the hot path.
export async function checkAspectDrift(env, categoryId = '183454') {
  try {
    const url = `${TAXO}/category_tree/${TREE_ID}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
    const r = await appGet(env, url);
    if (!r.ok || !r.json) return { ok: false, error: 'HTTP ' + r.status };
    const req = (r.json.aspects || []).filter((a) => a.aspectConstraint && a.aspectConstraint.aspectRequired).map((a) => a.localizedAspectName);
    return { ok: true, requiredAspects: req, drift: !(req.length === 1 && req[0] === 'Game') };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

export const __test = { matchGradeId, longGraderName, BAKED_GRADER_ID, BAKED_CARDCOND_ID };
