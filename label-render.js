/* label-render.js — shared renderers for the AUSPRINT PRO print pipeline + the paper packing slip.
 *
 * Loaded as a classic <script src="/label-render.js"> and exposed as window.LR.
 *
 * ONE workflow, used in two places:
 *   • Thermal address label — layoutLines() fits the address to a canvas, rasterizeLayout() thresholds
 *     it to a 1-bpp bitmap (1 = ink, MSB-first, rows padded to a whole byte) — the exact job shape
 *     POST /api/print expects. shipping-label.html AND orders.html both go through renderLinesToJob(),
 *     so the same address prints an identical label from either page. (This replaces the old duplicate
 *     renderers: shipping-label.html renderLabelToBitmap() ≡ this canvasToJob loop.)
 *   • Packing slip / pick sheet — HTML printed on a NORMAL printer (or Save-as-PDF) via a hidden iframe.
 *
 * Golden Rule 7: when the printer is unconfigured, callers fall back to LR.downloadJob() (PNG).
 */
(function () {
  var LR = {
    _cfg: { enabled: false, dpi: 300 },
    // Store identity + the marketing links/discount printed on the packing slip. Single source of
    // truth so the copy is editable in one spot (later surfaceable in settings.html).
    config: {
      store: 'Binders Keepers',
      storeFull: 'Binders Keepers Collectables',
      logo: '/logos/binderskeepers.jpg',        // degrades to a text wordmark if the file is missing
      links: {
        // The linktree is the single CTA — it already fans out to the socials and the webstore.
        linktree: 'https://linktr.ee/binderskeeperscards',
        shop: 'https://binderskeepers.cards',                // not printed today; kept for reference
        ebayStore: 'https://www.ebay.com.au/str/binderskeeperstcg'
      },
      // Coupon block is off. Set a code here to switch it back on — the slip renders it automatically.
      discount: { code: '', blurb: '' },
      footer: ''
    }
  };

  /* ---------- printer config + transport ---------- */
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
  var MM_PER_PT = 25.4 / 72;
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
  // Map the tool's font choice to a browser family. helvetica/arial/default → Arial (matches the
  // AUSPRINT's rendered output); times → serif; courier → mono.
  function fontFamily(f) {
    switch (String(f || '').toLowerCase()) {
      case 'times': case 'serif': return '"Times New Roman", Times, serif';
      case 'courier': case 'mono': return '"Courier New", Courier, monospace';
      default: return 'Arial, Helvetica, sans-serif';
    }
  }
  // Reusable off-screen ctx for text measurement (resolution-independent — only ratios matter).
  var _measCtx = null;
  function measCtx() { if (!_measCtx) { var c = document.createElement('canvas'); c.width = c.height = 8; _measCtx = c.getContext('2d'); } return _measCtx; }

  // Threshold a rendered canvas to a 1-bpp job (dark pixel = ink bit 1). Crisp black-on-white text
  // needs no dithering, so this is the simple luminance threshold.
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
  LR.isPhoneLine = isPhoneLine;

  var COUNTRY_RE = /^(australia|new zealand|aotearoa|united states( of america)?|usa|u\.s\.a\.|united kingdom|u\.k\.|uk|england|scotland|wales|canada|ireland|singapore|germany|france|japan|china|hong kong|new caledonia|fiji|papua new guinea)$/i;
  function isCountryLine(l) { return COUNTRY_RE.test(String(l).trim()); }
  LR.isCountryLine = isCountryLine;

  // AusPost-preferred locality: "Suburb STATE 3030" — no commas. Collapse comma-separated
  // suburb/state/postcode lines (e.g. a pasted "Werribee, VIC, 3030") so both entry points agree.
  var AU_STATE_RE = /\b(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)\b/i;
  function normalizeLocality(line) {
    var s = String(line == null ? '' : line);
    if (AU_STATE_RE.test(s) && /\b\d{4}\b/.test(s)) return s.replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return s.trim();
  }
  LR.normalizeLocality = normalizeLocality;

  // Ship-to lines from the structured order fields: eBay AU puts the buyer's username in Street1
  // ("ebay:xxxx") and the real street in Street2, so drop any "ebay:" line and any bare phone line;
  // drop the domestic AU country line. Line 0 = recipient name. Locality is comma-free by construction.
  function cleanAddressLines(order) {
    var raw = [];
    if (order.ship_name) raw.push(order.ship_name);
    if (order.ship_street1) raw.push(order.ship_street1);
    if (order.ship_street2) raw.push(order.ship_street2);
    var cityline = [order.ship_city, order.ship_state].filter(Boolean).join(' ');
    if (order.ship_postal) cityline = (cityline ? cityline + ' ' : '') + order.ship_postal;
    if (cityline.trim()) raw.push(cityline.trim());
    var cn = order.ship_country_name || order.ship_country;
    if (cn && !/^au(s(tralia)?)?$/i.test(String(cn).trim())) raw.push(cn);
    return raw.map(function (l) { return String(l).trim(); }).filter(Boolean)
      .filter(function (l) { return !/^ebay:/i.test(l); })   // the eBay username line — never on a label
      .filter(function (l) { return !isPhoneLine(l); })
      .map(normalizeLocality);                               // same normalizer the free-text path uses → identical lines
  }
  LR.cleanAddressLines = cleanAddressLines;

  /* ---------- thermal address label: layout (fit) → raster (bitmap) ---------- */
  // layoutLines: fit `lines` to the label and return draw positions in MILLIMETRES (so the raster can
  // place them at any dpi and apply an mm print-nudge). Handles country auto/keep/drop, wrap, manual
  // pt override, and the bold recipient name. This is the single fit engine both pages share.
  // opts: { wmm,hmm,margin,minPt,maxPt,hardMax,lineSpacing,font,align,wrap,ptOverride,countryMode,boldFirst }
  LR.layoutLines = function (lines, opts) {
    opts = opts || {};
    var wmm = opts.wmm || 100, hmm = opts.hmm || 50, margin = opts.margin != null ? opts.margin : 5;
    var minPt = opts.minPt || 8, maxPt = opts.maxPt || 28, hardMax = opts.hardMax || Math.max(maxPt, 60);
    var lineSpacing = opts.lineSpacing || 1.2, family = fontFamily(opts.font);
    var align = opts.align === 'center' ? 'center' : 'left', boldFirst = opts.boldFirst !== false;
    var wrap = !!opts.wrap, countryMode = opts.countryMode || 'keep';
    var MEAS = 300, pxPerMm = MEAS / 25.4, pxPerPt = MEAS / 72;
    var usableWmm = wmm - 2 * margin, usableHmm = hmm - 2 * margin;
    var usableW = usableWmm * pxPerMm, usableH = usableHmm * pxPerMm;
    var ctx = measCtx();
    lines = (lines || []).map(function (l) { return String(l == null ? '' : l).trim(); }).filter(Boolean);

    function setFont(pt, bold) { ctx.font = (bold ? 'bold ' : '') + (pt * pxPerPt).toFixed(2) + 'px ' + family; }
    function physical(src, pt) {
      var out = [];
      for (var i = 0; i < src.length; i++) {
        var bold = boldFirst && i === 0;
        if (wrap) { setFont(pt, bold); var parts = wrapText(ctx, src[i], usableW); for (var j = 0; j < parts.length; j++) out.push({ t: parts[j], b: bold }); }
        else out.push({ t: src[i], b: bold });
      }
      return out;
    }
    function fitsAt(src, pt) {
      var phys = physical(src, pt), lineH = pt * pxPerPt * lineSpacing;
      if (phys.length * lineH > usableH + 1) return false;
      for (var i = 0; i < phys.length; i++) { setFont(pt, phys[i].b); if (ctx.measureText(phys[i].t).width > usableW + 1) return false; }
      return true;
    }
    function autoFit(src) { if (!src.length) return maxPt; for (var pt = maxPt; pt >= minPt; pt -= 0.5) { if (fitsAt(src, pt)) return pt; } return minPt; }

    // country auto/keep/drop (only if the last line is a country name)
    var dropped = false;
    if (lines.length && isCountryLine(lines[lines.length - 1]) && countryMode !== 'keep') {
      var without = lines.slice(0, -1);
      if (countryMode === 'drop') { lines = without; dropped = true; }
      else if (autoFit(without) > autoFit(lines)) { lines = without; dropped = true; }   // auto: keep only if it doesn't shrink the font
    }

    var autoPt = autoFit(lines);
    var pt = opts.ptOverride != null ? opts.ptOverride : autoPt;
    pt = Math.max(minPt, Math.min(pt, hardMax));
    var phys = physical(lines, pt);
    var overflow = !fitsAt(lines, pt);

    var lineHmm = pt * lineSpacing * MM_PER_PT, glyphHmm = pt * MM_PER_PT;
    var blockHmm = phys.length ? (phys.length - 1) * lineHmm + glyphHmm : 0;
    var topmm = margin + Math.max(0, (usableHmm - blockHmm) / 2);
    var xmm = align === 'center' ? wmm / 2 : margin;
    var draws = [];
    for (var i = 0; i < phys.length; i++) draws.push({ t: phys[i].t, x: xmm, y: topmm + i * lineHmm, pt: pt, bold: phys[i].b, align: align });
    return { draws: draws, pt: pt, autoPt: autoPt, overflow: overflow, dropped: dropped, lineCount: phys.length, lines: lines, wmm: wmm, hmm: hmm, font: opts.font };
  };

  // rasterizeLayout: draw a layout's mm-positioned text to a canvas at the printer dpi, applying the
  // print nudge (offXmm/offYmm), and threshold → 1-bpp job. The single rasteriser both pages share.
  LR.rasterizeLayout = function (layout, opts) {
    opts = opts || {};
    var wmm = opts.wmm || layout.wmm || 100, hmm = opts.hmm || layout.hmm || 50;
    var dpi = dpiOf(opts), family = fontFamily(opts.font || layout.font);
    var pxPerMm = dpi / 25.4, pxPerPt = dpi / 72;
    var c = mkCanvas(wmm, hmm, dpi), ctx = c.ctx;
    var offX = (opts.offXmm || 0) * pxPerMm, offY = (opts.offYmm || 0) * pxPerMm;
    var draws = layout.draws || [];
    for (var i = 0; i < draws.length; i++) {
      var d = draws[i];
      ctx.font = (d.bold ? 'bold ' : '') + (d.pt * pxPerPt).toFixed(2) + 'px ' + family;
      ctx.textAlign = d.align === 'center' ? 'center' : 'left';
      ctx.fillText(d.t, Math.round(d.x * pxPerMm + offX), Math.round(d.y * pxPerMm + offY));
    }
    return canvasToJob(c.cv, wmm, hmm);
  };

  // Fit `lines` then raster → job (carries the fit metadata for callers that surface status).
  LR.renderLinesToJob = function (lines, opts) {
    var layout = LR.layoutLines(lines, opts);
    var job = LR.rasterizeLayout(layout, opts);
    job.pt = layout.pt; job.autoPt = layout.autoPt; job.overflow = layout.overflow;
    job.dropped = layout.dropped; job.lineCount = layout.lineCount;
    return job;
  };

  // Structured-order entry point (orders.html). Defaults match shipping-label.html's 100×50 defaults
  // so the same address produces an identical label from either page. countryMode 'keep' because
  // cleanAddressLines has already resolved AU/foreign country lines.
  LR.renderAddressLabel = function (order, opts) {
    opts = opts || {};
    var merged = {
      wmm: opts.wmm || 100, hmm: opts.hmm || 50, margin: opts.margin != null ? opts.margin : 5,
      minPt: opts.minPt || 8, maxPt: opts.maxPt || 28, hardMax: opts.hardMax || 60,
      lineSpacing: opts.lineSpacing || 1.2, font: opts.font || 'arial', align: opts.align || 'left',
      boldFirst: true, countryMode: opts.countryMode || 'keep', dpi: opts.dpi,
      ptOverride: opts.ptOverride, offXmm: opts.offXmm, offYmm: opts.offYmm, wrap: opts.wrap
    };
    return LR.renderLinesToJob(cleanAddressLines(order), merged);
  };

  /* ---------- QR (embedded SVG, from the vendored qrcode-generator) ---------- */
  // Returns a crisp black-on-white <svg> string for `text` (a fixed marketing URL). Pure vector, so it
  // stays sharp at any print scale and always scans. Empty string if the lib didn't load (graceful).
  LR.qrSVG = function (text, opts) {
    opts = opts || {};
    if (typeof qrcode === 'undefined') return '';
    var ec = opts.ec || 'M', qr = null;
    for (var t = 1; t <= 40 && !qr; t++) {
      try { var q = qrcode(t, ec); q.addData(String(text)); q.make(); qr = q; } catch (e) { /* too small — grow */ }
    }
    if (!qr) return '';
    var n = qr.getModuleCount(), quiet = opts.quiet != null ? opts.quiet : 2, total = n + quiet * 2, path = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) path += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
    var size = opts.size || 120;
    return '<svg class="qr" width="' + size + '" height="' + size + '" viewBox="0 0 ' + total + ' ' + total
      + '" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code">'
      + '<rect width="' + total + '" height="' + total + '" fill="#fff"/><path d="' + path + '" fill="#000"/></svg>';
  };

  /* ---------- print a paper document via the browser dialog ---------- */
  // Hidden same-origin iframe (so it isn't popup-blocked). Two modes:
  //   • default        — openPrintDoc fires the print (pick sheet, legacy).
  //   • { selfPrint }  — the document triggers its own print once it's ready (after images load +
  //     the fit-to-page pass). openPrintDoc only handles the iframe lifecycle + cleanup.
  LR.openPrintDoc = function (html, opts) {
    opts = opts || {};
    var ifr = document.createElement('iframe');
    ifr.setAttribute('aria-hidden', 'true');
    ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(ifr);
    var win = ifr.contentWindow, cleaned = false, fired = false;
    function cleanup() { if (cleaned) return; cleaned = true; setTimeout(function () { if (ifr.parentNode) ifr.parentNode.removeChild(ifr); }, 500); }
    function go() { if (fired) return; fired = true; try { win.focus(); win.print(); } catch (e) { } setTimeout(cleanup, 60000); }
    win.onafterprint = cleanup;
    win.document.open(); win.document.write(html); win.document.close();
    if (opts.selfPrint) { setTimeout(cleanup, 120000); return; }   // the doc prints itself
    ifr.onload = go;        // fires in most browsers after document.close()
    setTimeout(go, 400);    // fallback — onload on a written iframe is unreliable (go() is single-fire)
  };

  // Print-ready HTML document shell (A4/Letter, black on white) — used by the pick sheet.
  function DOC(title, body) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>'
      + '@page{margin:14mm;}'
      + '*{box-sizing:border-box;}body{font-family:Arial,Helvetica,sans-serif;color:#000;font-size:12pt;line-height:1.4;margin:0;}'
      + '.store{font-size:20pt;font-weight:700;}.tag{font-size:9pt;letter-spacing:2px;color:#555;margin-top:1px;}'
      + '.meta{font-family:"Courier New",monospace;font-size:9.5pt;color:#333;margin:6px 0 16px;}'
      + 'table{width:100%;border-collapse:collapse;margin:6px 0;}th{text-align:left;font-size:8.5pt;letter-spacing:.5px;color:#555;border-bottom:2px solid #000;padding:6px 5px;}td{padding:8px 5px;border-bottom:1px solid #e2e2e2;font-size:11.5pt;vertical-align:top;}'
      + '.box{font-family:"Courier New",monospace;font-weight:700;white-space:nowrap;}.qty{text-align:center;width:44px;}.chk{width:26px;}.chk::before{content:"";display:inline-block;width:12px;height:12px;border:1.5px solid #000;vertical-align:middle;}.ord{font-family:"Courier New",monospace;font-size:8.5pt;color:#666;white-space:nowrap;}'
      + 'h2{font-size:12pt;margin:20px 0 4px;padding-bottom:3px;border-bottom:1px solid #000;page-break-after:avoid;}h2 span{color:#888;font-weight:400;font-size:10pt;}tr{page-break-inside:avoid;}'
      + '</style></head><body>' + body + '</body></html>';
  }

  /* ---------- packing slip (adaptive single A4: branded slip + marketing, greyscale) ---------- */
  function firstName(s) { var m = String(s == null ? '' : s).trim().split(/\s+/)[0]; return m || ''; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function niceDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); if (!m) return '';
    return (+m[3]) + ' ' + (MON[(+m[2]) - 1] || '') + ' ' + m[1];
  }
  function host(url) { return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); }

  LR.packingSlipHTML = function (order) {
    var cfg = LR.config || {}, links = cfg.links || {}, disc = cfg.discount || {};
    var addr = cleanAddressLines(order);
    var name = addr.length ? addr[0] : '';
    var rest = addr.slice(1);
    var fn = firstName(order.ship_name || name);
    var date = niceDate(order.paid_time);

    var rows = (order.items || []).map(function (it) {
      var box = it.sku ? esc(it.sku) : (it.location ? esc(it.location) : '&mdash;');
      var img = it.image_url
        ? '<img class="th" src="' + esc(it.image_url) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '<span class="th none"></span>';
      var iid = it.ebay_item_id ? '<span class="iid">#' + esc(it.ebay_item_id) + '</span>' : '';
      var qty = it.quantity || 1;
      var lineTot = it.unit_price_cents != null ? money((+it.unit_price_cents) * qty, order.currency) : '';
      return '<div class="irow">'
        + '<span class="tick"></span>' + img
        + '<span class="bx"><span class="sku">' + box + '</span></span>'
        + '<span class="ti">' + esc(it.title || it.ebay_item_id || 'item') + iid + '</span>'
        + '<span class="q">' + qty + '</span>'
        + '<span class="tot">' + lineTot + '</span>'
        + '</div>';
    }).join('');

    var meta = [];
    if (order.order_id) meta.push('Order ' + esc(order.order_id));
    if (order.sales_record_number) meta.push('Sales #' + esc(order.sales_record_number));

    var note = order.buyer_note ? '<div class="note"><b>Note from buyer:</b> ' + esc(order.buyer_note) + '</div>' : '';

    // Marketing QR (fixed URL) — computed here on the host page (where the qrcode lib is loaded) and
    // embedded as static SVG, so the print iframe needs no library. One CTA: the linktree hub.
    var qrFollow = links.linktree ? LR.qrSVG(links.linktree, { size: 150 }) : '';

    var couponHTML = disc.code
      ? '<div class="coupon"><div class="cpn-l">NEXT ORDER</div><div class="cpn-c">' + esc(disc.code) + '</div>'
        + '<div class="cpn-b">' + esc(disc.blurb || '') + (links.shop ? ' at ' + esc(host(links.shop)) : '') + '</div></div>'
      : '';

    var body = ''
      + '<div class="sheet">'
      // ---- brand header ----
      + '<header class="hd">'
      + '<div class="brand">'
      + (cfg.logo ? '<img class="logo" src="' + esc(cfg.logo) + '" alt="' + esc(cfg.storeFull || cfg.store || '') + '"'
        + ' onload="this.parentNode.classList.add(&#39;haslogo&#39;)" onerror="this.remove()">' : '')
      + '<div class="bwrap"><div class="bstore">' + esc(cfg.store || 'Binders Keepers') + '</div>'
      + '<div class="bsub">' + esc((cfg.storeFull || '').replace(cfg.store || '', '').trim() || 'Collectables') + '</div></div>'
      + '</div>'
      + '<div class="hmeta"><div class="htag">PACKING SLIP</div>'
      + (order.order_id ? '<div class="hord">Order ' + esc(order.order_id) + '</div>' : '')
      + '<div class="hsub">' + [date, (order.sales_record_number ? 'Sales #' + esc(order.sales_record_number) : '')].filter(Boolean).join(' &middot; ') + '</div></div>'
      + '</header>'
      // ---- thank-you + ship-to ----
      + '<div class="mid">'
      + '<div class="thanks">Thanks so much for your order' + (fn ? ', <b>' + esc(fn) + '</b>' : '') + '! Hope you love the cards.</div>'
      + '<section class="shipto"><div class="lbl">SHIP TO</div><div class="nm">' + esc(name) + '</div>'
      + rest.map(function (l) { return '<div class="al">' + esc(l) + '</div>'; }).join('') + '</section>'
      + note
      + '</div>'
      // ---- items ----
      + '<div class="items"><div class="ihead"><span class="tick-h"></span><span class="im-h"></span>'
      + '<span class="bx">Box</span><span class="ti">Item</span><span class="q">Qty</span><span class="tot">Total</span></div>'
      + '<div class="ilist">' + rows + '</div></div>'
      + '<div class="foot"><div class="ftot"><span>Order total</span><b>' + esc(money(order.total_cents, order.currency)) + '</b></div></div>'
      // ---- marketing band (bottom-anchored, greyscale) ----
      + '<section class="mkt">'
      + '<div class="mkt-hd"><div class="mkt-t">Loved your cards? There&rsquo;s plenty more.</div>'
      + '<div class="mkt-s">New singles and sealed land all the time, and everything we do lives in one place.</div></div>'
      + '<div class="mkt-grid">'
      + '<div class="tile">' + qrFollow
      + '<div class="tx"><b>Follow us, and show us your pulls</b>'
      + '<span>Scan for our socials, our store, and what&rsquo;s dropping next. Tag us in your pulls, we love seeing them.</span>'
      + '<span class="url">' + esc(host(links.linktree)) + '</span></div></div>'
      + '</div>'
      + '<div class="mkt-ft">' + couponHTML
      + '<div class="fb">Happy with your order? A quick 5-star rating on eBay means the world to a small team like ours. 💜</div></div>'
      + '</section>'
      + '</div>';   // .sheet

    return slipDOC('Packing slip ' + (order.order_id || ''), body);
  };

  // A4 shell for the packing slip: greyscale, everything scales with --s so the fit pass can shrink a
  // big order to a single page while keeping the marketing band. Self-prints once images load + it fits.
  function slipDOC(title, body) {
    var css = ''
      + '@page{size:A4;margin:0;}'
      + '*{box-sizing:border-box;margin:0;padding:0;}'
      + ':root{--s:1;}'
      + 'html,body{background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
      + '.sheet{width:210mm;min-height:297mm;margin:0 auto;padding:calc(13mm*var(--s)) calc(14mm*var(--s)) calc(10mm*var(--s));display:flex;flex-direction:column;}'
      // header
      + '.hd{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding-bottom:calc(8pt*var(--s));border-bottom:2px solid #111;}'
      + '.brand{display:flex;align-items:center;gap:calc(10pt*var(--s));min-width:0;}'
      // The logo artwork already contains the "Binders Keepers" wordmark, so the text wordmark beside it
      // is hidden once the image actually loads — and shown as the fallback if it 404s.
      + '.logo{width:calc(88px*var(--s));height:calc(88px*var(--s));object-fit:contain;border-radius:8px;}'
      + '.brand.haslogo .bwrap{display:none;}'
      + '.bstore{font-family:Georgia,"Times New Roman",serif;font-weight:700;font-size:calc(22pt*var(--s));line-height:1;letter-spacing:-.01em;}'
      + '.bsub{font-size:calc(9pt*var(--s));letter-spacing:.32em;text-transform:uppercase;color:#666;margin-top:calc(3pt*var(--s));}'
      + '.hmeta{text-align:right;flex:none;}'
      + '.htag{font-size:calc(8.5pt*var(--s));letter-spacing:.28em;color:#888;font-weight:700;}'
      + '.hord{font-family:"Courier New",monospace;font-weight:700;font-size:calc(12.5pt*var(--s));margin-top:calc(2pt*var(--s));}'
      + '.hsub{font-family:"Courier New",monospace;font-size:calc(9pt*var(--s));color:#666;margin-top:calc(1pt*var(--s));}'
      // mid: thanks + ship-to
      + '.mid{margin-top:calc(10pt*var(--s));}'
      + '.thanks{font-family:Georgia,serif;font-size:calc(13.5pt*var(--s));color:#222;margin-bottom:calc(9pt*var(--s));}'
      + '.shipto{border-left:3px solid #111;padding-left:calc(9pt*var(--s));}'
      + '.shipto .lbl{font-size:calc(7.5pt*var(--s));letter-spacing:.2em;color:#888;margin-bottom:calc(2pt*var(--s));}'
      + '.shipto .nm{font-size:calc(14pt*var(--s));font-weight:700;line-height:1.15;}'
      + '.shipto .al{font-size:calc(11pt*var(--s));color:#333;line-height:1.3;}'
      + '.note{margin-top:calc(8pt*var(--s));border:1px solid #bbb;border-radius:6px;padding:calc(6pt*var(--s)) calc(9pt*var(--s));font-size:calc(10pt*var(--s));background:#f6f6f6;}'
      // items
      + '.items{margin-top:calc(12pt*var(--s));}'
      + '.ihead,.irow{display:flex;align-items:center;gap:calc(6pt*var(--s));}'
      + '.ihead{padding:0 calc(4pt*var(--s)) calc(5pt*var(--s));border-bottom:2px solid #111;font-size:calc(7.5pt*var(--s));letter-spacing:.1em;text-transform:uppercase;color:#777;font-weight:700;}'
      + '.irow{padding:calc(5pt*var(--s)) calc(4pt*var(--s));border-bottom:1px solid #e2e2e2;break-inside:avoid;}'
      + '.tick{width:calc(13px*var(--s));height:calc(13px*var(--s));flex:none;border:1.5px solid #333;border-radius:3px;}'
      + '.tick-h{width:calc(13px*var(--s));flex:none;}'
      + '.th{width:calc(34px*var(--s));height:calc(47px*var(--s));flex:none;object-fit:cover;border:1px solid #ccc;border-radius:3px;filter:grayscale(1);}'
      + '.th.none{width:calc(34px*var(--s));height:calc(47px*var(--s));flex:none;display:inline-block;border-radius:3px;background:repeating-linear-gradient(135deg,#eee,#eee 3px,#f7f7f7 3px,#f7f7f7 6px);}'
      + '.im-h{width:calc(34px*var(--s));flex:none;}'
      + '.bx{width:calc(72px*var(--s));flex:none;}'
      + '.sku{font-family:"Courier New",monospace;font-weight:700;font-size:calc(10pt*var(--s));white-space:nowrap;}'
      + '.ti{flex:1;min-width:0;font-size:calc(10.5pt*var(--s));line-height:1.2;}'
      + '.iid{display:block;font-family:"Courier New",monospace;font-size:calc(7pt*var(--s));color:#999;}'
      + '.q{width:calc(34px*var(--s));flex:none;text-align:center;font-weight:700;font-size:calc(10.5pt*var(--s));}'
      + '.tot{width:calc(58px*var(--s));flex:none;text-align:right;font-family:"Courier New",monospace;font-size:calc(9.5pt*var(--s));color:#444;white-space:nowrap;}'
      + '.sheet.nothumb .th,.sheet.nothumb .im-h{display:none;}'
      + '.sheet.twocol .ihead{display:none;}'
      + '.sheet.twocol .ilist{column-count:2;column-gap:calc(9mm*var(--s));}'
      + '.sheet.compact .mkt-s{display:none;}'
      + '.sheet.compact .tile .tx span:not(.url){display:none;}'
      + '.sheet.compact .tile .qr{width:calc(62px*var(--s));height:calc(62px*var(--s));}'
      + '.foot{margin-top:calc(6pt*var(--s));}'
      + '.ftot{display:flex;justify-content:flex-end;gap:calc(14pt*var(--s));align-items:baseline;font-size:calc(11pt*var(--s));}'
      + '.ftot b{font-size:calc(15pt*var(--s));}'
      // marketing band — bottom anchored
      + '.mkt{margin-top:auto;padding-top:calc(11pt*var(--s));}'
      + '.mkt-hd{border-top:2px dashed #bbb;padding-top:calc(9pt*var(--s));}'
      + '.mkt-t{font-family:Georgia,serif;font-weight:700;font-size:calc(16pt*var(--s));line-height:1.1;}'
      + '.mkt-s{font-size:calc(10.5pt*var(--s));color:#555;margin-top:calc(3pt*var(--s));}'
      + '.mkt-grid{display:flex;gap:calc(16pt*var(--s));margin-top:calc(10pt*var(--s));}'
      + '.tile{flex:1;display:flex;gap:calc(13pt*var(--s));align-items:center;border:1px solid #ccc;border-radius:8px;padding:calc(10pt*var(--s));background:#fafafa;}'
      + '.tile .qr{width:calc(104px*var(--s));height:calc(104px*var(--s));flex:none;}'
      + '.tile .tx{min-width:0;}'
      + '.tile .tx b{font-size:calc(12.5pt*var(--s));display:block;}'
      + '.tile .tx span{display:block;font-size:calc(9.5pt*var(--s));color:#555;line-height:1.3;margin-top:1px;}'
      + '.tile .tx .url{font-family:"Courier New",monospace;font-size:calc(9pt*var(--s));color:#111;margin-top:calc(3pt*var(--s));font-weight:700;}'
      + '.mkt-ft{display:flex;gap:calc(12pt*var(--s));align-items:stretch;margin-top:calc(10pt*var(--s));}'
      + '.coupon{flex:none;border:2px dashed #111;border-radius:8px;padding:calc(6pt*var(--s)) calc(12pt*var(--s));text-align:center;display:flex;flex-direction:column;justify-content:center;}'
      + '.coupon .cpn-l{font-size:calc(7.5pt*var(--s));letter-spacing:.22em;color:#777;}'
      + '.coupon .cpn-c{font-family:"Courier New",monospace;font-weight:700;font-size:calc(17pt*var(--s));letter-spacing:.06em;line-height:1;}'
      + '.coupon .cpn-b{font-size:calc(8.5pt*var(--s));color:#555;margin-top:calc(2pt*var(--s));}'
      + '.fb{flex:1;display:flex;align-items:center;font-size:calc(10pt*var(--s));color:#333;background:#f2f2f2;border-radius:8px;padding:calc(6pt*var(--s)) calc(11pt*var(--s));line-height:1.35;}'
      + '@media screen{body{background:#e9e9ee;padding:16px 0;}.sheet{box-shadow:0 8px 30px rgba(0,0,0,.25);background:#fff;}}';

    // self-print: wait for card thumbnails, shrink to one page, then print.
    var script = '(function(){'
      + 'function A4px(){var p=document.createElement("div");p.style.cssText="position:absolute;visibility:hidden;height:297mm;";document.body.appendChild(p);var h=p.offsetHeight;p.remove();return h;}'
      // .sheet has min-height:297mm, so a fitting page measures EXACTLY one A4 (never less); only a
      // genuine overflow exceeds it. Threshold sits +2px above the page so a fitting page is left at s=1.
      // Ladder for big orders: scale down → drop thumbnails → two-column items → compact marketing.
      + 'function fit(){var root=document.documentElement,sheet=document.querySelector(".sheet"),max=A4px()+2,s=1;'
      + 'function over(){return sheet.scrollHeight>max;}'
      + 'function shrink(f){while(over()&&s>f){s=Math.round((s-0.03)*100)/100;root.style.setProperty("--s",s);}}'
      + 'root.style.setProperty("--s",1);shrink(0.62);'
      + 'if(over()){sheet.classList.add("nothumb");shrink(0.52);}'
      + 'if(over()){sheet.classList.add("twocol");shrink(0.46);}'
      + 'if(over()){sheet.classList.add("compact");shrink(0.36);}}'
      + 'function done(){try{fit();}catch(e){}try{window.focus();window.print();}catch(e){}}'
      + 'var imgs=[].slice.call(document.images).filter(function(im){return !im.complete;});'
      + 'if(!imgs.length){setTimeout(done,40);return;}'
      + 'var n=imgs.length,fired=false;function one(){if(--n<=0&&!fired){fired=true;done();}}'
      + 'imgs.forEach(function(im){im.addEventListener("load",one);im.addEventListener("error",one);});'
      + 'setTimeout(function(){if(!fired){fired=true;done();}},4000);'
      + '})();';

    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' + css
      + '</style></head><body>' + body + '<' + 'script>' + script + '<' + '/script></body></html>';
  }

  /* ---------- pick sheet (browser print / PDF — grouped by box, sorted by slot) ---------- */
  LR.pickSheetHTML = function (groups, meta) {
    meta = meta || {};
    var sections = (groups || []).map(function (g) {
      var rows = g.items.map(function (it) {
        return '<tr><td class="chk"></td><td class="box">' + esc(it.sku || '') + '</td><td class="qty">' + (it.quantity || 1)
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
