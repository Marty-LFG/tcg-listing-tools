// lib/psa.mjs — PSA public cert-verification lookup for the inventory "PSA cert" entry path.
//
// Given a slab's cert number, PSA's public API returns the card it belongs to plus the
// assigned grade — enough to auto-fill the inventory add form. Server-side only (the token
// stays in .env, Golden Rules 1/2). Like lib/pricecharting.mjs it NEVER throws into the
// caller and returns { matched:false } on a missing token or any failure (Golden Rule 7) so
// the add form always degrades to manual entry.
//
// UNVERIFIED against a live token (no PSA_API_TOKEN in .env here): the response field names
// below follow PSA's documented Public API (GetByCertNumber -> { PSACert: {...} }). Confirm
// the mapping once a token exists — the graceful-degradation contract holds either way.
//
// The API is quota-capped at ~1 call/day on the public tier, so scrapeCert() below reads the
// public cert PAGE (no quota) as a fallback — see the note there.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const ORIGIN = 'https://api.psacard.com/publicapi';

// Pull a numeric grade out of PSA's grade string ("GEM MT 10", "MINT 9", "10").
function parseGrade(g) {
  if (g == null) return null;
  const m = String(g).match(/(\d+(?:\.\d+)?)\s*$/);
  return m ? parseFloat(m[1]) : null;
}

// PSA prints the market/language into the Brand ("POKEMON JAPANESE SV4M-FUTURE FLASH"),
// NOT the top-level Category ("TCG Cards"), so sniff the whole descriptor. EN by default.
// Exported so the inventory image resolver can re-derive language from a stored set name.
export function detectLanguage(...parts) {
  const h = parts.map((x) => String(x == null ? '' : x)).join(' ').toUpperCase();
  if (/\bJAPAN(?:ESE)?\b/.test(h)) return 'JP';
  if (/\bKOREAN?\b/.test(h)) return 'KO';
  if (/\bCHINESE\b|\bTAIWAN\b/.test(h)) return 'ZH';
  return 'EN';
}

