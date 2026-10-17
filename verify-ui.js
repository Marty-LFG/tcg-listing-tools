// verify-ui.js — the verification surface, shared by inventory.html and sealed.html.
//
// A root-level classic script, like datetime.js and extras.js, for the reason those are: the stock
// pages are standalone HTML with inline scripts, and the alternative to a shared file is the same four
// hundred lines pasted into two pages that then drift. Everything customer-visible here is internal
// tooling copy, so it follows the house copy rule anyway: no em or en dashes, sentence case, plain
// verbs, and the button says what it does.
//
// NO NEW VISUAL LANGUAGE. Both pages already define --gold/--green/--amber/--red, .pill, .btn, .sec,
// .overlay, .modal, .fld and .hint, and this file reaches for those rather than shipping a second
// design. The one thing it adds is the progress bar, because the content is "a fraction of a physical
// pile" and length is the honest way to draw that: a row of cards or tiles would say nothing a number
// does not already say. The gold accent is deliberately NOT used for a status, so that status colour
// keeps meaning status on a page where gold already means "this is a heading".
(function () {
  'use strict';
  var API = '/api/verification';
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var SHAPE_LABEL = { graded: 'Graded slabs', raw: 'Raw singles', sealed: 'Sealed' };
  // Outcome to pill colour. Only three colours, because an operator scanning a list is answering one
  // question: is this row done, not started, or stuck.
  var TONE = {
    verified: 'ok', corrected: 'ok',
    discrepancy: 'err', missing: 'err', unavailable: 'warn', override: 'warn',
  };
  var WORD = {
    verified: 'verified', corrected: 'corrected', discrepancy: 'does not match',
    missing: 'not found', unavailable: 'cannot check', override: 'published unverified',
  };

  var FLAGS = { inventory: {}, sealed: {} };
  var VOCAB = null;
  var state = { mount: null, kind: null, repaint: null, reload: null };

  // ---- styles: only what the pages do not already have -------------------------------------------
  function injectCss() {
    if (document.getElementById('bkv-css')) return;
    var css = [
      // CAPPED, and not by accident. Left to the section's full width the three tracks stretch to
      // ~900px of 7px hairline, which reads as three loading bars rather than as a chart of how much
      // of a physical pile is left. Held to a block the eye takes in at once, the lengths compare.
      '.bkv{display:grid;gap:11px;max-width:660px;}',
      '.bkv-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}',
      '.bkv-tot{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--muted);}',
      '.bkv-row{display:grid;grid-template-columns:104px minmax(90px,1fr) 72px 74px;align-items:center;gap:12px;}',
      '@media(max-width:620px){.bkv-row{grid-template-columns:92px minmax(60px,1fr) 64px;}.bkv-units{display:none;}}',
      '.bkv-lbl{font-size:12.5px;color:var(--text);}',
      // The bar. Track is the page's hairline; fill is green because it means the same thing the
      // verified pill means. Square-ish radius so it does not read as another pill.
      '.bkv-bar{position:relative;height:7px;border-radius:4px;background:rgba(255,255,255,.07);border:1px solid var(--line);overflow:hidden;}',
      '.bkv-fill{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,rgba(67,214,160,.55),var(--green));border-radius:4px;}',
      '.bkv-left{font-family:var(--mono);font-size:12px;color:var(--text);text-align:right;}',
      '.bkv-left.done{color:var(--green);}',
      '.bkv-units{font-family:var(--mono);font-size:11px;color:var(--faint);text-align:right;}',
      '.bkv-foot{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);}',
      '.bkv-foot b{font-weight:600;color:var(--text);}',
      '.bkv-warn{color:var(--amber);} .bkv-err{color:var(--red);}',
      '.bkv-claims{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:12px;padding:11px 13px;margin-bottom:15px;font-size:12.5px;line-height:1.6;}',
      '.bkv-claims .k{color:var(--muted);}',
      '.bkv-hist{margin-top:14px;font-family:var(--mono);font-size:11.5px;color:var(--muted);display:grid;gap:4px;max-height:132px;overflow:auto;}',
    ].join('');
    var el = document.createElement('style');
    el.id = 'bkv-css';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ---- the modal, built once and reused ----------------------------------------------------------
  function injectModal() {
    if (document.getElementById('bkvOverlay')) return;
    var d = document.createElement('div');
    d.className = 'overlay';
    d.id = 'bkvOverlay';
    d.innerHTML = ''
      + '<div class="modal" style="max-width:580px;">'
      + '<h2>Check against the item</h2>'
      + '<div class="bkv-claims" id="bkvClaims"></div>'
      + '<div class="grid">'
      + '<div class="fld full"><label>What did you find</label><select id="bkvOutcome"></select>'
      + '<div class="hint" id="bkvOutcomeHint"></div></div>'
      + '<div class="fld"><label>Units counted</label><input id="bkvUnits" type="number" min="0" step="1">'
      + '<div class="hint" id="bkvUnitsHint"></div></div>'
      + '<div class="fld"><label>Picture on the listing</label><select id="bkvPhoto">'
      + '<option value="">not recorded</option><option value="catalogue">catalogue art</option>'
      + '<option value="own">its own photograph</option></select>'
      + '<div class="hint">What the listing may honestly claim.</div></div>'
      + '<div class="fld full"><label>Note</label><input id="bkvNote" placeholder="what is wrong, or where you found it"></div>'
      + '<div class="fld full"><label>Who looked</label><input id="bkvActor" placeholder="your name"></div>'
      + '</div>'
      + '<div class="status" id="bkvStatus"></div>'
      + '<div class="bkv-hist" id="bkvHist"></div>'
      + '<div class="modal-actions">'
      + '<button class="btn ghost" id="bkvCancel">Cancel</button>'
      + '<button class="btn go" id="bkvSave">Record check</button>'
      + '</div></div>';
    document.body.appendChild(d);
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    document.getElementById('bkvCancel').onclick = close;
    document.getElementById('bkvSave').onclick = save;
    document.getElementById('bkvOutcome').onchange = outcomeChanged;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && d.classList.contains('on')) close();
    });
  }

  function close() {
    var o = document.getElementById('bkvOverlay');
    if (o) o.classList.remove('on');
  }

  // ---- the panel ---------------------------------------------------------------------------------
  function bar(shape, c) {
    var pct = c.rows ? Math.round((c.verified / c.rows) * 100) : 0;
    var left = c.outstanding;
    return '<div class="bkv-row">'
      + '<div class="bkv-lbl">' + esc(SHAPE_LABEL[shape] || shape) + '</div>'
      + '<div class="bkv-bar" role="img" aria-label="' + pct + '% of ' + esc(SHAPE_LABEL[shape] || shape) + ' checked">'
        + '<div class="bkv-fill" style="width:' + pct + '%;"></div></div>'
      + '<div class="bkv-left' + (left ? '' : ' done') + '">' + (left ? left + ' left' : 'all done') + '</div>'
      // The units figure only where it differs from the row count. On slabs and raw singles a row IS
      // a unit, so printing "5 left · 5 units" twice says one thing twice; on a pool of six it is the
      // number that matters, because that is six objects to pick up.
      + '<div class="bkv-units">' + (c.outstanding_units === left ? '' : c.outstanding_units + ' units') + '</div>'
      + '</div>';
  }

  function renderPanel(data) {
    var el = state.mount;
    if (!el) return;
    var t = data.total;
    if (!t.rows) {
      el.innerHTML = '<div class="sec"><div class="bkv"><div class="bkv-head">'
        + '<span class="sec-h" style="margin:0;">Verified by hand</span></div>'
        + '<div class="bkv-foot">No stock to check yet.</div></div></div>';
      return;
    }
    var foot = [];
    if (t.failing) {
      foot.push('<span class="bkv-err"><b>' + t.failing + '</b> ' + (t.failing === 1 ? 'row needs' : 'rows need')
        + ' another look</span>');
    }
    if (t.recount_due) {
      foot.push('<span class="bkv-warn"><b>' + t.recount_due + '</b> counted '
        + (t.recount_due === 1 ? 'row has' : 'rows have') + ' moved since</span>');
    }
    if (data.drift) {
      foot.push('<span class="bkv-err">The cached dates disagree with the ledger on <b>' + data.drift
        + '</b> rows. Something wrote verified_at outside the ledger.</span>');
    }
    if (!foot.length) {
      foot.push(t.outstanding
        ? 'Nothing is stuck. The storefront refuses every unchecked row until somebody looks.'
        : 'Every row on the shelf has been checked against the item.');
    }
    var shapes = ['graded', 'raw', 'sealed'].filter(function (s) { return data.shapes[s] && data.shapes[s].rows; });
    el.innerHTML = '<div class="sec"><div class="bkv">'
      + '<div class="bkv-head"><span class="sec-h" style="margin:0;">Verified by hand</span>'
      + '<span class="bkv-tot">' + t.verified + ' of ' + t.rows + ' rows · '
      + t.verified_units + ' of ' + t.units + ' units</span></div>'
      + shapes.map(function (s) { return bar(s, data.shapes[s]); }).join('')
      + '<div class="bkv-foot">' + foot.join('') + '</div>'
      + '</div></div>';
  }

  // ---- the row pill ------------------------------------------------------------------------------
  //
  // Reads verified_at off the row for the clean cases and the flags map for the rest, which is exactly
  // the split the server draws: the cache answers the common question, the ledger answers the rest.
  function pill(kind, row) {
    var f = (FLAGS[kind] || {})[row.id];
    if (f && !f.ok) {
      return ' <span class="pill" style="color:var(--' + (TONE[f.outcome] === 'err' ? 'red' : 'amber')
        + ');border-color:' + (TONE[f.outcome] === 'err' ? 'rgba(240,102,110,.45)' : 'rgba(240,192,74,.45)') + ';"'
        + ' title="' + esc((f.note || '') + (f.actor ? ' (' + f.actor + ')' : '')) + '">'
        + esc(WORD[f.outcome] || f.outcome) + '</span>';
    }
    if (row.verified_at) {
      var when = (window.TZ && TZ.date) ? TZ.date(row.verified_at) : String(row.verified_at).slice(0, 10);
      if (f && f.recount_due) {
        return ' <span class="pill" style="color:var(--amber);border-color:rgba(240,192,74,.45);"'
          + ' title="counted ' + f.units + ', the row now says ' + f.quantity + '">recount</span>';
      }
      return ' <span class="pill" style="color:var(--green);border-color:rgba(67,214,160,.45);"'
        + ' title="checked against the item on ' + esc(when) + '">verified</span>';
    }
    return ' <span class="pill" style="color:var(--amber);border-color:rgba(240,192,74,.45);"'
      + ' title="nobody has checked this against the physical item, so it cannot publish">not checked</span>';
  }

  function button(kind, id) {
    return '<button class="btn sm ghost" title="Check this against the physical item"'
      + ' onclick="BKV.open(\'' + kind + '\',' + id + ')">✓</button>';
  }

  // ---- open / save ------------------------------------------------------------------------------
  var open_ = { kind: null, id: null, qty: 1 };

  function claimLine(k, v) {
    return v == null || v === '' ? '' : '<span class="k">' + esc(k) + '</span> ' + esc(v) + ' ';
  }

  async function open(kind, id) {
    injectCss(); injectModal();
    open_ = { kind: kind, id: id, qty: 1 };
    var st = document.getElementById('bkvStatus');
    st.className = 'status'; st.textContent = '';
    document.getElementById('bkvOverlay').classList.add('on');
    document.getElementById('bkvNote').value = '';
    document.getElementById('bkvPhoto').value = '';
    document.getElementById('bkvActor').value = (function () {
      try { return localStorage.getItem('bkv.actor') || ''; } catch (e) { return ''; }
    })();
    var sel = document.getElementById('bkvOutcome');
    if (!sel.options.length) {
      if (!VOCAB) VOCAB = await (await fetch(API + '/vocab')).json();
      sel.innerHTML = VOCAB.reportable.map(function (o) {
        return '<option value="' + o + '">' + esc(WORD[o] || o) + '</option>';
      }).join('');
    }
    sel.value = 'verified';
    document.getElementById('bkvClaims').innerHTML = '<span class="k">loading</span>';
    document.getElementById('bkvHist').innerHTML = '';
    var r = await (await fetch(API + '/item?kind=' + encodeURIComponent(kind) + '&id=' + id)).json();
    var q = r.state && r.state.qty_cached != null ? r.state.qty_cached : 1;
    open_.qty = q;
    document.getElementById('bkvUnits').value = q;
    document.getElementById('bkvUnitsHint').textContent = q > 1
      ? 'The row says ' + q + '. Count them: a count that disagrees is recorded as a mismatch.'
      : 'The row holds ' + q + '.';
    // What the row CLAIMS, so the operator has something to read against the object in hand. Pulled
    // from the already-rendered list row rather than refetched, because the list has it all.
    var src = (window.BKV_ROW_FACTS && window.BKV_ROW_FACTS(kind, id)) || {};
    document.getElementById('bkvClaims').innerHTML = (claimLine('', src.name)
      + claimLine('sku', src.sku) + claimLine('grade', src.grade) + claimLine('condition', src.condition)
      + claimLine('shelf', src.location) + claimLine('holds', q + (q === 1 ? ' unit' : ' units')))
      || '<span class="k">stock row ' + kind + ' ' + id + '</span>';
    var h = (r.history || []).map(function (v) {
      return '<div>' + [esc(String(v.at).slice(0, 16)), esc(WORD[v.outcome] || v.outcome),
        v.units != null ? v.units + '/' + (v.qty_cached == null ? '?' : v.qty_cached) : '',
        esc(v.actor || ''), v.note ? esc(v.note) : ''].filter(Boolean).join(' · ') + '</div>';
    }).join('');
    document.getElementById('bkvHist').innerHTML = h || '<div>No check on record.</div>';
    outcomeChanged();
    document.getElementById('bkvActor').focus();
  }

  function outcomeChanged() {
    var o = document.getElementById('bkvOutcome').value;
    var hint = { verified: 'The row matches the item in hand.',
      corrected: 'You found it, the row was wrong, and you have already fixed the row.',
      discrepancy: 'You found it and the row is still wrong. It cannot publish until it is fixed and checked again.',
      missing: 'It is not where the row says it is. File the loss as a stock movement as well.',
      unavailable: 'It cannot be brought to hand right now, so nobody can check it.' }[o] || '';
    document.getElementById('bkvOutcomeHint').textContent = hint;
  }

  async function save() {
    var btn = document.getElementById('bkvSave');
    var st = document.getElementById('bkvStatus');
    var actor = document.getElementById('bkvActor').value.trim();
    if (!actor) { st.className = 'status err'; st.textContent = 'Say who looked. Every check is attributed.'; return; }
    try { localStorage.setItem('bkv.actor', actor); } catch (e) { /* private window: not worth failing over */ }
    btn.disabled = true;
    st.className = 'status load'; st.textContent = 'Recording.';
    var body = {
      kind: open_.kind, item_id: open_.id,
      outcome: document.getElementById('bkvOutcome').value,
      units: document.getElementById('bkvUnits').value,
      photo: document.getElementById('bkvPhoto').value || null,
      note: document.getElementById('bkvNote').value.trim() || null,
      actor: actor,
    };
    try {
      var r = await fetch(API + '/record', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      var j = await r.json();
      if (!r.ok) { st.className = 'status err'; st.textContent = j.error || 'The check was not recorded.'; btn.disabled = false; return; }
      if (j.downgraded) {
        // Said out loud, because the operator chose "verified" and the server recorded something else.
        st.className = 'status warn';
        st.textContent = 'Recorded as a mismatch. ' + j.downgraded;
        btn.disabled = false;
      } else {
        st.className = 'status ok'; st.textContent = 'Recorded.';
        close(); btn.disabled = false;
      }
      // RELOAD, not repaint. The page renders rows from its own cached /items payload, and the row
      // just checked still carries the verified_at it was fetched with — null. Repainting from memory
      // therefore redraws "not checked" over a row that was just verified. Every other write on these
      // pages calls load() for the same reason.
      await refresh();
      if (state.reload) await state.reload();
    } catch (e) {
      st.className = 'status err'; st.textContent = String(e && e.message || e); btn.disabled = false;
    }
  }

  // ---- wiring -----------------------------------------------------------------------------------
  //
  // flags are fetched for BOTH kinds whichever page is mounted: inventory.html renders sealed nothing,
  // but the panel counts every shape, and a page that showed the owner only its own half would answer
  // "how much is left" wrongly on both pages.
  async function refresh() {
    injectCss();
    try {
      var c = await (await fetch(API + '/counts')).json();
      renderPanel(c);
    } catch (e) { /* GR7: a diagnostic that takes the page down is worse than no diagnostic */ }
    try {
      var f = await (await fetch(API + '/flags')).json();
      FLAGS = f.flags || FLAGS;
    } catch (e) { /* same */ }
  }

  /**
   * mount({ el, kind, repaint, reload }) — called once by each page. `kind` is the kind this page's
   * rows are, so pill()/button() can be called without repeating it at every call site.
   *
   * TWO HOOKS, because the two moments need different things. `repaint` redraws the list from the
   * page's memory, which is all that is needed when only this file's flags changed. `reload` refetches
   * it, which is what a recorded check needs: verified_at lives on the row the page fetched, so a
   * repaint would redraw the stale value over the row just checked.
   */
  function mount(opts) {
    injectCss(); injectModal();
    state.mount = typeof opts.el === 'string' ? document.getElementById(opts.el) : opts.el;
    state.kind = opts.kind || 'inventory';
    state.repaint = opts.repaint || null;
    state.reload = opts.reload || null;
    // REPAINT AFTER THE FLAGS LAND, and this is not optional. The page renders its rows from its own
    // /items fetch, which finishes before this one: pill() would then draw every row from verified_at
    // alone, so a row whose last check found a discrepancy showed "not checked" — the one distinction
    // the flags map exists to make. A repaint is enough here (nothing on the rows has changed, only
    // what this file knows about them) and costs no request.
    return refresh().then(function () { if (state.repaint) state.repaint(); });
  }

  window.BKV = {
    mount: mount,
    refresh: refresh,
    open: open,
    close: close,
    pill: function (row) { return pill(state.kind, row); },
    button: function (id) { return button(state.kind, id); },
    pillFor: pill,
    buttonFor: button,
  };
}());
