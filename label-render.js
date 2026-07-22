/* label-render.js — shared thermal-label renderers for the AUSPRINT PRO print pipeline.
 *
 * Loaded as a classic <script src="/label-render.js"> and exposed as window.LR. Every renderer draws
 * to an off-screen canvas at the printer's dot density, then thresholds to a 1-bpp bitmap (1 = ink,
 * MSB-first, rows padded to a whole byte) — the exact job shape POST /api/print expects. This is the
 * same convention as pdf-print.html to1bpp() and shipping-label.html renderLabelToBitmap(); the
 * difference is these renderers are fed structured ORDER data (not a pasted address / dropped PDF).
 *
 * Golden Rule 7: when the printer is unconfigured, callers fall back to LR.downloadJob() (PNG).
 */
(function () {
  var LR = {
    _cfg: { enabled: false, dpi: 300 },
    config: { store: 'Binders Keepers' },   // page header; override from the host page if desired
  };

  /* ---------- printer config + transport ---------- */
  // GET /api/print → { enabled, dpi, ip, page:{w,h}, ... }. Cached on LR._cfg for the default DPI.
  LR.loadPrintCfg = function () {
    return fetch('/api/print').then(function (r) { return r.json(); }).then(function (c) {
      if (c && typeof c === 'object') LR._cfg = c;
      return LR._cfg;
    }).catch(function () { LR._cfg = { enabled: false, dpi: 300 }; return LR._cfg; });
  };
  // jobs: [{ bitmap, widthDots, heightDots, wmm, hmm, copies? }]. Resolves to the /api/print JSON.
  LR.printJobs = function (jobs, opts) {
    opts = opts || {};
    var body = { jobs: jobs };
    if (opts.copies != null) body.copies = opts.copies;
    if (opts.speed != null) body.speed = opts.speed;
    if (opts.density != null) body.density = opts.density;
    return fetch('/api/print', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, message: 'bad response' }; }); });
  };

  /* ---------- canvas helpers ---------- */
  function dpiOf(opts) { return (opts && opts.dpi) || (LR._cfg && LR._cfg.dpi) || 300; }
  function mkCanvas(wmm, hmm, dpi) {
    var wDots = Math.max(1, Math.round(wmm * dpi / 25.4));
    var hDots = Math.max(1, Math.round(hmm * dpi / 25.4));
    var cv = document.createElement('canvas'); cv.width = wDots; cv.height = hDots;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, wDots, hDots);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
    return { cv: cv, ctx: ctx, wDots: wDots, hDots: hDots, pxPerMm: dpi / 25.4 };
  }
  var FAMILY = 'Arial, Helvetica, sans-serif';
  var MONO = '"Courier New", Courier, monospace';
  function pt2px(pt, dpi) { return pt * dpi / 72; }

  // Threshold a rendered canvas to a 1-bpp job (dark pixel = ink bit 1). Crisp black-on-white text
  // needs no dithering, so this is the simple luminance threshold (matches shipping-label.html).
  function canvasToJob(cv, wmm, hmm) {
    var w = cv.width, h = cv.height;
    var img = cv.getContext('2d').getImageData(0, 0, w, h).data;
    var wBytes = Math.ceil(w / 8);
    var out = new Uint8Array(wBytes * h);
    for (var y = 0; y < h; y++) {
      var row = y * wBytes;
      for (var x = 0; x < w; x++) {
        var p = (y * w + x) * 4;
        var lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
        if (img[p + 3] > 128 && lum < 128) out[row + (x >> 3)] |= (0x80 >> (x & 7));
      }
    }
    var bin = '';
    for (var k = 0; k < out.length; k += 8192) bin += String.fromCharCode.apply(null, out.subarray(k, Math.min(k + 8192, out.length)));
    return { bitmap: btoa(bin), widthDots: w, heightDots: h, wmm: wmm, hmm: hmm };
  }
  // Rebuild a viewable canvas from a 1-bpp job (preview + PNG-download fallback).
  LR.jobToCanvas = function (job) {
    var w = job.widthDots, h = job.heightDots, wBytes = Math.ceil(w / 8), bin = atob(job.bitmap);
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d'); var id = ctx.createImageData(w, h); var d = id.data;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var bit = (bin.charCodeAt(y * wBytes + (x >> 3)) >> (7 - (x & 7))) & 1;
      var p = (y * w + x) * 4, v = bit ? 0 : 255; d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
    }
    ctx.putImageData(id, 0, 0); return c;
  };
  LR.downloadJob = function (job, name) {
    LR.jobToCanvas(job).toBlob(function (blob) {
      var url = URL.createObjectURL(blob); var a = document.createElement('a');
      a.href = url; a.download = name || 'label.png'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
    });
  };

  // Word-wrap a string to lines that fit maxW at the given font (ctx.font must be preset).
  function wrapText(ctx, s, maxW) {
    var words = String(s == null ? '' : s).split(/\s+/).filter(Boolean);
    var out = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var t = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = words[i]; }
      else cur = t;
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  }

  /* ---------- address label (the "print postage label" button — same output as shipping-label.html) ---------- */
  function addressLines(order) {
    var L = [];
    if (order.ship_name) L.push(order.ship_name);
    if (order.ship_street1) L.push(order.ship_street1);
    if (order.ship_street2) L.push(order.ship_street2);
    var cityline = [order.ship_city, order.ship_state].filter(Boolean).join(' ');
    if (order.ship_postal) cityline = (cityline ? cityline + '  ' : '') + order.ship_postal;
    if (cityline.trim()) L.push(cityline.trim());
    var cn = order.ship_country_name || order.ship_country;
    if (cn && !/^au(s(tralia)?)?$/i.test(String(cn).trim())) L.push(cn);   // drop the domestic AU country line
    return L.filter(Boolean);
  }
  // Auto-fit: largest pt in [minPt,maxPt] where every line fits the usable width and the block fits height.
  function fitFont(ctx, lines, usableW, usableH, dpi, lineSpacing, minPt, maxPt) {
    for (var pt = maxPt; pt >= minPt; pt -= 0.5) {
      var px = pt2px(pt, dpi), lh = px * lineSpacing;
      if (lines.length * lh > usableH + 1) continue;
      var ok = true;
      for (var i = 0; i < lines.length; i++) {
        ctx.font = (i === 0 ? 'bold ' : '') + px.toFixed(2) + 'px ' + FAMILY;
        if (ctx.measureText(lines[i]).width > usableW + 1) { ok = false; break; }
      }
      if (ok) return pt;
    }
    return minPt;
  }
  LR.renderAddressLabel = function (order, opts) {
    opts = opts || {};
    var dpi = dpiOf(opts), wmm = opts.wmm || 100, hmm = opts.hmm || 50, margin = opts.margin != null ? opts.margin : 5;
    var c = mkCanvas(wmm, hmm, dpi), ctx = c.ctx, pxPerMm = c.pxPerMm, lineSpacing = 1.2;
    var usableW = (wmm - 2 * margin) * pxPerMm, usableH = (hmm - 2 * margin) * pxPerMm;
    var lines = addressLines(order);
    var pt = fitFont(ctx, lines, usableW, usableH, dpi, lineSpacing, 8, opts.maxPt || 28);
    var px = pt2px(pt, dpi), lh = px * lineSpacing;
    var blockH = lines.length ? (lines.length - 1) * lh + px : 0;
    var x = margin * pxPerMm, y = margin * pxPerMm + Math.max(0, (usableH - blockH) / 2);
    ctx.textAlign = 'left';
    for (var i = 0; i < lines.length; i++) {
      ctx.font = (i === 0 ? 'bold ' : '') + px.toFixed(2) + 'px ' + FAMILY;
      ctx.fillText(lines[i], Math.round(x), Math.round(y)); y += lh;
    }
    return canvasToJob(c.cv, wmm, hmm);
  };

  /* ---------- packing slip (self-built from order data — eBay has no packing-slip API) ---------- */
  LR.renderPackingSlip = function (order, opts) {
    opts = opts || {};
    var dpi = dpiOf(opts), wmm = opts.wmm || 100, hmm = opts.hmm || 150, margin = opts.margin != null ? opts.margin : 5;
    var store = opts.store || (LR.config && LR.config.store) || 'Binders Keepers';
    var c = mkCanvas(wmm, hmm, dpi), ctx = c.ctx, pxPerMm = c.pxPerMm;
    var left = Math.round(margin * pxPerMm), right = c.wDots - margin * pxPerMm, usableW = right - left;
    var y = margin * pxPerMm;
    function setFont(pt, bold, mono) { ctx.font = (bold ? 'bold ' : '') + pt2px(pt, dpi).toFixed(2) + 'px ' + (mono ? MONO : FAMILY); ctx.textAlign = 'left'; }
    function draw(s, pt, bold, o) {
      o = o || {}; setFont(pt, bold, o.mono);
      var x = left; ctx.textAlign = o.align || 'left';
      if (o.align === 'right') x = right; else if (o.align === 'center') x = (left + right) / 2;
      ctx.fillText(s == null ? '' : String(s), Math.round(x), Math.round(y));
      if (!o.noAdvance) y += pt2px(pt, dpi) * (o.spacing || 1.35);
    }
    function rule() { y += 1.4 * pxPerMm; ctx.fillRect(left, Math.round(y), usableW, Math.max(1, Math.round(0.28 * pxPerMm))); y += 2.4 * pxPerMm; }
    function money(cents, cur) { return (cur === 'AUD' || !cur ? 'A$' : cur + ' ') + ((Math.round(+cents || 0)) / 100).toFixed(2); }

    // header
    draw(store, 13, true);
    draw('PACKING SLIP', 8.5, false, { spacing: 1.6 });
    draw('Order ' + (order.order_id || ''), 8, false, { mono: true, spacing: 1.25 });
    var meta = [];
    if (order.sales_record_number) meta.push('Sales rec #' + order.sales_record_number);
    var paid = order.paid_time ? String(order.paid_time).replace('T', ' ').slice(0, 10) : '';
    if (paid) meta.push(paid);
    if (meta.length) draw(meta.join('   ·   '), 8, false, { mono: true });
    rule();

    // ship to
    draw('SHIP TO', 7.5, true, { spacing: 1.5 });
    draw(order.ship_name || '', 11, true);
    if (order.ship_street1) draw(order.ship_street1, 10, false, { spacing: 1.25 });
    if (order.ship_street2) draw(order.ship_street2, 10, false, { spacing: 1.25 });
    var cityline = [order.ship_city, order.ship_state].filter(Boolean).join(' ');
    if (order.ship_postal) cityline = (cityline ? cityline + '  ' : '') + order.ship_postal;
    if (cityline.trim()) draw(cityline.trim(), 10, false, { spacing: 1.25 });
    var cn = order.ship_country_name || order.ship_country;
    if (cn && !/^au(s(tralia)?)?$/i.test(String(cn).trim())) draw(cn, 10, false, { spacing: 1.25 });
    if (order.buyer_username) draw('@' + order.buyer_username, 8, false, { mono: true });
    rule();

    // items
    draw('ITEMS', 7.5, true, { spacing: 1.5 });
    var items = order.items || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var qty = (it.quantity || 1);
      setFont(9.5, true, false); var qtyStr = qty + '×  ';
      var qtyW = ctx.measureText(qtyStr).width;
      // qty (bold) on the same baseline as the first wrapped title line
      var titleFontPt = 9.5;
      setFont(titleFontPt, false, false);
      var titleLines = wrapText(ctx, it.title || it.sku || it.ebay_item_id || 'item', usableW - qtyW);
      var startY = y;
      setFont(9.5, true, false); ctx.textAlign = 'left';
      ctx.fillText(qtyStr, left, Math.round(startY));
      for (var t = 0; t < titleLines.length; t++) {
        setFont(titleFontPt, false, false); ctx.textAlign = 'left';
        ctx.fillText(titleLines[t], Math.round(left + qtyW), Math.round(y));
        y += pt2px(titleFontPt, dpi) * 1.25;
      }
      if (it.sku) draw(it.sku + (it.location ? '   ·   ' + it.location : ''), 7.5, false, { mono: true, spacing: 1.35 });
      else if (it.location) draw(it.location, 7.5, false, { mono: true, spacing: 1.35 });
      y += 0.8 * pxPerMm;
    }
    rule();

    // totals
    var totalStr = money(order.total_cents, order.currency);
    setFont(11, true, false); ctx.textAlign = 'left'; ctx.fillText('TOTAL', left, Math.round(y));
    ctx.textAlign = 'right'; ctx.fillText(totalStr, Math.round(right), Math.round(y));
    y += pt2px(11, dpi) * 1.6; ctx.textAlign = 'left';

    // buyer note
    if (order.buyer_note) {
      rule();
      draw('NOTE FROM BUYER', 7.5, true, { spacing: 1.4 });
      setFont(9, false, false);
      var noteLines = wrapText(ctx, order.buyer_note, usableW);
      for (var n = 0; n < noteLines.length; n++) draw(noteLines[n], 9, false, { spacing: 1.25 });
    }

    // footer thank-you (only if there's room)
    if (y < c.hDots - 10 * pxPerMm) {
      y = c.hDots - 7 * pxPerMm;
      draw('Thanks for your order! ' + (LR.config && LR.config.footer || ''), 8, false, { spacing: 1.2 });
    }
    return canvasToJob(c.cv, wmm, hmm);
  };

  /* ---------- pick sheet (one consolidated pull list, grouped by location; paginates across pages) ---------- */
  // groups: [{ location, items:[{ title, sku, quantity, order_id, buyer_username }] }] (from /api/postsale/picksheet).
  // Returns an ARRAY of jobs — one per label page — so a long run spans several die-cut labels.
  LR.renderPickSheet = function (groups, opts) {
    opts = opts || {};
    var dpi = dpiOf(opts), wmm = opts.wmm || 100, hmm = opts.hmm || 150, margin = opts.margin != null ? opts.margin : 5;
    var pageItems = flattenGroups(groups);
    var jobs = [], idx = 0, pageNo = 0;
    var totalUnits = 0, totalOrders = {};
    for (var g = 0; g < groups.length; g++) for (var ii = 0; ii < groups[g].items.length; ii++) { totalUnits += (groups[g].items[ii].quantity || 1); totalOrders[groups[g].items[ii].order_id] = 1; }
    var orderCount = Object.keys(totalOrders).length;

    while (idx < pageItems.length || pageNo === 0) {
      pageNo++;
      var c = mkCanvas(wmm, hmm, dpi), ctx = c.ctx, pxPerMm = c.pxPerMm;
      var left = Math.round(margin * pxPerMm), right = c.wDots - margin * pxPerMm, usableW = right - left;
      var bottom = c.hDots - margin * pxPerMm;
      var y = margin * pxPerMm;
      function setFont(pt, bold, mono) { ctx.font = (bold ? 'bold ' : '') + pt2px(pt, dpi).toFixed(2) + 'px ' + (mono ? MONO : FAMILY); ctx.textAlign = 'left'; }
      // header (page 1 gets the summary; later pages a slim continuation line)
      setFont(12, true, false); ctx.fillText('PICK SHEET', left, Math.round(y)); y += pt2px(12, dpi) * 1.4;
      setFont(8, false, true);
      var hdr = pageNo === 1 ? (orderCount + ' order' + (orderCount === 1 ? '' : 's') + ' · ' + totalUnits + ' item' + (totalUnits === 1 ? '' : 's')) : ('continued · p' + pageNo);
      ctx.fillText(hdr, left, Math.round(y)); y += pt2px(8, dpi) * 1.4;
      y += 1.2 * pxPerMm; ctx.fillRect(left, Math.round(y), usableW, Math.max(1, Math.round(0.28 * pxPerMm))); y += 2.2 * pxPerMm;

      var lastLoc = null, placed = 0;
      while (idx < pageItems.length) {
        var row = pageItems[idx];
        // measure the height this row (loc header if new + wrapped title + meta) would consume
        var needsHeader = row.location !== lastLoc;
        setFont(9, false, false);
        var titleLines = wrapText(ctx, row.title || row.sku || row.ebay_item_id || 'item', usableW - 8 * (dpi / 96));
        var rowH = (needsHeader ? pt2px(9, dpi) * 1.6 + 1.5 * pxPerMm : 0)
          + titleLines.length * pt2px(9, dpi) * 1.25 + pt2px(7, dpi) * 1.3 + 1 * pxPerMm;
        if (placed > 0 && y + rowH > bottom) break;   // overflow → next page (but always place ≥1 row so we can't loop forever)

        if (needsHeader) {
          y += 1.2 * pxPerMm;
          setFont(9.5, true, false);
          ctx.fillText(row.location || 'Unsorted', left, Math.round(y));
          y += pt2px(9.5, dpi) * 1.6;
          lastLoc = row.location;
        }
        // checkbox glyph + qty + title
        setFont(9, true, false); var qtyStr = '[ ] ' + (row.quantity || 1) + '×  ';
        var qtyW = ctx.measureText(qtyStr).width;
        ctx.fillText(qtyStr, left, Math.round(y));
        for (var t = 0; t < titleLines.length; t++) {
          setFont(9, false, false);
          ctx.fillText(titleLines[t], Math.round(left + qtyW), Math.round(y));
          y += pt2px(9, dpi) * 1.25;
        }
        setFont(7, false, true);
        ctx.fillText((row.order_id || '') + '  @' + (row.buyer_username || ''), Math.round(left + qtyW), Math.round(y));
        y += pt2px(7, dpi) * 1.3 + 1 * pxPerMm;
        idx++; placed++;
      }
      jobs.push(canvasToJob(c.cv, wmm, hmm));
      if (idx >= pageItems.length) break;
    }
    return jobs;
  };
  function flattenGroups(groups) {
    var out = [];
    for (var g = 0; g < (groups || []).length; g++) {
      var loc = groups[g].location;
      for (var i = 0; i < groups[g].items.length; i++) { var r = groups[g].items[i]; out.push({ location: loc, title: r.title, sku: r.sku, quantity: r.quantity, order_id: r.order_id, buyer_username: r.buyer_username, ebay_item_id: r.ebay_item_id }); }
    }
    return out;
  }

  window.LR = LR;
})();
