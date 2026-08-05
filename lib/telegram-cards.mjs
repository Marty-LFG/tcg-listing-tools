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

// THE PULL LIST. Grouped by storage location and walked in SKU order, because that is the shape of
// the job: you stand at one box, pull everything you need from it, move to the next. Sorting by
// buyer would send you back and forth across the shelf for no reason — the buyer only matters once
// the cards are in your hand, which is what the dispatch summary below is for.
//
// `groups` comes straight from buildPickSheet(), the same function behind the printed pick sheet, so
// the phone and the paper can never disagree about the order to walk.
export function renderPullList(groups = [], { orderCount = 0, itemCount = 0, unitCount = 0, heldCount = 0 } = {}, done) {
  // An order held back (cancellation requested, or a payment that failed) is off the pull list but
  // still on the digest. Say so on its own line: a count that quietly shrank is the thing that sends
  // somebody hunting through the shelves for a card the list no longer mentions.
  const heldLine = heldCount
    ? `\n⛔ <b>${heldCount} order${heldCount === 1 ? '' : 's'} held back — do not pack</b>` : '';
  // Nothing left to pull: "3 orders · 0 lines" is a contradiction to read past. Say the orders are
  // still there (they have to be posted) and that the pulling is done.
  if (!groups.length) {
    return '📦 <b>To pack today</b>'
      + (orderCount ? `\n<i>${orderCount} order${orderCount === 1 ? '' : 's'} · all pulled</i>` : '')
      + heldLine
      + '\n\n<i>Nothing to pull — everything is packed.</i>' + renderDigestFooter(done);
  }
  const head = '📦 <b>To pack today</b>\n'
    + `<i>${orderCount} order${orderCount === 1 ? '' : 's'} · ${itemCount} line${itemCount === 1 ? '' : 's'}`
    + (unitCount !== itemCount ? ` · ${unitCount} card${unitCount === 1 ? '' : 's'}` : '') + '</i>'
    + heldLine;

  const blocks = [];
  let used = head.length, shown = 0, dropped = 0;
  for (const g of groups) {
    let b = `\n\n<b>${escapeHtml(g.location || 'Unsorted')}</b>`;
    for (const it of g.items || []) {
      // SKU in monospace: it is the sort key and the thing your eye tracks down the box, and a
      // proportional font makes a column of near-identical codes hard to scan.
      const sku = it.sku ? `<code>${escapeHtml(it.sku)}</code>  ` : '';
      const qty = it.quantity > 1 ? ` <b>×${it.quantity}</b>` : '';
      b += `\n  ${sku}${escapeHtml(shortTitle(it.title) || it.ebay_item_id || 'card')}${qty}`;
    }
    if (used + b.length > MAX_TEXT) { dropped += (g.items || []).length; continue; }
    blocks.push(b); used += b.length; shown++;
  }
  const more = dropped ? `\n\n<i>…and ${dropped} more line${dropped === 1 ? '' : 's'} (${groups.length - shown} box${groups.length - shown === 1 ? '' : 'es'}) — see the pick sheet</i>` : '';
  return head + blocks.join('') + more + renderDigestFooter(done);
}

// What happened, and who did it. The digest buttons act on a whole day's orders, so the message has
// to keep saying so after the buttons are gone: two people share this chat, and "did someone already
// dispatch these?" is exactly the question a cleared message can't answer.
export function renderDigestFooter(done) {
  if (!done) return '';
  const { icon = 'ℹ️', status = '', who = '', detail = '' } = done;
  return `\n\n${icon} <b>${escapeHtml(status)}</b>${who ? ` by ${escapeHtml(who)}` : ''}`
    + (detail ? `\n<i>${escapeHtml(detail)}</i>` : '');
}

// THE DISPATCH SUMMARY — the second half of the same job, sent as its own message because it answers
// a different question: not "what do I pull" but "where is each satchel going". Keeping it separate
// means neither list has to carry the other's ordering.
export function renderDispatchSummary(orders = [], done) {
  const packed = orders.filter((o) => o.picked_at).length;
  let s = '🚚 <b>Where it’s going</b>\n'
    + `<i>${orders.length} order${orders.length === 1 ? '' : 's'}`
    + (packed ? ` · ${packed} already pulled` : '') + '</i>\n';
  for (const o of orders) {
    const where = [o.ship_city, o.ship_state].filter(Boolean).join(', ');
    const n = (o.items || []).reduce((t, i) => t + (i.quantity || 1), 0);
    // A postage upgrade needs a label bought on eBay before this one can go anywhere, so it is called
    // out here rather than left to be discovered at the bench.
    const tier = o.postage && o.postage.upgrade ? ` · <b>${escapeHtml(String(o.postage.tier).toUpperCase())}</b>` : '';
    s += `\n${o.picked_at ? '✅' : '•'} <b>@${escapeHtml(o.buyer_username || 'buyer')}</b>`
      + (where ? ` · ${escapeHtml(where)}` : '')
      + ` · ${n} card${n === 1 ? '' : 's'}${tier}`;
  }
  return s + renderDigestFooter(done);
}

