// test/invariants/runs-route-reachability.test.mjs — every route in lib/runs.mjs must be REACHABLE.
//
// THE BUG THIS EXISTS FOR. The per-run matcher was `/^\/([A-Za-z0-9-]+)(\/[a-z-]+)?$/`, and `[a-z-]`
// cannot match a `/`. So `tail` could only ever be a single segment, and two routes written against
// two-segment tails — `POST /:id/anchor/upgrade` and `POST /:id/print/mark` — fell through to next() and
// 404'd. Both were written, gated, tested at the module level, and unreachable over HTTP.
//
// The upgrade one mattered most: §5.7.5's upgrade is what moves an anchor from `submitted` to
// `confirmed`, and §5.7.7's sale gate refuses while any header anchor is unconfirmed. An unreachable
// route therefore meant NO RUN COULD EVER OPEN FOR SALE, and nothing said so.
//
// A route test would have caught it for those two routes. This catches it for every route that will ever
// be added, by asking the router's own regex whether it can produce each tail the file compares against —
// which is the actual invariant, rather than a list someone has to remember to extend.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../lib/runs.mjs', import.meta.url), 'utf8');

// The matcher, lifted from the source rather than restated — a copy here could drift from the real one
// and this test would then be checking itself.
const MATCHER = (() => {
  const m = SRC.match(/const runM = p\.match\((\/\^.*?\/)\);/);
  assert.ok(m, 'could not find the per-run matcher in lib/runs.mjs — has it been renamed?');
  return new RegExp(m[1].slice(1, -1));
})();

// Every literal this file compares `tail` against.
const TAILS = [...new Set([...SRC.matchAll(/tail === '([^']*)'/g)].map((m) => m[1]))].sort();

describe('every per-run route is reachable by the router that dispatches it', () => {
  it('finds the matcher and a healthy number of tails', () => {
    assert.ok(TAILS.length >= 18, `only found ${TAILS.length} tails; the scan is probably broken`);
    assert.ok(MATCHER.source.includes('[A-Za-z0-9-]'), MATCHER.source);
  });

  for (const tail of TAILS) {
    it(`'${tail || '(bare run)'}' can actually be produced by the matcher`, () => {
      const m = `/E1${tail}`.match(MATCHER);
      assert.ok(m, `no request path can ever produce tail '${tail}' — the route is dead code`);
      assert.equal(m[2] || '', tail, `the matcher captures '${m[2] || ''}', not '${tail}'`);
    });
  }

  it('and the two that were dead are specifically alive', () => {
    // Named rather than left to the loop, because these are the ones that were broken and a future
    // refactor that quietly drops them should fail on a test that says their names.
    for (const tail of ['/anchor/upgrade', '/print/mark']) {
      assert.ok(TAILS.includes(tail), `${tail} is no longer routed at all`);
      assert.equal(`/E1${tail}`.match(MATCHER)?.[2], tail);
    }
  });
});

describe('the matcher stays bounded', () => {
  it('refuses a third segment rather than swallowing it as a run id', () => {
    // `*` would make any depth match, so a typo'd or not-yet-written path would resolve a run and then
    // fall through to next() looking like a missing route rather than a malformed one.
    assert.equal('/E1/a/b/c'.match(MATCHER), null);
  });

  it('and still refuses the digit-bearing paths that are routed earlier', () => {
    // /:id/pick/:no, /:id/bundles/:no and /reservations/:id/* are matched ABOVE this line with their own
    // regexes. They must not also match here, or the earlier route's absence would be invisible.
    for (const p of ['/E1/pick/1', '/E1/bundles/1', '/reservations/5/assign']) {
      assert.equal(p.match(MATCHER), null, `${p} must be handled by its own matcher, not this one`);
    }
  });

  it('matches a bare run id with an empty tail', () => {
    const m = '/E1'.match(MATCHER);
    assert.ok(m);
    assert.equal(m[2] || '', '');
  });
});
