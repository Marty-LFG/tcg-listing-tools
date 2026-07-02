// lib/repricer.mjs — Vite plugin that owns the store-repricer DB + /api/repricer/* API and runs
// the Telegram long-poll loop. Mirrors trackerPlugin(env) in lib/tracker.mjs; registered in
// vite.config.js `plugins`.
//
// PHASE 1 SCOPE (this file today): Telegram plumbing only — prove the alert -> Approve/Skip ->
// message-updates loop end to end with a dry-run "test" proposal that NEVER writes to eBay. The
// eBay read+compare collector (Phase 3) and the real ReviseInventoryStatus apply (Phase 4) slot
// in later: Phase 4 just replaces the `kind:'test'` branch in handleCallback with a real
// applyReprice(proposal). Everything degrades gracefully with no bot token (Golden Rule 7).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRepricerDb, REPRICER_DB_PATH, getMeta, setMeta, recordChat } from './repricer-db.mjs';
import {
  telegramEnabled, telegramChatConfigured, escapeHtml,
  sendMessage, editMessageText, answerCallbackQuery, getMe,
  startTelegramPoller, stopTelegramPoller,
} from './telegram.mjs';
import {
  keysConfigured, runameConfigured, buildConsentUrl, exchangeCode,
  saveConsent, oauthStatus, deleteTokenStore,
} from './ebay-oauth.mjs';
import { getUser } from './ebay-trading.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'repricer.config.json');

const DEFAULT_CONFIG = {
  scan_enabled: false,
  cadence_hours: 24,
  target: 'cheapest_in_cluster',
  guardrails: {
    min_uplift_pct: 10, min_uplift_aud: 1.0, min_comparable: 8,
    required_confidence: 'high', max_increase_pct_per_run: 40,
    proposal_ttl_hours: 24, never_decrease: true,
  },
  exclude_seller_username: 'omg.its.alcatrazz',
  telegram: { digest_enabled: true, poll_enabled: true },
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw, guardrails: { ...DEFAULT_CONFIG.guardrails, ...(raw.guardrails || {}) }, telegram: { ...DEFAULT_CONFIG.telegram, ...(raw.telegram || {}) } };
  } catch { return DEFAULT_CONFIG; }
}

// --- tiny http helpers (same shape as lib/tracker.mjs) ---
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) b = b.slice(0, 1e6); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const money = (n, cur = 'AUD') => (cur === 'AUD' ? 'A$' : cur + ' ') + (Math.round(Number(n) * 100) / 100).toFixed(2);
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Build the Telegram card body for a proposal. `decided` = { status, who } stamps the outcome.
function renderProposalCard(p, decided) {
  const ev = safeParse(p.evidence) || {};
  let s = `<b>🔼 Underpriced listing</b>${p.kind === 'test' ? ' <i>(test — no eBay write)</i>' : ''}\n`;
  s += `<b>${escapeHtml(p.title || p.item_id || 'listing')}</b>\n`;
  s += `You: ${money(p.from_price, p.currency)}  →  suggest <b>${money(p.to_price, p.currency)}</b>`;
  if (p.from_price > 0) s += `  <i>(+${Math.round(((p.to_price - p.from_price) / p.from_price) * 100)}%)</i>`;
  s += '\n';
  if (ev.summary) s += `${escapeHtml(ev.summary)}\n`;
  if (decided) {
    const icon = decided.status.startsWith('approved') ? '✅' : decided.status === 'skipped' ? '⏭' : 'ℹ️';
    s += `\n${icon} <b>${escapeHtml(decided.status)}</b> by ${escapeHtml(decided.who)}`;
  }
  return s;
}

function proposalButtons(id) {
  return [[{ text: '✅ Approve', data: `ap:${id}` }, { text: '⏭ Skip', data: `sk:${id}` }]];
}