/**
 * THE HOLD CARD — a cancellation, or a payment that failed after eBay called the order paid.
 *
 * The 🟢 SOLD alert is read once and forgotten. This one is read and ACTED ON — or, worse, not acted
 * on, and a cancelled order goes in the post. So it leads with the verdict rather than the money, it
 * lists each card with the SKU and the shelf it belongs on (the actual physical job is putting them
 * back), and it ends with the one thing that is still the reader's problem.
 *
 * It never claims a restock it did not do. A line decremented before the effect log existed cannot be
 * put back faithfully, so it is NAMED and handed over rather than quietly rounded up to "done".
 */
export function renderHoldAlert({ kind = 'cancel', state, orderId, salesRecordNumber, buyerUsername,
  totalText, items = [], reason, initiator, requestedAt, restock, watching } = {}, decided) {
  const dead = state === 'cancelled';
  const head = dead ? '🚫 <b>ORDER CANCELLED</b>'
    : kind === 'payment' ? '⏸ <b>PAYMENT FAILED</b>'
      : '⏸ <b>CANCELLATION REQUESTED</b>';
  let s = `${head}  ·  @${escapeHtml(buyerUsername || '')}\n`;
  s += `<b>${escapeHtml(totalText || '')}</b> · <code>${escapeHtml(orderId || '')}</code>`
    + (salesRecordNumber ? ` · #${escapeHtml(String(salesRecordNumber))}` : '') + '\n';
  for (const it of items) {
    const qty = it.quantity > 1 ? ` <b>×${it.quantity}</b>` : '';
    const sku = it.sku ? `<code>${escapeHtml(it.sku)}</code>  ` : '';
    // The location is the whole reason this line exists: these cards have to go back somewhere.
    const loc = it.location ? ` <i>→ ${escapeHtml(it.location)}</i>` : '';
    s += `\n  ${sku}${escapeHtml(shortTitle(it.title) || it.ebay_item_id || 'card')}${qty}${loc}`;
  }
  if (kind === 'cancel') {
    const who = initiator ? `${escapeHtml(initiator)} cancelled it` : 'Cancelled';
    s += `\n\n${who}${reason ? ` — ${escapeHtml(reason)}` : ''}`;
    if (requestedAt) s += `\n<i>${escapeHtml(requestedAt)}</i>`;
  }

  if (dead) {
    s += '\n\n⛔ <b>Do not post this.</b> It is off the pick sheet and the digest, and no message will go to the buyer.';
    if (restock && restock.reversed) {
      s += `\n✅ ${restock.reversed} line${restock.reversed === 1 ? '' : 's'} put back on the shelf.`;
    }
    if (restock && restock.skipped && restock.skipped.length) {
      s += `\n⚠️ <b>${restock.skipped.length} line${restock.skipped.length === 1 ? '' : 's'} could not be put back automatically</b> — check the stock by hand.`;
      for (const sk of restock.skipped.slice(0, 5)) {
        s += `\n   <code>${escapeHtml(sk.sku || '?')}</code> — ${escapeHtml(sk.why || 'unknown')}`;
      }
    }
    if (watching) s += `\n📋 eBay usually relists these itself. Watching for the new listing.`;
  } else if (kind === 'payment') {
    s += '\n\n⚠️ <b>Hold off packing.</b> eBay says the payment failed after the order was marked paid.'
      + ' It stays in the queue but off the pull list until the money is actually there.';
  } else {
    s += '\n\n⚠️ <b>Hold off packing.</b> It stays in the queue in case you reject the request, but it is'
      + ' off the pull list until you decide. Stock has <b>not</b> been put back yet.'
      // Without this line the acknowledge button reads as "approve", which is exactly what it is not:
      // eBay does not expose the Cancel ID over the API we use, so the decision is a Seller Hub one.
      + '\n<i>Approving or rejecting a cancellation is a Seller Hub job — the tool can’t do it for you.</i>';
  }
  s += '\n\n<i>Tap “Got it” to clear this and unpin it.</i>';
  return s + renderDigestFooter(decided);
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
