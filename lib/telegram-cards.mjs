// lib/telegram-cards.mjs — how the bot writes its messages.
//
// Pure text builders, no DB and no fetch, so the wording is testable without a bot token. The plugins
// own the sending; this file owns the reading experience.
//
// The audience is a person holding a phone, usually while doing something else — standing at the
// shelf pulling cards, or glancing at a notification mid-conversation. That rules out the format
// these messages used to have: one line per order with every card comma-joined into it, which turns
// a ten-card order into an unbroken paragraph you have to re-read to pull from.

import { escapeHtml } from './telegram.mjs';

// Telegram's own limit is 4096 characters. Stop short so a truncation notice always fits.
const MAX_TEXT = 3800;

// Noise that appears on EVERY listing title and so distinguishes nothing: the game prefix, the
// rarity, the finish, the language, the condition. What survives is name + number + set, which is
// exactly what you need to find the card in a binder.
//
// Deliberately conservative. If the strip leaves too little to identify the card, the original wins:
// a long line you can act on beats a short one you can't.
const GAME_PREFIX = /^(pok[eé]mon|one piece|magic:? the gathering|mtg|lorcana|star wars:? unlimited|swu|riftbound|yu-?gi-?oh|disney lorcana)\s+/i;
const NOISE = [
  /\b(special\s+)?illustration\s+rare\b/ig,
  /\b(double|ultra|hyper|super|secret|art|trainer|character|shiny|black|gold)\s+rare\b/ig,
  /\brare\s+holo\b/ig,
  /\b(reverse\s+)?holo(foil)?\b/ig,
  /\bfull\s+art\b/ig,
  /\b(IR|SIR|SAR|UR|SR|RR|AR|HR)\b/g,
  /\b(EN|JP|CN|KO)\b/g,
  /\b(M\/NM|NM\/M|NM|LP|MP|HP|DMG)\b/ig,
];

export function shortTitle(title) {
  const raw = String(title == null ? '' : title).trim().replace(/\s+/g, ' ');
  if (!raw) return '';
  let t = raw.replace(GAME_PREFIX, '');
  for (const re of NOISE) t = t.replace(re, ' ');
  t = t.replace(/\s*[-–—]\s*$/, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  // Must still carry a letter and some length, or we've stripped the card away.
  return t.length >= 3 && /[\p{L}]/u.test(t) ? t : raw;
}

// One block per order, one card per line. An order is a physical act — walk to the shelf, pull these,
// put them in one satchel — so the grouping on screen matches the grouping in your hands.
export function renderPackDigest(orders = []) {
  const total = orders.length;
  const cards = orders.reduce((n, o) => n + (o.items || []).length, 0);
  const packed = orders.filter((o) => o.picked_at).length;

  const head = '📦 <b>To pack today</b>\n'
    + `<i>${total} order${total === 1 ? '' : 's'} · ${cards} card${cards === 1 ? '' : 's'}`
    + (packed ? ` · ${packed} already packed` : '') + '</i>';

  const blocks = [];
  let used = head.length, shown = 0;
  for (const o of orders) {
    const where = [o.ship_city, o.ship_state].filter(Boolean).join(', ');
    let b = `\n\n${o.picked_at ? '✅ ' : ''}<b>@${escapeHtml(o.buyer_username || 'buyer')}</b>`
      + (where ? ` · ${escapeHtml(where)}` : '');
    for (const it of o.items || []) {
      const qty = it.quantity > 1 ? ` ×${it.quantity}` : '';
      b += `\n  ${escapeHtml(shortTitle(it.title) || o.order_id || 'card')}${qty}`;
    }
    if (used + b.length > MAX_TEXT) break;
    blocks.push(b); used += b.length; shown++;
  }
  const more = shown < total ? `\n\n<i>…and ${total - shown} more order${total - shown === 1 ? '' : 's'}</i>` : '';
  return head + blocks.join('') + more;
}

// A sale alert is read in one glance, mid-something-else. Money and destination are the two facts
// that matter; the card names are the confirmation you actually sold what you thought you did.
export function renderSaleAlert({ items = [], totalText, where, buyerUsername, repeat } = {}) {
  let s = `🟢 <b>SOLD</b>${repeat ? '  ⭐ <i>repeat buyer</i>' : ''}\n`;
  s += `<b>${escapeHtml(totalText || '')}</b>`;
  if (where) s += ` · ${escapeHtml(where)}`;
  s += ` · @${escapeHtml(buyerUsername || '')}\n`;
  for (const it of items) {
    const qty = it.quantity > 1 ? ` ×${it.quantity}` : '';
    s += `\n  ${escapeHtml(shortTitle(it.title || it.sku || it.itemId || 'item'))}${qty}`;
  }
  return s;
}
