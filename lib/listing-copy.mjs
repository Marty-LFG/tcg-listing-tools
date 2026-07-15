// lib/listing-copy.mjs — single shared source for eBay TITLES + DESCRIPTIONS used by
// the bulk listing tool (grid preview, channel mappers, harnesses).
//
// MIRROR RULE (Golden Rules 6 + 9, same convention as lib/normalize.mjs): the
// browser builders keep their own inline copies (extras.js TCG.fitTitle/condCode/
// langCode; each builder's genTitle()/buildHTML()) because they are classic
// <script>s that cannot import ESM. The functions below are VERBATIM ports —
// if you change one side, change the other. scripts/check-listing-copy.mjs
// enforces byte-identical parity; run it after touching either side.
//   - fitTitle / condCode / langCode  ⇄  extras.js:682-719
//   - pokemon titleParts/buildDescription ⇄ pokemon-listing-builder.html genTitle()/genPitch()/buildHTML()
//   - lorcana titleParts/buildDescription ⇄ lorcana-listing-builder.html genTitle()/genPitch()/buildHTML()
//
// Pure/dual-target: no DOM, no fetch, no DB — importable by Vite plugins, Node
// harnesses, and <script type="module"> pages (the bulk builder).

// ---------------------------------------------------------------------------
// Owner-verified wording (Golden Rule 6) — for CARD (raw single) listings.
// Do not reword. The LEGO/Funko builders have their own wording; not mirrored here.
// ---------------------------------------------------------------------------
export const CARD_CONDITION_SUFFIX = '. Pulled straight to sleeve and stored in a toploader.';
export const CARD_POSTAGE = 'Ships in a penny sleeve and toploader inside a rigid mailer, with FREE postage within Australia.';
export const CARD_FOOTER = 'From a smoke-free home. Fast dispatch. Thanks for looking.';
export const DEFAULT_CARD_CONDITION = 'Ungraded, Near Mint';   // safest default — under-promises (INAD safety)

// GRADED-slab wording — the card penny-sleeve/toploader lines are physically wrong
// for an encapsulated slab. ⚠ OWNER-REVIEW: new wording, not yet owner-verified;
// kept minimal + under-promising until confirmed (tracked in docs/BULK_LISTING_DESIGN.md).
export const SLAB_CONDITION_SUFFIX = '. Professionally graded and encapsulated — see photos and item specifics for the cert details.';
export const SLAB_POSTAGE = 'Ships securely inside a rigid mailer, with FREE postage within Australia.';

// ---------------------------------------------------------------------------
// Variant vocabulary — THE single source (Golden Rule 5). identity variant =
// edition + finish joined, so 1st Edition vs Unlimited printings never merge
// in inventory (uq_inv_bulk_identity keys on this string).
// ---------------------------------------------------------------------------

// Source printing key -> finish label. Pokémon keys are tcgplayer.prices keys;
// Lorcana keys are the Lorcast price fields.
export const PRINTING_TO_FINISH = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  reverseHolofoil: 'Reverse Holofoil',
  '1stEditionNormal': 'Normal',
  '1stEditionHolofoil': 'Holofoil',
  unlimited: 'Normal',
  unlimitedHolofoil: 'Holofoil',
  usd: 'Normal',
  usd_foil: 'Foil',
};
// Printing keys that also imply an edition (vintage Pokémon).
export const PRINTING_TO_EDITION = {
  '1stEditionNormal': '1st Edition',
  '1stEditionHolofoil': '1st Edition',
  unlimited: 'Unlimited',
  unlimitedHolofoil: 'Unlimited',
};

// Canonical identity/display variant from (edition, finish).
// 'Base' = plain non-foil so an empty string never lands in the UNIQUE index.
export function variantToken(edition, finish) {
  const f = (finish || '').trim();
  const base = /reverse/i.test(f) ? 'Reverse Holo'
    : /holo/i.test(f) ? 'Holo'
    : /enchanted/i.test(f) ? 'Enchanted'
    : /foil/i.test(f) ? 'Foil'
    : 'Base';
  const e = (edition || '').trim();
  if (!e || /unlimited/i.test(e)) {
    // Unlimited is the default printing — only 1st Edition marks the variant,
    // but keep explicit Unlimited when the source said so AND a 1st Ed exists
    // is unknowable here; 'Unlimited Holo' stays distinct from 'Holo' would
    // split identities, so Unlimited collapses to the base token.
    return base;
  }
  return base === 'Base' ? e : e + ' ' + base;   // '1st Edition' | '1st Edition Holo' …
}

