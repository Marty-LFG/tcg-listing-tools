/* grade-report-pdf.js — the Card Pre-Grader's printed report.
 *
 * A browser classic script (no modules, no imports) that assigns window.GradeReportPDF.
 * One entry point:
 *
 *     GradeReportPDF.build(data) -> Promise<jsPDF doc>
 *
 * It never saves. The caller does `doc.save(filename)` so the page keeps ownership of naming.
 * It never throws either: every section is wrapped, so a missing image, a null price ladder or a
 * half-populated prediction degrades to a thinner document instead of an exception in the click
 * handler (Golden Rule 7). A report that prints four sections beats a toast that says "PDF failed".
 *
 * WHY IT LOOKS LIKE THIS
 * The suite's Vault Ledger system is a dark screen theme. Paper is the opposite medium, so this is
 * the same system translated rather than copied: near-black ink on warm off-white, hairline rules
 * instead of boxes, generous whitespace, one accent. The screen accent (#d9a4ff) is a pastel that
 * sits at roughly 1.5:1 on white and would print as a grey smudge, so the print accent is the same
 * hue driven down to #5B2E8C (about 9:1 on the paper colour). One accent, per the system.
 *
 * jsPDF ships three core fonts and they happen to map the system's three roles exactly:
 *     times     = display serif   (Fraunces's job: masthead, section heads, tier labels)
 *     helvetica = body and labels  (IBM Plex Sans's job)
 *     courier   = EVERY number     (IBM Plex Mono's job, and this is the rule that carries the look)
 * Nothing else is available without embedding a font file, which this module deliberately does not
 * do: no external assets, so it works on a LAN with no internet.
 *
 * Units are millimetres on A4. Font sizes are always points regardless of the unit, which is why
 * line widths look small (0.12 mm is about a 0.34 pt hairline).
 */
