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
      + '*{box-sizing:border-box;}body{font-family:Arial,Helvetica,sans-serif;color:#000;font-size:12pt;line-height:1.4;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
      + '.store{font-size:20pt;font-weight:700;}.tag{font-size:9pt;letter-spacing:2px;color:#555;margin-top:1px;}'
      + '.meta{font-family:"Courier New",monospace;font-size:9.5pt;color:#333;margin:6px 0 16px;}'
      + 'table{width:100%;border-collapse:collapse;margin:6px 0;}th{text-align:left;font-size:8.5pt;letter-spacing:.5px;color:#555;border-bottom:2px solid #000;padding:6px 5px;}td{padding:8px 5px;border-bottom:1px solid #e2e2e2;font-size:11.5pt;vertical-align:top;}'
      + '.box{font-family:"Courier New",monospace;font-weight:700;white-space:nowrap;}.qty{text-align:center;width:44px;}.chk{width:26px;}.chk::before{content:"";display:inline-block;width:14px;height:14px;border:1.5px solid #000;vertical-align:middle;}.ord{font-family:"Courier New",monospace;font-size:8.5pt;color:#666;white-space:nowrap;}'
      + '.pim{width:56px;padding:5px;}.pim img{width:46px;height:64px;object-fit:cover;border:1px solid #ccc;border-radius:3px;filter:grayscale(1);}.pim .pnone{display:inline-block;width:46px;height:64px;border-radius:3px;background:repeating-linear-gradient(135deg,#eee,#eee 3px,#f7f7f7 3px,#f7f7f7 6px);}'
      + 'h2{font-size:12pt;margin:20px 0 4px;padding-bottom:3px;border-bottom:1px solid #000;page-break-after:avoid;}h2 span{color:#888;font-weight:400;font-size:10pt;}tr{page-break-inside:avoid;}'
      // --- postage ---
      // Tiers are told apart by BORDER WEIGHT, not by a filled background: browsers print with
      // "Background graphics" off by default, so a reversed block can come out as white text on white
      // paper. Silent and invisible is the one failure mode this feature cannot have.
      + '.tier{display:inline-block;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:7.5pt;letter-spacing:.09em;padding:1px 5px;white-space:nowrap;line-height:1.5;}'
      + '.t-express{border:2.5px solid #000;color:#000;}'
      + '.t-tracked{border:1.5px solid #000;color:#000;}'
      + '.t-paid{border:1px dashed #555;color:#333;}'
      + '.tc{width:78px;text-align:right;}'
      // Exception banner: read before anyone walks off to the shelves, so it sits above the first box.
      + '.upg{border:3px solid #000;margin:0 0 16px;page-break-inside:avoid;}'
      + '.upg-hd{font-size:12pt;font-weight:700;letter-spacing:.14em;text-transform:uppercase;padding:7px 10px;border-bottom:3px solid #000;background:#eee;}'
      + '.upg table{width:100%;border-collapse:collapse;margin:0;}'
      + '.upg td{padding:6px 10px;border-bottom:1px solid #ccc;font-size:10.5pt;vertical-align:middle;}'
      + '.upg tr:last-child td{border-bottom:0;}'
      + '.upg .tc{width:96px;text-align:left;}'
      + '.upg .who{font-size:9.5pt;color:#555;}'
      + '.upg .do{font-weight:700;text-align:right;white-space:nowrap;}'
      // The hold banner is the same block, shouting. These print on a mono laser, so the separation
      // has to survive greyscale: a heavier rule and a solid black header, not a colour.
      + '.upg.hold{border-width:5px;}'
      + '.upg.hold .upg-hd{background:#000;color:#fff;}'
      + '.upg.hold .tc{width:44px;font-size:14pt;text-align:center;}'
      + '</style></head><body>' + body + '</body></html>';
  }

  /* ---------- packing slip (adaptive single A4: branded slip + marketing, greyscale) ---------- */
  function firstName(s) { var m = String(s == null ? '' : s).trim().split(/\s+/)[0]; return m || ''; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // The date on paper is the SYDNEY date (AEST/AEDT), converted from the stored UTC timestamp — near
  // UTC midnight the raw ISO date is the wrong day here in Australia. Uses numeric Intl parts + MON so
  // the month is always "Jul" (ICU 'short' can render "July"); falls back to the raw ISO date offline.
  function sydParts(iso) {
    var d = iso ? new Date(iso) : null;
    if (d && !isNaN(d.getTime())) {
      try {
        var p = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
        var o = {}; for (var i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
        return { d: +o.day, m: +o.month, y: +o.year };
      } catch (e) { /* fall through to raw ISO */ }
    }
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? { d: +m[3], m: +m[2], y: +m[1] } : null;
  }
  function niceDate(iso) {
    var p = sydParts(iso);
    return p ? p.d + ' ' + (MON[p.m - 1] || '') + ' ' + p.y : '';
  }
  // "4 Aug" — the year is noise on a delivery estimate that is always days away.
  function shortDate(iso) {
    var p = sydParts(iso);
    return p ? p.d + ' ' + (MON[p.m - 1] || '') : '';
  }
  // A delivery window as one phrase: "4 Aug", "4–6 Aug", "30 Jul – 2 Aug".
  function dateRange(a, b) {
    var pa = sydParts(a), pb = sydParts(b);
    if (!pa && !pb) return '';
    if (!pa) pa = pb; if (!pb) pb = pa;
    if (pa.y === pb.y && pa.m === pb.m) {
      return pa.d === pb.d ? shortDate(a || b) : pa.d + '–' + pb.d + ' ' + (MON[pa.m - 1] || '');
    }
    return pa.d + ' ' + (MON[pa.m - 1] || '') + ' – ' + pb.d + ' ' + (MON[pb.m - 1] || '');
  }

  /* ---------- postage ----------------------------------------------------------------------- */
  // lib/postage.mjs is the source of truth for these tiers and does the classifying; the server hands
  // every order down with a ready-made `postage` object. All this side needs is the ordering, so a
  // combined slip covering several orders can show the strongest tier across them.
  LR.TIERS = ['standard', 'paid', 'tracked', 'express'];
  function tierRank(t) { var i = LR.TIERS.indexOf(String(t || 'standard')); return i < 0 ? 0 : i; }
  function strongestTier(list) {
    return (list || []).reduce(function (best, t) { return tierRank(t) > tierRank(best) ? t : best; }, 'standard');
  }
  // The word that goes in the box. Short enough to read from across a packing bench.
  var TIER_WORD = { express: 'EXPRESS', tracked: 'TRACKED', paid: 'PAID POSTAGE' };

  // Print treatment is border WEIGHT, never a filled background with knocked-out text. Browsers print
  // with "Background graphics" off by default, and an inverted block whose fill doesn't print is white
  // text on white paper — invisible. Which is the exact failure this whole feature exists to prevent.
  function tierChip(tier, cls) {
    return TIER_WORD[tier] ? '<span class="' + (cls || 'tier') + ' t-' + esc(tier) + '">' + TIER_WORD[tier] + '</span>' : '';
  }
  function host(url) { return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); }

  // One item row on a packing slip (shared by single + combined slips). This is the CUSTOMER copy —
  // no picking tick-box and no internal box/SKU code (the seller-side pick sheet carries those); a
  // larger card image, closer to eBay's own slip.
  function slipItemRow(it, order) {
    var img = it.image_url
      ? '<img class="th" src="' + esc(it.image_url) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
      : '<span class="th none"></span>';
    var iid = it.ebay_item_id ? '<span class="iid">#' + esc(it.ebay_item_id) + '</span>' : '';
    var qty = it.quantity || 1;
    var lineTot = it.unit_price_cents != null ? money((+it.unit_price_cents) * qty, order.currency) : '';
    return '<div class="irow">'
      + img
      + '<span class="ti">' + esc(it.title || it.ebay_item_id || 'item') + iid + '</span>'
      + '<span class="q">' + qty + '</span>'
      + '<span class="tot">' + lineTot + '</span>'
      + '</div>';
  }

  // The POSTAGE block on a packing slip. Customer-facing wording, seller-legible weight: it reads to
  // the buyer as confirmation that we saw what they paid for, and it is the second checkpoint for
  // whoever is packing — the pick sheet catches it at the shelf, this catches it at the bench.
  //
  // A free letter (the great majority of card orders) gets one quiet grey line and no box. Only an
  // upgrade gets a bordered block, so a sheet with a box on it is worth stopping for.
  function postageBlockHTML(orders) {
    var ps = orders.map(function (o) { return o.postage || {}; }).filter(function (p) { return p && p.tier; });
    if (!ps.length) return '';
    var tier = strongestTier(ps.map(function (p) { return p.tier; }));
    var lead = ps[0];
    var paid = orders.reduce(function (n, o) { return n + (+(o.postage && o.postage.paid_cents) || 0); }, 0);

    var line = esc(lead.label || 'Standard delivery');
    if (tier === 'standard' && !paid) line += ', free';
    else if (paid) line += ' &middot; ' + esc(money(paid, orders[0].currency));

    // Scheduled dates only exist once the parcel is moving, and they are the accurate ones by then, so
    // the wording follows the source rather than promising an estimate as a fact.
    var win = dateRange(lead.eta_min, lead.eta_max);
    var eta = win ? (lead.eta_source === 'scheduled' ? 'Arriving ' + esc(win) : 'Estimated arrival ' + esc(win)) : '';

    // Present on a reprint after the label was bought. eBay shows the buyer this on their order page
    // too, so it is a convenience here, not the only copy.
    var trk = lead.tracking
      ? '<div class="ptrk">Tracking &middot; <b>' + esc(lead.tracking) + '</b>' + (lead.carrier ? ' (' + esc(lead.carrier) + ')' : '') + '</div>'
      : '';

    return '<section class="postage t-' + esc(tier) + (tier !== 'standard' ? ' up' : '') + '">'
      + '<div class="lbl">POSTAGE</div>'
      + (TIER_WORD[tier] ? '<div class="pblock">' + TIER_WORD[tier] + '</div>' : '')
      + '<div class="pline">' + line + '</div>'
      + (eta ? '<div class="peta">' + eta + '</div>' : '')
      + trk
      + '</section>';
  }

  // slipSheetHTML(order | [order, order, …]) — the <div class="sheet"> for ONE physical shipment: a
  // single-order slip, OR a COMBINED slip when passed several orders for the same buyer (multiple eBay
  // orders shipping together): one ship-to, items grouped under a per-order sub-header, and a combined
  // total. Everything else (brand + marketing band) is identical, so a buyer with two orders needs one
  // sheet, not two. Returned bare of the document shell so a batch can stack many sheets in one doc.
  function slipSheetHTML(orderOrOrders) {
    var orders = (Array.isArray(orderOrOrders) ? orderOrOrders.slice() : [orderOrOrders]).filter(Boolean);
    if (!orders.length) return '<div class="sheet"></div>';
    var combined = orders.length > 1;
    var primary = orders[0];
    var cfg = LR.config || {}, links = cfg.links || {}, disc = cfg.discount || {};
    var addr = cleanAddressLines(primary);
    var name = addr.length ? addr[0] : '';
    var rest = addr.slice(1);
    var fn = firstName(primary.ship_name || name);

    // date: single = paid date; combined = range across the orders
    var ds = orders.map(function (o) { return o.paid_time; }).filter(Boolean).sort();
    var d0 = ds.length ? niceDate(ds[0]) : '', d1 = ds.length ? niceDate(ds[ds.length - 1]) : '';
    var dateStr = combined ? (d0 && d1 && d0 !== d1 ? d0 + ' &ndash; ' + d1 : d0) : niceDate(primary.paid_time);

    // items — combined: group under a per-order sub-header; single: flat
    // On a combined slip the postage block shows the STRONGEST tier across the orders. When they
    // actually differ, each order also gets its own postage note under its sub-header — otherwise one
    // Express order silently vouches for two standard ones sharing the same satchel.
    var tiers = orders.map(function (o) { return (o.postage && o.postage.tier) || 'standard'; });
    var mixed = combined && tiers.some(function (t) { return t !== tiers[0]; });

    var itemsHTML = combined
      ? orders.map(function (o) {
        var p = o.postage || {};
        return '<div class="ordhdr"><span>Order ' + esc(o.order_id || '')
          + (o.sales_record_number ? ' &middot; Sales #' + esc(o.sales_record_number) : '') + '</span>'
          + '<span class="ordtot">'
          + (mixed ? tierChip(p.tier, 'otier') + '<span class="opost">' + esc(p.label || '') + '</span>' : '')
          + esc(money(o.total_cents, o.currency)) + '</span></div>'
          + (o.items || []).map(function (it) { return slipItemRow(it, o); }).join('');
      }).join('')
      : (primary.items || []).map(function (it) { return slipItemRow(it, primary); }).join('');

    var grandTotal = orders.reduce(function (s, o) { return s + (+o.total_cents || 0); }, 0);
    var note = primary.buyer_note ? '<div class="note"><b>Note from buyer:</b> ' + esc(primary.buyer_note) + '</div>' : '';

    // Marketing QR (fixed URL) — computed here on the host page (where the qrcode lib is loaded) and
    // embedded as static SVG, so the print iframe needs no library. One CTA: the linktree hub.
    var qrFollow = links.linktree ? LR.qrSVG(links.linktree, { size: 150 }) : '';

    var couponHTML = disc.code
      ? '<div class="coupon"><div class="cpn-l">NEXT ORDER</div><div class="cpn-c">' + esc(disc.code) + '</div>'
        + '<div class="cpn-b">' + esc(disc.blurb || '') + (links.shop ? ' at ' + esc(host(links.shop)) : '') + '</div></div>'
      : '';

    var hord = combined ? (orders.length + ' orders') : (primary.order_id ? 'Order ' + esc(primary.order_id) : '');
    var hsub = combined ? dateStr : [dateStr, (primary.sales_record_number ? 'Sales #' + esc(primary.sales_record_number) : '')].filter(Boolean).join(' &middot; ');

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
      + '<div class="hmeta"><div class="htag">PACKING SLIP' + (combined ? ' &middot; COMBINED' : '') + '</div>'
      + (hord ? '<div class="hord">' + hord + '</div>' : '')
      + '<div class="hsub">' + hsub + '</div></div>'
      + '</header>'
      // ---- thank-you + ship-to ----
      + '<div class="mid">'
      + '<div class="thanks">Thanks so much for your order' + (combined ? 's' : '') + (fn ? ', <b>' + esc(fn) + '</b>' : '') + '! Hope you love the cards.</div>'
      + '<div class="midrow">'
      + '<section class="shipto"><div class="lbl">SHIP TO</div><div class="nm">' + esc(name) + '</div>'
      + rest.map(function (l) { return '<div class="al">' + esc(l) + '</div>'; }).join('') + '</section>'
      + postageBlockHTML(orders)
      + '</div>'
      + note
      + '</div>'
      // ---- items ----
      + '<div class="items"><div class="ihead"><span class="im-h"></span>'
      + '<span class="ti">Item</span><span class="q">Qty</span><span class="tot">Total</span></div>'
      + '<div class="ilist">' + itemsHTML + '</div></div>'
      + '<div class="foot"><div class="ftot"><span>' + (combined ? 'Combined total &middot; ' + orders.length + ' orders' : 'Order total') + '</span><b>' + esc(money(grandTotal, primary.currency)) + '</b></div></div>'
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

    return body;
  }

  // Print-dialog title / suggested PDF filename for one shipment.
  function slipTitle(orders) {
    if (!orders.length) return 'Packing slip';
    var primary = orders[0];
    if (orders.length > 1) {
      var addr = cleanAddressLines(primary);
      return 'Packing slip ' + orders.length + ' orders for ' + (primary.buyer_username || (addr.length ? addr[0] : ''));
    }
    return 'Packing slip ' + (primary.order_id || '');
  }

  // One shipment, one document — the per-row 🧾 buttons.
  LR.packingSlipHTML = function (orderOrOrders) {
    var orders = (Array.isArray(orderOrOrders) ? orderOrOrders.slice() : [orderOrOrders]).filter(Boolean);
    return slipDOC(slipTitle(orders), slipSheetHTML(orders));
  };

  // packingSlipBatchHTML(shipments) — a whole run of orders as ONE document, one slip per page. Each
  // entry of `shipments` is an array of orders that physically ship together (see selectedShipments in
  // orders.html), so a buyer with two orders gets one combined sheet here, not two sheets.
  LR.packingSlipBatchHTML = function (shipments) {
    var groups = (shipments || []).filter(function (g) { return g && g.length; });
    if (!groups.length) return slipDOC('Packing slips', '');
    if (groups.length === 1) return LR.packingSlipHTML(groups[0]);
    var orderCount = groups.reduce(function (s, g) { return s + g.length; }, 0);
    var title = 'Packing slips ' + groups.length + (orderCount !== groups.length ? ' (' + orderCount + ' orders)' : '');
    return slipDOC(title, groups.map(slipSheetHTML).join(''), groups.length);
  };

  // A4 shell for the packing slip: greyscale, everything scales with --s so the fit pass can shrink a
  // big order to a single page while keeping the marketing band. Self-prints once images load + it fits.
  // `sheets` (batch only) is how many slips are in the document — it only stretches the image wait.
  function slipDOC(title, body, sheets) {
    var css = ''
      + '@page{size:A4;margin:0;}'
      + '*{box-sizing:border-box;margin:0;padding:0;}'
      + ':root{--s:1;}'
      + 'html,body{background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
      + '.sheet{width:210mm;min-height:297mm;margin:0 auto;padding:calc(13mm*var(--s)) calc(14mm*var(--s)) calc(10mm*var(--s));display:flex;flex-direction:column;}'
      // Batch: break BEFORE every sheet after the first, never after — a break-after on the last sheet
      // is exactly what produces a blank final page. A single slip is untouched: the sibling selector
      // has nothing to match.
      + '.sheet + .sheet{break-before:page;page-break-before:always;}'
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
      + '.midrow{display:flex;align-items:flex-start;gap:calc(14pt*var(--s));}'
      + '.shipto{flex:1;min-width:0;border-left:3px solid #111;padding-left:calc(9pt*var(--s));}'
      + '.shipto .lbl{font-size:calc(7.5pt*var(--s));letter-spacing:.2em;color:#888;margin-bottom:calc(2pt*var(--s));}'
      + '.shipto .nm{font-size:calc(14pt*var(--s));font-weight:700;line-height:1.15;}'
      + '.shipto .al{font-size:calc(11pt*var(--s));color:#333;line-height:1.3;}'
      // postage — quiet for a free letter, a bordered block for anything the buyer paid extra for.
      // Weight and border only: see tierChip() on why nothing here relies on a printed background.
      + '.postage{flex:none;width:calc(64mm*var(--s));min-width:0;}'
      + '.postage .lbl{font-size:calc(7.5pt*var(--s));letter-spacing:.2em;color:#888;margin-bottom:calc(2pt*var(--s));}'
      + '.postage .pline{font-size:calc(11pt*var(--s));color:#333;line-height:1.3;}'
      + '.postage .peta{font-size:calc(9.5pt*var(--s));color:#666;margin-top:calc(1pt*var(--s));}'
      + '.postage .ptrk{font-family:"Courier New",monospace;font-size:calc(9pt*var(--s));color:#222;margin-top:calc(3pt*var(--s));word-break:break-all;}'
      + '.postage .pblock{display:inline-block;font-weight:700;letter-spacing:.16em;line-height:1;'
      + 'padding:calc(4pt*var(--s)) calc(8pt*var(--s));margin-bottom:calc(4pt*var(--s));}'
      + '.postage.up{border-left:3px solid #111;padding-left:calc(9pt*var(--s));}'
      + '.postage.up .pline{font-weight:700;color:#111;}'
      + '.postage.t-express .pblock{border:2.5px solid #000;font-size:calc(13pt*var(--s));}'
      + '.postage.t-tracked .pblock{border:1.5px solid #000;font-size:calc(11.5pt*var(--s));}'
      + '.postage.t-paid .pblock{border:1px dashed #555;color:#333;font-size:calc(10.5pt*var(--s));}'
      // combined slip, mixed tiers: a per-order marker beside each sub-header total
      + '.otier{border:1.5px solid #000;font-family:Arial,Helvetica,sans-serif;font-weight:700;letter-spacing:.1em;font-size:calc(7.5pt*var(--s));padding:0 calc(4pt*var(--s));margin-right:calc(6pt*var(--s));}'
      + '.opost{font-weight:400;color:#555;margin-right:calc(8pt*var(--s));}'
      + '.note{margin-top:calc(8pt*var(--s));border:1px solid #bbb;border-radius:6px;padding:calc(6pt*var(--s)) calc(9pt*var(--s));font-size:calc(10pt*var(--s));background:#f6f6f6;}'
      // items
      + '.items{margin-top:calc(12pt*var(--s));}'
      + '.ihead,.irow{display:flex;align-items:center;gap:calc(6pt*var(--s));}'
      + '.ihead{padding:0 calc(4pt*var(--s)) calc(5pt*var(--s));border-bottom:2px solid #111;font-size:calc(7.5pt*var(--s));letter-spacing:.1em;text-transform:uppercase;color:#777;font-weight:700;}'
      + '.irow{padding:calc(5pt*var(--s)) calc(4pt*var(--s));border-bottom:1px solid #e2e2e2;break-inside:avoid;}'
      // combined-slip per-order sub-header
      + '.ordhdr{display:flex;justify-content:space-between;align-items:center;gap:calc(8pt*var(--s));margin-top:calc(9pt*var(--s));padding:calc(3.5pt*var(--s)) calc(6pt*var(--s));background:#eee;border-radius:4px;font-family:"Courier New",monospace;font-weight:700;font-size:calc(9pt*var(--s));color:#333;break-inside:avoid;}'
      + '.ilist>.ordhdr:first-child{margin-top:0;}'
      + '.ordtot{color:#111;white-space:nowrap;}'
      + '.tick{width:calc(13px*var(--s));height:calc(13px*var(--s));flex:none;border:1.5px solid #333;border-radius:3px;}'
      + '.tick-h{width:calc(13px*var(--s));flex:none;}'
      + '.th{width:calc(54px*var(--s));height:calc(75px*var(--s));flex:none;object-fit:cover;border:1px solid #ccc;border-radius:3px;filter:grayscale(1);}'
      + '.th.none{width:calc(54px*var(--s));height:calc(75px*var(--s));flex:none;display:inline-block;border-radius:3px;background:repeating-linear-gradient(135deg,#eee,#eee 3px,#f7f7f7 3px,#f7f7f7 6px);}'
      + '.im-h{width:calc(54px*var(--s));flex:none;}'
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

    // A 20-slip batch pulls ~100 thumbnails, and the flat 4s that suited one slip would print half of
    // them blank. Never shorter than the single-slip wait, never longer than 15s.
    var waitMs = Math.min(15000, Math.max(4000, 2000 + 400 * (sheets || 1)));

    // self-print: wait for card thumbnails, shrink each slip to one page, then print.
    var script = '(function(){'
      + 'function A4px(){var p=document.createElement("div");p.style.cssText="position:absolute;visibility:hidden;height:297mm;";document.body.appendChild(p);var h=p.offsetHeight;p.remove();return h;}'
      // .sheet has min-height:297mm, so a fitting page measures EXACTLY one A4 (never less); only a
      // genuine overflow exceeds it. Threshold sits +2px above the page so a fitting page is left at s=1.
      // Ladder for big orders: scale down → drop thumbnails → two-column items → compact marketing.
      // --s is set on the SHEET, not on :root, so in a batch one fat order shrinks alone instead of
      // dragging every other slip down with it. Every calc(…*var(--s)) lives on .sheet or a descendant,
      // and a property set on an element applies to that element's own declarations, so .sheet's own
      // padding still resolves.
      + 'function fitSheet(sheet,max){var s=1;'
      + 'function over(){return sheet.scrollHeight>max;}'
      + 'function shrink(f){while(over()&&s>f){s=Math.round((s-0.03)*100)/100;sheet.style.setProperty("--s",s);}}'
      + 'sheet.style.setProperty("--s",1);shrink(0.62);'
      + 'if(over()){sheet.classList.add("nothumb");shrink(0.52);}'
      + 'if(over()){sheet.classList.add("twocol");shrink(0.46);}'
      + 'if(over()){sheet.classList.add("compact");shrink(0.36);}}'
      + 'function fit(){var max=A4px()+2;[].slice.call(document.querySelectorAll(".sheet")).forEach(function(sh){fitSheet(sh,max);});}'
      + 'function done(){try{fit();}catch(e){}try{window.focus();window.print();}catch(e){}}'
      + 'var imgs=[].slice.call(document.images).filter(function(im){return !im.complete;});'
      + 'if(!imgs.length){setTimeout(done,40);return;}'
      + 'var n=imgs.length,fired=false;function one(){if(--n<=0&&!fired){fired=true;done();}}'
      + 'imgs.forEach(function(im){im.addEventListener("load",one);im.addEventListener("error",one);});'
      + 'setTimeout(function(){if(!fired){fired=true;done();}},' + waitMs + ');'
      + '})();';

    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' + css
      + '</style></head><body>' + body + '<' + 'script>' + script + '<' + '/script></body></html>';
  }

  /* ---------- pick sheet (browser print / PDF — grouped by box, sorted by slot) ---------- */
  // Seller-side pull list. Grouped + ordered by BOX (the SKU-prefix bin, from buildPickSheet), with a
  // tick box, a card thumbnail (fast visual match) and the full SKU slot code, so a bin is walked
  // front-to-back. This carries the box info the customer packing slip no longer does.
  LR.pickSheetHTML = function (groups, meta) {
    meta = meta || {};
    var sections = (groups || []).map(function (g) {
      var rows = g.items.map(function (it) {
        var img = it.image_url
          ? '<img src="' + esc(it.image_url) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
          : '<span class="pnone"></span>';
        // The tier marker is carried per LINE because one order's cards scatter across several boxes,
        // and the picker standing at a shelf needs to know this card belongs to an Express order
        // without cross-referencing anything. A standard order prints an EMPTY cell: nine in ten
        // orders are plain letters, and a badge on every row would destroy the scan. Absence is the
        // signal, and it is the fastest one to read.
        return '<tr><td class="chk"></td><td class="pim">' + img + '</td><td class="box">' + esc(it.sku || '') + '</td><td class="qty">' + (it.quantity || 1)
          + '</td><td>' + esc(it.title || 'item') + '</td>'
          + '<td class="tc">' + tierChip(it.postage_tier) + '</td>'
          + '<td class="ord">' + esc(it.order_id || '') + '</td></tr>';
      }).join('');
      return '<h2>' + esc(g.location || 'Unsorted') + ' <span>(' + g.items.length + ')</span></h2>'
        + '<table class="pick"><tbody>' + rows + '</tbody></table>';
    }).join('');
    var summary = (meta.order_count || 0) + ' orders · ' + (meta.item_count || 0) + ' lines · ' + (meta.unit_count || 0) + ' units';
    return DOC('Pick sheet',
      '<div class="store">Pick sheet</div><div class="tag">SORTED BY BOX FOR PICKING</div><div class="meta">' + esc(summary) + '</div>'
      + holdBanner(meta) + upgradeBanner(meta) + (sections || '<p>Nothing to pick.</p>')
    );
  };

  // A BANNER is an exception called out above the first box: something about this run that has to be
  // read before anyone walks off to the shelves. There are two kinds today (postage upgrades, and
  // orders on hold) and they are the same table with different words in it — so the markup lives once
  // here and each banner supplies only what genuinely differs: its heading, and per order a chip, a
  // description and the action. `.upg.hold` in the CSS is a modifier for exactly this reason.
  function bannerRow(r) {
    return '<tr><td class="tc">' + (r.chip || '') + '</td>'
      + '<td class="ord">' + esc(r.order_id || '') + (r.sales_record_number ? ' <span class="who">#' + esc(r.sales_record_number) + '</span>' : '') + '</td>'
      + '<td class="who">' + esc(r.buyer_username || '') + '</td>'
      + '<td>' + esc(r.detail || '') + '</td>'
      + '<td class="do">' + esc(r.todo || '') + '</td></tr>';
  }
  function bannerBlock(cls, heading, rows) {
    if (!rows.length) return '';
    return '<div class="' + cls + '"><div class="upg-hd">' + esc(heading) + '</div>'
      + '<table><tbody>' + rows.map(bannerRow).join('') + '</tbody></table></div>';
  }

  // The DO-NOT-PACK banner, printed ABOVE the postage one. Cards for these orders are deliberately not
  // in the sections below — an order with a cancellation in flight, or a payment that bounced after
  // eBay said it was paid, must not be packed by muscle memory while somebody walks the shelves.
  function holdBanner(meta) {
    var holds = (meta && meta.holds) || [];
    return bannerBlock('upg hold',
      'DO NOT PACK — ' + holds.length + (holds.length === 1 ? ' order is' : ' orders are') + ' on hold',
      holds.map(function (h) {
        // Why it is held, then what to do about it. Approving or rejecting a cancellation is a Seller
        // Hub action — eBay does not expose the Cancel ID over the API we use — so the sheet says where
        // to go rather than implying the tool can settle it.
        return {
          chip: '⛔', order_id: h.order_id, sales_record_number: h.sales_record_number,
          buyer_username: h.buyer_username,
          detail: [h.why, h.cancel_reason].filter(Boolean).join(' · '),
          todo: h.cancel_state === 'requested' ? 'Approve or reject it on eBay'
            : h.payment_state === 'failed' ? 'Payment failed — check it on eBay before packing'
              : h.cancel_state === 'unknown' ? 'Unrecognised eBay status — check it on eBay'
                : 'Cancelled — put these cards back',
        };
      }));
  }

  // The postage exception banner. Rendered only when this run actually contains an order that is not a
  // plain letter, so a normal day's sheet looks exactly as it always has.
  function upgradeBanner(meta) {
    var ups = (meta && meta.upgrades) || [];
    var total = (meta && meta.order_count) || ups.length;
    return bannerBlock('upg',
      ups.length + ' of ' + total + (total === 1 ? ' order needs' : ' orders need') + ' a postage upgrade',
      ups.map(function (u) {
        var paid = u.paid_cents ? money(u.paid_cents, u.currency) : '';
        // The chip already carries the tier, so a label that IS the tier phrase (which is what we fall
        // back to when eBay gave us no real service name) would just say the same thing twice.
        var named = u.label && u.label.toUpperCase() !== String(TIER_WORD[u.tier] || '').toUpperCase() ? u.label : '';
        return {
          chip: tierChip(u.tier), order_id: u.order_id, sales_record_number: u.sales_record_number,
          buyer_username: u.buyer_username,
          detail: [named, paid].filter(Boolean).join(' · '),
          // eBay's Australia Post deal has no API, so buying the label stays a person's job. Saying so
          // on the sheet is the difference between a flagged order and an actioned one.
          todo: u.tracked ? (u.tracking ? 'Label bought · ' + u.tracking : 'Buy the label on eBay') : 'Check the postage on eBay',
        };
      }));
  }

  window.LR = LR;
})();
