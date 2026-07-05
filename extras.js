/* extras.js — shared across all listing builders.
   TCG.renderExtras(container, { name, images:[{label,url}], prices:[{label,amount,currency}], history:[{daysAgo,price}]|null })
   Uses each tool's own CSS vars (--gold/--line/--muted/--text/--field/--panel2) so it themes itself. */
(function () {
  const TCG = (window.TCG = window.TCG || {});
  let RATES = null, RATE_DATE = '';

  TCG.loadFx = async function () {
    if (RATES) return RATES;
    try {
      const r = await fetch('/api/fx/latest?from=USD&to=AUD,EUR,GBP,JPY');
      if (r.ok) { const j = await r.json(); RATES = Object.assign({ USD: 1 }, j.rates || {}); RATE_DATE = j.date || ''; }
    } catch (e) {}
    return RATES;
  };
  function conv(amount, from, to) {
    if (!RATES) return null;
    const usd = from === 'USD' ? amount : amount / (RATES[from] || 1);
    return to === 'USD' ? usd : usd * (RATES[to] || 1);
  }
  TCG.toAUD = function (a, from) { return conv(a, from || 'USD', 'AUD'); };

  function money(n, cur) {
    const sym = { USD: 'US$', AUD: 'A$', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5' }[cur] || (cur + ' ');
    return sym + (Math.round(n * 100) / 100).toFixed(2);
  }

  async function downloadImg(url, filename) {
    try {
      const r = await fetch('/api/img?u=' + encodeURIComponent(url));
      if (!r.ok) throw 0;
      let b = await r.blob();
      // eBay accepts AVIF, but PNG is universally safe — transcode AVIF (Lorcast) to PNG in-browser.
      // The browser already has an AVIF decoder; createImageBitmap -> canvas -> PNG needs no deps and
      // no server CPU. Falls back to the original AVIF blob if the browser can't transcode it.
      if (/\.avif$/i.test(filename) || /image\/avif/i.test(b.type)) {
        const png = await avifBlobToPng(b);
        if (png) { b = png; filename = filename.replace(/\.avif$/i, '.png'); }
      }
      const o = URL.createObjectURL(b);
      const a = document.createElement('a'); a.href = o; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(o), 3000);
    } catch (e) { window.open(url, '_blank'); }
  }

  // Decode an image blob (e.g. AVIF) and re-encode as a PNG blob, or null if unsupported.
  function avifBlobToPng(blob) {
    return new Promise(function (resolve) {
      if (typeof createImageBitmap !== 'function') return resolve(null);
      createImageBitmap(blob).then(function (bmp) {
        try {
          const c = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0);
          if (bmp.close) bmp.close();
          c.toBlob(function (out) { resolve(out); }, 'image/png');
        } catch (e) { resolve(null); }
      }).catch(function () { resolve(null); });
    });
  }

  TCG.clear = function (el) { if (el) el.innerHTML = ''; };

  // ---------- activity indicator (bottom-left toast stack) ----------
  // TCG.activity('label') -> handle with .update(l) / .done(msg) / .fail(msg).
  // Shows a live elapsed timer so the app always feels like it's doing something.
  var _actWrap = null;
  function actWrap() {
    if (!_actWrap) {
      var st = document.createElement('style');
      st.textContent = '@keyframes tcgspin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
      _actWrap = document.createElement('div');
      _actWrap.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:99999;display:flex;flex-direction:column;gap:6px;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;';
      document.body.appendChild(_actWrap);
    }
    return _actWrap;
  }
  TCG.activity = function (label) {
    var t0 = Date.now();
    var el = document.createElement('div');
    el.style.cssText = 'background:var(--panel2,#1a1a1a);border:1px solid var(--line,#333);color:var(--text,#eee);border-radius:999px;padding:7px 13px;font-size:12px;font-weight:600;box-shadow:0 4px 18px rgba(0,0,0,.35);display:flex;align-items:center;gap:8px;max-width:360px;opacity:0;transform:translateY(6px);transition:opacity .18s,transform .18s;';
    var spin = '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;border:2px solid var(--gold,#c8aa6e);border-top-color:transparent;animation:tcgspin .7s linear infinite;flex:none;"></span>';
    el.innerHTML = '<span class="ic">' + spin + '</span><span class="tx" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(label) + '</span><span class="el" style="color:var(--muted,#888);font-weight:400;flex:none;"></span>';
    actWrap().appendChild(el);
    requestAnimationFrame(function () { el.style.opacity = '1'; el.style.transform = 'none'; });
    var tick = setInterval(function () { el.querySelector('.el').textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's'; }, 100);
    function fin(icon, color, msg, hold) {
      clearInterval(tick);
      var s = ((Date.now() - t0) / 1000).toFixed(1);
      el.querySelector('.ic').innerHTML = '<span style="color:' + color + ';font-weight:800;flex:none;">' + icon + '</span>';
      el.querySelector('.tx').textContent = msg || label;
      el.querySelector('.el').textContent = ' · ' + s + 's';
      setTimeout(function () { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; setTimeout(function () { if (el.parentNode) el.remove(); }, 230); }, hold);
    }
    return {
      update: function (l) { var tx = el.querySelector('.tx'); if (tx) tx.textContent = l; return this; },
      done: function (msg) { fin('✓', '#36d399', msg, 1300); },
      fail: function (msg) { fin('✕', '#f06262', msg, 3200); },
    };
  };

  // reconstruct a rough price series from Scrydex trend deltas
  TCG.histFromTrends = function (market, trends) {
    if (market == null || !trends) return null;
    const pts = [{ daysAgo: 0, price: +market }];
    [90, 30, 7, 1].forEach(d => {
      const t = trends['days_' + d];
      if (t && t.price_change != null) pts.push({ daysAgo: d, price: +market - +t.price_change });
    });
    return pts.length > 1 ? pts : null;
  };

  function lineGraph(points) {
    const pts = points.slice().sort((a, b) => b.daysAgo - a.daysAgo);
    const W = 320, H = 110, pad = 12;
    const maxD = Math.max.apply(null, pts.map(p => p.daysAgo)) || 1;
    const ys = pts.map(p => p.price);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys), spanY = (maxY - minY) || 1;
    const X = d => pad + ((maxD - d) / maxD) * (W - 2 * pad);
    const Y = v => H - pad - ((v - minY) / spanY) * (H - 2 * pad);
    const poly = pts.map(p => X(p.daysAgo).toFixed(1) + ',' + Y(p.price).toFixed(1)).join(' ');
    const dots = pts.map(p => `<circle cx="${X(p.daysAgo).toFixed(1)}" cy="${Y(p.price).toFixed(1)}" r="2.5" fill="var(--gold,#c8aa6e)"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;"><polyline points="${poly}" fill="none" stroke="var(--gold,#c8aa6e)" stroke-width="2"/>${dots}</svg>`;
  }
  // exposed so the price-tracker dashboard can draw bare sparklines from /api/tracker history
  TCG.lineGraph = lineGraph;

  // POST a card to the price-tracker watchlist.
  // p = {game, identity_key, name, variant?, note?, source?, price?:{market,low,currency}}
  TCG.addToTracker = async function (p) {
    try {
      const r = await fetch('/api/tracker/watchlist', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
      });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  };

  // POST a card to graded-card INVENTORY (Binders Keepers). Returns {id,sku,created} or null.
  // p = {game, identity_key, name, set_name?, number?, variant?, language?,
  //      grading_company?, grade?, grade_label?, subgrades?, cert_number?, graded_date?,
  //      quantity?, location?, status?, cost_cents?, acq_fees_cents?, acquired_at?, source_vendor?,
  //      target_price_cents?, value_cents?, value_currency?, value_source?, notes?, link_watchlist?}
  TCG.addToInventory = async function (p) {
    try {
      const r = await fetch('/api/inventory/items', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
      });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  };

  // ---- pricing-panel helpers (shared) ----
  // Confidence pill — only used where we have a REAL signal (PriceCharting match today).
  var CONF_COL = { high: '#36d399', medium: '#f0c020', low: '#f06262' };
  function confPill(c) {
    if (!c || !c.level) return '';
    var col = CONF_COL[c.level] || 'var(--muted,#888)';
    return '<span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;border:1px solid ' + col + ';color:' + col + ';border-radius:999px;padding:1px 7px;margin-left:6px;white-space:nowrap;">' + esc(c.text || c.level) + '</span>';
  }
  // Source + measure chip — the provenance atom (e.g. "TCGplayer · holofoil market").
  function srcChip(p) {
    var t = p.source ? (p.source + (p.measure ? ' · ' + p.measure : '')) : (p.label || '');
    if (!t) return '';
    return '<span style="font-size:11px;color:var(--muted,#888);background:var(--field,#111);border:1px solid var(--line,#333);border-radius:5px;padding:1px 6px;">' + esc(t) + '</span>';
  }
  // Right-hand value — AUD-FIRST: bold A$ primary, native currency a muted secondary (provenance).
  function priceVal(p) {
    var aud = TCG.toAUD(+p.amount, p.currency);
    var spread = '';
    if (p.spread && (p.spread.low != null || p.spread.high != null)) {
      var lo = p.spread.low != null ? money(+p.spread.low, p.currency) : '', hi = p.spread.high != null ? money(+p.spread.high, p.currency) : '';
      spread = '<div style="font-size:10.5px;color:var(--muted,#888);">' + (lo && hi ? lo + '–' + hi : (lo || hi)) + '</div>';
    }
    if (aud != null) {
      var nat = (p.currency && p.currency !== 'AUD') ? '<span style="color:var(--muted,#888);font-weight:400;font-size:11px;"> · ' + money(+p.amount, p.currency) + '</span>' : '';
      return '<div style="font-weight:700;">' + money(aud, 'AUD') + nat + '</div>' + spread;
    }
    return '<div style="font-weight:700;">' + money(+p.amount, p.currency) + '</div>' + spread; // FX down → native-primary fallback
  }
  function priceRow(p) {
    var left = (p.group === 'graded')
      ? '<span style="color:var(--gold,#c8aa6e);font-weight:600;">' + esc(p.measure || p.label || '') + '</span>'
      : srcChip(p);
    left += confPill(p.conf);
    if (p.note) left += '<div style="font-size:10.5px;color:var(--muted,#888);margin-top:2px;">' + esc(p.note) + '</div>';
    return '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;padding:6px 0;border-top:1px solid var(--line,#333);font-size:13px;"><div style="min-width:0;">' + left + '</div><div style="text-align:right;white-space:nowrap;">' + priceVal(p) + '</div></div>';
  }
  // Median of the AUD-converted MARKET-group prices, + min/max for the divergence flag.
  function marketConsensus(prices) {
    var auds = (prices || []).filter(function (p) { return (p.group || 'market') === 'market'; })
      .map(function (p) { return TCG.toAUD(+p.amount, p.currency); })
      .filter(function (x) { return x != null && x > 0; }).sort(function (a, b) { return a - b; });
    if (!auds.length) return null;
    var n = auds.length, med = n % 2 ? auds[(n - 1) / 2] : (auds[n / 2 - 1] + auds[n / 2]) / 2;
    return { med: med, lo: auds[0], hi: auds[n - 1], n: n, ratio: auds[0] > 0 ? auds[n - 1] / auds[0] : 1 };
  }
  // Builds the inner pricing body: consensus hero + divergence flag + grouped (Market/Graded/Asking) rows.
  function buildPriceBody(prices) {
    var h2 = 'font-size:10.5px;letter-spacing:.3px;color:var(--muted,#888);';
    var html = '', c = marketConsensus(prices);
    if (c) {
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--line,#333);">'
        + '<div><div style="' + h2 + '">Market consensus</div><div style="font-weight:800;font-size:20px;color:var(--gold,#c8aa6e);line-height:1.1;">' + money(c.med, 'AUD') + '</div></div>'
        + '<div style="' + h2 + 'text-align:right;">median of ' + c.n + ' source' + (c.n > 1 ? 's' : '') + '<br>USD/EUR&rarr;AUD</div></div>';
      if (c.n >= 2) {
        var pct = Math.round((c.ratio - 1) * 100);
        html += c.ratio > 1.25
          ? '<div style="margin-top:8px;padding:7px 10px;border-radius:8px;background:rgba(240,192,32,.10);border:1px solid rgba(240,192,32,.35);font-size:11.5px;color:var(--amber,#f0c020);">&#9888; Sources differ ' + money(c.lo, 'AUD') + '–' + money(c.hi, 'AUD') + ' (+' + pct + '%) — check recent sales</div>'
          : '<div style="margin-top:8px;padding:7px 10px;border-radius:8px;background:rgba(54,211,153,.10);border:1px solid rgba(54,211,153,.35);font-size:11.5px;color:#36d399;">&#10003; Sources agree within ' + pct + '%</div>';
      }
    }
    var groups = [['market', 'Market', 'what the market sits at'], ['graded', 'Graded', 'PriceCharting · eBay-sold'], ['asking', 'Asking', 'cheapest live listings']];
    var first = true;
    groups.forEach(function (g) {
      var rows = prices.filter(function (p) { return (p.group || 'market') === g[0]; });
      if (!rows.length) return;
      html += '<div style="' + h2 + 'margin:' + (first ? '10px' : '14px') + ' 0 4px;">' + g[1] + ' <span style="opacity:.6;">· ' + g[2] + '</span></div>';
      first = false;
      rows.forEach(function (p) { html += priceRow(p); });
    });
    return html;
  }

  TCG.renderExtras = function (container, data) {
    if (!container) return;
    data = data || {};
    const name = ((data.name || 'card') + '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'card';
    // Each image: disp = candidate DISPLAY urls (small/fast, raced for the quickest);
    // dl = the DOWNLOAD url (always best quality). Back-compat: {url, fallback} still works.
    const imgs = (data.images || []).map(function (im) {
      var disp = im.display ? im.display.slice() : (im.url ? [im.url] : []);
      if (im.fallback) disp.push(im.fallback);
      disp = disp.filter(Boolean);
      return { label: im.label, disp: disp, dl: im.download || im.url || disp[0] || '' };
    }).filter(function (p) { return p.disp.length || p.dl; });
    const hasImg = imgs.length;
    const prices = (data.prices || []).filter(p => p && p.amount != null && p.amount !== '');
    if (!hasImg && !prices.length && !data.priceNote) { container.innerHTML = ''; return; }

    const box = 'border:1px solid var(--line,#333);border-radius:12px;padding:14px;background:var(--panel2,#1a1a1a);';
    const head = 'font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted,#888);font-weight:700;margin-bottom:10px;';
    let html = '';

    if (hasImg) {
      html += `<div style="${box}margin-bottom:14px;"><div style="${head}">Card image</div><div style="display:flex;gap:14px;flex-wrap:wrap;">`;
      imgs.forEach(function (p, idx) {
        var ext = (p.dl.match(/\.(png|jpe?g|webp|avif)(?:\?|$)/i) || [])[1] || 'png';
        html += `<div style="text-align:center;">
          <img id="tcg-img-${idx}" src="${p.disp[0] || p.dl}" alt="${esc(p.label)}" loading="lazy" data-disp="${encodeURIComponent(JSON.stringify(p.disp))}" style="width:150px;max-width:42vw;border-radius:8px;display:block;border:1px solid var(--line,#333);background:var(--field,#111);min-height:60px;">
          <button class="tcg-dl" data-url="${encodeURIComponent(p.dl)}" data-fn="${name}-${(p.label||'art').toLowerCase()}.${ext}" style="margin-top:8px;width:100%;padding:6px;border:1px solid var(--gold,#c8aa6e);background:transparent;color:var(--gold,#c8aa6e);border-radius:7px;font-weight:700;font-size:12px;cursor:pointer;" title="Downloads best available quality">&#8595; ${esc(p.label)} <span style="opacity:.55;font-weight:400;">HQ</span></button>
        </div>`;
      });
      html += '</div></div>';
    }

    if (prices.length || data.priceNote) {
      html += `<div style="${box}"><div style="${head}">Pricing</div>`;
      if (prices.length) {
        html += `<div id="tcg-prices"></div>`;
        html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line,#333);">
          <div style="${head}margin-bottom:8px;">Convert</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input id="tcg-amt" type="number" step="0.01" style="width:92px;padding:7px 9px;background:var(--field,#111);border:1px solid var(--line,#333);border-radius:7px;color:var(--text,#eee);font-size:14px;">
            <select id="tcg-from" style="padding:7px 9px;background:var(--field,#111);border:1px solid var(--line,#333);border-radius:7px;color:var(--text,#eee);font-size:13px;"><option>USD</option><option>EUR</option><option>GBP</option><option>AUD</option></select>
            <span style="color:var(--muted,#888);">&rarr;</span>
            <span id="tcg-out" style="font-weight:700;font-size:16px;color:var(--gold,#c8aa6e);">&mdash;</span>
          </div>
          <div id="tcg-rate" style="font-size:11px;color:var(--muted,#888);margin-top:6px;"></div></div>`;
        if (data.history && data.history.length > 1) {
          const ys = data.history.map(p => p.price), maxD = Math.max.apply(null, data.history.map(p => p.daysAgo));
          html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line,#333);"><div style="${head}margin-bottom:6px;">Price trend</div>${lineGraph(data.history)}<div style="font-size:11px;color:var(--muted,#888);margin-top:4px;">${money(Math.min.apply(null, ys), 'USD')} &ndash; ${money(Math.max.apply(null, ys), 'USD')} over ~${maxD} days (reconstructed from trend deltas)</div></div>`;
        }
        if (data.pcLink) {
          html += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line,#333);font-size:11px;"><a href="${esc(data.pcLink)}" target="_blank" rel="noopener" style="color:var(--gold,#c8aa6e);text-decoration:none;">Verify match on PriceCharting &#8599;</a></div>`;
        }
      } else {
        html += `<div style="font-size:12px;color:var(--muted,#888);">${esc(data.priceNote)}</div>`;
      }
      // Optional native-market reference link (e.g. PriceCharting Japanese console) — shown in both states.
      if (data.priceLink && data.priceLink.href) {
        html += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line,#333);font-size:11px;"><a href="${esc(data.priceLink.href)}" target="_blank" rel="noopener" style="color:var(--gold,#c8aa6e);text-decoration:none;">${esc(data.priceLink.label || 'Verify on PriceCharting')} &#8599;</a></div>`;
      }
      html += '</div>';
    }

    container.innerHTML = html;

    container.querySelectorAll('.tcg-dl').forEach(b =>
      b.addEventListener('click', () => downloadImg(decodeURIComponent(b.getAttribute('data-url')), b.getAttribute('data-fn'))));

    // Race the DISPLAY candidates — show whichever CDN paints first (best download stays separate).
    container.querySelectorAll('img[data-disp]').forEach(function (imgEl) {
      var disp; try { disp = JSON.parse(decodeURIComponent(imgEl.getAttribute('data-disp') || '[]')); } catch (e) { disp = []; }
      if (!disp || disp.length < 2) return;
      var settled = false;
      disp.forEach(function (u) { var pre = new Image(); pre.onload = function () { if (settled) return; settled = true; imgEl.src = u; }; pre.src = u; });
    });

    if (prices.length) {
      TCG.loadFx().then(() => {
        const pr = container.querySelector('#tcg-prices');
        if (pr) pr.innerHTML = buildPriceBody(prices);
        const amt = container.querySelector('#tcg-amt'), from = container.querySelector('#tcg-from'),
              out = container.querySelector('#tcg-out'), rate = container.querySelector('#tcg-rate');
        const cons = marketConsensus(prices), seed = prices[0];
        if (amt) {
          if (cons) { amt.value = cons.med.toFixed(2); from.value = 'AUD'; }      // seed from the AUD consensus
          else if (seed) { amt.value = (+seed.amount).toFixed(2); from.value = seed.currency; }
        }
        function upd() { const v = parseFloat(amt.value) || 0; const a = TCG.toAUD(v, from.value); out.textContent = a != null ? money(a, 'AUD') : 'rate n/a'; }
        if (amt) { amt.addEventListener('input', upd); from.addEventListener('change', upd); upd(); }
        if (rate) { const r = TCG.toAUD(1, 'USD'); rate.textContent = r != null ? ('1 USD = ' + money(r, 'AUD') + (RATE_DATE ? '  (' + RATE_DATE + ')' : '')) : 'FX rate unavailable (proxy offline?)'; }
      });
    }
  };

  // ---------- eBay AU comps (delivered totals incl. shipping; SOLD where available, else ASKING) ----------
  // Shared across builders. Caller passes a game-specific search query; we hit eBay (via /api/ebay),
  // prefer true sold prices (Marketplace Insights) and fall back to current asking (Browse), then render
  // delivered totals (item + shipping), AU vs Worldwide, and the cheapest-delivered "undercut" target.
  var ebaySoldOff = false;   // set once we learn Marketplace Insights isn't granted (no retry this session)
  function ebMoney(n){ return 'A$' + (Math.round(n * 100) / 100).toFixed(2); }
  function ebShip(opt){ var so = (opt || [])[0]; return (so && so.shippingCost && so.shippingCost.value != null) ? parseFloat(so.shippingCost.value) : null; } // null = calculated/unknown
  function ebAuction(it){ return Array.isArray(it.buyingOptions) && it.buyingOptions.indexOf('AUCTION') >= 0; }
  function ebNormAsk(it){ var price = it.price && parseFloat(it.price.value); if (!(price > 0)) return null;
    return { price: price, ship: ebShip(it.shippingOptions), loc: (it.itemLocation && it.itemLocation.country) || '?', title: it.title || '', url: it.itemWebUrl || '',
      created: it.itemCreationDate || it.itemOriginDate || null, cond: it.condition || '', condId: it.conditionId || '', auction: ebAuction(it), sold: false }; }
  function ebNormSold(s){ var lp = s.lastSoldPrice, price = lp && parseFloat(lp.value); if (!(price > 0)) return null;
    return { price: price, ship: ebShip(s.shippingOptions), loc: (s.itemLocation && s.itemLocation.country) || '?', title: s.title || '', url: s.itemWebUrl || '',
      created: s.lastSoldDate || s.itemEndDate || null, cond: s.condition || '', condId: s.conditionId || '', auction: false, sold: true }; }

  function renderEbayComps(el, rows, mode){
    if (!el) return;
    var all = rows.map(function (r) { return Object.assign({}, r, { delivered: r.price + (r.ship || 0), known: r.ship != null }); });
    function seg(list){ var k = list.filter(function (r) { return r.known; }).map(function (r) { return r.delivered; }).sort(function (a, b) { return a - b; });
      return { n: list.length, cheap: k[0], med: k.length ? k[Math.floor(k.length / 2)] : null, unknown: list.length - k.length }; }
    var au = seg(all.filter(function (r) { return r.loc === 'AU'; })), ww = seg(all);
    var overall = all.filter(function (r) { return r.known; }).sort(function (a, b) { return a.delivered - b.delivered; })[0];
    var box = 'border:1px solid var(--line,#333);border-radius:12px;padding:14px;background:var(--panel2,#1a1a1a);';
    var head = 'font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted,#888);font-weight:700;';
    var note = mode === 'sold' ? 'SOLD — actual recent sales' : 'ASKING — current listings (not sold)' + (ebaySoldOff ? ' · sold prices need eBay Marketplace Insights access' : '');
    var html = '<div style="' + box + '">';
    html += '<div style="' + head + '">eBay comps · delivered incl. shipping · AUD</div>';
    html += '<div style="font-size:11px;color:var(--muted,#888);margin:3px 0 10px;">' + note + '</div>';
    if (overall) {
      html += '<div style="border:1px solid var(--gold,#c8aa6e);border-radius:9px;padding:10px 12px;margin-bottom:12px;background:rgba(200,170,110,.08);">'
        + '<div style="color:var(--gold,#c8aa6e);font-weight:700;font-size:14px;">Cheapest delivered: ' + ebMoney(overall.delivered) + '</div>'
        + '<div style="font-size:12px;color:var(--text,#eee);margin-top:3px;">item ' + ebMoney(overall.price) + ' + ship ' + ebMoney(overall.ship) + (overall.loc && overall.loc !== '?' ? ' · ' + overall.loc : '') + '</div>'
        + '<div style="font-size:12px;color:var(--muted,#888);margin-top:6px;">List with <b style="color:var(--gold,#c8aa6e);">FREE shipping under ' + ebMoney(overall.delivered) + '</b> to be the cheapest total a buyer pays.</div>'
        + '</div>';
    }
    function segRow(label, s){ if (!s.n) return '';
      return '<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:13px;border-top:1px solid var(--line,#333);">'
        + '<span style="color:var(--muted,#888);">' + label + ' <span style="opacity:.65;">(' + s.n + ')</span></span>'
        + '<span style="font-weight:600;text-align:right;">' + (s.cheap != null ? 'cheapest ' + ebMoney(s.cheap) : '—') + (s.med != null ? ' · median ' + ebMoney(s.med) : '') + '</span></div>'; }
    html += segRow('🇦🇺 Australia', au) + segRow('🌏 Worldwide', ww);
    if (ww.unknown) html += '<div style="font-size:11px;color:var(--muted,#888);margin-top:6px;">' + ww.unknown + ' listing(s) with calculated/unknown shipping — excluded from delivered totals.</div>';
    var top = all.filter(function (r) { return r.known; }).sort(function (a, b) { return a.delivered - b.delivered; }).slice(0, 3);
    if (top.length) {
      html += '<div style="' + head + 'margin:12px 0 6px;border-top:1px solid var(--line,#333);padding-top:10px;">Cheapest delivered</div>';
      top.forEach(function (r) { var t = esc((r.title || '').slice(0, 54));
        html += '<div style="font-size:12px;padding:3px 0;line-height:1.4;">' + ebMoney(r.delivered)
          + ' <span style="color:var(--muted,#888);">= ' + ebMoney(r.price) + ' + ' + ebMoney(r.ship) + ' ship · ' + esc(r.loc || '?') + '</span>'
          + (r.url ? ' <a href="' + esc(r.url) + '" target="_blank" rel="noopener" style="color:var(--gold,#c8aa6e);text-decoration:none;">↗</a>' : '')
          + '<div style="color:var(--muted,#888);font-size:11px;">' + t + '</div></div>'; });
    }
    html += '</div>';
    el.innerHTML = html;
  }

  // ---------- comps analysis (distribution / clustering / confidence) ----------
  // The cheapest listing is a poor value signal — one $10 outlier among twenty $30s means
  // it's a $30 card. We bin delivered prices, find the densest CLUSTER (the real market),
  // and recommend undercutting the cheapest WITHIN that cluster. Raw vs graded are different
  // markets (kept separate); auctions are volatile (excluded from the cluster, still shown).
  function quantile(sortedAsc, q){ if(!sortedAsc.length) return null; var pos=(sortedAsc.length-1)*q, base=Math.floor(pos), rest=pos-base;
    return sortedAsc[base+1]!==undefined ? sortedAsc[base]+rest*(sortedAsc[base+1]-sortedAsc[base]) : sortedAsc[base]; }
  function median(arr){ return quantile(arr.slice().sort(function(a,b){return a-b;}), 0.5); }
  // Trust eBay's authoritative conditionId (2750=Graded; 4000=Ungraded/3000=Used/1000=New are raw).
  // Only fall back to title/condition keywords when no conditionId is present — raw card titles
  // routinely mention "PSA"/"graded" ("not PSA graded", "PSA-ready"), which falsely flags them.
  function isGraded(r){
    var id = String(r.condId || '');
    if (id === '2750') return true;
    if (id === '4000' || id === '3000' || id === '1000') return false;
    return /\b(psa|bgs|cgc|sgc|ace|tag)\b\s*\d|graded|gem\s*mint/i.test((r.cond||'') + ' ' + (r.title||''));
  }

  // Accessories / sealed / lots that pollute a singles search (the keyring, display case,
  // proxy/custom, multi-card lot, booster pack, etc.). Word-boundaried to avoid false hits
  // ("showcase" won't match \bcase\b, "metallic" won't match \bmetal\b).
  var JUNK_RE = /keyring|key\s*ring|\bcase\b|display|\bsleeve\b|toploader|top\s*loader|protector|\bproxy\b|custom|orica|\bmetal\b|jumbo|oversized|playmat|\bdecal\b|\bsticker\b|\bbundle\b|\blot\b|\bbooster\b|\bpack\b|\bbox\b|\bcoin\b|\bpin\b|\bsigned\b|\baltered\b|art\s*card|art\s*series|\bsealed\b|starter\s*deck|\bplayset\b|pick\s*your|choose\s*your|complete\s*your|set\s*of\b|\bsingles\b|\bbulk\b/i;
  // Build a flexible title matcher for a collector number. "232/91" matches 232/91 AND 232/091
  // (eBay titles zero-pad inconsistently); a bare "296" matches the number on a word boundary.
  function buildNumberRe(num){
    var s = String(num || '').trim(); if (!s) return null;
    var m = s.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
    if (m) return new RegExp('\\b' + m[1] + '\\s*\\/\\s*0*' + String(+m[2]) + '\\b');
    var n = s.match(/\d{1,4}/); return n ? new RegExp('\\b0*' + String(+n[0]) + '\\b') : null;
  }

  // Classify a listing TITLE's card language from text signals (no reliable eBay aspect exists —
  // see docs/DATA_SOURCES.md). Returns 'ko' | 'jp' | 'cn' | 'eu' | 'en'. Order matters: kana is
  // JP-certain, hangul KO-certain; a Latin language word is decisive; bare Han (no kana/keyword)
  // is ambiguous JP-or-CN and defaults to JP (the dominant CJK Pokémon market).
  TCG.classifyLang = function (title) {
    var t = title || '';
    if (/[가-힯]/.test(t) || /\b(korean|kor)\b/i.test(t)) return 'ko';
    if (/[぀-ヿ]/.test(t) || /\b(japanese|jpn?|nihongo)\b/i.test(t)) return 'jp';   // kana ⇒ JP
    if (/中文|简体|繁體|宝可梦|寶可夢/.test(t) || /\b(chinese|s[-\s]?chinese|simplified|traditional)\b/i.test(t)) return 'cn';
    if (/\b(french|fran[çc]ais|deutsch|german|italiano|italian|espa(?:ñ|n)ol|spanish|portugu[eê]s|portuguese|russian)\b/i.test(t)) return 'eu';
    if (/[一-鿿]/.test(t)) return 'jp';                                             // bare Han ⇒ default JP
    return 'en';
  };

  // TCG.analyzeComps(rows, {mode, ref, refLabel, precision, numberMatch, lang}) -> rich analysis.
  // With precision:true, rows are first narrowed to listings that are plausibly THIS exact card
  // (title carries the collector number, not an accessory/lot, right language) before any stats.
  TCG.analyzeComps = function (rows, opts) {
    opts = opts || {};
    var mode = opts.mode || 'asking';
    var src = rows || [], nRaw = src.length, filtered = false, numbered = false, finish = null;
    if (opts.precision) {
      filtered = true;
      var numRe = buildNumberRe(opts.numberMatch);
      numbered = !!numRe;                                            // was a collector-number filter actually applied?
      finish = (opts.finish === 'foil' || opts.finish === 'nonfoil') ? opts.finish : null;
      // Map the builder's dataLang (en/ja/zh-cn/zh-tw/ko) to a classifier category.
      var wantLang = ({ ja: 'jp', 'zh-cn': 'cn', 'zh-tw': 'cn', ko: 'ko', en: 'en' })[opts.lang] || opts.lang || 'en';
      src = src.filter(function (r) {
        var t = r.title || '';
        if (numRe && !numRe.test(t)) return false;                 // must carry THIS card's number
        if (JUNK_RE.test(t)) return false;                          // not an accessory / lot
        var cl = TCG.classifyLang(t);
        // EN mode: keep only English-classified (drops CJK + any foreign-language listing — a strict
        // superset of the old behaviour). JP/CN/KO modes: keep the wanted language AND bilingual
        // English-titled listings (most JP/CN cards on eBay AU carry English Pokémon names); drop
        // only titles CONFIRMED to be a DIFFERENT foreign language.
        if (wantLang === 'en') { if (cl !== 'en') return false; }
        else if (cl !== wantLang && cl !== 'en') return false;
        if (finish) {
          // Same collector number sells foil AND non-foil — keep only the matching finish so a foil
          // isn't priced off cheaper non-foil (and vice-versa). Unlabelled listings stay (most singles
          // don't state it); only the EXPLICITLY opposite finish is dropped.
          var nonfoil = /\bnon[\s-]?foil\b|\bnonfoil\b|\bnon[\s-]?holo\b/i.test(t);
          var isFoil = !nonfoil && /\bcold\s*foil\b|\brainbow\s*foil\b|\bfoil\b|\breverse\s*holo\b|\bholo(?:foil|graphic)?\b/i.test(t);
          if (finish === 'foil' && nonfoil) return false;
          if (finish === 'nonfoil' && isFoil) return false;
        }
        return true;
      });
    }
    var all = src.map(function (r) { return Object.assign({}, r, { delivered: r.price + (r.ship||0), known: r.ship != null, graded: isGraded(r) }); });
    var result = { mode: mode, nRaw: nRaw, nMatched: all.length, filtered: filtered, numbered: numbered, finish: finish, nTotal: all.length, nComparable: 0, rows: all, histogram: [], segments: {}, confidence: { level: 'low', score: 0, reasons: [] } };

    // comparable = raw, fixed-price, known delivered (what a buyer actually pays for the card).
    // Relax progressively if that's too thin, so a graded-only filter analyses the graded cluster
    // rather than coming up empty.
    var comparable = all.filter(function (r) { return r.known && !r.graded && !r.auction; });
    var basis = comparable;
    if (basis.length < 5) basis = all.filter(function (r) { return r.known && !r.graded; });   // + auctions
    if (basis.length < 5) basis = all.filter(function (r) { return r.known; });                 // + graded
    var prices = basis.map(function (r) { return r.delivered; }).sort(function (a,b){ return a-b; });
    var n = prices.length; result.nComparable = n;

    function seg(list){ var d = list.filter(function(r){return r.known;}).map(function(r){return r.delivered;}); return { n: list.length, median: d.length ? median(d) : null }; }
    result.segments = {
      raw: seg(all.filter(function(r){return !r.graded;})),
      graded: seg(all.filter(function(r){return r.graded;})),
      au: seg(all.filter(function(r){return r.loc === 'AU';})),
      ww: seg(all),
      auction: { n: all.filter(function(r){return r.auction;}).length },
      fixed: { n: all.filter(function(r){return !r.auction;}).length },
    };
    if (!n) return result;

    // histogram over [min, p95] (clip the long tail so a few high outliers don't swamp the bins)
    var lo = prices[0], hiClip = quantile(prices, 0.95) || prices[n-1], hi = Math.max(hiClip, lo + 0.01);
    var bins = Math.max(5, Math.min(14, Math.round(Math.sqrt(n)) * 2));
    var w = (hi - lo) / bins || 1;
    var hist = []; for (var i=0;i<bins;i++) hist.push({ lo: lo+i*w, hi: lo+(i+1)*w, count: 0, items: [] });
    prices.forEach(function (p) { var idx = Math.min(bins-1, Math.max(0, Math.floor((p-lo)/w))); hist[idx].count++; hist[idx].items.push(p); });

    var modeBin = hist.reduce(function(m,b){ return b.count > m.count ? b : m; }, hist[0]);
    var mi = hist.indexOf(modeBin);
    var clusterItems = modeBin.items.slice();
    [mi-1, mi+1].forEach(function (j) { if (hist[j] && hist[j].count >= modeBin.count * 0.5) clusterItems = clusterItems.concat(hist[j].items); });
    clusterItems.sort(function(a,b){return a-b;});
    var fair = median(clusterItems), clusterLo = clusterItems[0], clusterHi = clusterItems[clusterItems.length-1];
    var recommended = Math.max(0.5, Math.round((clusterLo - 0.01) * 100) / 100); // undercut cheapest IN-cluster

    result.histogram = hist.map(function (b) { return { lo: b.lo, hi: b.hi, count: b.count, inCluster: b.lo >= clusterLo - 1e-9 && b.hi <= clusterHi + w }; });
    result.fair = fair; result.fairRange = [clusterLo, clusterHi];
    result.recommended = recommended; result.cheapestInCluster = clusterLo;
    result.globalCheapest = prices[0]; result.globalMedian = median(prices);

    if (opts.ref && opts.ref.market != null) {
      var refAud = TCG.toAUD(+opts.ref.market, opts.ref.currency || 'USD');
      result.ref = { market: +opts.ref.market, currency: opts.ref.currency || 'USD', aud: refAud };
      if (refAud) result.refDelta = (fair - refAud) / refAud * 100;
    }

    // confidence: sample size + cluster tightness + sold-vs-asking + reference agreement
    var reasons = [], score = 0, clusterFrac = clusterItems.length / n;
    if (n >= 15) { score += 2; reasons.push(n + ' comparable listings'); }
    else if (n >= 6) { score += 1; reasons.push('only ' + n + ' comparable listings'); }
    else reasons.push('few comparable listings (' + n + ')');
    if (clusterFrac >= 0.5) { score += 2; reasons.push(Math.round(clusterFrac*100) + '% cluster tightly around the price'); }
    else if (clusterFrac >= 0.33) { score += 1; reasons.push('moderate clustering'); }
    else reasons.push('prices are spread out');
    if (mode === 'sold') { score += 2; reasons.push('based on SOLD prices'); } else reasons.push('asking prices, not sold');
    if (result.refDelta != null) {
      if (Math.abs(result.refDelta) <= 15) { score += 1; reasons.push('agrees with ' + (opts.refLabel||'reference') + ' price'); }
      else reasons.push('differs from ' + (opts.refLabel||'reference') + ' by ' + Math.round(result.refDelta) + '%');
    }
    if (result.segments.auction.n > result.segments.fixed.n) reasons.push('many auctions (volatile)');
    if (result.finish) reasons.push(result.finish === 'foil' ? 'foil only (non-foil removed)' : 'non-foil only (foil removed)');
    result.confidence = { level: score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low', score: score, reasons: reasons };
    return result;
  };

  // ---------- comps "pro" view: inline summary + expandable detail modal ----------
  var _lastComps = null;
  var MONO = 'font-family:ui-monospace,Menlo,Consolas,monospace;';
  function fmtDate(s){ try { return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; } }
  function confBadge(c){ var col = c.level === 'high' ? '#36d399' : c.level === 'medium' ? '#f0c020' : '#f06262';
    return '<span style="display:inline-block;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:' + col + ';border:1px solid ' + col + ';border-radius:999px;padding:2px 9px;">' + c.level + ' confidence</span>'; }

  function compHistogramSVG(a){
    var bins = a.histogram || []; if (!bins.length) return '';
    var W = 520, H = 168, padL = 8, padR = 8, padT = 14, padB = 26;
    var maxC = Math.max.apply(null, bins.map(function (b) { return b.count; })) || 1;
    var lo = bins[0].lo, hi = bins[bins.length-1].hi, span = (hi - lo) || 1;
    var plotW = W - padL - padR, plotH = H - padT - padB, bw = plotW / bins.length;
    var bars = bins.map(function (b, i) {
      var h = b.count ? Math.max(2, (b.count / maxC) * plotH) : 0, x = padL + i * bw, y = padT + plotH - h;
      var fill = b.inCluster ? 'var(--gold,#c8aa6e)' : 'rgba(255,255,255,.13)';
      return '<rect x="' + (x+1).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw-2).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + fill + '"><title>' + ebMoney(b.lo) + '–' + ebMoney(b.hi) + ': ' + b.count + '</title></rect>'
        + (b.count ? '<text x="' + (x+bw/2).toFixed(1) + '" y="' + (y-3).toFixed(1) + '" text-anchor="middle" font-size="9" fill="var(--muted,#888)">' + b.count + '</text>' : '');
    }).join('');
    function mark(v, color, label){ if (v == null || v < lo || v > hi) return ''; var x = padL + ((v-lo)/span) * plotW;
      return '<line x1="' + x.toFixed(1) + '" y1="' + padT + '" x2="' + x.toFixed(1) + '" y2="' + (padT+plotH) + '" stroke="' + color + '" stroke-width="1.5" stroke-dasharray="3,3"/>'
        + '<text x="' + x.toFixed(1) + '" y="' + (padT+plotH+11) + '" text-anchor="middle" font-size="9" fill="' + color + '">' + label + '</text>'; }
    var markers = mark(a.fair, 'var(--gold,#c8aa6e)', 'fair') + (a.ref && a.ref.aud ? mark(a.ref.aud, '#5aa9ff', 'ref') : '');
    var axis = '<text x="' + padL + '" y="' + (H-4) + '" font-size="9" fill="var(--muted,#888)">' + ebMoney(lo) + '</text><text x="' + (W-padR) + '" y="' + (H-4) + '" text-anchor="end" font-size="9" fill="var(--muted,#888)">' + ebMoney(hi) + '</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block;">' + bars + markers + axis + '</svg>';
  }

  function compScatterSVG(a){
    var pts = (a.rows || []).filter(function (r) { return r.known && r.created; });
    if (pts.length < 2) return '<div style="font-size:11px;color:var(--muted,#888);">Not enough dated listings to plot over time.</div>';
    var W = 520, H = 180, padL = 8, padR = 8, padT = 10, padB = 22;
    var ts = pts.map(function (r) { return +new Date(r.created); });
    var tMin = Math.min.apply(null, ts), tMax = Math.max.apply(null, ts), tSpan = (tMax - tMin) || 1;
    var ys = pts.map(function (r) { return r.delivered; });
    var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys), ySpan = (yMax - yMin) || 1;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    function X(t){ return padL + ((t - tMin) / tSpan) * plotW; } function Y(v){ return padT + plotH - ((v - yMin) / ySpan) * plotH; }
    var dots = pts.map(function (r) {
      var x = X(+new Date(r.created)), y = Y(r.delivered), color = r.graded ? '#5aa9ff' : 'var(--gold,#c8aa6e)';
      var ring = r.loc === 'AU' ? '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5.5" fill="none" stroke="' + color + '" stroke-opacity=".35"/>' : '';
      return ring + '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="' + (r.auction ? 'none' : color) + '" stroke="' + color + '" stroke-width="1.2"><title>' + ebMoney(r.delivered) + ' · ' + esc(r.cond||'') + ' · ' + fmtDate(r.created) + '</title></circle>';
    }).join('');
    var fairLine = (a.fair != null && a.fair >= yMin && a.fair <= yMax) ? '<line x1="' + padL + '" y1="' + Y(a.fair).toFixed(1) + '" x2="' + (W-padR) + '" y2="' + Y(a.fair).toFixed(1) + '" stroke="var(--gold,#c8aa6e)" stroke-width="1" stroke-dasharray="2,3" opacity=".6"/>' : '';
    var axis = '<text x="' + padL + '" y="' + (H-4) + '" font-size="9" fill="var(--muted,#888)">' + fmtDate(tMin) + '</text><text x="' + (W-padR) + '" y="' + (H-4) + '" text-anchor="end" font-size="9" fill="var(--muted,#888)">' + fmtDate(tMax) + '</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block;">' + fairLine + dots + axis + '</svg>';
  }

  function renderCompsPro(el, a, ctx){
    if (!el) return; ctx = ctx || {}; _lastComps = { analysis: a, ctx: ctx };
    var box = 'border:1px solid var(--line,#333);border-radius:12px;padding:14px;background:var(--panel2,#1a1a1a);';
    var head = 'font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted,#888);font-weight:700;';
    if (a.fair == null) { el.innerHTML = '<div style="' + box + '"><div style="' + head + '">eBay comps</div><div style="font-size:12px;color:var(--muted,#888);margin-top:6px;">' + a.nTotal + ' listings, but none comparable (raw · fixed-price · known postage) to price from.</div></div>'; return; }
    var modePill = '<span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;border-radius:999px;padding:2px 8px;white-space:nowrap;border:1px solid ' + (a.mode === 'sold' ? '#36d399' : '#f0c020') + ';color:' + (a.mode === 'sold' ? '#36d399' : '#f0c020') + ';">' + (a.mode === 'sold' ? 'sold' : 'asking · not sold') + '</span>';
    var html = '<div style="' + box + '"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">'
      + '<div><div style="' + head + '">eBay market analysis · AUD</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px;">' + a.nComparable + ' comparable' + (a.filtered ? ' · matched ' + a.nMatched + ' of ' + a.nRaw + (a.numbered ? ' for this exact card' : ' for this card') : ' of ' + a.nTotal) + '</div></div>'
      + '<div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end;">' + confBadge(a.confidence) + modePill + '</div></div>';
    if (a.confidence && a.confidence.reasons && a.confidence.reasons.length)
      html += '<div style="font-size:11px;color:var(--muted,#888);margin-top:8px;line-height:1.5;">' + a.confidence.reasons.map(function (x) { return esc(x); }).join(' · ') + '</div>';
    if (ctx.filterOptions && ctx.filterOptions.length) {
      html += '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">' + ctx.filterOptions.map(function (o) {
        var on = o.key === ctx.filterKey;
        return '<button class="comps-filter" data-key="' + o.key + '" style="font-size:11px;padding:3px 10px;border-radius:999px;cursor:pointer;font-weight:700;border:1px solid ' + (on ? 'var(--gold,#c8aa6e)' : 'var(--line,#333)') + ';background:' + (on ? 'rgba(200,170,110,.12)' : 'transparent') + ';color:' + (on ? 'var(--gold,#c8aa6e)' : 'var(--muted,#888)') + ';">' + esc(o.label) + '</button>';
      }).join('') + '</div>';
    }
    html += '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end;margin-top:12px;">'
      + '<div><div style="' + head + 'margin-bottom:2px;">List at</div><div style="' + MONO + 'font-size:30px;font-weight:800;color:var(--gold,#c8aa6e);line-height:1;">' + ebMoney(a.recommended) + '</div></div>'
      + '<div style="font-size:12px;color:var(--text,#eee);line-height:1.55;"><div>fair value <b style="' + MONO + '">' + ebMoney(a.fair) + '</b> <span style="color:var(--muted,#888);">(cluster ' + ebMoney(a.fairRange[0]) + '–' + ebMoney(a.fairRange[1]) + ')</span></div>'
      + '<div style="color:var(--muted,#888);">cheapest ' + ebMoney(a.globalCheapest) + ' · median ' + ebMoney(a.globalMedian) + '</div>'
      + (a.ref && a.ref.aud ? '<div style="color:var(--muted,#888);">ref ' + esc(ctx.refLabel||'') + ' ' + ebMoney(a.ref.aud) + (a.refDelta != null ? ' · fair ' + (a.refDelta > 0 ? '+' : '') + Math.round(a.refDelta) + '%' : '') + '</div>' : '')
      + '</div></div>';
    html += '<div style="margin-top:12px;">' + compHistogramSVG(a) + '</div>';
    if (a.globalCheapest != null && a.globalCheapest < a.fairRange[0] * 0.8)
      html += '<div style="font-size:11.5px;color:var(--amber,#f0c020);margin-top:8px;">⚠ cheapest (' + ebMoney(a.globalCheapest) + ') sits below the main cluster — likely an outlier or condition difference, not the market. Price to the cluster, not the floor.</div>';
    html += '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;"><button id="comps-detail" style="padding:8px 13px;border:1px solid var(--gold,#c8aa6e);background:transparent;color:var(--gold,#c8aa6e);border-radius:8px;font-weight:700;font-size:12.5px;cursor:pointer;">📊 Distribution &amp; detail</button>';
    if (ctx.card && ctx.card.identity_key) html += '<button id="comps-save" style="padding:8px 13px;border:1px solid var(--line,#333);background:transparent;color:var(--muted,#888);border-radius:8px;font-weight:700;font-size:12.5px;cursor:pointer;">＋ Save fair value to tracker</button>';
    html += '</div></div>';
    el.innerHTML = html;
    var d = el.querySelector('#comps-detail'); if (d) d.addEventListener('click', TCG.openCompsModal);
    var s = el.querySelector('#comps-save'); if (s) s.addEventListener('click', function () { saveCompToTracker(s); });
    if (ctx._opts) el.querySelectorAll('.comps-filter').forEach(function (b) {
      b.addEventListener('click', function () { TCG.ebayComps(Object.assign({}, ctx._opts, { filterKey: b.getAttribute('data-key') })); });
    });
  }

  TCG.openCompsModal = function(){
    if (!_lastComps) return; var a = _lastComps.analysis, ctx = _lastComps.ctx || {}, card = ctx.card || {};
    if (a.fair == null) return; // no priceable cluster — renderCompsPro shows the inline note instead
    var ex = document.getElementById('comps-modal'); if (ex) ex.remove();
    var head = 'font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted,#888);font-weight:700;';
    var seg = a.segments;
    function chip(label, s){ if (!s || !s.n) return ''; return '<span style="font-size:11px;border:1px solid var(--line,#333);border-radius:999px;padding:3px 9px;color:var(--text,#eee);">' + label + ' <b>' + s.n + '</b>' + (s.median != null ? ' · ' + ebMoney(s.median) : '') + '</span>'; }
    var rowsTop = (a.rows || []).filter(function (r) { return r.known; }).sort(function (x,y){ return x.delivered - y.delivered; }).slice(0, 14);
    var table = rowsTop.map(function (r) {
      var badges = (r.graded ? '<span style="color:#5aa9ff;">graded</span> ' : '') + (r.auction ? '<span style="color:var(--muted,#888);">auction</span>' : '');
      return '<tr style="border-top:1px solid var(--line,#333);"><td style="padding:4px 6px;' + MONO + 'font-weight:700;color:var(--gold,#c8aa6e);">' + ebMoney(r.delivered) + '</td><td style="padding:4px 6px;color:var(--muted,#888);font-size:11px;">' + ebMoney(r.price) + '+' + ebMoney(r.ship||0) + '</td><td style="padding:4px 6px;font-size:11px;">' + esc((r.cond||'').slice(0,14)) + ' ' + badges + '</td><td style="padding:4px 6px;font-size:11px;color:var(--muted,#888);">' + esc(r.loc||'?') + '</td><td style="padding:4px 6px;font-size:11px;color:var(--muted,#888);">' + (r.created ? fmtDate(r.created) : '') + '</td><td style="padding:4px 6px;">' + (r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener" style="color:var(--gold,#c8aa6e);">↗</a>' : '') + '</td></tr>';
    }).join('');
    var ov = document.createElement('div'); ov.id = 'comps-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.62);backdrop-filter:blur(3px);display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow:auto;';
    var d = '<div style="max-width:720px;width:100%;background:var(--panel,#141414);border:1px solid var(--gold,#c8aa6e);border-radius:16px;padding:20px 22px;box-shadow:0 24px 70px rgba(0,0,0,.55);">';
    d += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;"><div><div style="font-size:18px;font-weight:800;color:var(--text,#eee);">Market analysis</div><div style="font-size:12px;color:var(--muted,#888);">' + esc(card.name || ctx.query || 'card') + '</div></div><button id="comps-x" style="background:none;border:1px solid var(--line,#333);color:var(--muted,#888);border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;">✕</button></div>';
    d += '<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-end;margin:16px 0;padding-bottom:14px;border-bottom:1px solid var(--line,#333);"><div><div style="' + head + '">Recommended list price</div><div style="' + MONO + 'font-size:34px;font-weight:800;color:var(--gold,#c8aa6e);line-height:1.05;">' + ebMoney(a.recommended) + '</div><div style="font-size:11px;color:var(--muted,#888);">undercuts cheapest in-cluster (' + ebMoney(a.cheapestInCluster) + ')</div></div><div style="font-size:12.5px;color:var(--text,#eee);line-height:1.6;"><div>fair value <b style="' + MONO + '">' + ebMoney(a.fair) + '</b> · cluster ' + ebMoney(a.fairRange[0]) + '–' + ebMoney(a.fairRange[1]) + '</div><div style="color:var(--muted,#888);">cheapest ' + ebMoney(a.globalCheapest) + ' · median ' + ebMoney(a.globalMedian) + '</div><div style="margin-top:4px;">' + confBadge(a.confidence) + '</div></div></div>';
    d += '<div style="' + head + 'margin-bottom:6px;">Price distribution <span style="text-transform:none;font-weight:400;color:var(--muted,#888);">— ' + a.nComparable + ' comparable (raw · fixed-price); gold = main cluster</span></div>' + compHistogramSVG(a);
    d += '<div style="' + head + 'margin:16px 0 6px;">Listings over time <span style="text-transform:none;font-weight:400;color:var(--muted,#888);">— delivered price by date listed</span></div>' + compScatterSVG(a);
    d += '<div style="font-size:10.5px;color:var(--muted,#888);margin-top:4px;"><span style="color:var(--gold,#c8aa6e);">●</span> raw &nbsp; <span style="color:#5aa9ff;">●</span> graded &nbsp; ○ auction &nbsp; ◌ ring = AU seller</div>';
    d += '<div style="' + head + 'margin:16px 0 8px;">Breakdown</div><div style="display:flex;gap:8px;flex-wrap:wrap;">' + chip('Raw', seg.raw) + chip('Graded', seg.graded) + chip('🇦🇺 AU', seg.au) + chip('🌏 All', seg.ww) + (seg.auction.n ? '<span style="font-size:11px;border:1px solid var(--line,#333);border-radius:999px;padding:3px 9px;color:var(--muted,#888);">auctions <b>' + seg.auction.n + '</b></span>' : '') + '</div>';
    d += '<div style="' + head + 'margin:16px 0 6px;">Why this confidence</div><ul style="margin:0;padding-left:18px;font-size:12px;color:var(--text,#eee);line-height:1.6;">' + a.confidence.reasons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    d += '<div style="font-size:11px;color:var(--muted,#888);margin-top:12px;line-height:1.5;">Source: eBay ' + (a.mode === 'sold' ? 'Marketplace Insights (sold)' : 'Browse (current asking)') + ', AU marketplace · delivered = item + postage.' + (a.mode !== 'sold' ? ' Sold history needs eBay Marketplace Insights access.' : '') + (a.ref && a.ref.aud ? ' Reference ' + esc(ctx.refLabel||'API') + ' ' + ebMoney(a.ref.aud) + '.' : '') + (a.filtered ? ' Narrowed to ' + (a.numbered ? 'this exact card (number-matched; ' : 'this card (') + 'accessories, lots & other languages removed): ' + a.nMatched + ' of ' + a.nRaw + ' listings.' : '') + '</div>';
    d += '<div style="' + head + 'margin:16px 0 6px;">Cheapest listings</div><div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="text-align:left;color:var(--muted,#888);font-size:10px;text-transform:uppercase;"><th style="padding:0 6px;">Delivered</th><th style="padding:0 6px;">Item+ship</th><th style="padding:0 6px;">Condition</th><th style="padding:0 6px;">Loc</th><th style="padding:0 6px;">Listed</th><th></th></tr></thead><tbody>' + table + '</tbody></table></div>';
    d += '<div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end;">' + (card.identity_key ? '<button id="comps-save2" style="padding:9px 14px;border:1px solid var(--gold,#c8aa6e);background:transparent;color:var(--gold,#c8aa6e);border-radius:8px;font-weight:700;font-size:12.5px;cursor:pointer;">＋ Save fair value to tracker</button>' : '') + '<button id="comps-close" style="padding:9px 14px;border:1px solid var(--line,#333);background:transparent;color:var(--muted,#888);border-radius:8px;font-weight:700;font-size:12.5px;cursor:pointer;">Close</button></div>';
    d += '</div>';
    ov.innerHTML = d; document.body.appendChild(ov);
    function close(){ ov.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e){ if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#comps-x').addEventListener('click', close);
    ov.querySelector('#comps-close').addEventListener('click', close);
    var s2 = ov.querySelector('#comps-save2'); if (s2) s2.addEventListener('click', function () { saveCompToTracker(s2); });
  };

  async function saveCompToTracker(btn){
    if (!_lastComps || !_lastComps.ctx || !_lastComps.ctx.card) return;
    var a = _lastComps.analysis, card = _lastComps.ctx.card; if (a.fair == null) return;
    btn.textContent = 'Saving…'; btn.disabled = true;
    try {
      var r = await fetch('/api/tracker/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ game: card.game, identity_key: card.identity_key, name: card.name, variant: card.variant || '', market: Math.round(a.fair*100)/100, currency: 'AUD', source: 'ebay', sample_size: a.nComparable }) });
      btn.textContent = r.ok ? 'Saved to tracker ✓' : 'Save failed';
    } catch (e) { btn.textContent = 'Save failed'; }
    setTimeout(function () { btn.disabled = false; }, 500);
  }

  // TCG.ebayComps({ query, container, status }) -> renders delivered comps; returns {count,mode,cheapestDelivered}.
  TCG.ebayComps = async function (opts) {
    opts = opts || {};
    var q = (opts.query || '').trim(), el = opts.container, st = opts.status, act = null;
    function S(cls, msg){ if (st) { st.className = 'status ' + cls; st.textContent = msg; }
      if (act) { var m = msg.replace(/^[✓✕]\s*/, ''); cls === 'ok' ? act.done(m) : (cls === 'warn' || cls === 'err') ? act.fail(m) : act.update(m); } }
    if (!q) { S('warn', 'Look up or enter a card first.'); return; }
    // filter: either a fixed opts.filter (e.g. Funko "conditions:{NEW}"), or a toggleable
    // set of opts.filterOptions [{key,label,filter}] with opts.filterKey selecting the active one.
    var activeFilterKey = null, filt = '';
    if (opts.filterOptions && opts.filterOptions.length) {
      activeFilterKey = opts.filterKey || opts.filterOptions[0].key;
      var fo = opts.filterOptions.filter(function (o) { return o.key === activeFilterKey; })[0] || opts.filterOptions[0];
      filt = fo.filter ? '&filter=' + encodeURIComponent(fo.filter) : '';
    } else {
      filt = opts.filter ? '&filter=' + encodeURIComponent(opts.filter) : '';
    }
    act = TCG.activity('Searching eBay…');
    S('load', 'Searching eBay comps…');
    try {
      var rows = null, mode = 'asking';
      if (!ebaySoldOff) {
        try {
          var rs = await fetch('/api/ebay/buy/marketplace_insights/v1_beta/item_sales/search?limit=50&q=' + encodeURIComponent(q) + filt);
          if (rs.ok) { var js = await rs.json(); rows = (js.itemSales || []).map(ebNormSold).filter(Boolean); mode = 'sold'; }
          else { ebaySoldOff = true; try { await rs.text(); } catch (_) {} }   // drain body; 403 invalid_scope -> no Insights access
        } catch (e) { ebaySoldOff = true; }
      }
      if (!rows) {
        // analyze mode pulls more results (eBay Browse is free) for a real distribution
        var lim = opts.analyze ? 200 : 50;
        var rb = await fetch('/api/ebay/buy/browse/v1/item_summary/search?limit=' + lim + '&q=' + encodeURIComponent(q) + filt);
        if (rb.status === 503) { S('warn', 'eBay keys not set in .env (EBAY_APP_ID/EBAY_CERT_ID). Pricing skipped.'); return; }
        if (!rb.ok) { var d = ''; try { var ej = await rb.json(); d = ej.detail || ej.error || ''; } catch (e) {} S('warn', 'eBay lookup failed (' + rb.status + ')' + (d ? ': ' + d : '') + '. Fields still work.'); return; }
        var jb = await rb.json(); rows = (jb.itemSummaries || []).map(ebNormAsk).filter(Boolean); mode = 'asking';
      }
      if (!rows.length) { S('warn', 'No eBay comps for "' + q + '".'); if (el) el.innerHTML = ''; return; }
      if (opts.analyze) {
        var analysis = TCG.analyzeComps(rows, { mode: mode, ref: opts.ref, refLabel: opts.refLabel, precision: opts.precision, numberMatch: opts.numberMatch, finish: opts.finish, lang: opts.lang });
        renderCompsPro(el, analysis, { card: opts.card, refLabel: opts.refLabel, query: q, filterOptions: opts.filterOptions, filterKey: activeFilterKey, _opts: opts });
        S('ok', '✓ ' + rows.length + ' comps · fair value ' + (analysis.fair != null ? ebMoney(analysis.fair) : 'n/a') + (analysis.confidence ? ' (' + analysis.confidence.level + ' confidence)' : ''));
        return { count: rows.length, mode: mode, analysis: analysis };
      }
      renderEbayComps(el, rows, mode);
      var cheap = rows.filter(function (r) { return r.ship != null; }).map(function (r) { return r.price + r.ship; }).sort(function (a, b) { return a - b; })[0];
      S('ok', '✓ ' + rows.length + ' eBay ' + (mode === 'sold' ? 'sold' : 'asking') + ' comps' + (cheap != null ? ' · cheapest delivered ' + ebMoney(cheap) : ''));
      return { count: rows.length, mode: mode, cheapestDelivered: cheap };
    } catch (e) { S('err', 'eBay lookup blocked (proxy not running?).'); }
  };

  // MIRROR: condCode/langCode/fitTitle are ported verbatim in lib/listing-copy.mjs
  // (the bulk tool's shared copy — classic scripts can't import ESM). If you edit
  // any of the three, edit BOTH sides and run scripts/check-listing-copy.mjs.
  TCG.condCode=function(s){
    s=(s||'').trim();var l=s.toLowerCase();
    var g=l.match(/(psa|cgc|bgs|sgc)\s*([0-9]+(?:\.5)?)/);
    if(g)return g[1].toUpperCase()+' '+g[2];
    if(/near\s*mint|\bnm\b/.test(l))return 'M/NM';
    if(/\bmint\b|^m$/.test(l))return 'M';
    if(/lightly\s*played|\blp\b/.test(l))return 'LP';
    if(/moderately\s*played|\bmp\b/.test(l))return 'MP';
    if(/heavily\s*played|\bhp\b/.test(l))return 'HP';
    if(/damaged|\bdmg\b|\bpoor\b/.test(l))return 'DMG';
    if(/excellent|\bex\b/.test(l))return 'EX';
    return (s.split(/[\s,]+/)[0]||'').toUpperCase();
  };
  TCG.langCode=function(s){
    var l=(s||'').trim().toLowerCase().replace(/\s*\(.*$/,'');   // "Chinese (Simp.)" -> "chinese"
    var map={english:'EN',japanese:'JP',chinese:'ZH',korean:'KO',german:'DE',french:'FR',italian:'IT',spanish:'ES',portuguese:'PT',russian:'RU'};
    if(map[l])return map[l];
    if(!s)return 'EN';
    return s.length<=3?s.toUpperCase():s.slice(0,2).toUpperCase();
  };
  TCG.fitTitle=function(parts,max){
    max=max||80;
    parts=(parts||[]).filter(function(p){return p&&p.text!=null&&(''+p.text).trim()!=='';});
    function join(ps){return ps.map(function(p){return (''+p.text).trim();}).filter(Boolean).join(' ').replace(/\s+/g,' ').trim();}
    var cur=parts.map(function(p){return Object.assign({},p);});
    if(join(cur).length<=max)return join(cur);
    cur=parts.map(function(p){return Object.assign({},p,{text:(p.abbr!=null?p.abbr:p.text)});});
    if(join(cur).length<=max)return join(cur);
    cur=cur.filter(function(p){return p.text!=null&&(''+p.text).trim()!=='';});
    while(join(cur).length>max&&cur.length>1){
      var idx=-1,lo=Infinity;
      cur.forEach(function(p,i){var pr=(p.prio==null?50:p.prio);if(pr<lo){lo=pr;idx=i;}});
      if(idx<0)break;cur.splice(idx,1);
    }
    var out=join(cur);
    if(out.length>max)out=out.slice(0,max).trim();
    return out;
  };

  // --- collectibles helpers (LEGO / Funko) — condCode() above stays card-only ---
  function esc(s){return (''+(s==null?'':s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function copyToClipboard(text,btn){
    function ok(){ if(btn){var t=btn.textContent;btn.textContent='Copied!';setTimeout(function(){btn.textContent=t;},1200);} }
    function fb(){var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);ok();}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(ok).catch(fb);}else fb();
  }

  // LEGO condition enum -> compact title token.
  TCG.legoCondToken=function(s){
    var l=(s||'').toLowerCase();
    if(/seal|misb/.test(l))return 'New Sealed';
    if(/\bnew\b/.test(l))return 'New';
    if(/incomplete/.test(l))return 'Used Incomplete';
    if(/used|complete/.test(l))return 'Used Complete';
    return (s||'').trim();
  };

  // Funko condition -> title token. Graded grade wins; else box grade; else Loose.
  // o = { grade, oob, boxcond, protector }
  TCG.funkoCondToken=function(o){
    o=o||{};
    if(o.grade && (''+o.grade).trim())return (''+o.grade).trim();   // e.g. "UKG 85"
    var tok;
    if(o.oob){ tok='Loose'; }
    else{
      var b=(o.boxcond||'').toLowerCase();
      tok=/near|\bnm\b/.test(b)?'NM Box':/mint/.test(b)?'Mint Box':/good/.test(b)?'Good Box':/damag/.test(b)?'Damaged Box':(o.boxcond||'').trim();
    }
    if(o.protector)tok=(tok?tok+' ':'')+'w/ Protector';
    return tok;
  };

  // Renders an eBay item-specifics name/value list + a Copy button that yields
  // tab-separated "name<TAB>value" lines (easy to paste into eBay's fields).
  // pairs = [[name, value], ...]; empty values are dropped.
  TCG.renderItemSpecifics=function(el,pairs){
    if(!el)return;
    var rows=(pairs||[]).filter(function(p){return p&&p[1]!=null&&(''+p[1]).trim()!=='';});
    if(!rows.length){el.innerHTML='';return;}
    var box='border:1px solid var(--line,#333);border-radius:12px;padding:14px;background:var(--panel2,#1a1a1a);margin-bottom:14px;';
    var head='font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted,#888);font-weight:700;';
    var html='<div style="'+box+'"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><div style="'+head+'">eBay item specifics</div>'+
      '<button id="tcg-is-copy" style="padding:5px 11px;border:1px solid var(--gold,#c8aa6e);background:transparent;color:var(--gold,#c8aa6e);border-radius:7px;font-weight:700;font-size:11.5px;cursor:pointer;">Copy</button></div>';
    rows.forEach(function(p){
      html+='<div style="display:flex;justify-content:space-between;gap:14px;padding:5px 0;font-size:13px;border-top:1px solid var(--line,#333);"><span style="color:var(--muted,#888);">'+esc(p[0])+'</span><span style="font-weight:600;text-align:right;">'+esc(p[1])+'</span></div>';
    });
    html+='</div>';
    el.innerHTML=html;
    var btn=el.querySelector('#tcg-is-copy');
    if(btn)btn.addEventListener('click',function(){copyToClipboard(rows.map(function(p){return p[0]+'\t'+p[1];}).join('\n'),btn);});
  };

  // TCG.setCombobox(opts) — a filterable dropdown with a per-row icon (a reusable version of the
  // Pokémon set picker, so any builder can show set symbols — native <select>/<datalist> can't).
  // Markup: an <input> + an (empty) menu element, both inside a position:relative wrapper.
  //   opts.input  : the typing/display field (HTMLInputElement)
  //   opts.menu   : the (empty) dropdown container (HTMLElement) — gets class 'tcg-cb-menu'
  //   opts.items  : array OR () => array of { value, label, code?, icon? } (read fresh each open,
  //                 so data loaded after init shows up without re-wiring)
  //   opts.onPick : (item) => void
  //   opts.display: optional (item) => string put in the input on pick (defaults to item.label)
  //   opts.limit  : max rows rendered (default 40)
  // Returns { refresh, open, close }. Self-themes via the host page's --gold/--line/--field vars.
  TCG.setCombobox = function (opts) {
    var input = opts.input, menu = opts.menu;
    if (!input || !menu) return null;
    var getItems = typeof opts.items === 'function' ? opts.items : function () { return opts.items || []; };
    var onPick = opts.onPick || function () {};
    var toDisplay = opts.display || function (it) { return it.label; };
    var limit = opts.limit || 40;
    injectCss();
    menu.classList.add('tcg-cb-menu');
    var active = -1, shown = [];

    function norm(s) { return (s == null ? '' : '' + s).toLowerCase(); }
    function filter(q) {
      q = norm(q).trim();
      var items = getItems() || [], out = [];
      for (var i = 0; i < items.length && out.length < limit; i++) {
        var it = items[i];
        if (!q || norm(it.label).indexOf(q) >= 0 || norm(it.code).indexOf(q) >= 0 || norm(it.value).indexOf(q) >= 0) out.push(it);
      }
      return out;
    }
    function render(q) {
      shown = filter(q); active = -1;
      if (!shown.length) { menu.classList.remove('open'); menu.innerHTML = ''; return; }
      var h = '';
      for (var i = 0; i < shown.length; i++) {
        var it = shown[i];
        var icon = it.icon ? '<img src="' + esc(it.icon) + '" alt="" loading="lazy">' : '<span class="tcg-cb-ico"></span>';
        var code = it.code ? '<span class="tcg-cb-code">' + esc(it.code) + '</span>' : '';
        h += '<div class="tcg-cb-opt" data-i="' + i + '">' + icon + '<span class="tcg-cb-lbl">' + esc(it.label) + '</span>' + code + '</div>';
      }
      menu.innerHTML = h; menu.classList.add('open');
      var rows = menu.querySelectorAll('.tcg-cb-opt');
      for (var j = 0; j < rows.length; j++) {
        rows[j].addEventListener('mousedown', function (e) { e.preventDefault(); pick(shown[+this.getAttribute('data-i')]); });
      }
    }
    function mark() {
      var rows = menu.querySelectorAll('.tcg-cb-opt');
      for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('on', i === active);
      if (active >= 0 && rows[active]) rows[active].scrollIntoView({ block: 'nearest' });
    }
    function pick(it) { if (!it) return; input.value = toDisplay(it); menu.classList.remove('open'); onPick(it); }
    function open() { render(input.value); }
    function close() { menu.classList.remove('open'); }

    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('focus', function () { render(input.value); });
    input.addEventListener('blur', function () { setTimeout(close, 150); });
    input.addEventListener('keydown', function (e) {
      if (!menu.classList.contains('open')) { if (e.key === 'ArrowDown') render(input.value); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); mark(); }
      else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(shown[active]); } }
      else if (e.key === 'Escape') { close(); }
    });

    return { refresh: function () { if (document.activeElement === input) render(input.value); }, open: open, close: close };

    function injectCss() {
      if (document.getElementById('tcg-cb-css')) return;
      var s = document.createElement('style'); s.id = 'tcg-cb-css';
      s.textContent =
        '.tcg-cb-menu{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:60;background:var(--panel2,#171b25);' +
        'border:1px solid var(--line,#333);border-radius:10px;max-height:300px;overflow:auto;display:none;box-shadow:0 12px 28px rgba(0,0,0,.45);}' +
        '.tcg-cb-menu.open{display:block;}' +
        '.tcg-cb-opt{display:flex;align-items:center;gap:10px;padding:8px 11px;cursor:pointer;font-size:13px;color:var(--text,#eee);}' +
        '.tcg-cb-opt:hover,.tcg-cb-opt.on{background:rgba(255,255,255,.07);}' +
        '.tcg-cb-opt img{width:24px;height:24px;flex:none;object-fit:contain;border-radius:5px;background:#e9ebf0;padding:2px;}' +
        '.tcg-cb-opt .tcg-cb-ico{width:24px;flex:none;}' +
        '.tcg-cb-lbl{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.tcg-cb-code{font-size:11px;color:var(--muted,#8a8f9c);text-transform:uppercase;font-weight:700;flex:none;}';
      document.head.appendChild(s);
    }
  };
})();
