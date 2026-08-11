// test/unit/logbuffer.test.mjs — the scrubbed ring buffer behind GET /api/status/logs
// (lib/logbuffer.mjs). Uses the _push/_setRedactions/_reset seams so the suite never
// monkeypatches the real console. The no-secret-leak guarantee (GR2) is the load-bearing test.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getLogs, logTags, tagOf, scrubSecrets, _setRedactions, _push, _reset } from '../../lib/logbuffer.mjs';

beforeEach(() => _reset());

describe('secret scrubbing (GR2 — nothing secret leaves the box)', () => {
  // Deliberately SHORT fake values: scrub matches by env-value (any length ≥6), not shape,
  // so these exercise it fully while staying under the no-secrets invariant's 25-char
  // "looks like a real key" threshold (test/invariants/no-secrets.test.mjs).
  const env = {
    SCRYDEX_API_KEY: 'fake-scrydex-k-1',
    SCRYDEX_TEAM_ID: 'fake-team-id-2',      // credential header value — must be scrubbed
    TELEGRAM_BOT_TOKEN: 'fake-bot-tok-3',
    EBAY_APP_ID: 'fake-app-id-4',
    LABEL_PRINTER_IP: '192.168.4.220',      // NOT secret by name → must stay visible
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

describe('scrubSecrets (exported for open-endpoint callers — status.mjs probe detail / last_error)', () => {
  it('redacts .env secret values and runtime bearer tokens; passes null through', () => {
    _setRedactions({ SCRYDEX_API_KEY: 'fake-scrydex-secret-1' });
    assert.equal(scrubSecrets('upstream said key=fake-scrydex-secret-1 bad'), 'upstream said key=*** bad');
    assert.match(scrubSecrets('Authorization: Bearer abc123def456ghi789'), /Bearer \*\*\*/);
    assert.equal(scrubSecrets(null), null);
    assert.equal(scrubSecrets('scrydex_inactive'), 'scrydex_inactive');  // an error code is not a secret
  });
});

describe('globalThis-backed buffer survives module re-import (the Vite-restart fix)', () => {
  it('a writer in one module instance and a reader in another share the ring buffer', async () => {
    // Cache-busting query strings give two DISTINCT module instances that still share globalThis —
    // the exact writer(old)/reader(new) split Vite creates on an in-process restart. If _buf were
    // module-scoped again, the reader instance would see nothing and this would fail.
    const writer = await import('../../lib/logbuffer.mjs?inst=w');
    const reader = await import('../../lib/logbuffer.mjs?inst=r');
    writer._reset();
    writer._push('warn', 'cross-instance-line');
    assert.notEqual(writer, reader, 'expected two distinct module instances');
    assert.ok(reader.getLogs({ tail: 10 }).some((e) => e.msg === 'cross-instance-line'),
      'reader instance must see the writer instance line via the shared globalThis buffer');
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

describe('ANSI stripping + Vite HMR noise filtering', () => {
  const ESC = String.fromCharCode(27);   // build escape codes without a literal control byte in source
  it('strips terminal colour codes but keeps bracketed [tags]', () => {
    _push('info', ESC + '[32m[collector]' + ESC + '[39m pass ok');
    const m = getLogs().at(-1).msg;
    assert.equal(m, '[collector] pass ok');
    assert.ok(!m.includes(ESC), 'no raw escape byte survived');
  });
  it('drops Vite HMR/reload chatter but keeps real app logs', () => {
    _push('info', ESC + '[2m8:49:55 am' + ESC + '[22m ' + ESC + '[36m[vite]' + ESC + '[39m page reload settings.html');
    _push('info', '[refresh] baked pokemon ok');
    const msgs = getLogs().map((l) => l.msg);
    assert.ok(!msgs.some((m) => m.includes('[vite]')), 'vite reload line dropped');
    assert.ok(msgs.includes('[refresh] baked pokemon ok'), 'app log kept');
  });
  it('keeps a vite line that is an ERROR (only info-level HMR noise is dropped)', () => {
    _push('error', '[vite] internal server error');
    assert.ok(getLogs().some((l) => l.level === 'error' && l.msg.includes('[vite]')));
  });
});

// A ring that evicts oldest-first answers "what happened most recently", which is the wrong question
// for a diagnostic buffer with one very chatty subsystem in it. Measured live on 2026-08-11: 190 of
// 214 lines were [api/ebay] comp-search URLs from a single scan, leaving one [ebay-notify] line and
// no [postsale] lines. The buffer was remembering price lookups and forgetting the sale that did not
// alert — the exact incident it exists for.
describe('fair-share eviction — one loud subsystem cannot evict every other', () => {
  const MAX = 500;

  it('keeps the quiet subsystem’s lines through a flood', () => {
    _push('info', '[postsale] order-poll: 1 new paid order ingested');
    _push('warn', '[ebay-notify] cursor HELD for 10-99');
    // A comps scan an order of magnitude bigger than the whole buffer.
    for (let i = 0; i < MAX * 4; i++) _push('info', '[api/ebay] /buy/browse/v1/item_summary/search?q=card-' + i);

    const kept = getLogs({ tail: MAX }).map((e) => e.msg);
    assert.ok(kept.some((m) => m.includes('[postsale] order-poll')), 'the sale line must survive the flood');
    assert.ok(kept.some((m) => m.includes('[ebay-notify] cursor HELD')), 'so must the notification line');
  });

  it('still lets the loud one keep its most recent lines', () => {
    for (let i = 0; i < MAX * 2; i++) _push('info', '[api/ebay] search-' + i);
    const ebay = getLogs({ tail: MAX, tag: 'api/ebay' }).map((e) => e.msg);
    assert.ok(ebay.length > 100, 'a burst is itself diagnostic — this is not suppression');
    assert.ok(ebay.at(-1).endsWith('search-' + (MAX * 2 - 1)), 'and the newest is the one kept');
  });

  it('never exceeds the ring size', () => {
    for (let i = 0; i < MAX * 3; i++) _push('info', '[a] ' + i);
    for (let i = 0; i < MAX * 3; i++) _push('info', '[b] ' + i);
    assert.equal(getLogs({ tail: MAX + 100 }).length, MAX);
  });

  it('degrades to plain oldest-first when only one subsystem is logging', () => {
    for (let i = 0; i < MAX + 10; i++) _push('info', '[only] ' + i);
    const msgs = getLogs({ tail: MAX }).map((e) => e.msg);
    assert.equal(msgs.length, MAX);
    assert.equal(msgs[0], '[only] 10', 'the first ten aged out, exactly as a plain ring would do');
    assert.equal(msgs.at(-1), '[only] ' + (MAX + 9));
  });

  it('shares the buffer between two equally loud subsystems', () => {
    for (let i = 0; i < MAX; i++) { _push('info', '[a] ' + i); _push('info', '[b] ' + i); }
    const a = getLogs({ tail: MAX, tag: 'a' }).length;
    const b = getLogs({ tail: MAX, tag: 'b' }).length;
    assert.ok(Math.abs(a - b) <= 1, `expected an even split, got a=${a} b=${b}`);
  });
});

describe('tags — reading past a busy neighbour', () => {
  it('derives the tag from the leading bracket, and buckets untagged lines together', () => {
    assert.equal(tagOf('[postsale] hello'), 'postsale');
    assert.equal(tagOf('[api/ebay] /buy/browse'), 'api/ebay');
    assert.equal(tagOf('no bracket here'), '(untagged)');
  });

  it('filters to one subsystem', () => {
    _push('info', '[postsale] a');
    _push('info', '[api/ebay] b');
    _push('info', '[postsale] c');
    const only = getLogs({ tail: 50, tag: 'postsale' });
    assert.deepEqual(only.map((e) => e.msg), ['[postsale] a', '[postsale] c']);
  });

  it('combines with the level filter rather than replacing it', () => {
    _push('info', '[postsale] routine');
    _push('error', '[postsale] broke');
    _push('error', '[api/ebay] upstream 500');
    const r = getLogs({ tail: 50, tag: 'postsale', level: 'warn' });
    assert.deepEqual(r.map((e) => e.msg), ['[postsale] broke']);
  });

  it('indexes what is in the buffer, busiest first', () => {
    for (let i = 0; i < 5; i++) _push('info', '[api/ebay] ' + i);
    _push('info', '[postsale] one');
    assert.deepEqual(logTags(), [{ tag: 'api/ebay', count: 5 }, { tag: 'postsale', count: 1 }]);
  });

  it('every entry carries its tag', () => {
    _push('info', '[ebay-notify] listening');
    assert.equal(getLogs({ tail: 1 })[0].tag, 'ebay-notify');
  });
});