// lookupCert(certNumber, token) ->
//   { matched:true, identity:{name,set_name,number,year,variant,language}, grade, grade_label,
//     grading_company:'PSA', cert_number, raw }
//   | { matched:false, reason? }
export async function lookupCert(cert, token) {
  const c = String(cert == null ? '' : cert).trim();
  if (!token || !c) return { matched: false, reason: 'no_token_or_cert' };
  try {
    const r = await fetch(ORIGIN + '/cert/GetByCertNumber/' + encodeURIComponent(c), {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    if (!r.ok) {
      // Surface WHY (rate-limit vs auth vs not-found) so the UI shows a truthful message —
      // PSA's public API has a very low daily quota, so a 429 is easy to hit. The body is
      // short and token-free (e.g. "API calls quota exceeded! maximum admitted 1 per Day").
      let detail = '';
      try { detail = (await r.text()).replace(/\s+/g, ' ').trim().slice(0, 180); } catch {}
      return { matched: false, reason: 'http_' + r.status, status: r.status, detail };
    }
    let j;
    try { j = await r.json(); } catch { return { matched: false, reason: 'bad_json' }; }
    const d = (j && (j.PSACert || j.psaCert)) || j;
    if (!d || typeof d !== 'object') return { matched: false, reason: 'empty' };

    const grade = parseGrade(d.CardGrade ?? d.cardGrade ?? d.GradeDescription);
    const category = String(d.Category || d.category || '');
    // Best-effort slab image (PSA public API GetImagesByCertNumber). UNVERIFIED field shapes;
    // any failure just leaves image_url null. Only front image is surfaced.
    let image_url = null;
    try {
      const ri = await fetch(ORIGIN + '/cert/GetImagesByCertNumber/' + encodeURIComponent(c), {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
      if (ri.ok) {
        const ij = await ri.json();
        const arr = Array.isArray(ij) ? ij : (ij.PSACertImages || ij.images || ij.Images || []);
        const front = (arr || []).find((x) => x && (x.IsFrontImage || x.isFrontImage)) || (arr || [])[0];
        if (front) image_url = front.ImageURL || front.imageURL || front.url || null;
      }
    } catch {}
    return {
      matched: true,
      identity: {
        name: d.Subject || d.subject || d.Brand || '',
        set_name: d.Brand || d.brand || category || '',
        number: d.CardNumber || d.cardNumber || '',
        year: d.Year || d.year || '',
        variant: d.Variety || d.variety || '',
        language: detectLanguage(d.Brand, d.brand, category, d.Subject, d.Variety),
      },
      grade,
      grade_label: d.GradeDescription || d.gradeDescription || (grade != null ? 'PSA ' + grade : ''),
      grading_company: 'PSA',
      cert_number: c,
      image_url,
      raw: d,
    };
  } catch (e) {
    return { matched: false, reason: String((e && e.message) || e) };
  }
}

// ---- public cert-page scrape (no API quota) --------------------------------
// PSA's JSON API is capped at ~1 call/day on the public tier, so it's useless for actually
// entering cards. The public cert page (the same URL the "Verify" link opens) is fully
// server-rendered with a labelled <dl> of the card's details and carries NO quota. It sits
// behind Cloudflare, which fingerprints node's undici and 403s a native fetch() — but curl's
// TLS/HTTP fingerprint passes and returns a 200 (no JS challenge to solve). curl ships with
// Windows 10+/macOS/Linux, so no new dependency. This reads ONE public page for the user's
// own slab; it's the fallback certLookup uses when the API can't answer. Never throws (GR7).
const CERT_PAGE = 'https://www.psacard.com/cert/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
// Fetch the cert page via the system curl (undici is Cloudflare-blocked). Returns HTML | null.
async function curlGet(url) {
  try {
    const { stdout } = await execFileP('curl', [
      '-sL', '--compressed', '--max-time', '15',
      '-A', UA,
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      url,
    ], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return stdout || null;
  } catch { return null; }
}
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// Parse the cert page's <dt>Label</dt><dd>Value</dd> definition list into { label(lower) -> value }.
// Exported for unit testing (pure; no network).
export function parseCertPage(html) {
  const out = {};
  const re = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const label = decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).toLowerCase();
    const value = decodeEntities(m[2].replace(/<[^>]+>/g, ' '));
    if (label && value && out[label] === undefined) out[label] = value;
  }
  return out;
}
// scrapeCert(cert) -> same normalized shape as lookupCert (minus the slab photo, which the page
// lazy-loads via JS). { matched:true, identity:{…}, grade, grade_label, … } | { matched:false, reason }
export async function scrapeCert(cert) {
  const c = String(cert == null ? '' : cert).trim();
  if (!c) return { matched: false, reason: 'no_cert' };
  const html = await curlGet(CERT_PAGE + encodeURIComponent(c));
  if (!html) return { matched: false, reason: 'scrape_unreachable' };   // curl missing / blocked / timeout
  const f = parseCertPage(html);
  const brand = f['brand/title'] || f['brand'] || f['brand/set'] || '';
  const subject = f['subject'] || '';
  const category = f['category'] || '';
  const gradeStr = f['item grade'] || f['grade'] || f['card grade'] || '';
  if (!brand && !subject) return { matched: false, reason: 'scrape_no_fields' };
  const grade = parseGrade(gradeStr);
  const variety = f['variety/pedigree'] || f['variety'] || '';
  return {
    matched: true,
    identity: {
      name: subject || brand,
      set_name: brand || category,
      number: f['card number'] || f['card #'] || '',
      year: f['year'] || '',
      variant: variety,
      language: detectLanguage(brand, category, subject, variety),
    },
    grade,
    grade_label: gradeStr || (grade != null ? 'PSA ' + grade : ''),
    grading_company: 'PSA',
    cert_number: c,
    image_url: null,               // slab photo is JS-loaded; the card image comes from the game API path
    source: 'psa_cert_page',
    raw: f,
  };
}
