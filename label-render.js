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

  /* ---------- shared HTML / address helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(cents, cur) { return (cur === 'AUD' || !cur ? 'A$' : cur + ' ') + ((Math.round(+cents || 0)) / 100).toFixed(2); }
  function isPhoneLine(l) { var d = (String(l).match(/\d/g) || []).length; return d >= 6 && !/[a-zA-Z]/.test(l); }

  // Ship-to lines from the structured order fields, cleaned exactly like shipping-label.html: eBay AU
  // puts the buyer's username in Street1 ("ebay:xxxx") and the real street in Street2, so drop any
  // "ebay:" line and any bare phone line; drop the domestic AU country line. Line 0 = recipient name.
  function cleanAddressLines(order) {
    var raw = [];
    if (order.ship_name) raw.push(order.ship_name);
    if (order.ship_street1) raw.push(order.ship_street1);
    if (order.ship_street2) raw.push(order.ship_street2);
    var cityline = [order.ship_city, order.ship_state].filter(Boolean).join(' ');
    if (order.ship_postal) cityline = (cityline ? cityline + '  ' : '') + order.ship_postal;
    if (cityline.trim()) raw.push(cityline.trim());
    var cn = order.ship_country_name || order.ship_country;
    if (cn && !/^au(s(tralia)?)?$/i.test(String(cn).trim())) raw.push(cn);
    return raw.map(function (l) { return String(l).trim(); }).filter(Boolean)
      .filter(function (l) { return !/^ebay:/i.test(l); })   // the eBay username line — never on a label
      .filter(function (l) { return !isPhoneLine(l); });
  }
  LR.cleanAddressLines = cleanAddressLines;

  // Print an HTML document via the browser's own print dialog (normal printer OR "Save as PDF"), using
  // a hidden same-origin iframe so it isn't popup-blocked. For paper documents (packing slip, pick
  // sheet) — NOT the thermal printer.
  LR.openPrintDoc = function (html) {
    var ifr = document.createElement('iframe');
    ifr.setAttribute('aria-hidden', 'true');
    ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(ifr);
    var win = ifr.contentWindow, cleaned = false, fired = false;
    function cleanup() { if (cleaned) return; cleaned = true; setTimeout(function () { if (ifr.parentNode) ifr.parentNode.removeChild(ifr); }, 500); }
    function go() { if (fired) return; fired = true; try { win.focus(); win.print(); } catch (e) { } setTimeout(cleanup, 60000); }
    win.onafterprint = cleanup;
    win.document.open(); win.document.write(html); win.document.close();
    ifr.onload = go;        // fires in most browsers after document.close()
    setTimeout(go, 400);    // fallback — onload on a written iframe is unreliable (go() is single-fire)
  };

  // Print-ready HTML document shell (A4/Letter, black on white).
  function DOC(title, body) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>'
      + '@page{margin:14mm;}'
      + '*{box-sizing:border-box;}body{font-family:Arial,Helvetica,sans-serif;color:#000;font-size:12pt;line-height:1.4;margin:0;}'
      + '.store{font-size:20pt;font-weight:700;}.tag{font-size:9pt;letter-spacing:2px;color:#555;margin-top:1px;}'
      + '.meta{font-family:"Courier New",monospace;font-size:9.5pt;color:#333;margin:6px 0 16px;}'
      + '.shipto{margin:6px 0 18px;}.shipto .lbl{font-size:8pt;letter-spacing:1.5px;color:#777;margin-bottom:3px;}.shipto .name{font-size:15pt;font-weight:700;}.shipto div{margin:1px 0;}'
      + 'table{width:100%;border-collapse:collapse;margin:6px 0;}th{text-align:left;font-size:8.5pt;letter-spacing:.5px;color:#555;border-bottom:2px solid #000;padding:6px 5px;}td{padding:8px 5px;border-bottom:1px solid #e2e2e2;font-size:11.5pt;vertical-align:top;}'
      + '.box{font-family:"Courier New",monospace;font-weight:700;white-space:nowrap;}.qty{text-align:center;width:44px;}.chk{width:26px;font-size:14pt;}.ord{font-family:"Courier New",monospace;font-size:8.5pt;color:#666;white-space:nowrap;}'
      + '.total{text-align:right;font-size:14pt;font-weight:700;margin-top:12px;}.note{margin-top:16px;border:1px solid #bbb;border-radius:6px;padding:9px 12px;font-size:11pt;background:#f7f7f7;}.thanks{margin-top:26px;font-size:11pt;color:#222;}'
      + 'h2{font-size:12pt;margin:20px 0 4px;padding-bottom:3px;border-bottom:1px solid #000;page-break-after:avoid;}h2 span{color:#888;font-weight:400;font-size:10pt;}table.pick tr{page-break-inside:avoid;}'
      + '</style></head><body>' + body + '</body></html>';
  }

  /* ---------- address label (thermal — the AUSPRINT sticky label for the envelope) ---------- */
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
    var lines = cleanAddressLines(order);
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

  /* ---------- packing slip (browser print / PDF on a NORMAL printer — carries the box/slot) ---------- */
  LR.packingSlipHTML = function (order) {
    var store = (LR.config && LR.config.store) || 'Binders Keepers';
    var addr = cleanAddressLines(order);           // already strips the eBay username line
    var name = addr.length ? addr[0] : '';
    var rest = addr.slice(1);
    var meta = ['Order ' + esc(order.order_id || '')];
    if (order.sales_record_number) meta.push('Sales #' + esc(order.sales_record_number));
    var d = order.paid_time ? String(order.paid_time).slice(0, 10) : '';
    if (d) meta.push(esc(d));
    var rows = (order.items || []).map(function (it) {
      var box = it.sku ? esc(it.sku) : (it.location ? esc(it.location) : '&mdash;');
      return '<tr><td class="box">' + box + '</td><td class="qty">' + (it.quantity || 1) + '</td><td>' + esc(it.title || it.ebay_item_id || 'item') + '</td></tr>';
    }).join('');
    var note = order.buyer_note ? '<div class="note"><b>Note from buyer:</b> ' + esc(order.buyer_note) + '</div>' : '';
    var footer = (LR.config && LR.config.footer) ? ' ' + esc(LR.config.footer) : '';
    return DOC('Packing slip ' + (order.order_id || ''),
      '<div class="store">' + esc(store) + '</div><div class="tag">PACKING SLIP</div>'
      + '<div class="meta">' + meta.join(' &nbsp;&middot;&nbsp; ') + '</div>'
      + '<div class="shipto"><div class="lbl">SHIP TO</div><div class="name">' + esc(name) + '</div>'
      + rest.map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('') + '</div>'
      + '<table><thead><tr><th>Box / Slot</th><th class="qty">Qty</th><th>Item</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="total">Total &nbsp; ' + esc(money(order.total_cents, order.currency)) + '</div>'
      + note
      + '<div class="thanks">Thanks so much for your order &mdash; hope you love the cards!' + footer + '</div>'
    );
  };

  /* ---------- pick sheet (browser print / PDF — grouped by box, sorted by slot) ---------- */
  // groups: [{ location, items:[{ title, sku, quantity, order_id, buyer_username }] }] from /api/postsale/picksheet.
  LR.pickSheetHTML = function (groups, meta) {
    meta = meta || {};
    var sections = (groups || []).map(function (g) {
      var rows = g.items.map(function (it) {
        return '<tr><td class="chk">&#9744;</td><td class="box">' + esc(it.sku || '') + '</td><td class="qty">' + (it.quantity || 1)
          + '</td><td>' + esc(it.title || 'item') + '</td><td class="ord">' + esc(it.order_id || '') + '</td></tr>';
      }).join('');
      return '<h2>' + esc(g.location || 'Unsorted') + ' <span>(' + g.items.length + ')</span></h2>'
        + '<table class="pick"><tbody>' + rows + '</tbody></table>';
    }).join('');
    var summary = (meta.order_count || 0) + ' orders · ' + (meta.item_count || 0) + ' lines · ' + (meta.unit_count || 0) + ' units';
    return DOC('Pick sheet',
      '<div class="store">Pick sheet</div><div class="meta">' + esc(summary) + '</div>' + (sections || '<p>Nothing to pick.</p>')
    );
  };

  window.LR = LR;
})();
