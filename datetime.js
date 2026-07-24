/* datetime.js — the ONE place the suite formats a date/time for display.
 *
 * Everything a user sees is rendered in SYDNEY time (Australia/Sydney → AEST or AEDT, switched
 * automatically by daylight saving). Timestamps are stored UTC/ISO; this converts at render. Loaded
 * as a classic <script src="/datetime.js"> → window.TZ (and TCG.tz if extras.js is present).
 *
 * Convention: a column heading / field label that shows a date-time carries a "(Sydney)" tag so the
 * zone is unmistakable; a standalone timestamp with no such heading uses TZ.stamp(), which appends the
 * live AEST/AEDT abbreviation.
 */
(function () {
  var ZONE = 'Australia/Sydney';
  var LOC = 'en-AU';
  var TZ = { zone: ZONE, label: 'Sydney' };

  function toDate(x) {
    if (x == null || x === '') return null;
    var d = (x instanceof Date) ? x : new Date(x);
    return isNaN(d.getTime()) ? null : d;
  }

  // Minutes east of UTC for Sydney at date d — AEST = 600, AEDT = 660. Offset-based so it never
  // depends on the browser's locale rendering "AEST"/"AEDT" (some give "GMT+10" instead).
  function offMin(d) {
    try {
      var p = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
      var o = {}; for (var i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
      var h = o.hour === '24' ? 0 : +o.hour;
      var asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, h, +o.minute, +o.second);
      return Math.round((asUTC - d.getTime()) / 60000);
    } catch (e) { return 600; }
  }
  TZ.abbr = function (x) { var d = toDate(x) || new Date(); return offMin(d) === 660 ? 'AEDT' : 'AEST'; };

  // Build strings from NUMERIC Sydney parts + a fixed month table so the output is identical across
  // every ICU build (some render month 'short' as "July" instead of "Jul").
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function parts(d) {
    var o = {};
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour12: true, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', second: '2-digit' })
        .formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    } catch (e) { /* falls through → empty parts */ }
    return o;
  }
  TZ.date = function (x) { var d = toDate(x); if (!d) return ''; var o = parts(d); if (!o.year) return ''; return (+o.day) + ' ' + (MON[(+o.month) - 1] || '') + ' ' + o.year; };  // 24 Jul 2026
  TZ.time = function (x) { var d = toDate(x); if (!d) return ''; var o = parts(d); if (!o.hour) return ''; return (+o.hour) + ':' + o.minute + ' ' + String(o.dayPeriod || '').toLowerCase(); };  // 3:52 pm
  TZ.dateTime = function (x) { var d = toDate(x); if (!d) return ''; var dt = TZ.date(d); return dt ? dt + ', ' + TZ.time(d) : ''; };  // 24 Jul 2026, 3:52 pm
  TZ.clock = function (x) {  // 15:52:03 (24-hour, for logs)
    var d = toDate(x); if (!d) return '';
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d); }
    catch (e) { return ''; }
  };
  // Self-describing timestamp WITH the zone abbrev — for standalone times not under a "(Sydney)" heading.
  TZ.stamp = function (x) { var d = toDate(x); if (!d) return ''; return TZ.dateTime(d) + ' ' + TZ.abbr(d); };                       // 24 Jul 2026, 3:52 pm AEST
  // Compact: the Sydney time if it's today, otherwise the Sydney date+time. For dense tables.
  TZ.smart = function (x) { var d = toDate(x); if (!d) return ''; return TZ.date(d) === TZ.date(new Date()) ? TZ.time(d) : TZ.dateTime(d); };
  // Relative age (timezone-independent) — kept for "3h ago"-style freshness, falls back to a Sydney date past 30d.
  TZ.ago = function (x) {
    var d = toDate(x); if (!d) return '';
    var s = (Date.now() - d.getTime()) / 1000;
    if (s < 0) return TZ.smart(d);
    if (s < 60) return 'just now';
    var m = s / 60; if (m < 60) return Math.round(m) + 'm ago';
    var h = m / 60; if (h < 24) return Math.round(h) + 'h ago';
    var dd = h / 24; if (dd < 30) return Math.round(dd) + 'd ago';
    return TZ.date(d);
  };

  window.TZ = TZ;
  if (window.TCG) window.TCG.tz = TZ;
})();
