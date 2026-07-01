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

const ORIGIN = 'https://api.psacard.com/publicapi';

// Pull a numeric grade out of PSA's grade string ("GEM MT 10", "MINT 9", "10").
function parseGrade(g) {
  if (g == null) return null;
  const m = String(g).match(/(\d+(?:\.\d+)?)\s*$/);
  return m ? parseFloat(m[1]) : null;
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
    if (!r.ok) return { matched: false, reason: 'http_' + r.status };
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
        language: /japan/i.test(category) ? 'JP' : 'EN',
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
