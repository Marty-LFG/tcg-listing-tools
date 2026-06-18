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
      const b = await r.blob(); const o = URL.createObjectURL(b);
      const a = document.createElement('a'); a.href = o; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(o), 3000);
    } catch (e) { window.open(url, '_blank'); }
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
    if (!hasImg && !prices.length) { container.innerHTML = ''; return; }

    const box = 'border:1px solid var(--line,#333);border-radius:12px;padding:14px;background:var(--panel2,#1a1a1a);';
    const head = 'font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted,#888);font-weight:700;margin-bottom:10px;';
    let html = '';

    if (hasImg) {
      html += `<div style="${box}margin-bottom:14px;"><div style="${head}">Card image</div><div style="display:flex;gap:14px;flex-wrap:wrap;">`;
      imgs.forEach(function (p, idx) {
        var ext = (p.dl.match(/\.(png|jpe?g|webp)(?:\?|$)/i) || [])[1] || 'png';
        html += `<div style="text-align:center;">
          <img id="tcg-img-${idx}" src="${p.disp[0] || p.dl}" alt="${esc(p.label)}" loading="lazy" data-disp="${encodeURIComponent(JSON.stringify(p.disp))}" style="width:150px;max-width:42vw;border-radius:8px;display:block;border:1px solid var(--line,#333);background:var(--field,#111);min-height:60px;">
          <button class="tcg-dl" data-url="${encodeURIComponent(p.dl)}" data-fn="${name}-${(p.label||'art').toLowerCase()}.${ext}" style="margin-top:8px;width:100%;padding:6px;border:1px solid var(--gold,#c8aa6e);background:transparent;color:var(--gold,#c8aa6e);border-radius:7px;font-weight:700;font-size:12px;cursor:pointer;" title="Downloads best available quality">&#8595; ${esc(p.label)} <span style="opacity:.55;font-weight:400;">HQ</span></button>
        </div>`;
      });
      html += '</div></div>';
    }

    if (prices.length) {
      html += `<div style="${box}"><div style="${head}">Pricing</div><div id="tcg-prices"></div>`;
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
        if (pr) pr.innerHTML = prices.map(p => {
          const aud = TCG.toAUD(+p.amount, p.currency);
          return `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;"><span style="color:var(--muted,#888);">${p.label}</span><span style="font-weight:600;">${money(+p.amount, p.currency)}${aud != null ? ' <span style="color:var(--muted,#888);font-weight:400;">&asymp; ' + money(aud, 'AUD') + '</span>' : ''}</span></div>`;
        }).join('');
        const amt = container.querySelector('#tcg-amt'), from = container.querySelector('#tcg-from'),
              out = container.querySelector('#tcg-out'), rate = container.querySelector('#tcg-rate');
        const seed = prices[0];
        if (amt && seed) { amt.value = (+seed.amount).toFixed(2); from.value = seed.currency; }
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
  function ebNormAsk(it){ var price = it.price && parseFloat(it.price.value); if (!(price > 0)) return null;
    return { price: price, ship: ebShip(it.shippingOptions), loc: (it.itemLocation && it.itemLocation.country) || '?', title: it.title || '', url: it.itemWebUrl || '' }; }
  function ebNormSold(s){ var lp = s.lastSoldPrice, price = lp && parseFloat(lp.value); if (!(price > 0)) return null;
    return { price: price, ship: ebShip(s.shippingOptions), loc: (s.itemLocation && s.itemLocation.country) || '?', title: s.title || '', url: s.itemWebUrl || '' }; }

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

  // TCG.ebayComps({ query, container, status }) -> renders delivered comps; returns {count,mode,cheapestDelivered}.
  TCG.ebayComps = async function (opts) {
    opts = opts || {};
    var q = (opts.query || '').trim(), el = opts.container, st = opts.status, act = null;
    function S(cls, msg){ if (st) { st.className = 'status ' + cls; st.textContent = msg; }
      if (act) { var m = msg.replace(/^[✓✕]\s*/, ''); cls === 'ok' ? act.done(m) : (cls === 'warn' || cls === 'err') ? act.fail(m) : act.update(m); } }
    if (!q) { S('warn', 'Look up or enter a card first.'); return; }
    var filt = opts.filter ? '&filter=' + encodeURIComponent(opts.filter) : '';   // e.g. "conditions:{NEW}" for Funko
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
        var rb = await fetch('/api/ebay/buy/browse/v1/item_summary/search?limit=50&q=' + encodeURIComponent(q) + filt);
        if (rb.status === 503) { S('warn', 'eBay keys not set in .env (EBAY_APP_ID/EBAY_CERT_ID). Pricing skipped.'); return; }
        if (!rb.ok) { var d = ''; try { var ej = await rb.json(); d = ej.detail || ej.error || ''; } catch (e) {} S('warn', 'eBay lookup failed (' + rb.status + ')' + (d ? ': ' + d : '') + '. Fields still work.'); return; }
        var jb = await rb.json(); rows = (jb.itemSummaries || []).map(ebNormAsk).filter(Boolean); mode = 'asking';
      }
      if (!rows.length) { S('warn', 'No eBay comps for "' + q + '".'); if (el) el.innerHTML = ''; return; }
      renderEbayComps(el, rows, mode);
      var cheap = rows.filter(function (r) { return r.ship != null; }).map(function (r) { return r.price + r.ship; }).sort(function (a, b) { return a - b; })[0];
      S('ok', '✓ ' + rows.length + ' eBay ' + (mode === 'sold' ? 'sold' : 'asking') + ' comps' + (cheap != null ? ' · cheapest delivered ' + ebMoney(cheap) : ''));
      return { count: rows.length, mode: mode, cheapestDelivered: cheap };
    } catch (e) { S('err', 'eBay lookup blocked (proxy not running?).'); }
  };

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
    var l=(s||'').trim().toLowerCase();
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
})();