(function (global) {
  'use strict';

  /* ============================== palette (print) ============================== */
  // Flat RGB triples. Kept as arrays so setTextColor/setDrawColor/setFillColor can spread them.
  var PAPER = [251, 250, 247];   // warm off-white; every page is painted with it
  var INK = [23, 22, 26];        // near-black, never pure #000 (prints harsh, reads cheap)
  var MUTED = [110, 106, 114];
  var FAINT = [162, 157, 166];
  var HAIR = [214, 209, 202];    // hairline rules
  var ACCENT = [91, 46, 140];    // #5B2E8C — the grader's violet, darkened for paper
  var POS = [26, 102, 74];       // profit
  var NEG = [160, 44, 44];       // loss
  var WARN = [138, 100, 16];     // borderline

  var W = 210, H = 297, MARGIN = 18;
  var FOOT_Y = 283;              // footer baseline; content must stop above it
  var BOTTOM = 272;              // last usable content line

  var LW_HAIR = 0.12, LW_RULE = 0.2, LW_HEAVY = 0.45;

  /* ============================== tiny helpers ============================== */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function gradeStr(g) { return !isNum(g) ? '-' : (g % 1 === 0 ? String(g) : g.toFixed(1)); }
  function money(n) { return !isNum(n) ? '-' : '$' + (Math.round(n * 100) / 100).toFixed(2); }
  function signedMoney(n) { return !isNum(n) ? '-' : (n >= 0 ? '+' : '-') + money(Math.abs(n)); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function str(v) { return v == null ? '' : String(v); }
  // jsPDF's core fonts are WinAnsi, so anything above U+00FF is dropped from the page WITHOUT an
  // error. That bit us on the config disclaimers: their em-dashes simply disappeared mid-sentence
  // and the line read as a typo. Every string is folded to the Latin-1 range on the way in.
  // The middot and the multiplication sign are inside WinAnsi and survive untouched.
  // Known limit: a genuinely non-Latin card name (Japanese, Korean) still will not print, and the
  // only fix for that is embedding a Unicode font, which would break the no-external-assets rule.
  function plain(v) {
    return str(v)
      .replace(/[‐-―−]/g, '-')
      .replace(/[‘’‛′]/g, "'")
      .replace(/[“”‟″]/g, '"')
      .replace(/…/g, '...')
      .replace(/→/g, '->')
      .replace(/ /g, ' ');
  }
  function cap(s) { s = str(s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  // Never let one bad section take the whole document down.
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  // "52.4/47.6" -> 52.4. centeringPct formats both shares into one string and the diagram needs the
  // first number back; parsing it beats asking the page to pass the same figure twice.
  function shareOf(labelText, dflt) {
    var m = /^\s*([0-9]+(?:\.[0-9]+)?)/.exec(str(labelText));
    return m ? parseFloat(m[1]) : dflt;
  }
  function imgFormat(dataUrl) {
    return /^data:image\/png/i.test(str(dataUrl)) ? 'PNG' : 'JPEG';
  }
  function dateOnly(v) {
    if (!v) return '';
    if (typeof v === 'string') return v.slice(0, 10);
    try { return new Date(v).toISOString().slice(0, 10); } catch (e) { return ''; }
  }

  /* ============================== the page object ==============================
   * P wraps the jsPDF doc with a flowing cursor (P.y), the column bounds, and the typographic
   * primitives. Sections call P.ensure(h) before drawing a block; when the block will not fit the
   * cursor moves to a fresh page. There are almost no forced breaks, so a card with no AI pass and
   * no back scan produces a tight two-page report rather than three pages of white.
   */
  function makeP(doc, d) {
    var P = {
      doc: doc, x: MARGIN, right: W - MARGIN, cw: W - 2 * MARGIN, y: 0, d: d, firstPage: true
    };

    function paint() {
      doc.setFillColor(PAPER[0], PAPER[1], PAPER[2]);
      doc.rect(0, 0, W, H, 'F');
    }

    // The running head on pages 2+. Page 1 gets the full masthead instead.
    function runningHead() {
      var name = str(d.card.name) || 'Card pre-grading report';
      P.label(name.toUpperCase().slice(0, 58), P.x, 14, FAINT, 6.2, 0.3);
      var right = 'PRE-GRADE';
      P.mono(right, P.right, 14, FAINT, 6.4, 'right');
      P.setDraw(HAIR, LW_HAIR);
      doc.line(P.x, 16.6, P.right, 16.6);
      return 24;
    }

    P.newPage = function () {
      doc.addPage();
      paint();
      P.y = runningHead();
      P.firstPage = false;
    };
    P.ensure = function (h) {
      if (P.y + (h || 8) > BOTTOM) P.newPage();
      return P.y;
    };
    P.gap = function (h) { P.y += (h == null ? 4 : h); };

    P.setDraw = function (c, lw) {
      doc.setDrawColor(c[0], c[1], c[2]);
      doc.setLineWidth(lw == null ? LW_HAIR : lw);
    };
    P.setFill = function (c) { doc.setFillColor(c[0], c[1], c[2]); };
    P.setText = function (c) { doc.setTextColor(c[0], c[1], c[2]); };

    // Body / label / number are the three voices. Everything on the page goes through one of them.
    P.text = function (txt, x, y, o) {
      o = o || {};
      doc.setFont(o.font || 'helvetica', o.style || 'normal');
      doc.setFontSize(o.size || 9);
      P.setText(o.color || INK);
      var opts = {};
      if (o.align) opts.align = o.align;
      if (o.charSpace) opts.charSpace = o.charSpace;
      doc.text(plain(txt), x, y, opts);
    };
    P.serif = function (txt, x, y, size, color, style) {
      P.text(txt, x, y, { font: 'times', style: style || 'bold', size: size || 12.5, color: color || INK });
    };
    P.mono = function (txt, x, y, color, size, align, style) {
      P.text(txt, x, y, { font: 'courier', style: style || 'normal', size: size || 8.4, color: color || INK, align: align });
    };
    // Tracked micro-labels stand in for the system's small-caps eyebrows. Right alignment is done by
    // hand because letter-spacing plus align is not worth trusting across jsPDF versions.
    P.label = function (txt, x, y, color, size, cs, align) {
      var s = plain(txt).toUpperCase();
      size = size || 6.4; cs = cs == null ? 0.35 : cs;
      var px = x;
      if (align === 'right') px = x - P.labelWidth(s, size, cs);
      P.text(s, px, y, { style: 'bold', size: size, color: color || MUTED, charSpace: cs });
    };
    P.labelWidth = function (txt, size, cs) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(size || 6.4);
      var s = plain(txt).toUpperCase();
      return doc.getTextWidth(s) + (cs == null ? 0.35 : cs) * Math.max(0, s.length - 1);
    };
    P.widthOf = function (txt, font, style, size) {
      doc.setFont(font || 'helvetica', style || 'normal');
      doc.setFontSize(size || 9);
      return doc.getTextWidth(plain(txt));
    };

    // The index page's "section rule" made literal on paper: a serif heading, a hairline that runs
    // to the margin, and an optional mono note hanging off the right end.
    P.sectionRule = function (title, note) {
      P.ensure(16);
      var y = P.y;
      P.serif(title, P.x, y, 12.5, INK);
      var tw = P.widthOf(title, 'times', 'bold', 12.5);
      var nw = 0;
      if (note) nw = P.widthOf(note, 'courier', 'normal', 7) + 3;
      var lx = P.x + tw + 3, rx = P.right - nw;
      if (rx > lx) { P.setDraw(HAIR, LW_HAIR); doc.line(lx, y - 1.3, rx, y - 1.3); }
      if (note) P.mono(note, P.right, y, FAINT, 7, 'right');
      P.y = y + 6.4;
    };

    // Wrapped body copy. Returns the height consumed so callers can lay out beside it.
    P.para = function (txt, x, y, w, o) {
      o = o || {};
      var size = o.size || 8.4, lead = o.lead || size * 0.44;
      doc.setFont('helvetica', o.style || 'normal');
      doc.setFontSize(size);
      var lines = doc.splitTextToSize(plain(txt), w);
      P.setText(o.color || MUTED);
      for (var i = 0; i < lines.length; i++) doc.text(lines[i], x, y + i * lead);
      return lines.length * lead;
    };

    paint();
    P.y = 0;
    return P;
  }

  /* ============================== masthead ============================== */
  function masthead(P, d) {
    var doc = P.doc, y = 20;

    // Monogram: the suite's 48px gold tile, redrawn as an accent-outlined square with a serif glyph.
    P.setDraw(ACCENT, LW_RULE);
    doc.roundedRect(P.x, y - 7.6, 11, 11, 1.6, 1.6, 'S');
    P.text('P', P.x + 2.6, y + 0.9, { font: 'times', style: 'bold', size: 12, color: ACCENT });
    P.text('G', P.x + 5.7, y + 0.9, { font: 'times', style: 'bold', size: 12, color: INK });

    P.serif('Card Pre-Grading Report', P.x + 15, y, 19, INK);
    P.label('tcg-listing-tools · estimate, not a grade', P.x + 15.6, y + 5.4, MUTED, 6.4, 0.34);

    // Right rail: the register-style facts, all mono.
    var ry = y - 5.6;
    P.label('issued', P.right, ry, FAINT, 5.8, 0.3, 'right');
    P.mono(dateOnly(d.meta.generatedAt) || dateOnly(new Date()), P.right, ry + 4.2, INK, 8.4, 'right');
    if (d.meta.reportId != null) {
      P.label('report', P.right, ry + 8.8, FAINT, 5.8, 0.3, 'right');
      P.mono('#' + d.meta.reportId, P.right, ry + 13, INK, 8.4, 'right');
    }

    P.setDraw(ACCENT, 0.5);
    doc.line(P.x, y + 9.6, P.right, y + 9.6);
    P.y = y + 17;
  }

  /* ============================== card identity ============================== */
  var THUMB_W = 24, THUMB_H = 33.5;

  // The scan thumbnail belongs beside the grade, not floating on its own. It is drawn here only
  // when there is no headline block to hang it off, which is the no-prediction case.
  function thumbnail(P, d, x, y) {
    var front = d.shots['scan-front'];
    if (!front || !front.dataUrl) return false;
    return safe(function () {
      P.doc.addImage(front.dataUrl, imgFormat(front.dataUrl), x, y, THUMB_W, THUMB_H);
      P.setDraw(HAIR, LW_HAIR);
      P.doc.rect(x, y, THUMB_W, THUMB_H, 'S');
      return true;
    }, false);
  }

  function identity(P, d) {
    var doc = P.doc, c = d.card;
    var headlineWillRun = !!(d.bestCo && d.pred.perCompany[d.bestCo]);
    var hasThumb = headlineWillRun ? false : thumbnail(P, d, P.right - THUMB_W, P.y - 2);
    var thumbW = THUMB_W, thumbH = THUMB_H;

    var textW = P.cw - (hasThumb || headlineWillRun ? thumbW + 8 : 0);
    var name = plain(c.name) || '(unnamed card)';
    doc.setFont('times', 'bold'); doc.setFontSize(16);
    var nameLines = doc.splitTextToSize(name, textW);
    P.setText(INK);
    for (var i = 0; i < Math.min(2, nameLines.length); i++) doc.text(nameLines[i], P.x, P.y + 4 + i * 6.4);
    var used = Math.min(2, nameLines.length) * 6.4;

    var bits = [];
    if (c.number) bits.push('No. ' + c.number);
    if (c.set) bits.push(c.set);
    if (c.rarity) bits.push(c.rarity);
    if (c.finish) bits.push(c.finish);
    if (c.language) bits.push(c.language);
    // Wrapped, not drawn flat: a card with a long set name plus a long rarity would otherwise run
    // under the thumbnail and off the sheet.
    var subH = P.para(bits.join('   ·   ') || 'Identity not filled in, so value-at-grade is unavailable.',
      P.x, P.y + used + 3.2, textW, { size: 8.6, color: MUTED, lead: 4.1 });

    P.y += Math.max(used + 5 + subH, hasThumb ? thumbH + 4 : 0);
  }

  /* ============================== the headline answer ==============================
   * Page one has to answer one question before anything else: which company, what grade, and is it
   * worth the fee. Everything here is sized so that answer survives a glance across a desk.
   */
  function headline(P, d) {
    var doc = P.doc;
    var co = d.bestCo;
    var p = co ? d.pred.perCompany[co] : null;
    if (!p) return;
    var e = d.econ[co] || {};
    var meta = d.companies[co] || {};
    var code = str(meta.label || co).split(' ')[0];

    var blockH = 44;
    P.ensure(blockH + 6);
    var top = P.y, x = P.x + 6.5;

    // The accent rail. The system's status rail, one bar, no box.
    P.setFill(ACCENT);
    doc.rect(P.x, top, 1.3, blockH, 'F');

    // The scan sits at the end of the rail, so the card and its grade read as one statement and
    // page one has no orphaned block of white where a picture used to float alone.
    var hasThumb = thumbnail(P, d, P.right - THUMB_W, top + 4);
    var contentRight = hasThumb ? P.right - THUMB_W - 8 : P.right;

    P.label('best fit · predicted grade', x, top + 4, MUTED, 6.4, 0.4);

    // Company in sans, grade in mono. The grade is a number, so it is mono, and at 34pt that single
    // decision is what makes the page read as a document instead of a slide.
    P.text(code, x, top + 19, { style: 'bold', size: 15, color: INK });
    var codeW = P.widthOf(code, 'helvetica', 'bold', 15);
    P.mono(gradeStr(p.grade), x + codeW + 4, top + 19, ACCENT, 34, null, 'bold');
    var gw = P.widthOf(gradeStr(p.grade), 'courier', 'bold', 34);
    var afterX = x + codeW + 4 + gw + 6;

    if (p.gradeLabel) P.serif(p.gradeLabel, afterX, top + 14.5, 12, INK, 'bolditalic');
    if (isNum(p.tagScore)) P.mono(p.tagScore + ' / 1000', afterX, top + 19.6, MUTED, 8);

    // A top tier is earned, not automatic, so it gets a badge when the rules awarded one.
    var tier = topTierName(p.gradeLabel);
    if (tier) {
      var tw = P.labelWidth(tier, 6.2, 0.5) + 6;
      P.setDraw(ACCENT, LW_RULE);
      doc.roundedRect(afterX, top + 21.5, tw, 6.2, 1, 1, 'S');
      P.label(tier, afterX + 3, top + 25.7, ACCENT, 6.2, 0.5);
    }

    // Confidence + the pillars that produced the grade, as a mono strip.
    var sy = top + 26.5;
    P.label('confidence', x, sy, FAINT, 5.8, 0.3);
    P.mono(cap(p.confidence || 'unknown'), x + 22, sy, INK, 8);
    var px = x + 46;
    ['centering', 'corners', 'edges', 'surface'].forEach(function (k) {
      var v = p.pillars ? p.pillars[k] : null;
      P.label(k.slice(0, 4), px, sy - 3.4, FAINT, 5.4, 0.28);
      P.mono(gradeStr(v), px, sy, INK, 8.4);
      px += 20;
    });

    // The money line, laid out as the hub's counter: label, hairline leader, figure.
    P.setDraw(HAIR, LW_HAIR);
    doc.line(x, top + 30.5, contentRight, top + 30.5);

    var vy = top + 37;
    var verdictColor = e.verdict === 'Submit' ? POS : e.verdict === 'Borderline' ? WARN : NEG;
    // Missing comps is a gap in the price data, not a judgement on the card — say so in the
    // label rather than printing something that scans as the verdict itself.
    P.label(e.ok ? 'verdict' : 'money', x, vy - 4.2, FAINT, 5.8, 0.3);
    P.text(e.ok ? str(e.verdict) : 'Not priced', x, vy, {
      style: 'bold', size: e.ok ? 13 : 9.5, color: e.ok ? verdictColor : MUTED
    });

    if (e.ok) {
      var cells = [
        ['expected value', money(e.expectedValue), INK],
        ['vs selling raw', signedMoney(e.profitVsRaw), e.profitVsRaw >= 0 ? POS : NEG],
        ['fee · turnaround', money(e.fee) + ' · ' + (e.tier ? e.tier.turnaroundDays + 'd' : '?'), INK]
      ];
      var cx = P.x + 52, step = 27;
      cells.forEach(function (cell, i) {
        P.label(cell[0], cx + i * step, vy - 4.2, FAINT, 5.6, 0.26);
        P.mono(cell[1], cx + i * step, vy, cell[2], 9, null, 'bold');
      });
    } else {
      P.text('Look the card up so the graded ladder can price this grade.', P.x + 52, vy, { size: 8, color: MUTED });
    }

    P.y = top + blockH + 6;
  }

  function topTierName(labelText) {
    var s = str(labelText);
    if (/black label/i.test(s)) return 'Black Label';
    if (/flawless/i.test(s)) return 'Flawless';
    if (/pristine/i.test(s)) return 'Pristine';
    if (/gold label/i.test(s)) return 'Gold Label';
    return null;
  }

  /* ============================== centering diagram ==============================
   * The one measurement in this whole report that is geometry rather than opinion, so it gets a
   * drawing. The inner frame sits at the measured proportions: when millimetre borders are known
   * (a scan with a real dpi) the frame is true to scale against a 63 x 88 mm card, and when only
   * the ratio is known the diagram uses a nominal border budget split by the measured shares. Both
   * cases show the same lean, which is the point of the picture.
   */
  var CARD_W_MM = 63, CARD_H_MM = 88;

  function centeringDiagram(P, x, y, w, r, mm, title) {
    var doc = P.doc;
    var h = w * (CARD_H_MM / CARD_W_MM);
    var lShare = shareOf(r && r.lrLabel, 50), tShare = shareOf(r && r.tbLabel, 50);
    var fx, fy, unit;

    if (mm && isNum(mm.l) && isNum(mm.r) && isNum(mm.t) && isNum(mm.b)) {
      fx = { l: mm.l / CARD_W_MM, r: mm.r / CARD_W_MM };
      fy = { t: mm.t / CARD_H_MM, b: mm.b / CARD_H_MM };
      unit = 'mm';
    } else {
      // No dpi, so no millimetres. 20% of the width and 14% of the height is a readable stand-in
      // for a typical Pokemon border, split by the measured shares.
      var TOTX = 0.20, TOTY = 0.14;
      fx = { l: TOTX * lShare / 100, r: TOTX * (100 - lShare) / 100 };
      fy = { t: TOTY * tShare / 100, b: TOTY * (100 - tShare) / 100 };
      unit = '%';
    }
    // A wild measurement must not invert the frame and draw a rectangle inside out.
    fx.l = clamp(fx.l, 0.015, 0.42); fx.r = clamp(fx.r, 0.015, 0.42);
    fy.t = clamp(fy.t, 0.012, 0.42); fy.b = clamp(fy.b, 0.012, 0.42);

    P.label(title, x, y - 2.6, MUTED, 6, 0.32);

    P.setDraw(INK, LW_RULE);
    doc.roundedRect(x, y, w, h, 1.4, 1.4, 'S');

    var ix = x + fx.l * w, iy = y + fy.t * h;
    var iw = w - (fx.l + fx.r) * w, ih = h - (fy.t + fy.b) * h;
    P.setDraw(ACCENT, 0.38);
    doc.rect(ix, iy, iw, ih, 'S');

    // Dimension lines with end ticks, the way a measured drawing does it.
    var midY = y + h / 2, midX = x + w / 2, tick = 1.1;
    P.setDraw(MUTED, LW_HAIR);
    doc.line(x, midY, ix, midY);
    doc.line(x, midY - tick, x, midY + tick);
    doc.line(ix, midY - tick, ix, midY + tick);
    doc.line(x + w, midY, ix + iw, midY);
    doc.line(x + w, midY - tick, x + w, midY + tick);
    doc.line(ix + iw, midY - tick, ix + iw, midY + tick);
    doc.line(midX, y, midX, iy);
    doc.line(midX - tick, y, midX + tick, y);
    doc.line(midX - tick, iy, midX + tick, iy);
    doc.line(midX, y + h, midX, iy + ih);
    doc.line(midX - tick, y + h, midX + tick, y + h);
    doc.line(midX - tick, iy + ih, midX + tick, iy + ih);

    function dim(v, share) { return unit === 'mm' ? v.toFixed(1) : share.toFixed(1); }
    P.mono(dim(unit === 'mm' ? mm.l : 0, lShare), x - 1.6, midY + 1.2, INK, 6.8, 'right');
    P.mono(dim(unit === 'mm' ? mm.r : 0, 100 - lShare), x + w + 1.6, midY + 1.2, INK, 6.8);
    P.mono(dim(unit === 'mm' ? mm.t : 0, tShare), midX, y - 1.8, INK, 6.8, 'center');
    P.mono(dim(unit === 'mm' ? mm.b : 0, 100 - tShare), midX, y + h + 4, INK, 6.8, 'center');

    return { h: h, unit: unit };
  }

  function centeringSection(P, d) {
    var f = d.centering.front, b = d.centering.back;
    if (!f && !b) return;
    P.sectionRule('Measured centering', 'geometry');

    var dw = 34, pad = 13;
    var blockH = dw * (CARD_H_MM / CARD_W_MM) + 22;
    P.ensure(blockH + 24);
    var top = P.y + 4;

    var res = null;
    if (f) res = safe(function () { return centeringDiagram(P, P.x + 4, top, dw, f, d.centering.frontMm, 'Front'); }, null);
    var hasBack = !!b;
    if (hasBack) safe(function () { centeringDiagram(P, P.x + 4 + dw + pad + 10, top, dw, b, d.centering.backMm, 'Back'); }, null);

    // The readings, to the right of the drawings.
    var tx = P.x + 4 + (hasBack ? 2 * dw + pad + 10 : dw) + 16;
    var ty = top + 2;
    function readout(title, r, mm) {
      P.label(title, tx, ty, MUTED, 6, 0.32); ty += 4.6;
      if (!r) {
        P.text('Not measured. Back centering is assumed to pass, and confidence is reduced for it.',
          tx, ty, { size: 7.6, color: MUTED });
        ty += 7;
        return;
      }
      P.label('l/r', tx, ty, FAINT, 5.4, 0.26);
      P.mono(str(r.lrLabel), tx + 9, ty, INK, 8.2);
      P.label('t/b', tx + 34, ty, FAINT, 5.4, 0.26);
      P.mono(str(r.tbLabel), tx + 43, ty, INK, 8.2);
      ty += 5;
      P.label('worst', tx, ty, FAINT, 5.4, 0.26);
      P.mono(str(r.label) + '  (' + str(r.worstAxis) + ')', tx + 12, ty, ACCENT, 8.6, null, 'bold');
      ty += 5;
      if (mm && isNum(mm.t)) {
        P.mono('T ' + mm.t.toFixed(1) + '  B ' + mm.b.toFixed(1) + '  L ' + mm.l.toFixed(1) + '  R ' + mm.r.toFixed(1) + ' mm',
          tx, ty, MUTED, 7);
        ty += 4.6;
      }
      ty += 3;
    }
    readout('Front', f, d.centering.frontMm);
    readout('Back', b, d.centering.backMm);

    if (isNum(d.centering.psaCap)) {
      P.text('Centering alone caps this card at PSA ' + gradeStr(d.centering.psaCap) + '.',
        tx, ty, { size: 7.8, color: INK, style: 'bold' });
      ty += 5;
      // and what the band above would have taken — the cap alone never says how close it was.
      // The caller supplies this already spelled with '<=' (WinAnsi has no math operators).
      if (d.centering.psaWants) {
        P.text('PSA ' + str(d.centering.psaWants) + '.', tx, ty, { size: 7.2, color: MUTED });
        ty += 4.6;
      }
    }

    P.y = Math.max(top + (res ? res.h : 40) + 10, ty + 2);
    var note = (res && res.unit === 'mm')
      ? 'Border widths are millimetres, measured from the scan dpi against a 63 x 88 mm card.'
      : 'No scan dpi, so the drawing shows the measured ratio on a nominal border, and the figures are percentage shares.';
    P.y += P.para(note, P.x, P.y, P.cw, { size: 7.4, color: FAINT }) + 4;
  }

  /* ============================== probability bars ============================== */
  function probBars(P, x, y, w, probs, hero) {
    var doc = P.doc, rowH = 4.6, n = Math.min(3, probs.length);
    for (var i = 0; i < n; i++) {
      var it = probs[i];
      var p = clamp(isNum(it.p) ? it.p : 0, 0, 1);
      var yy = y + i * rowH;
      P.mono(gradeStr(it.grade), x, yy, INK, 7);
      var bx = x + 7, bw = w - 7 - 12;
      P.setDraw(HAIR, LW_HAIR);
      doc.line(bx, yy - 1.1, bx + bw, yy - 1.1);
      var isHero = hero != null && it.grade === hero;
      P.setFill(isHero ? ACCENT : MUTED);
      doc.rect(bx, yy - 2.5, Math.max(0.4, bw * p), 1.4, 'F');
      P.mono(Math.round(p * 100) + '%', x + w, yy, isHero ? INK : MUTED, 7, 'right');
    }
    return n * rowH;
  }

  /* ============================== predictions table ============================== */
  function predictionsSection(P, d) {
    if (!d.order.length) return;
    var doc = P.doc;
    P.sectionRule('Predicted grade by company', 'best fit marked');

    var cols = { co: P.x, grade: P.x + 30, label: P.x + 56, bars: P.right - 46, conf: P.right };
    P.label('company', cols.co, P.y, FAINT, 5.6, 0.3);
    P.label('grade', cols.grade, P.y, FAINT, 5.6, 0.3);
    P.label('label · subgrades', cols.label, P.y, FAINT, 5.6, 0.3);
    P.label('likelihood', cols.bars, P.y, FAINT, 5.6, 0.3);
    P.setDraw(HAIR, LW_HAIR);
    doc.line(P.x, P.y + 1.8, P.right, P.y + 1.8);
    P.y += 7;

    d.order.forEach(function (c) {
      var p = d.pred.perCompany[c];
      if (!p) return;
      var meta = d.companies[c] || {};
      var isFit = (c === d.bestCo);
      var rowH = 15;
      P.ensure(rowH + 4);
      var y = P.y;

      if (isFit) {
        // The best fit is marked by a rail and a word, never by colour alone.
        P.setFill(ACCENT);
        doc.rect(P.x - 3, y - 3.6, 1, rowH - 2, 'F');
      }
      P.text(str(meta.label || c), cols.co, y, { style: isFit ? 'bold' : 'normal', size: 9, color: INK });
      if (isFit) P.label('best fit', cols.co, y + 4.4, ACCENT, 5.4, 0.3);

      P.mono(str(meta.label || c).split(' ')[0] + ' ' + gradeStr(p.grade), cols.grade, y, INK, 10.5, null, 'bold');
      if (p.subgrades) {
        P.mono('C ' + gradeStr(p.subgrades.centering) + '  Co ' + gradeStr(p.subgrades.corners) +
          '  E ' + gradeStr(p.subgrades.edges) + '  S ' + gradeStr(p.subgrades.surface),
          cols.label, y + 4.6, MUTED, 7);
      }
      P.text(str(p.gradeLabel), cols.label, y, { font: 'times', style: 'italic', size: 9.5, color: INK });
      // Confidence rides under the grade, because the likelihood column is the bars' space.
      P.label(str(p.confidence || '?') + ' conf', cols.grade, y + 4.6, FAINT, 5.4, 0.28);

      safe(function () {
        if (p.probabilities && p.probabilities.length) probBars(P, cols.bars, y, 46, p.probabilities, p.grade);
      });

      P.y = y + rowH;
      P.setDraw(HAIR, LW_HAIR);
      doc.line(P.x, P.y - 4, P.right, P.y - 4);
    });
    P.gap(2);
  }

  /* ============================== economics ============================== */
  function economicsSection(P, d) {
    if (!d.order.length) return;
    var doc = P.doc;
    P.sectionRule('Is it worth grading', 'USD');

    if (!isNum(d.pricing.rawUSD)) {
      P.y += P.para('No raw price was available for this card, so the money side is blank. Look the card up so PriceCharting can supply the raw and graded ladder, then generate the report again.',
        P.x, P.y, P.cw, { size: 8.2, color: MUTED }) + 5;
      return;
    }
    var feePct = isNum(d.cfg.marketplaceFeePct) ? d.cfg.marketplaceFeePct : 13;
    P.label('raw value now', P.x, P.y, FAINT, 5.8, 0.3);
    P.mono(money(d.pricing.rawUSD), P.x + 32, P.y, INK, 9.4, null, 'bold');
    P.text('selling raw nets ' + money(d.pricing.rawUSD * (1 - feePct / 100)) + ' after the ' + feePct + '% sale fee',
      P.x + 56, P.y, { size: 8, color: MUTED });
    P.y += 7;

    var c1 = P.x, c2 = P.x + 30, c3 = P.x + 62, c4 = P.x + 92, c5 = P.x + 122, c6 = P.right;
    P.label('company', c1, P.y, FAINT, 5.6, 0.3);
    P.label('at grade', c2, P.y, FAINT, 5.6, 0.3);
    P.label('fee · days', c3, P.y, FAINT, 5.6, 0.3);
    P.label('expected', c4, P.y, FAINT, 5.6, 0.3);
    P.label('vs raw', c5, P.y, FAINT, 5.6, 0.3);
    P.label('verdict', c6, P.y, FAINT, 5.6, 0.3, 'right');
    P.setDraw(HAIR, LW_HAIR);
    doc.line(P.x, P.y + 1.8, P.right, P.y + 1.8);
    P.y += 6.4;

    d.order.forEach(function (c) {
      var p = d.pred.perCompany[c], e = d.econ[c] || {};
      if (!p) return;
      P.ensure(9);
      var y = P.y, meta = d.companies[c] || {};
      P.text(str(meta.label || c).split(' ')[0], c1, y, { style: c === d.bestCo ? 'bold' : 'normal', size: 8.6, color: INK });
      var atVal = safe(function () {
        return typeof d.pricing.valueAtGrade === 'function' ? d.pricing.valueAtGrade(c, p.grade, p.gradeLabel) : null;
      }, null);
      P.mono(gradeStr(p.grade) + ' -> ' + money(atVal), c2, y, INK, 7.8);
      if (e.ok) {
        P.mono(money(e.fee) + ' · ' + (e.tier ? e.tier.turnaroundDays + 'd' : '?'), c3, y, INK, 7.8);
        P.mono(money(e.expectedValue), c4, y, INK, 7.8);
        P.mono(signedMoney(e.profitVsRaw), c5, y, e.profitVsRaw >= 0 ? POS : NEG, 7.8, null, 'bold');
        var vc = e.verdict === 'Submit' ? POS : e.verdict === 'Borderline' ? WARN : NEG;
        P.text(str(e.verdict), c6, y, { style: 'bold', size: 8.4, color: vc, align: 'right' });
        P.mono('score ' + str(e.capitalScore), c6, y + 3.6, FAINT, 6.2, 'right');
      } else {
        P.text(str(e.reason || 'no graded comps'), c3, y, { size: 7.8, color: MUTED });
      }
      P.y = y + 8.6;
      P.setDraw(HAIR, LW_HAIR);
      doc.line(P.x, P.y - 3.4, P.right, P.y - 3.4);
    });

    P.y += P.para('Cheapest tier is shown for each company and faster tiers cost more. Turnaround is on-site business days and excludes shipping in both directions. Expected value weights every grade in the distribution by its probability, so it sits below the headline grade on purpose.',
      P.x, P.y + 1, P.cw, { size: 7.4, color: FAINT }) + 6;
  }

  /* ============================== per-corner / per-edge grid ==============================
   * The TAG-style 3 x 3: corners in the corner cells, edges between them, surface in the middle.
   * A weak cell is called out with a heavy border rather than a fill. Printed emphasis costs ink,
   * and a box around a number means stop and look at that corner.
   */
  function grid3(P, x, y, size, corners, edges, surface, title) {
    var doc = P.doc, cell = size / 3;
    var vals = [
      [corners.tl, 'TL'], [edges.top, 'T'], [corners.tr, 'TR'],
      [edges.left, 'L'], [surface, 'S'], [edges.right, 'R'],
      [corners.bl, 'BL'], [edges.bottom, 'B'], [corners.br, 'BR']
    ];
    P.label(title, x, y - 2.4, MUTED, 6, 0.32);
    for (var i = 0; i < 9; i++) {
      var cx = x + (i % 3) * cell, cy = y + Math.floor(i / 3) * cell;
      var v = vals[i][0];
      var weak = isNum(v) && v <= 8.5;
      P.setDraw(weak ? ACCENT : HAIR, weak ? LW_HEAVY : LW_HAIR);
      doc.rect(cx, cy, cell, cell, 'S');
      P.label(vals[i][1], cx + 1.2, cy + 3.2, FAINT, 4.6, 0.2);
      P.mono(isNum(v) ? gradeStr(v) : '·', cx + cell / 2, cy + cell / 2 + 2.4,
        isNum(v) ? INK : FAINT, 10.5, 'center', weak ? 'bold' : 'normal');
    }
    return size;
  }

  function granularSection(P, d) {
    var g = d.ai && d.ai.granular;
    if (!g || !g.corners) return;
    function side(k) {
      return {
        corners: (g.corners && g.corners[k]) || {},
        edges: (g.edges && g.edges[k]) || {},
        surface: (d.ai.surface && d.ai.surface[k])
      };
    }
    function hasAny(s) {
      return ['tl', 'tr', 'bl', 'br'].some(function (k) { return isNum(s.corners[k]); }) ||
        ['top', 'right', 'bottom', 'left'].some(function (k) { return isNum(s.edges[k]); });
    }
    var F = side('front'), B = side('back');
    if (!hasAny(F) && !hasAny(B)) return;

    P.sectionRule('Corner and edge detail', 'AI vision · advisory');
    var size = 33;
    P.ensure(size + 16);
    var top = P.y + 2;
    var x = P.x + 2;
    if (hasAny(F)) { safe(function () { grid3(P, x, top, size, F.corners, F.edges, F.surface, 'Front'); }); x += size + 12; }
    if (hasAny(B)) { safe(function () { grid3(P, x, top, size, B.corners, B.edges, B.surface, 'Back'); }); x += size + 12; }

    var tw = P.right - x;
    if (tw > 40) {
      P.para('Corners sit in the corner cells, edges between them, surface in the middle. Graders subgrade to the weakest point rather than the average, so the boxed cells are the ones deciding this card. A dot means the photos did not show that area well enough to call.',
        x, top + 4, tw, { size: 7.6, color: MUTED });
    }
    P.y = top + size + 8;
    if (tw <= 40) {
      P.y += P.para('Corners sit in the corner cells, edges between them, surface in the middle. Graders subgrade to the weakest point rather than the average, so the boxed cells are the ones deciding this card.',
        P.x, P.y, P.cw, { size: 7.6, color: MUTED }) + 4;
    }
  }

  /* ============================== score breakdown ============================== */
  function breakdownSection(P, d) {
    var co = d.bestCo, p = co ? d.pred.perCompany[co] : null;
    if (!p || !p.pillars) return;
    var doc = P.doc;
    var w = ((d.companies[co] || {}).pillarWeights) || { centering: 0.3, corners: 0.3, edges: 0.2, surface: 0.2 };
    P.sectionRule('Score breakdown', 'house method');
    P.ensure(40);

    var c1 = P.x, c2 = P.x + 42, c3 = P.x + 62, c4 = P.x + 88, barX = P.x + 100, barW = P.right - barX;
    P.label('pillar', c1, P.y, FAINT, 5.6, 0.3);
    P.label('grade', c2, P.y, FAINT, 5.6, 0.3);
    P.label('weight', c3, P.y, FAINT, 5.6, 0.3);
    P.label('points', c4, P.y, FAINT, 5.6, 0.3);
    P.setDraw(HAIR, LW_HAIR);
    doc.line(P.x, P.y + 1.8, P.right, P.y + 1.8);
    P.y += 6.2;

    var total = 0;
    ['centering', 'corners', 'edges', 'surface'].forEach(function (k) {
      var g = p.pillars[k], wt = isNum(w[k]) ? w[k] : 0;
      var pts = isNum(g) ? Math.round(g * wt * 100) : 0;
      total += pts;
      var y = P.y;
      P.text(cap(k), c1, y, { size: 8.4, color: INK });
      P.mono(gradeStr(g), c2, y, INK, 8.2);
      P.mono('×' + wt.toFixed(2), c3, y, MUTED, 8.2);
      P.mono(String(pts), c4, y, INK, 8.2);
      P.setDraw(HAIR, LW_HAIR);
      doc.line(barX, y - 1.1, barX + barW, y - 1.1);
      P.setFill(ACCENT);
      doc.rect(barX, y - 2.4, Math.max(0.4, barW * clamp(pts / 300, 0, 1)), 1.4, 'F');
      P.y = y + 6;
    });
    P.setDraw(INK, LW_HAIR);
    doc.line(P.x, P.y - 3.2, P.right, P.y - 3.2);
    P.text('Total on ' + str((d.companies[co] || {}).label || co) + ' weights', c1, P.y + 1.4, { style: 'bold', size: 8.4, color: INK });
    P.mono(String(total) + ' / 1000', c4, P.y + 1.4, ACCENT, 10, null, 'bold');
    P.y += 7;
    P.y += P.para('Each pillar grade multiplied by that grader weighting, times one hundred. It is a plain decomposition of the prediction on this page, and it is not the TAG DIG score.',
      P.x, P.y, P.cw, { size: 7.4, color: FAINT }) + 5;
  }

  /* ============================== defects and AI notes ============================== */
  function severityColor(sev) {
    return sev === 'major' ? NEG : sev === 'moderate' ? WARN : MUTED;
  }

  function defectsSection(P, d) {
    var list = d.defects;
    if (!list.length && !(d.ai && d.ai.reasoning)) return;
    var doc = P.doc;

    if (list.length) {
      P.sectionRule('Detected flaws', list.length + ' found');
      list.forEach(function (f) {
        P.ensure(9);
        var y = P.y;
        // Numbered disc, same number as the pin printed on the plates.
        P.setFill(severityColor(f.severity));
        doc.circle(P.x + 2, y - 1.1, 2.1, 'F');
        P.mono(String(f.n), P.x + 2, y + 0.4, PAPER, 6.4, 'center', 'bold');
        var head = [cap(f.pillar), f.side, f.location].filter(Boolean).join(' · ');
        P.text(head, P.x + 6.5, y, { style: 'bold', size: 8.2, color: INK });
        // Right-aligned to the margin rather than trailing the headline: a long location string
        // would otherwise push the flag off the page.
        if (f.gradeSignificant) P.label('grade significant', P.right, y, ACCENT, 5.4, 0.3, 'right');
        var body = str(f.note || f.severity);
        P.y = y + 3.6 + P.para(body, P.x + 6.5, y + 3.6, P.cw - 6.5, { size: 7.6, color: MUTED }) + 3.4;
        P.setDraw(HAIR, LW_HAIR);
        doc.line(P.x, P.y - 2.2, P.right, P.y - 2.2);
      });
      P.gap(3);
    }

    if (d.ai && d.ai.reasoning) {
      P.sectionRule('Vision notes', 'advisory');
      P.y += P.para(str(d.ai.reasoning), P.x, P.y, P.cw, { size: 8, color: INK, lead: 3.9 }) + 3;
      var who = [d.ai.provider, d.ai.model].filter(Boolean).join(' · ');
      if (who) { P.mono(who, P.x, P.y, FAINT, 7); P.y += 6; }
    }
  }

  /* ============================== annotated plates ==============================
   * The scans, with the numbered defect pins burned in. Composited on an offscreen canvas and
   * embedded as JPEG: the raw PNG scans are several megabytes each and would make the report
   * unmailable. An <img> does not decode synchronously, so every load is awaited, and every load
   * is also raced against a timeout because a promise that never settles would hang build() and
   * the user would just watch a button do nothing forever.
   */
  function loadImage(src) {
    return new Promise(function (resolve) {
      try {
        if (typeof Image === 'undefined' || !src) return resolve(null);
        var im = new Image(), done = false;
        function finish(v) { if (!done) { done = true; resolve(v); } }
        im.onload = function () { finish(im); };
        im.onerror = function () { finish(null); };
        im.src = src;
        setTimeout(function () { finish(null); }, 8000);
      } catch (e) { resolve(null); }
    });
  }

  function composeAnnotated(shot, pins, maxDim) {
    return loadImage(shot && shot.dataUrl).then(function (img) {
      if (!img) return null;
      return safe(function () {
        if (typeof document === 'undefined' || !document.createElement) return null;
        var sc = Math.min(1, (maxDim || 1600) / Math.max(img.width || 1, img.height || 1));
        var cw = Math.max(1, Math.round((img.width || 1) * sc));
        var ch = Math.max(1, Math.round((img.height || 1) * sc));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var ctx = cv.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, cw, ch);
        pins.forEach(function (f) {
          if (!isNum(f.x) || !isNum(f.y)) return;
          var px = f.x * cw, py = f.y * ch, r = Math.max(9, Math.round(cw * 0.014));
          var c = severityColor(f.severity);
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold ' + Math.round(r * 1.15) + 'px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(f.n), px, py);
        });
        return { dataUrl: cv.toDataURL('image/jpeg', 0.85), w: cw, h: ch };
      }, null);
    });
  }

  function platesSection(P, d) {
    var sides = [{ id: 'scan-front', side: 'front', title: 'Annotated plate, front' },
    { id: 'scan-back', side: 'back', title: 'Annotated plate, back' }];
    var chain = Promise.resolve();
    sides.forEach(function (s) {
      chain = chain.then(function () {
        var shot = d.shots[s.id];
        if (!shot || !shot.dataUrl) return null;
        var pins = d.defects.filter(function (f) { return f.pinned && f.imageRef === s.id; });
        return composeAnnotated(shot, pins, 1600).then(function (comp) {
          if (!comp) return;
          safe(function () {
            var listed = d.defects.filter(function (f) { return f.side === s.side; });
            var listH = listed.length ? 4 + listed.length * 5.6 : 8;
            // A plate wants a page, but not a page of nothing. If a decent block is still free the
            // plate goes in below whatever is already there and sizes itself to the gap; only a
            // genuinely cramped page gets broken. That is the difference between five dense pages
            // and six with a lonely paragraph on one of them.
            if (P.y + 120 + listH > BOTTOM) P.newPage();
            P.sectionRule(s.title, pins.length ? pins.length + ' pinned' : 'no pins');
            var maxW = P.cw;
            var maxH = clamp(BOTTOM - P.y - listH - 4, 60, 185);
            var sc = Math.min(maxW / comp.w, maxH / comp.h);
            var iw = comp.w * sc, ih = comp.h * sc;
            var ix = P.x + (maxW - iw) / 2;
            // addImage parses the JPEG itself and throws on anything it dislikes. Losing the picture
            // must not lose the page it was on, so the failure prints a line and the defect list
            // underneath still goes out.
            var placed = safe(function () {
              P.doc.addImage(comp.dataUrl, 'JPEG', ix, P.y, iw, ih);
              P.setDraw(HAIR, LW_HAIR);
              P.doc.rect(ix, P.y, iw, ih, 'S');
              return true;
            }, false);
            if (placed) P.y += ih + 7;
            else {
              P.text('The scan could not be embedded. The numbered flaws below still refer to it.',
                P.x, P.y + 2, { size: 8, color: MUTED });
              P.y += 10;
            }
            if (!listed.length) {
              P.text('Nothing flagged on this side.', P.x, P.y, { size: 8, color: MUTED });
              P.y += 6;
              return;
            }
            listed.forEach(function (f) {
              P.ensure(7);
              var y = P.y;
              P.setFill(severityColor(f.severity));
              P.doc.circle(P.x + 2, y - 1.1, 2.1, 'F');
              P.mono(String(f.n), P.x + 2, y + 0.4, PAPER, 6.4, 'center', 'bold');
              var head = [cap(f.pillar), f.location].filter(Boolean).join(' · ');
              P.text(head + (f.note ? ', ' + f.note : ''), P.x + 6.5, y, { size: 7.8, color: INK });
              P.y = y + 5.6;
            });
          });
        });
      }).catch(function () { });
    });
    return chain;
  }

  /* ============================== disclaimers ============================== */
  function disclaimersSection(P, d) {
    var doc = P.doc;
    var list = (d.cfg.disclaimers || []).filter(Boolean);
    P.ensure(60);
    P.sectionRule('Read this before you act on it', dateOnly(d.cfg.asOf) ? 'as of ' + dateOnly(d.cfg.asOf) : '');

    P.y += P.para('This report predicts how a grading company might grade the card in the photos supplied. It is an estimate produced by measurement and by a vision model, and it carries no authority. The company that slabs the card makes the only grade that counts.',
      P.x, P.y, P.cw, { size: 8.2, color: INK, lead: 3.9 }) + 5;

    list.forEach(function (t) {
      P.ensure(10);
      var y = P.y;
      P.setFill(ACCENT);
      doc.rect(P.x, y - 1.7, 1.5, 1.5, 'F');
      P.y = y + P.para(str(t), P.x + 5, y, P.cw - 5, { size: 7.8, color: MUTED, lead: 3.5 }) + 2.6;
    });

    if (dateOnly(d.cfg.asOf)) {
      P.gap(2);
      P.mono('Tolerances and fees as of ' + dateOnly(d.cfg.asOf) + '.', P.x, P.y, FAINT, 7);
      P.y += 5;
    }
  }

  /* ============================== footers ==============================
   * Stamped last, once the page count is known. Every page carries the same three facts so a loose
   * sheet on a desk still says what it is and what it is not.
   */
  function footers(P, d) {
    var doc = P.doc;
    var n = safe(function () { return doc.getNumberOfPages(); }, 1) || 1;
    for (var i = 1; i <= n; i++) {
      safe(function () {
        doc.setPage(i);
        P.setDraw(HAIR, LW_HAIR);
        doc.line(MARGIN, FOOT_Y - 4, W - MARGIN, FOOT_Y - 4);
        P.text('Estimate only. This is not an official grade.', MARGIN, FOOT_Y, { size: 7, color: MUTED });
        P.text('Card Pre-Grader · tcg-listing-tools', W / 2, FOOT_Y, { size: 7, color: FAINT, align: 'center' });
        P.mono(i + ' of ' + n, W - MARGIN, FOOT_Y, MUTED, 7, 'right');
        var asOf = dateOnly(d.cfg.asOf);
        if (asOf) P.mono('as of ' + asOf, W - MARGIN, FOOT_Y + 3.4, FAINT, 6, 'right');
      });
    }
  }

  /* ============================== data normalisation ==============================
   * The caller owns the numbers; this module owns none of the maths. Everything below is defensive
   * shaping so a half-filled report still lays out. The one legacy allowance: defects may arrive as
   * the page's pinnedDefects() rows ({n, d, pinned}) instead of the flat shape documented in the
   * header, and both are accepted.
   */
  function normalize(data) {
    var d = data || {};
    var cfg = d.cfg || {};
    var companies = cfg.companies || {};
    var pred = (d.pred && d.pred.perCompany) ? d.pred : { perCompany: {} };
    var order = Object.keys(companies).filter(function (c) { return pred.perCompany[c]; });
    if (!order.length) order = Object.keys(pred.perCompany);

    var defects = [];
    (Array.isArray(d.defects) ? d.defects : []).forEach(function (row, i) {
      if (!row) return;
      var f = row.d ? row.d : row;
      defects.push({
        n: isNum(row.n) ? row.n : i + 1,
        pinned: row.pinned != null ? !!row.pinned : (!!f.imageRef && isNum(f.x) && isNum(f.y)),
        pillar: f.pillar, side: f.side, imageRef: f.imageRef,
        x: f.x, y: f.y, location: f.location, severity: f.severity,
        gradeSignificant: !!f.gradeSignificant, note: f.note
      });
    });

    var best = d.bestCo && pred.perCompany[d.bestCo] ? d.bestCo : (order[0] || null);

    return {
      card: d.card || {},
      cfg: cfg,
      companies: companies,
      order: order,
      pred: pred,
      econ: d.econ || {},
      bestCo: best,
      centering: d.centering || {},
      ai: d.ai || null,
      shots: d.shots || {},
      defects: defects,
      pricing: d.pricing || {},
      meta: d.meta || {}
    };
  }

  /* ============================== entry point ============================== */
  function build(data) {
    return new Promise(function (resolve, reject) {
      var d = normalize(data);
      var JS = global.jspdf && global.jspdf.jsPDF;
      if (!JS) { reject(new Error('jsPDF is not loaded')); return; }
      // Compression matters here: the embedded scans dominate the file size. If a build of jsPDF
      // ever ships without the deflate path, fall back to an uncompressed document rather than
      // failing the download.
      var doc = safe(function () { return new JS({ unit: 'mm', format: 'a4', compress: true }); }, null)
        || new JS({ unit: 'mm', format: 'a4' });
      var P = makeP(doc, d);

      safe(function () { masthead(P, d); });
      safe(function () { identity(P, d); });
      safe(function () { headline(P, d); });
      safe(function () { centeringSection(P, d); });
      safe(function () { predictionsSection(P, d); });
      safe(function () { economicsSection(P, d); });
      safe(function () { granularSection(P, d); });
      safe(function () { breakdownSection(P, d); });
      safe(function () { defectsSection(P, d); });

      var after = safe(function () { return platesSection(P, d); }, null) || Promise.resolve();
      after.then(function () { }, function () { }).then(function () {
        safe(function () { disclaimersSection(P, d); });
        safe(function () { footers(P, d); });
        resolve(doc);
      });
    });
  }

  global.GradeReportPDF = { build: build };
})(typeof window !== 'undefined' ? window : this);