// Minimal self-contained consent helper served at GET /api/repricer/oauth. No build step, no deps;
// drives the /oauth/* JSON routes. The inline script avoids template literals (this file already
// is one) — plain string concatenation only.
function consentPageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect eBay — Repricer</title>
<style>
  :root{--bg:#14161a;--panel:#1c1f26;--line:#2c313b;--text:#e8e8ea;--muted:#8b93a1;--gold:#c8aa6e;--err:#e5674b}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,Segoe UI,Roboto,sans-serif;padding:28px}
  .wrap{max-width:640px;margin:0 auto}
  h1{font-size:19px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin:14px 0}
  .step{font-weight:700;color:var(--gold);font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
  code{background:#0f1115;padding:1px 5px;border-radius:4px;color:var(--gold)}
  button{background:var(--gold);color:#1a1a1a;border:0;border-radius:8px;padding:9px 15px;font-weight:700;cursor:pointer;font-size:13px}
  button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
  textarea{width:100%;box-sizing:border-box;background:#0f1115;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:10px;font:12px monospace;min-height:70px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
  .status{font-size:13px}.k{color:var(--muted)}
  .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid var(--line)}
  .pill.on{color:#7bd88f;border-color:#2f6b3f}.pill.off{color:var(--err);border-color:#5a2e26}
  pre{white-space:pre-wrap;word-break:break-word;background:#0f1115;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;color:var(--muted)}
</style></head><body><div class="wrap">
  <h1>Connect eBay to the repricer</h1>
  <p class="sub">One-time consent as the seller. Mints a refresh token stored <b>encrypted</b> on this server — no keys ever reach the browser.</p>
  <div class="card"><div class="step">Status</div><div id="status" class="status">loading…</div></div>
  <div class="card">
    <div class="step">Step 1 — Authorize on eBay</div>
    <div>Opens eBay's consent screen in a new tab. Log in as the seller and click <b>Agree</b>. eBay then redirects to a page whose address bar contains <code>?code=…</code>.</div>
    <div class="row"><button id="start">Open eBay consent →</button></div>
  </div>
  <div class="card">
    <div class="step">Step 2 — Paste the code</div>
    <div>Copy the whole <code>code</code> value from that redirect URL and paste it here (it expires in ~5 min).</div>
    <textarea id="code" placeholder="v^1.1#i^1#..."></textarea>
    <div class="row"><button id="connect">Connect</button><span id="exres" class="k"></span></div>
  </div>
  <div class="card">
    <div class="step">Step 3 — Verify</div>
    <div class="row"><button id="test" class="ghost">Test connection (GetUser)</button><button id="disc" class="ghost">Disconnect</button></div>
    <pre id="out" style="display:none"></pre>
  </div>
<script>
  var B = '/api/repricer/oauth';
  function getJSON(u){ return fetch(u).then(function(r){ return r.json(); }); }
  function postJSON(u, body){ return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){ return r.json().then(function(d){ return { status:r.status, data:d }; }); }); }
  function pill(on){ return '<span class="pill '+(on?'on':'off')+'">'+(on?'yes':'no')+'</span>'; }
  function refresh(){ getJSON(B+'/status').then(function(s){
    document.getElementById('status').innerHTML =
      '<div><span class="k">eBay keys:</span> '+pill(s.keys_configured)+'</div>'+
      '<div><span class="k">RuName:</span> '+pill(s.runame_configured)+'</div>'+
      '<div><span class="k">Connected:</span> '+pill(s.connected)+'</div>'+
      (s.connected ? '<div class="k">since '+(s.obtained_at||'')+' · refresh valid to '+(s.refresh_expires_at||'')+'</div>' : '');
  }); }
  document.getElementById('start').onclick = function(){ window.open(B+'/start','_blank'); };
  document.getElementById('connect').onclick = function(){
    var el = document.getElementById('exres'); el.textContent = 'connecting…';
    postJSON(B+'/exchange',{ code: document.getElementById('code').value.trim() }).then(function(r){
      el.textContent = r.data.ok ? '✓ connected' : ('✕ '+(r.data.error||'failed')); refresh(); });
  };
  document.getElementById('test').onclick = function(){
    var out = document.getElementById('out'); out.style.display='block'; out.textContent='testing…';
    postJSON(B+'/test',{}).then(function(r){ out.textContent = JSON.stringify(r.data,null,2); });
  };
  document.getElementById('disc').onclick = function(){
    postJSON(B+'/disconnect',{}).then(function(){ refresh(); document.getElementById('out').style.display='none'; });
  };
  refresh();
</script>
</div></body></html>`;
}

export function repricerPlugin(env) {
  return {
    name: 'repricer',
    configureServer(server) {
      const db = openRepricerDb();
      const cfg = loadConfig();

      // --- Telegram update dispatch ---
      async function handleCallback(cq) {
        const data = cq.data || '';
        const who = (cq.from && (cq.from.username ? '@' + cq.from.username : cq.from.first_name)) || 'someone';
        const m = data.match(/^(ap|sk):(\d+)$/);
        if (!m) return answerCallbackQuery(env, { id: cq.id, text: 'Unknown action' });
        const action = m[1], id = +m[2];
        const p = db.prepare('SELECT * FROM reprice_proposals WHERE id = ?').get(id);
        if (!p) return answerCallbackQuery(env, { id: cq.id, text: 'Proposal not found' });
        if (p.status !== 'pending') return answerCallbackQuery(env, { id: cq.id, text: 'Already ' + p.status });
        if (p.expires_at && p.expires_at < new Date().toISOString().replace('T', ' ').slice(0, 19)) {
          db.prepare("UPDATE reprice_proposals SET status='expired' WHERE id=?").run(id);
          await answerCallbackQuery(env, { id: cq.id, text: 'This proposal has expired' });
          return editMessageText(env, { chatId: p.telegram_chat_id, messageId: p.telegram_message_id, text: renderProposalCard(p, { status: 'expired', who }), clearButtons: true });
        }

        if (action === 'sk') {
          db.prepare("UPDATE reprice_proposals SET status='skipped', decided_by=?, decided_at=datetime('now') WHERE id=?").run(who, id);
          await answerCallbackQuery(env, { id: cq.id, text: 'Skipped' });
          return editMessageText(env, { chatId: p.telegram_chat_id, messageId: p.telegram_message_id, text: renderProposalCard(p, { status: 'skipped', who }), clearButtons: true });
        }

        // Approve. Phase 1: test proposals are recorded as approved but NEVER sent to eBay.
        // Phase 4 replaces this branch with: const r = await applyReprice(env, p); ...
        if (p.kind === 'test') {
          db.prepare("UPDATE reprice_proposals SET status='approved', decided_by=?, decided_at=datetime('now') WHERE id=?").run(who, id);
          await answerCallbackQuery(env, { id: cq.id, text: 'Approved (test — nothing written to eBay)' });
          return editMessageText(env, { chatId: p.telegram_chat_id, messageId: p.telegram_message_id, text: renderProposalCard(p, { status: 'approved (test)', who }), clearButtons: true });
        }
        // Real repricing is not wired until Phase 4.
        return answerCallbackQuery(env, { id: cq.id, text: 'Price writes are not enabled yet (Phase 4)', showAlert: true });
      }

      async function onUpdate(u) {
        if (u.callback_query) return handleCallback(u.callback_query);
        const chat = (u.message && u.message.chat) || (u.channel_post && u.channel_post.chat) || (u.my_chat_member && u.my_chat_member.chat);
        if (chat) { try { recordChat(db, chat); } catch {} }
      }

      // --- router ---
      const router = async (req, res) => {
        try {
          const method = req.method || 'GET';
          if (method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('access-control-allow-origin', '*');
            res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
            res.setHeader('access-control-allow-headers', 'content-type');
            return res.end();
          }
          const url = new URL(req.url, 'http://localhost');
          const p = url.pathname.replace(/\/+$/, '') || '/';

          // GET /config — non-secret status (never returns the bot token).
          if (p === '/config' && method === 'GET') {
            return send(res, 200, {
              telegram_enabled: telegramEnabled(env),
              chat_configured: telegramChatConfigured(env),
              scan_enabled: cfg.scan_enabled,
              cadence_hours: cfg.cadence_hours,
              target: cfg.target,
              guardrails: cfg.guardrails,
            });
          }

          // GET /me — confirm the bot token works (server-side; returns username, not the token).
          if (p === '/me' && method === 'GET') {
            const r = await getMe(env);
            return send(res, r.ok ? 200 : 502, r.ok
              ? { ok: true, username: r.result.username, name: r.result.first_name, id: r.result.id }
              : { ok: false, error: r.description || 'getMe failed' });
          }

          // GET /chatid — chats the bot has seen (setup helper to find your channel/group id).
          if (p === '/chatid' && method === 'GET') {
            const chats = db.prepare('SELECT id, type, title, username, last_seen_at FROM seen_chats ORDER BY last_seen_at DESC').all();
            return send(res, 200, { chats, hint: 'Add the bot to your channel/group (as admin for channels), then it appears here.' });
          }

          // GET /proposals — recent proposals (audit view).
          if (p === '/proposals' && method === 'GET') {
            const rows = db.prepare('SELECT * FROM reprice_proposals ORDER BY id DESC LIMIT 50').all();
            return send(res, 200, { proposals: rows });
          }

          // POST /test-alert — create a dry-run proposal and push it to Telegram with buttons.
          // Body (all optional): { title, from_price, to_price, summary, chat_id }
          if (p === '/test-alert' && method === 'POST') {
            if (!telegramEnabled(env)) return send(res, 503, { error: 'TELEGRAM_BOT_TOKEN not set in .env' });
            const b = await readJson(req);
            const chatId = b.chat_id || (env.TELEGRAM_CHAT_ID || '').trim();
            if (!chatId) return send(res, 400, { error: 'no chat_id — set TELEGRAM_CHAT_ID in .env or pass chat_id in the body. Use GET /api/repricer/chatid to find it.' });
            const title = b.title || "Kai'Sa - Survivor (Alt Art) 039a/298 - Riftbound Origins EN M/NM";
            const from = b.from_price != null ? +b.from_price : 12.0;
            const to = b.to_price != null ? +b.to_price : 18.49;
            const summary = b.summary || 'Market cluster A$18–21 · 14 comparable · high confidence';
            const ttlH = (cfg.guardrails && cfg.guardrails.proposal_ttl_hours) || 24;

            const ins = db.prepare(`INSERT INTO reprice_proposals
              (kind, item_id, title, from_price, to_price, currency, evidence, status, telegram_chat_id, expires_at)
              VALUES ('test', ?, ?, ?, ?, 'AUD', ?, 'pending', ?, datetime('now', ?))`)
              .run('TEST-' + Date.now(), title, from, to, JSON.stringify({ summary }), String(chatId), `+${ttlH} hours`);
            const id = ins.lastInsertRowid;
            const row = db.prepare('SELECT * FROM reprice_proposals WHERE id = ?').get(id);

            const r = await sendMessage(env, { chatId, text: renderProposalCard(row), buttons: proposalButtons(id) });
            if (!r.ok) { db.prepare("UPDATE reprice_proposals SET status='failed', error=? WHERE id=?").run(r.description || 'send failed', id); return send(res, 502, { error: 'Telegram send failed', detail: r.description }); }
            db.prepare('UPDATE reprice_proposals SET telegram_message_id=? WHERE id=?').run(r.result.message_id, id);
            return send(res, 201, { ok: true, id, message_id: r.result.message_id, chat_id: chatId });
          }

          // ---- eBay user-token OAuth (Phase 2) ----
          // GET /oauth — minimal consent helper page (drives the JSON routes below).
          if (p === '/oauth' && method === 'GET') {
            res.statusCode = 200;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.setHeader('access-control-allow-origin', '*');
            return res.end(consentPageHtml());
          }

          // GET /oauth/status — non-secret connection state.
          if (p === '/oauth/status' && method === 'GET') {
            return send(res, 200, oauthStatus(env));
          }

          // GET /oauth/start — 302 the browser to eBay's consent screen.
          if (p === '/oauth/start' && method === 'GET') {
            if (!keysConfigured(env)) return send(res, 503, { error: 'EBAY_APP_ID / EBAY_CERT_ID not set in .env' });
            if (!runameConfigured(env)) return send(res, 503, { error: 'EBAY_RUNAME not set in .env — register a RuName in the eBay portal (a localhost URL is rejected).' });
            const state = crypto.randomBytes(12).toString('hex');
            setMeta(db, 'oauth_state', state);
            res.statusCode = 302;
            res.setHeader('location', buildConsentUrl(env, state));
            return res.end();
          }

          // POST /oauth/exchange { code, state? } — trade the pasted auth code for tokens.
          if (p === '/oauth/exchange' && method === 'POST') {
            if (!keysConfigured(env) || !runameConfigured(env)) return send(res, 503, { error: 'eBay keys/RuName not configured in .env' });
            const b = await readJson(req);
            const code = (b.code || '').trim();
            if (!code) return send(res, 400, { error: 'code is required — paste the code=... value from the redirect URL' });
            if (b.state) { const want = getMeta(db, 'oauth_state'); if (want && b.state !== want) return send(res, 400, { error: 'state mismatch — restart the consent from Step 1' }); }
            try {
              saveConsent(env, await exchangeCode(env, code));
              return send(res, 200, { ok: true, ...oauthStatus(env) });
            } catch (e) {
              return send(res, 502, { ok: false, error: String(e?.message || e) });
            }
          }

          // POST /oauth/test — prove the user token authenticates against the Trading API (GetUser).
          if (p === '/oauth/test' && method === 'POST') {
            try {
              const u = await getUser(env);
              if (!u.ok) return send(res, 502, { ok: false, ack: u.ack, errors: u.errors });
              return send(res, 200, { ok: true, userId: u.userId, email: u.email, feedbackScore: u.feedbackScore, site: u.site, registrationDate: u.registrationDate });
            } catch (e) {
              return send(res, e?.code === 'not_connected' ? 409 : 502, { ok: false, error: String(e?.message || e), code: e?.code || null });
            }
          }

          // POST /oauth/disconnect — forget the stored refresh token.
          if (p === '/oauth/disconnect' && method === 'POST') {
            deleteTokenStore();
            return send(res, 200, { ok: true, ...oauthStatus(env) });
          }

          return send(res, 404, { error: 'unknown repricer route', path: p, method });
        } catch (e) {
          console.error('[api/repricer] error:', e?.message || e);
          return send(res, 500, { error: 'repricer error', detail: String(e?.message || e) });
        }
      };

      server.middlewares.use('/api/repricer', router);

      // Start the long-poll loop (singleton/HMR-guarded inside startTelegramPoller).
      if (cfg.telegram.poll_enabled && telegramEnabled(env)) {
        startTelegramPoller(env, {
          onUpdate,
          getOffset: () => { const v = getMeta(db, 'tg_offset'); return v ? +v : undefined; },
          setOffset: (o) => setMeta(db, 'tg_offset', o),
          log: (m) => console.log('[repricer/telegram]', m),
        });
        server.httpServer?.on('close', () => stopTelegramPoller());
      }

      console.log('[repricer] DB ' + REPRICER_DB_PATH + ' · API /api/repricer · telegram '
        + (telegramEnabled(env) ? (telegramChatConfigured(env) ? 'on' : 'on (no chat_id yet)') : 'off (no token)'));
    },
  };
}
