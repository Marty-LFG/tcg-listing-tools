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
    const hasImg = data.images && data.images.filter(i => i && i.url).length;
    const prices = (data.prices || []).filter(p => p && p.amount != null && p.amount !== '');
    if (!hasImg && !prices.length) { container.innerHTML = ''; return; }

    const box = 'border:1px solid var(--line,#333);border-radius:12px;padding:14px;background:var(--panel2,#1a1a1a);';
    const head = 'font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted,#888);font-weight:700;margin-bottom:10px;';
    let html = '';

    if (hasImg) {
      html += `<div style="${box}margin-bottom:14px;"><div style="${head}">Card image</div><div style="display:flex;gap:14px;flex-wrap:wrap;">`;
      data.images.filter(i => i && i.url).forEach(im => {
        html += `<div style="text-align:center;">
          <img src="${im.url}" alt="${im.label}" loading="lazy"${im.fallback ? ` onerror="this.onerror=null;this.src='${im.fallback}'"` : ''} style="width:150px;max-width:42vw;border-radius:8px;display:block;border:1px solid var(--line,#333);">
          <button class="tcg-dl" data-url="${encodeURIComponent(im.url)}" data-fn="${name}-${(im.label||'art').toLowerCase()}.png" style="margin-top:8px;width:100%;padding:6px;border:1px solid var(--gold,#c8aa6e);background:transparent;color:var(--gold,#c8aa6e);border-radius:7px;font-weight:700;font-size:12px;cursor:pointer;">&#8595; ${im.label}</button>
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
