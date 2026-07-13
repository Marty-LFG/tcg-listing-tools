// test/unit/req-body.test.mjs — shared JSON body reader (lib/req-body.mjs). Fake req via EventEmitter.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readJsonBody } from '../../lib/req-body.mjs';

const fakeReq = () => { const r = new EventEmitter(); r.destroy = () => { r.destroyed = true; }; return r; };
const feed = (req, chunks) => { for (const c of chunks) req.emit('data', Buffer.from(c)); req.emit('end'); };

describe('readJsonBody', () => {
  it('parses a valid JSON body streamed in chunks', async () => {
    const req = fakeReq(); const p = readJsonBody(req, 1e6);
    feed(req, ['{"a":', '1}']);
    assert.deepEqual(await p, { a: 1 });
  });
  it('empty body → {}', async () => {
    const req = fakeReq(); const p = readJsonBody(req, 1e6); req.emit('end');
    assert.deepEqual(await p, {});
  });
  it('malformed JSON → rejects with "invalid JSON body"', async () => {
    const req = fakeReq(); const p = readJsonBody(req, 1e6); feed(req, ['{bad']);
    await assert.rejects(() => p, /invalid JSON body/);
  });
  it('over the limit → rejects and destroys the request', async () => {
    const req = fakeReq(); const p = readJsonBody(req, 4);
    req.emit('data', Buffer.from('12345'));   // 5 > 4
    await assert.rejects(() => p, /payload too large/);
    assert.equal(req.destroyed, true);
  });
  it('boundary: size == limit is allowed; one byte over rejects', async () => {
    const ok = fakeReq(); const p1 = readJsonBody(ok, 2); feed(ok, ['{}']);   // 2 == 2
    assert.deepEqual(await p1, {});
    const over = fakeReq(); const p2 = readJsonBody(over, 1); over.emit('data', Buffer.from('{}'));   // 2 > 1
    await assert.rejects(() => p2, /payload too large/);
  });
  it('an error event rejects', async () => {
    const req = fakeReq(); const p = readJsonBody(req, 1e6); req.emit('error', new Error('boom'));
    await assert.rejects(() => p, /boom/);
  });
});
