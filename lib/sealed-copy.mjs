// lib/sealed-copy.mjs — buyer-facing copy for SEALED product listings.
//
// Deliberately a MODULE rather than a mirrored inline function. The eight card builders are classic
// <script> pages that cannot import, which is why lib/listing-copy.mjs exists as a byte-identical twin
// of each of them and why scripts/check-listing-copy.mjs has to prove they agree. sealed-listing-
// builder.html is an ESM page, so it imports this file directly and there is no twin to keep in step.
// That is the whole reason the sealed tool was built as a module page (plan D5).
//
// Voice rules, same as everywhere buyer-facing: kind, casual, human. No em dashes. No "not X but Y".
// No filler. Numbers are facts, so anything quoted here has to be true of the policy that will charge
// the buyer (GR6) — hence the postage sentence changes shape when a band charges per extra item.
import { fitTitle } from './listing-copy.mjs';
import { money } from './shipping-bands.mjs';

export const TYPE_WORD = {
  booster_box: 'Booster Box', booster_bundle: 'Booster Bundle', booster_pack: 'Booster Pack',
  elite_trainer_box: 'Elite Trainer Box', booster_case: 'Booster Case', blister: 'Blister',
  tin: 'Tin', collection: 'Collection', premium_collection: 'Premium Collection',
};
// English adds no word, because an English listing is the one that names no language. Same rule the
// singles titles use, and the same reason: on a non-English product the language IS the selling point.
export const LANG_WORD = { JP: 'Japanese', CN: 'Chinese', TW: 'Chinese', KO: 'Korean' };
const LANG_FULL = { EN: 'English', JP: 'Japanese', CN: 'Chinese (Simp.)', TW: 'Chinese (Trad.)', KO: 'Korean' };

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The set CODE belongs in its own row, not in the middle of a sentence.
const bareSet = (s) => String(s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();

/**
 * f: { name, set_name, set_code, product_type, language, variant, pack_count, condition, factory_sealed }
 * Returns a title inside eBay's 80-character budget, shed by priority exactly like the card builders.
 */
export function buildSealedTitle(f, max) {
  const parts = [
    { text: TYPE_WORD[f.product_type] || '', prio: 100 },
    { text: bareSet(f.set_name) || f.set_code || '', prio: 95 },
    { text: f.variant || '', prio: 80 },
    { text: LANG_WORD[String(f.language || 'EN').toUpperCase()] || '', prio: 66 },
    { text: f.pack_count ? f.pack_count + ' Packs' : '', prio: 55 },
    { text: 'Pokemon', prio: 45 },
    { text: f.condition === 'sealed' ? 'Factory Sealed' : '', prio: 40 },
  ].filter((p) => p.text);
  return fitTitle(parts, max || 80);
}

export function buildSealedPitch(f) {
  const set = bareSet(f.set_name) || f.set_code || '';
  const type = (TYPE_WORD[f.product_type] || 'sealed product').toLowerCase();
  const lang = LANG_WORD[String(f.language || 'EN').toUpperCase()];
  const packs = f.pack_count ? ', ' + f.pack_count + ' packs inside' : '';
  return 'A ' + (lang ? lang + ' ' : '') + set + ' ' + type + ', sealed and unsearched' + packs
    + '. Stored away from sunlight and posted with padding.';
}

export function sealedCondText(f) {
  if (f.condition === 'opened') return 'Opened, contents complete. See the photos for the box itself.';
  if (f.condition === 'damaged') return 'Sealed, but the box itself is damaged. The photos show it.';
  if (!f.factory_sealed) return 'Sealed, though the outer wrap has been replaced. See the photos.';
  return 'Brand new and factory sealed, never opened.';
}

// The postage sentence is the one place a wrong number becomes a promise. A band that charges nothing
// for each extra item can say "however many you take"; one that charges again per item must not, or a
// two-box order quotes half what checkout takes.
export function sealedPostageText(band) {
  if (!band || band.costCents == null) return 'Postage within Australia is shown at checkout.';
  const first = money(band.costCents);
  return Number(band.extraCents) > 0
    ? `Postage is ${first} for one anywhere in Australia, sent tracked with Australia Post so you can follow it along. More than one travels in its own satchel, so checkout shows the total.`
    : `Postage is ${first} anywhere in Australia however many you take, sent tracked with Australia Post so you can follow it along.`;
}

const SERIF = "Georgia,'Iowan Old Style','Times New Roman',serif";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The full eBay description. Inline styles only: eBay strips <style> and <script> (GR8). */
export function buildSealedDescription(f, opts = {}) {
  const band = opts.band || null;
  const name = f.name || [bareSet(f.set_name), TYPE_WORD[f.product_type]].filter(Boolean).join(' ');
  const rows = [
    ['Set', f.set_name],
    ['Set code', f.set_code],
    ['Product', TYPE_WORD[f.product_type]],
    ['Packs per box', f.pack_count],
    ['Language', LANG_FULL[String(f.language || 'EN').toUpperCase()] || f.language],
    ['Variant', f.variant],
  ].filter((r) => r[1] !== '' && r[1] != null);

  const tr = rows.map((r, i) => `<tr style="${i % 2 === 0 ? 'background:#faf8fb;' : ''}">`
    + `<td style="padding:9px 12px;color:#7a6f85;width:38%;">${esc(r[0])}</td>`
    + `<td style="padding:9px 12px;color:#1b1420;font-weight:600;">${esc(r[1])}</td></tr>`).join('');

  const head = (t) => `<div style="font-family:${SANS};font-size:10.5px;letter-spacing:.2em;`
    + `text-transform:uppercase;color:#7a6f85;font-weight:700;margin-bottom:7px;">${t}</div>`;

  return `<div style="max-width:760px;margin:0 auto;font-family:${SERIF};font-size:16px;line-height:1.6;color:#1b1420;background:#ffffff;">`
    + `<div style="background:#160f1d;padding:26px 26px 22px;">`
      + `<div style="font-family:${SANS};font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#d4b072;font-weight:700;">Binders Keepers &middot; Pok&eacute;mon TCG</div>`
      + `<div style="font-size:30px;color:#ffffff;margin-top:8px;font-weight:600;">${esc(name)}</div>`
    + `</div>`
    + `<div style="height:3px;background:#7ea8c9;"></div>`
    + `<div style="padding:22px 26px 0;"><p style="margin:0 0 16px;">${esc(f.pitch || buildSealedPitch(f))}</p></div>`
    + `<div style="padding:0 26px;">${head('The product')}`
      + `<table style="width:100%;border-collapse:collapse;font-size:14px;">${tr}</table></div>`
    + `<div style="padding:20px 26px 0;"><div style="border:1px solid #ece7f0;border-radius:6px;padding:14px 16px;background:#faf8fb;">`
      + `${head('Condition')}<p style="margin:0;">${esc(sealedCondText(f))}</p></div></div>`
    + `<div style="padding:20px 26px 26px;">${head('Postage &amp; protection')}`
      + `<p style="margin:0;">Packed with padding so it gets to you the way it left here. ${esc(sealedPostageText(band))}</p></div>`
    + `<div style="padding:0 26px 26px;color:#7a6f85;font-size:13px;font-style:italic;">Posted from Australia. Any questions, just ask.</div>`
  + `</div>`;
}