// The finish string as the single-card builders' f_finish expects it (for titles).
export function finishTitleInput(finish) { return finish || ''; }

// ---------------------------------------------------------------------------
// fitTitle / condCode / langCode — VERBATIM ports of extras.js:682-719.
// ---------------------------------------------------------------------------
export function condCode(s) {
  s = (s || '').trim(); var l = s.toLowerCase();
  var g = l.match(/(psa|cgc|bgs|sgc)\s*([0-9]+(?:\.5)?)/);
  if (g) return g[1].toUpperCase() + ' ' + g[2];
  if (/near\s*mint|\bnm\b/.test(l)) return 'M/NM';
  if (/\bmint\b|^m$/.test(l)) return 'M';
  if (/lightly\s*played|\blp\b/.test(l)) return 'LP';
  if (/moderately\s*played|\bmp\b/.test(l)) return 'MP';
  if (/heavily\s*played|\bhp\b/.test(l)) return 'HP';
  if (/damaged|\bdmg\b|\bpoor\b/.test(l)) return 'DMG';
  if (/excellent|\bex\b/.test(l)) return 'EX';
  return (s.split(/[\s,]+/)[0] || '').toUpperCase();
}

export function langCode(s) {
  var l = (s || '').trim().toLowerCase().replace(/\s*\(.*$/, '');   // "Chinese (Simp.)" -> "chinese"
  var map = { english: 'EN', japanese: 'JP', chinese: 'ZH', korean: 'KO', german: 'DE', french: 'FR', italian: 'IT', spanish: 'ES', portuguese: 'PT', russian: 'RU' };
  if (map[l]) return map[l];
  if (!s) return 'EN';
  return s.length <= 3 ? s.toUpperCase() : s.slice(0, 2).toUpperCase();
}

export function fitTitle(parts, max) {
  max = max || 80;
  parts = (parts || []).filter(function (p) { return p && p.text != null && ('' + p.text).trim() !== ''; });
  function join(ps) { return ps.map(function (p) { return ('' + p.text).trim(); }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(); }
  var cur = parts.map(function (p) { return Object.assign({}, p); });
  if (join(cur).length <= max) return join(cur);
  cur = parts.map(function (p) { return Object.assign({}, p, { text: (p.abbr != null ? p.abbr : p.text) }); });
  if (join(cur).length <= max) return join(cur);
  cur = cur.filter(function (p) { return p.text != null && ('' + p.text).trim() !== ''; });
  while (join(cur).length > max && cur.length > 1) {
    var idx = -1, lo = Infinity;
    cur.forEach(function (p, i) { var pr = (p.prio == null ? 50 : p.prio); if (pr < lo) { lo = pr; idx = i; } });
    if (idx < 0) break; cur.splice(idx, 1);
  }
  var out = join(cur);
  if (out.length > max) out = out.slice(0, max).trim();
  return out;
}

// ---------------------------------------------------------------------------
// Graded title token — 'PSA 10 GEM MINT' / 'BGS 10 BLACK LABEL' / 'TAG 10 PRISTINE'.
// Normalises grader shorthand; strips a leading company/grade repeat from the label.
// ---------------------------------------------------------------------------
const GRADE_LABEL_NORMALISE = { 'GEM - MT': 'GEM MINT', 'GEM MT': 'GEM MINT', 'GEM-MT': 'GEM MINT', 'NM - MT': 'NM-MT', 'MINT+': 'MINT' };
export function gradeTitleToken(company, grade, label) {
  const co = (company || '').toUpperCase().trim();
  const g = grade == null ? '' : (Math.round(+grade * 10) / 10 + '').replace(/\.0$/, '');
  let lab = (label || '').toUpperCase().trim();
  lab = lab.replace(new RegExp('^' + co + '\\s*', 'i'), '').replace(/^\d+(?:\.\d+)?\s*/, '').trim();
  lab = GRADE_LABEL_NORMALISE[lab] || lab;
  if (lab === g || lab === co) lab = '';
  return [co, g, lab].filter(Boolean).join(' ').trim();
}

// ---------------------------------------------------------------------------
// Per-game title parts — VERBATIM logic of each builder's genTitle(), taking the
// builder's field object f = {name,num,set,rarity,finish|variant,lang,cond} and
// bulk-only extras {edition, graded, grading_company, grade, grade_label}.
// When the bulk extras are absent the output is byte-identical to the builder.
// ---------------------------------------------------------------------------

// pokemon-listing-builder.html PKM_RAB rarity abbreviations (title token + details-row display).
const PKM_RAB = { 'special illustration rare': 'SIR', 'illustration rare': 'IR', 'ultra rare': 'UR', 'hyper rare': 'HR', 'double rare': 'RR', 'secret rare': 'Secret', 'rare secret': 'Secret', 'amazing rare': 'AR', 'radiant rare': 'Radiant', 'rare rainbow': 'Rainbow', 'art rare': 'AR', 'special art rare': 'SAR' };
// MIRROR of pokemon-listing-builder.html rarDisplay(): "Illustration Rare (IR)" for the details row.
function rarDisplay(r) { if (!r) return ''; const rl = ('' + r).toLowerCase(), ab = PKM_RAB[rl]; return ab && ab.toLowerCase() !== rl ? r + ' (' + ab + ')' : r; }

// lorcana-listing-builder.html rarAbbr().
export function lorcanaRarAbbr(r) {
  var rl = (r || '').toLowerCase();
  if (/enchanted/.test(rl)) return 'ENH';
  if (/legendary/.test(rl)) return 'LEG';
  if (/super\s*rare/.test(rl)) return 'SR';
  if (/\brare\b/.test(rl)) return 'RARE';
  return '';
}

export function titleParts(game, f) {
  f = f || {};
  const graded = !!(f.graded || f.grading_company);
  // Graded slabs: the grade token replaces the condition code and outranks nearly
  // everything (prio 90) so it survives 80-char pressure. Edition (1st Edition /
  // Unlimited on vintage) is a top-tier value signal (Golden Rule 5): prio 90.
  const condPart = graded
    ? { text: gradeTitleToken(f.grading_company, f.grade, f.grade_label), prio: 90 }
    : { text: condCode(f.cond), prio: 62 };
  const editionPart = { text: /1st/i.test(f.edition || '') ? '1st Edition' : '', prio: 90 };

  if (game === 'pokemon') {
    var name = f.name || '', num = f.num || '', setn = f.set || '', rar = f.rarity || '', fin = f.finish || '', lang = f.lang || '';
    var rl = (rar || '').toLowerCase(); var rarShort = PKM_RAB[rl] || rar;
    var finTok = '', finAbbr = ''; if (/reverse/i.test(fin)) { finTok = 'Reverse Holo'; finAbbr = 'RH'; } else if (/holo/i.test(fin)) { finTok = 'Holo'; finAbbr = 'Holo'; }
    return [
      { text: 'Pokemon', prio: 45 },
      { text: name, prio: 100 },
      { text: num, prio: 85 },
      editionPart,
      { text: setn, prio: 70 },
      { text: rar, abbr: rarShort, prio: 78 },
      { text: finTok, abbr: finAbbr, prio: 55 },
      { text: langCode(lang), prio: /^\s*english\s*$/i.test(lang) ? 30 : 66 },   // non-EN: keep JP/ZH/KO in title (INAD safety)
      condPart,
    ];
  }
  if (game === 'lorcana') {
    var lname = f.name || '', lnum = f.num || '', lset = f.set || '', lrar = f.rarity || '', variant = f.variant || '', llang = f.lang || '';
    var code = ((lset || '').match(/\(([^)]+)\)/) || [])[1] || '';
    var v = (variant || '').trim(); if (/standard|normal|base|none/i.test(v)) v = '';
    return [
      { text: lname, prio: 100 },
      { text: lnum, prio: 88 },
      { text: '- Disney Lorcana ' + (lset || ''), abbr: '- Lorcana' + (code ? ' (' + code + ')' : ''), prio: 72 },
      { text: langCode(llang), prio: 30 },
      { text: v ? v.toUpperCase() : '', prio: 80 },
      { text: lorcanaRarAbbr(lrar), prio: 58 },
      condPart,
    ];
  }
  if (game === 'riftbound') {
    // VERBATIM port of riftbound-listing-builder.html genTitle() (MIRROR RULE, GR6/9).
    var rname = f.name || '', rnum = f.num || '', rset = f.set || '', rrar = f.rarity || '', rvar = f.variant || '', rfin = f.finish || '', rlang = f.lang || '';
    var numHead = ((rnum || '').split('/')[0] || '');
    var isAlt = (rvar === 'Alternate Art') || /[a-z]$/i.test(numHead);
    var altParen = (rvar === 'Overnumbered') ? '(Overnumbered)' : (isAlt ? '(Alt Art)' : '');
    var rcode = ((rset || '').match(/\(([^)]+)\)/) || [])[1] || '';
    var rar = (rrar || '').trim();
    if (/common|uncommon|^rare$/i.test(rar)) rar = '';
    var rarTok = '';
    if (rar && rar.replace(/[()]/g, '').toLowerCase() !== altParen.replace(/[()]/g, '').toLowerCase()) rarTok = rar.toUpperCase();
    var foilTok = (!rarTok && rfin === 'Foil') ? 'FOIL' : '';
    return [
      { text: rname, prio: 100 },
      { text: altParen, prio: 60 },
      { text: rnum, prio: 88 },
      { text: '- Riftbound ' + (rset || ''), abbr: '- Riftbound' + (rcode ? ' (' + rcode + ')' : ''), prio: 72 },
      { text: langCode(rlang), prio: 30 },
      { text: rarTok, prio: 80 },
      { text: foilTok, prio: 55 },
      condPart,
    ];
  }
  // Generic fallback (games without a dedicated parts model yet): name-first.
  return [
    { text: f.name || '', prio: 100 },
    { text: f.num || '', prio: 85 },
    editionPart,
    { text: f.set || '', prio: 70 },
    { text: f.rarity || '', prio: 60 },
    { text: (f.finish || f.variant || ''), prio: 55 },
    { text: langCode(f.lang), prio: 30 },
    condPart,
  ];
}

