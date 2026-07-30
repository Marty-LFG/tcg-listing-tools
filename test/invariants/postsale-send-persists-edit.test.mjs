// test/invariants/postsale-send-persists-edit.test.mjs — the Send button in postsale.html must send
// what is ON SCREEN.
//
// Regression guard for a bug that reached a real buyer: the handler was
//   $('m_send').addEventListener('click', (e) => modalAction('/approve', null, e.target));
// which POSTs /approve with no body. The server then sends whatever is stored, so an edit the owner
// typed but did not separately Save was silently discarded and the ORIGINAL draft went out. The
// dashboard gave no hint — it closed the modal and reported success.
//
// This is client-side wiring, so no API-level test can catch it and the repo has no DOM harness.
// A source-shape assertion is the cheapest thing that fails if the wiring is reverted.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read, inlineScripts } from '../helpers/extract-inline.mjs';

const js = inlineScripts(read('postsale.html')).map((b) => b.body).join('\n');

describe('postsale.html — Send persists a pending edit first', () => {
  it('does not bind Send straight to /approve', () => {
    assert.doesNotMatch(js, /m_send'\)\.addEventListener\([\s\S]{0,80}?modalAction\(\s*'\/approve'/,
      'Send must not POST /approve directly — an unsaved edit would be dropped and the original sent');
  });

  it('the Send handler POSTs /edit before /approve', () => {
    const fn = js.match(/async function sendCurrent\s*\([\s\S]*?\n\}/);
    assert.ok(fn, 'expected a sendCurrent() handler for the Send button');
    const src = fn[0];
    const edit = src.indexOf("/edit");
    const approve = src.indexOf("/approve");
    assert.ok(edit !== -1, 'sendCurrent must persist the on-screen text via /edit');
    assert.ok(approve !== -1, 'sendCurrent must then send via /approve');
    assert.ok(edit < approve, '/edit must be posted BEFORE /approve');
  });

  it('compares against the loaded values so it knows the text is dirty', () => {
    assert.match(js, /LOADED\s*=\s*\{/, 'expected a LOADED snapshot of the persisted subject/body');
    assert.match(js, /!==\s*LOADED\.(subject|body)/, 'expected a dirty check against LOADED');
  });

  it('Send is wired to sendCurrent', () => {
    assert.match(js, /m_send'\)\.addEventListener\(\s*'click'\s*,\s*\(e\)\s*=>\s*sendCurrent\(/);
  });
});
