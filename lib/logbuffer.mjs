// lib/logbuffer.mjs — in-process ring buffer of recent console output, exposed
// (token-gated) at GET /api/status/logs so the always-on server's [refresh] /
// [collector] / [api/*] lines are diagnosable REMOTELY over the LAN HTTP surface,
// with no shell access to the box (see AGENTS.md — status row).
//
// Secret hygiene (GR2 — "secrets never leave the server"): every line is scrubbed of
// any .env value whose KEY name looks secret (…KEY/TOKEN/SECRET/CERT/APP_ID/RUNAME…)
// BEFORE it enters the buffer, and the /logs endpoint is gated by DIAG_TOKEN. The
// original console still fires unmodified, so the launcher/service stdout (local to
// the box) keeps full detail — only the network-visible copy is redacted.
//
// console.* is monkeypatched once per process (HMR-safe globalThis singleton, mirroring
// the timer singletons in collector.mjs / refresh.mjs) — that captures the codebase's
// existing console logging with zero call-site changes.
const MAX = 500;
const _buf = [];        // ring buffer: [{ t, level, msg }]
let _redactions = [];   // secret substrings to strip, longest-first

// Keys whose values are secrets. Name-based so it auto-covers future .env additions.
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|CERT|APP_ID|TEAM_ID|RUNAME|PASSWORD|CHAT_ID)/i;

function buildRedactions(env) {
  const vals = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === 'string' && v.trim().length >= 6 && SECRET_KEY_RE.test(k)) vals.push(v.trim());
  }
  // longest-first: redact a value before any shorter value it may contain
  return [...new Set(vals)].sort((a, b) => b.length - a.length);
}

function scrub(s) {
  let out = s;
  for (const secret of _redactions) {
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

function push(level, args) {
  let msg;
  try { msg = scrub(fmt(args)); } catch { return; }
  _buf.push({ t: new Date().toISOString(), level, msg: msg.slice(0, 2000) });
  if (_buf.length > MAX) _buf.splice(0, _buf.length - MAX);
}

// Idempotent + HMR-safe. Refreshes the redaction set every call (picks up .env), but
// patches console only once. Original console fns are preserved (still write to stdout).
export function installLogCapture(env) {
  _redactions = buildRedactions(env);
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
export function getLogs({ tail = 200, level = null } = {}) {
  const min = level && RANK[level] != null ? RANK[level] : 0;
  const filtered = min ? _buf.filter((e) => RANK[e.level] >= min) : _buf;
  const n = Math.max(1, Math.min(MAX, (tail | 0) || 200));
  return filtered.slice(-n);
}

// ---- test seams (avoid patching global console inside the suite) ----
export function _setRedactions(env) { _redactions = buildRedactions(env); }
export function _push(level, ...args) { push(level, args); }
export function _reset() { _buf.length = 0; _redactions = []; }
