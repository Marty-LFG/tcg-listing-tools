// test/unit/logbuffer.test.mjs — the scrubbed ring buffer behind GET /api/status/logs
// (lib/logbuffer.mjs). Uses the _push/_setRedactions/_reset seams so the suite never
// monkeypatches the real console. The no-secret-leak guarantee (GR2) is the load-bearing test.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getLogs, _setRedactions, _push, _reset } from '../../lib/logbuffer.mjs';

beforeEach(() => _reset());

describe('secret scrubbing (GR2 — nothing secret leaves the box)', () => {
  const env = {
    SCRYDEX_API_KEY: 'scrydex-secret-abcdef123456',
    SCRYDEX_TEAM_ID: 'team-id-secret-778899',    // credential header value — must be scrubbed
    TELEGRAM_BOT_TOKEN: '1234567890:AAExampleBotTokenValue',
    EBAY_APP_ID: 'MyApp-PRD-11112222-abcd',
    LABEL_PRINTER_IP: '192.168.4.220',   // NOT secret by name → must stay visible
  };
  it('strips every .env secret VALUE from a captured line', () => {
    _setRedactions(env);
    _push('info', `[api/rb] key ${env.SCRYDEX_API_KEY} team ${env.SCRYDEX_TEAM_ID}`);
    _push('warn', `[telegram] using ${env.TELEGRAM_BOT_TOKEN}`);
    const s = JSON.stringify(getLogs({ tail: 10 }));
    assert.ok(!s.includes(env.SCRYDEX_API_KEY), 'leaked SCRYDEX_API_KEY');
    assert.ok(!s.includes(env.SCRYDEX_TEAM_ID), 'leaked SCRYDEX_TEAM_ID');
    assert.ok(!s.includes(env.TELEGRAM_BOT_TOKEN), 'leaked TELEGRAM_BOT_TOKEN');
    assert.ok(s.includes('***'), 'redaction marker present');
  });
  it('does NOT redact non-secret values (printer IP)', () => {
    _setRedactions(env);
    _push('info', `[api/print] -> ${env.LABEL_PRINTER_IP}:9100`);
    assert.ok(JSON.stringify(getLogs()).includes('192.168.4.220'));
  });
  it('redacts runtime Bearer/Basic tokens that never came from .env', () => {
    _setRedactions({});
    _push('info', 'Authorization: Bearer eyJhbGciOi.abc123.def456ghi');
    const msg = getLogs()[0].msg;
    assert.ok(!/eyJhbGciOi/.test(msg), 'leaked bearer token');
    assert.match(msg, /Bearer \*\*\*/);
  });
});

describe('ring buffer + filters', () => {
  it('tail returns only the N most-recent lines', () => {
    for (let i = 0; i < 10; i++) _push('info', 'line ' + i);
    const out = getLogs({ tail: 3 });
    assert.equal(out.length, 3);
    assert.equal(out[2].msg, 'line 9');
    assert.equal(out[0].msg, 'line 7');
  });
  it('level acts as a minimum severity (warn => warn+error only)', () => {
    _push('info', 'i'); _push('warn', 'w'); _push('error', 'e');
    const warnUp = getLogs({ level: 'warn' }).map((l) => l.level);
    assert.deepEqual(warnUp, ['warn', 'error']);
    assert.equal(getLogs({ level: 'error' }).length, 1);
    assert.equal(getLogs().length, 3);   // no filter => everything
  });
  it('caps at the ring size (never grows unbounded)', () => {
    for (let i = 0; i < 640; i++) _push('info', 'x' + i);
    const all = getLogs({ tail: 5000 });
    assert.ok(all.length <= 500, `buffer grew to ${all.length}`);
    assert.equal(all[all.length - 1].msg, 'x639');   // newest retained
  });
  it('each entry carries an ISO timestamp + level', () => {
    _push('error', 'boom');
    const e = getLogs()[0];
    assert.match(e.t, /^\d{4}-\d\d-\d\dT/);
    assert.equal(e.level, 'error');
  });
});
