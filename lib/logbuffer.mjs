// lib/logbuffer.mjs — in-process ring buffer of recent console output, exposed
// (token-gated) at GET /api/status/logs so the always-on server's [refresh] /
// [collector] / [api/*] lines are diagnosable REMOTELY over the LAN HTTP surface,
// with no shell access to the box (see AGENTS.md — status row).
//
// Secret hygiene (GR2 — "secrets never leave the server"): every line is scrubbed of
// any .env value whose KEY name looks secret (…KEY/TOKEN/SECRET/CERT/APP_ID/RUNAME…)
// BEFORE it enters the buffer, and the /logs endpoint is gated by DIAG_TOKEN. The
// original console still fires unmodified, so the launcher/service stdout (local to
// the box) keeps full detail — only the network-visible copy is redacted. scrubSecrets
// is also exported so callers that emit upstream-derived strings on the OPEN /api/status
// (probe details, watchlist last_error) can redact them the same way.
//
// SURVIVES VITE RESTARTS: Vite restarts the dev server in-process and RE-IMPORTS the
// plugin modules, but console.* is patched exactly once (the globalThis guard below).
// So the writer (old module instance's `push`) and the reader (a newer status.mjs
// instance's `getLogs`) are different module instances — the ring buffer and redaction
// set therefore live on globalThis, shared across instances, or /logs would read an
// empty buffer after the first restart.
const MAX = 500;

// Keys whose values are secrets. Name-based so it auto-covers future .env additions.
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|CERT|APP_ID|TEAM_ID|RUNAME|PASSWORD|CHAT_ID)/i;

const buf = () => (globalThis.__tcgLogBuf || (globalThis.__tcgLogBuf = []));
const redactions = () => (globalThis.__tcgLogRedact || []);

function buildRedactions(env) {
  const vals = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === 'string' && v.trim().length >= 6 && SECRET_KEY_RE.test(k)) vals.push(v.trim());
  }
  // longest-first: redact a value before any shorter value it may contain
  return [...new Set(vals)].sort((a, b) => b.length - a.length);
}

// Redact every known .env secret VALUE + runtime Bearer/Basic tokens from a string.
// Exported so open-endpoint callers (status.mjs) can reuse the exact scrub.
export function scrubSecrets(s) {
  if (s == null) return s;
  let out = String(s);
  for (const secret of redactions()) {
    if (secret && out.includes(secret)) out = out.split(secret).join('***');
  }
  // belt-and-suspenders for tokens minted at runtime (never in .env): Bearer/Basic creds
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***');
  return out;
}

function fmt(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

// Strip ANSI / VT100 escape sequences (terminal colour codes Vite & friends emit). Over the HTTP log
// surface they render as blank/garbled control glyphs, so the /logs viewer shows unreadable lines.
// ESC is built via char code so no literal control byte lives in this source file.
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g');
function stripAnsi(s) { return String(s).replace(ANSI_RE, '').split(ESC).join(''); }
// Display-safe single line: colour codes gone, then any leftover C0/DEL control byte (a stray CR, a
// spinner backspace, a raw ESC the SGR regex missed, an embedded newline) collapsed to a space.
function sanitizeMsg(s) {
  return stripAnsi(String(s == null ? '' : s)).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/ {2,}/g, ' ').trim();
}
// Vite's own dev-server HMR/reload chatter — framework noise, not app diagnostics, and it can flood
// the buffer (reload loops when a client's HMR websocket can't connect). Dropped at info level only.
const VITE_NOISE_RE = /(page reload|hmr update|\bconnected\b|\bconnecting\b|ws proxy|optimized dependencies|server restarted)/i;

function push(level, args) {
  let msg;
  try { msg = stripAnsi(scrubSecrets(fmt(args))); } catch { return; }
  if (level === 'info' && msg.includes('[vite]') && VITE_NOISE_RE.test(msg)) return;
  const b = buf();
  b.push({ t: new Date().toISOString(), level, msg: msg.slice(0, 2000) });
  if (b.length > MAX) b.splice(0, b.length - MAX);
}

// Idempotent + survives re-import. Refreshes the (shared) redaction set every call, but
// patches console only once per process. Original console fns are preserved (still write
// to stdout). Because the buffer lives on globalThis, the once-installed patch keeps
// filling the same buffer a re-imported reader sees.
export function installLogCapture(env) {
  globalThis.__tcgLogRedact = buildRedactions(env);
  if (globalThis.__tcgLogCapture) return;
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  globalThis.__tcgLogCaptureOrig = orig;
  console.log = (...a) => { push('info', a); orig.log(...a); };
  console.info = (...a) => { push('info', a); orig.info(...a); };
  console.warn = (...a) => { push('warn', a); orig.warn(...a); };
  console.error = (...a) => { push('error', a); orig.error(...a); };
  globalThis.__tcgLogCapture = true;
}

const RANK = { info: 0, warn: 1, error: 2 };
// tail = how many of the most-recent lines; level = minimum severity ('warn' => warn+error).
// Messages are sanitized on READ too, so any line buffered by an older instance (pre-fix, still
// carrying ANSI/control bytes) is served clean regardless of when it entered the buffer.
export function getLogs({ tail = 200, level = null } = {}) {
  const b = buf();
  const min = level && RANK[level] != null ? RANK[level] : 0;
  const filtered = min ? b.filter((e) => RANK[e.level] >= min) : b;
  const n = Math.max(1, Math.min(MAX, (tail | 0) || 200));
  return filtered.slice(-n).map((e) => ({ ...e, msg: sanitizeMsg(e.msg) }));
}

// ---- test seams (avoid patching global console inside the suite) ----
export function _setRedactions(env) { globalThis.__tcgLogRedact = buildRedactions(env); }
export function _push(level, ...args) { push(level, args); }
export function _reset() { globalThis.__tcgLogBuf = []; globalThis.__tcgLogRedact = []; }