export function buildTitle(game, f, max) { return fitTitle(titleParts(game, f), max || 80); }

// ---------------------------------------------------------------------------
// Descriptions — VERBATIM ports of each builder's genPitch() + buildHTML()
// (inline styles ONLY, Golden Rule 8; owner-verified wording, Golden Rule 6).
// opts (bulk-only, absent => byte-identical to the builder):
//   { slab: true }  graded slab — swaps the condition/postage lines for the slab wording.
// ---------------------------------------------------------------------------
function esc(s) { return ('' + (s == null ? '' : s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Subgrades -> a compact "Centering 9.5 · Corners 9 · Edges 9.5 · Surface 10" line for the
// description. Accepts the inventory shape (a {centering,corners,edges,surface} object or its
// JSON string) and passes an already-display string through unchanged (the single builder types
// it free-form). Blank when there's nothing gradeable.
export function formatSubgrades(sg) {
  if (!sg) return '';
  let o = sg;
  if (typeof sg === 'string') {
    const t = sg.trim();
    if (!t) return '';
    if (t[0] !== '{') return t;                       // already a display string — verbatim
    try { o = JSON.parse(t); } catch { return t; }
  }
  if (!o || typeof o !== 'object') return String(o);
  const parts = [];
  if (o.centering != null) parts.push('Centering ' + o.centering);
  if (o.corners != null) parts.push('Corners ' + o.corners);
  if (o.edges != null) parts.push('Edges ' + o.edges);
  if (o.surface != null) parts.push('Surface ' + o.surface);
  return parts.join(' · ');
}

export function pokemonPitch(f) {
  const chase = /(illustration|special|hyper|secret|ultra|rainbow|gold|alt)/i.test(f.rarity);
  if (chase) return `${f.name} — a sought-after ${f.rarity} from the Pokémon TCG ${f.set} set. A standout chase card for collectors.`;
  return `${f.name} from the Pokémon TCG ${f.set} set${f.stage ? ', ' + f.stage : ''}.${f.rarity ? ' ' + f.rarity + ' rarity.' : ''}`;
}

export function lorcanaPitch(f, rawRarity, setName) {
  const name = f.name, type = (f.type || 'card').toLowerCase();
  const ink = f.ink, v = f.variant;
  const foil = /foil/i.test(v || '');
  const chaseRarity = ['Legendary', 'Super Rare', 'Enchanted'].includes(rawRarity);
  const inkPhrase = ink ? ink + '-ink ' : '';
  if (foil || chaseRarity) {
    const vWord = foil ? 'foil ' : '';
    return `The ${vWord}${name} ${type} from Disney Lorcana — ${setName}. A ${inkPhrase}standout chase card prized by collectors and players alike.`;
  }
  return `${name} — a ${inkPhrase}${type} from Disney Lorcana's ${setName} set. ${rawRarity || ''} rarity${foil ? ', foil finish' : ''}.`;
}

// riftbound-listing-builder.html mapRarity() — inlined (listing-copy stays browser-safe,
// so it cannot import the fs-backed lib/riftbound-data.mjs).
function rbMapRarity(r) { return r === 'Alternate Art' ? 'Showcase' : (r || ''); }

// VERBATIM port of riftbound-listing-builder.html genPitch(f, rawRarity) (MIRROR RULE).
export function riftboundPitch(f, rawRarity) {
  const setName = f.setName, name = f.name, type = (f.type || 'card'), dom = f.domain;
  const fin = f.finish === 'Foil' ? 'foil ' : '';
  const _alt = rawRarity === 'Alternate Art' || rawRarity === 'Showcase' || /\(alternate art\)/i.test(name);
  if (_alt) return `The Showcase alternate-art ${name} from Riftbound's ${setName} set — the premium full-art treatment and a standout chase card for collectors.`;
  if (rawRarity === 'Overnumbered') return `The Overnumbered full-art ${name} from Riftbound's ${setName} set — a sought-after special-rarity chase card for collectors.`;
  if (rawRarity === 'Epic') return `The Epic ${fin}${name} from Riftbound's ${setName} set — a ${dom || ''}${dom ? '-domain ' : ''}${type.toLowerCase()} and a solid pickup for collectors and players.`;
  return `${name} from Riftbound's ${setName} set — a ${dom ? dom + '-domain ' : ''}${type.toLowerCase()}${fin ? ', ' + f.finish.toLowerCase() : ''}. ${rbMapRarity(rawRarity)} rarity.`;
}

// A graded slab if the condition names a grading company + numeric grade — "PSA 10", "BGS 9.5",
// gradeTitleToken() output ("TAG 10 PRISTINE"), etc. Drives the slab-vs-raw wording swap when the
// caller passes no explicit opts.slab (the single-card builders don't). MIRROR: the same regex is
// inlined in pokemon-listing-builder.html buildHTML() — keep both sides identical (GR6/9).
export function isSlabCondition(cond) {
  return /\b(psa|bgs|cgc|sgc|ace|tag)\b\s*\d/i.test(cond || '');
}

function condPostage(f, opts) {
  const slab = !!(opts && opts.slab);
  return {
    cond: esc(f.cond) + esc(slab ? SLAB_CONDITION_SUFFIX : CARD_CONDITION_SUFFIX),
    postage: esc(slab ? SLAB_POSTAGE : CARD_POSTAGE),
  };
}

export function buildDescription(game, f, opts) {
  f = f || {};
  // Explicit opts.slab wins (the bulk/channel export passes it for graded rows). Otherwise INFER a
  // graded slab from the condition string — but only for the pokemon/generic frame, so the
  // lorcana/riftbound builders (raw-only single tools) keep their byte-identical mirrors.
  const slab = (opts && opts.slab != null) ? !!opts.slab
    : (game !== 'lorcana' && game !== 'riftbound' && isSlabCondition(f.cond));
  const cp = condPostage(f, { slab });
  if (game === 'lorcana') {
    const rows = [['Set', f.set], ['Card number', f.num],
      ['Rarity', f.rarity + (f.variant && f.variant !== 'Standard' ? ' — ' + f.variant : '')],
      ['Card type', f.type]];
    if (f.ink) rows.push(['Ink', f.ink]);
    if (f.cls) rows.push(['Classifications', f.cls]);
    const stat = [f.cost, f.strength, f.willpower, f.lore];
    if (stat.some(x => x !== '' && x != null)) rows.push(['Cost / Strength / Willpower / Lore', stat.map(x => (x === '' || x == null) ? '–' : x).join(' / ')]);
    rows.push(['Finish', f.variant]); rows.push(['Language', f.lang]);
    if (opts && opts.extraRows) rows.push(...opts.extraRows);
    let tr = '';
    rows.forEach((r, i) => { const bg = i % 2 === 0 ? 'background:#f6f7f9;' : '';
      tr += `<tr style="${bg}"><td style="padding:9px 12px;color:#6b6b7e;width:38%;">${esc(r[0])}</td><td style="padding:9px 12px;color:#1a1a22;font-weight:600;">${esc(r[1])}</td></tr>`; });
    const vSpan = (f.variant && f.variant !== 'Standard') ? ` <span style="color:#b6bac4;font-weight:600;">(${esc(f.variant)})</span>` : '';
    return `<div style="max-width:760px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a22;line-height:1.55;font-size:15px;">
  <div style="background:#1a1326;border-radius:10px 10px 0 0;padding:22px 24px;border-bottom:3px solid #c9a24b;">
    <div style="color:#c9a24b;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:6px;">Disney Lorcana</div>
    <div style="color:#ffffff;font-size:22px;font-weight:700;line-height:1.25;">${esc(f.name)}${vSpan}</div>
    <div style="color:#9a91ad;font-size:14px;margin-top:4px;">${esc(f.num)} &middot; ${esc(f.set)} &middot; ${esc(f.rarity)}</div>
  </div>
  <div style="padding:20px 24px 4px;"><p style="margin:0 0 16px;">${esc(f.pitch)}</p></div>
  <div style="padding:0 24px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1a1326;font-weight:700;border-bottom:2px solid #e8eaee;padding-bottom:6px;margin-bottom:4px;">Card details</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>${tr}</tbody></table>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="background:#f6f7f9;border-left:4px solid #1a1326;border-radius:0 8px 8px 0;padding:14px 16px;">
      <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1a1326;font-weight:700;margin-bottom:4px;">Condition</div>
      <p style="margin:0;">${cp.cond}</p>
    </div>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1a1326;font-weight:700;border-bottom:2px solid #e8eaee;padding-bottom:6px;margin-bottom:10px;">Postage &amp; protection</div>
    <p style="margin:0;">${cp.postage}</p>
  </div>
  <div style="padding:18px 24px 22px;"><p style="margin:0;color:#6b6b7e;font-size:13px;">${esc(CARD_FOOTER)}</p></div>
</div>`;
  }
  if (game === 'riftbound') {
    // VERBATIM port of riftbound-listing-builder.html buildHTML() (LoL palette; MIRROR RULE, GR6/8/9).
    const rows = [['Set', f.set], ['Card number', f.num], ['Rarity', f.rarity + (f.variant ? ' — ' + f.variant : '')], ['Card type', f.type], ['Domain', f.domain]];
    if (f.tags) rows.push(['Tags', f.tags]);
    if ((f.e || f.p || f.m) && /unit/i.test(f.type || '')) rows.push(['Energy / Power / Might', [f.e, f.p, f.m].filter(x => x !== '').join(' / ')]);
    rows.push(['Finish', f.finish]); rows.push(['Language', f.lang]);
    let tr = ''; rows.forEach((r, i) => { const bg = i % 2 === 0 ? 'background:#f5f6fa;' : '';
      tr += `<tr style="${bg}"><td style="padding:9px 12px;color:#6b6b7e;width:38%;">${esc(r[0])}</td><td style="padding:9px 12px;color:#1a1a22;font-weight:600;">${esc(r[1])}</td></tr>`; });
    const vSpan = f.variant ? ` <span style="color:#aeb9d4;font-weight:600;">(${esc(f.variant)})</span>` : '';
    return `<div style="max-width:760px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a22;line-height:1.55;font-size:15px;">
  <div style="background:#091428;border-radius:10px 10px 0 0;padding:22px 24px;border-bottom:3px solid #c8aa6e;">
    <div style="color:#c8aa6e;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:6px;">Riftbound &middot; League of Legends TCG</div>
    <div style="color:#ffffff;font-size:22px;font-weight:700;line-height:1.25;">${esc(f.name)}${vSpan}</div>
    <div style="color:#7e8db0;font-size:14px;margin-top:4px;">${esc(f.num)} &middot; ${esc(f.set)} &middot; ${esc(f.rarity)}</div>
  </div>
  <div style="padding:20px 24px 4px;"><p style="margin:0 0 16px;">${esc(f.pitch)}</p></div>
  <div style="padding:0 24px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#091428;font-weight:700;border-bottom:2px solid #e6e9f2;padding-bottom:6px;margin-bottom:4px;">Card details</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>${tr}</tbody></table>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="background:#f5f6fa;border-left:4px solid #c8aa6e;border-radius:0 8px 8px 0;padding:14px 16px;">
      <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#091428;font-weight:700;margin-bottom:4px;">Condition</div>
      <p style="margin:0;">${cp.cond}</p>
    </div>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#091428;font-weight:700;border-bottom:2px solid #e6e9f2;padding-bottom:6px;margin-bottom:10px;">Postage &amp; protection</div>
    <p style="margin:0;">${cp.postage}</p>
  </div>
  <div style="padding:18px 24px 22px;"><p style="margin:0;color:#6b6b7e;font-size:13px;">${esc(CARD_FOOTER)}</p></div>
</div>`;
  }
  // pokemon + generic fallback share the Pokémon frame (navy/gold) — the generic
  // case only differs in the eyebrow text.
  const eyebrow = game === 'pokemon' ? 'Pok&eacute;mon TCG' : esc(f.gameLabel || 'Trading Card');
  // MIRROR of pokemon-listing-builder.html buildHTML() rows — conditional rows self-skip when empty.
  const nlab = (f.lang || '').replace(/\s*\(.*$/, '').trim() || 'Original';
  const rows = [['Card Name', f.name]];
  if (f.nativeName) rows.push([nlab + ' name', f.nativeName + (f.romaji ? ' ' + f.romaji : '')]);
  rows.push(['Set', f.set + (f.nativeSet ? ' (' + f.nativeSet + ')' : '')]);
  if (f.setSymbol) rows.push(['Set Symbol', f.setSymbol]);
  rows.push(['Card number', f.num]);
  rows.push(['Rarity', rarDisplay(f.rarity)]);
  if (game === 'pokemon') { rows.push(['Pokémon', f.poke]); rows.push(['Stage', f.stage]); }   // Pokémon-only rows
  if (f.type) rows.push(['Type', f.type]);
  if (f.hp) rows.push(['HP', f.hp]);
  if (f.illustrator) rows.push(['Illustrator', f.illustrator]);
  if (f.regMark) rows.push(['Regulation mark', f.regMark]);
  if (f.edition) rows.push(['Edition', f.edition]);
  rows.push(['Finish', f.finish]); rows.push(['Language', f.lang]);
  if (f.releaseYear) rows.push(['Released', f.releaseYear]);
  if (f.enSet) rows.push(['English set', f.enSet]);
  if (f.cert) rows.push(['Cert number', f.cert]);
  if (f.subgrades) rows.push(['Subgrades', f.subgrades]);
  if (opts && opts.extraRows) rows.push(...opts.extraRows);
  let tr = ''; rows.forEach((r, i) => { const bg = i % 2 === 0 ? 'background:#f6f8fc;' : '';
    tr += `<tr style="${bg}"><td style="padding:9px 12px;color:#6b6b7e;width:38%;">${esc(r[0])}</td><td style="padding:9px 12px;color:#1a1a22;font-weight:600;">${esc(r[1])}</td></tr>`; });
  const imgHtml = f.img ? `<div style="text-align:center;padding:16px 24px 0;"><img src="${esc(f.img)}" alt="${esc(f.name)} ${esc(f.num)} ${esc(f.set)} Pok&eacute;mon TCG ${esc(f.lang)} card" style="max-width:320px;width:100%;height:auto;border-radius:8px;" /></div>` : '';
  return `<div style="max-width:760px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a22;line-height:1.55;font-size:15px;">
  <div style="background:#1c2b5e;border-radius:10px 10px 0 0;padding:22px 24px;border-bottom:3px solid #f0c020;">
    <div style="color:#f0c020;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:6px;">${eyebrow}</div>
    <div style="color:#ffffff;font-size:22px;font-weight:700;line-height:1.25;">${esc(f.name)}</div>
    <div style="color:#9aa6cf;font-size:14px;margin-top:4px;">${esc(f.num)} &middot; ${esc(f.set)} &middot; ${esc(rarDisplay(f.rarity))}${f.nativeName ? ' &middot; ' + esc(f.nativeName) : ''}</div>
  </div>
  ${imgHtml}
  <div style="padding:20px 24px 4px;"><p style="margin:0 0 16px;">${esc(f.pitch)}</p></div>
  <div style="padding:0 24px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1c2b5e;font-weight:700;border-bottom:2px solid #e9edf6;padding-bottom:6px;margin-bottom:4px;">Card details</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>${tr}</tbody></table>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="background:#f6f8fc;border-left:4px solid #f0c020;border-radius:0 8px 8px 0;padding:14px 16px;">
      <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1c2b5e;font-weight:700;margin-bottom:4px;">Condition</div>
      <p style="margin:0;">${cp.cond}</p>
    </div>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1c2b5e;font-weight:700;border-bottom:2px solid #e9edf6;padding-bottom:6px;margin-bottom:10px;">Postage &amp; protection</div>
    <p style="margin:0;">${cp.postage}</p>
  </div>
  <div style="padding:18px 24px 22px;"><p style="margin:0;color:#6b6b7e;font-size:13px;">${esc(CARD_FOOTER)}</p></div>
</div>`;
}

// ---------------------------------------------------------------------------
// ImportRow/BulkRow -> the builder-shaped field object f_* that titleParts and
// buildDescription consume. One adapter so the grid, channel map and harnesses
// all shape rows identically.
// ---------------------------------------------------------------------------
export function rowToFields(row) {
  row = row || {};
  const graded = !!(row.graded || row.grading_company);
  const f = {
    name: row.name || '',
    num: row.number || '',
    set: row.set_name || '',
    rarity: row.rarity || '',
    finish: row.finish || '',
    variant: row.finish || '',           // lorcana titles read f.variant
    lang: row.language || 'EN',
    cond: graded ? gradeTitleToken(row.grading_company, row.grade, row.grade_label) : (row.condition || DEFAULT_CARD_CONDITION),
    edition: row.edition || '',
    graded,
    grading_company: row.grading_company || null,
    grade: row.grade != null ? row.grade : null,
    grade_label: row.grade_label || '',
    cert: graded ? (row.cert_number || '') : '',          // surfaced as a description detail row when present
    subgrades: graded ? formatSubgrades(row.subgrades) : '',
    poke: '', stage: '', type: '', pitch: '',
  };
  if (row.game === 'riftbound') {
    // riftbound reads its own variant (identity: Alternate Art / Overnumbered, NOT the
    // finish) and card facts (type/domain/tags/stats) carried on the row from enumerate/
    // import, or re-resolved from the baked catalog at export time (lib/channels/ebay-map.mjs).
    f.variant = row.variant || '';
    f.type = row.rb_type || '';
    f.domain = row.rb_domain || '';
    f.tags = row.rb_tags || '';
    f.e = row.rb_e != null ? row.rb_e : '';
    f.p = row.rb_p != null ? row.rb_p : '';
    f.m = row.rb_m != null ? row.rb_m : '';
    f.setName = (row.set_name || '').replace(/\s*\([^)]*\)\s*$/, '');
    f.pitch = riftboundPitch(f, f.rarity);
  } else {
    f.pitch = row.game === 'lorcana'
      ? lorcanaPitch(f, f.rarity, f.set)
      : pokemonPitch(f);
  }
  return f;
}

// Multi-variation "pick your single" helpers (EXPERIMENTAL on EBAY_AU — only
// Card Condition/Customised are variation-enabled aspects in 183454; gate on a
// real sample upload before relying on this shape).
export function variationTitle(game, setName, opts) {
  opts = opts || {};
  const gameWord = game === 'pokemon' ? 'Pokemon' : game === 'lorcana' ? 'Disney Lorcana' : game.toUpperCase();
  return fitTitle([
    { text: gameWord, prio: 100 },
    { text: setName, prio: 95 },
    { text: 'Singles', prio: 90 },
    { text: opts.scope || 'Commons & Uncommons', abbr: 'C/UC', prio: 60 },
    { text: '- Pick Your Card', abbr: '- Choose', prio: 80 },
    { text: opts.cond || 'M/NM', prio: 70 },
  ], 80);
}
export function variationAttrs(row) {
  // Single 'Card' axis: number + name + finish (custom specific — see note above).
  return { Card: [row.number, row.name, row.finish && row.finish !== 'Normal' ? row.finish : ''].filter(Boolean).join(' ') };
}
