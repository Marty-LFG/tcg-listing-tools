// test/unit/comps-windows.test.mjs — TCG.openComps, the two reused comps windows.
//
// Working a pile is: punch in a card, tap BIN and Sold, read both off a second screen, move on. That
// only works if the links land in the SAME two windows every time — a new tab per card buries the
// screen by the fifth one, and a new window per card is worse. So each slot has a named target, and
// the window geometry is applied only when a window is created: once they are dragged where they
// belong they stay there, because the spec ignores features for a window that already exists.
//
// extras.js is a classic script with no exports, so it is booted in a vm with a browser shim — the
// same approach test/unit/cached-json.test.mjs uses.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read } from '../helpers/extract-inline.mjs';

// A stand-in for the browser's window.open: records every call and hands back a fake WindowProxy
// that can be "closed" and counts focus() calls.
function boot({ blocked = false } = {}) {
  const opens = [];
  const windows = new Map();                       // name -> fake WindowProxy
  const sandbox = {
    document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }), head: { appendChild() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: false, status: 0, headers: { get: () => null }, json: async () => ({}) }),
    setTimeout, clearTimeout, console, Date, Math, JSON,
  };
  sandbox.window = sandbox;
  sandbox.screen = { availWidth: 2560, availHeight: 1400, availLeft: 0, availTop: 0 };
  sandbox.window.open = (url, name, features) => {
    opens.push({ url, name, features });
    if (blocked) return null;                      // popup blocker: window.open hands back null
    let w = windows.get(name);
    if (!w || w.closed) { w = { closed: false, focuses: 0, focus() { this.focuses++; }, url }; windows.set(name, w); }
    else w.url = url;                              // an existing named window just navigates
    return w;
  };
  vm.createContext(sandbox);
  vm.runInContext(read('extras.js'), sandbox);
  return { TCG: sandbox.window.TCG, opens, windows };
}

const BIN = 'https://www.ebay.com.au/sch/i.html?_nkw=A&LH_BIN=1&_sop=15&rt=nc&LH_PrefLoc=1';
const SOLD = 'https://www.ebay.com.au/sch/i.html?_nkw=A&LH_BIN=1&_sop=13&LH_Sold=1&LH_Complete=1&rt=nc&LH_PrefLoc=1';

describe('TCG.openComps — two windows, reused', () => {
  let env;
  beforeEach(() => { env = boot(); });

  it('BIN and Sold get their own named window, so neither replaces the other', () => {
    env.TCG.openComps(BIN, 'bin');
    env.TCG.openComps(SOLD, 'sold');
    assert.deepEqual(env.opens.map((o) => o.name), ['bk-comps-bin', 'bk-comps-sold']);
    assert.equal(env.windows.size, 2);
  });

  it('card after card lands in the SAME two windows', () => {
    for (const card of ['A', 'B', 'C']) {
      env.TCG.openComps(BIN + '&c=' + card, 'bin');
      env.TCG.openComps(SOLD + '&c=' + card, 'sold');
    }
    assert.equal(env.windows.size, 2, 'six clicks, two windows');
    assert.match(env.windows.get('bk-comps-bin').url, /c=C$/, 'the window followed the last card');
    assert.match(env.windows.get('bk-comps-sold').url, /c=C$/);
  });

  it('raises a window it just created, and never one already open', () => {
    env.TCG.openComps(BIN, 'bin');
    const w = env.windows.get('bk-comps-bin');
    assert.equal(w.focuses, 1, 'a new window must not be born behind the tool');
    env.TCG.openComps(BIN + '&c=B', 'bin');
    env.TCG.openComps(BIN + '&c=C', 'bin');
    assert.equal(w.focuses, 1, 'the keyboard belongs to the grid — do not steal focus mid-pile');
  });

  it('reopens after the operator closes one', () => {
    env.TCG.openComps(BIN, 'bin');
    const first = env.windows.get('bk-comps-bin');
    first.closed = true;
    env.TCG.openComps(BIN, 'bin');
    const second = env.windows.get('bk-comps-bin');
    assert.notEqual(second, first, 'a closed window is gone; open a fresh one');
    assert.equal(second.focuses, 1, 'and raise it, because it is new');
  });

  it('opens side by side on the first click, and never re-imposes geometry after that', () => {
    env.TCG.openComps(BIN, 'bin');
    env.TCG.openComps(SOLD, 'sold');
    const [bin, sold] = env.opens;
    assert.match(bin.features, /popup=yes/, 'a window, not a tab');
    assert.match(bin.features, /width=1280/, 'half of a 2560 screen');
    assert.match(bin.features, /left=0/, 'BIN on the left');
    assert.match(sold.features, /left=1280/, 'Sold on the right');
    // Features are passed every time and IGNORED by the browser for an existing window — that is
    // what lets the operator drag them to a second screen once and keep them there.
    env.TCG.openComps(BIN + '&c=B', 'bin');
    assert.equal(env.opens[2].features, bin.features);
  });

  it('never carries noopener, or there would be no handle to reuse', () => {
    env.TCG.openComps(BIN, 'bin');
    assert.ok(!/noopener/.test(env.opens[0].features));
  });

  it('says so when the browser refuses, so the caller can fall back to the link', () => {
    const b = boot({ blocked: true });
    assert.equal(b.TCG.openComps(BIN, 'bin'), false, 'blocked: let the anchor open its own tab');
    assert.equal(b.TCG.openComps('', 'bin'), false, 'nothing to open');
    assert.equal(env.TCG.openComps(BIN, 'bin'), true);
  });

  it('an unknown slot still opens somewhere rather than throwing', () => {
    assert.equal(env.TCG.openComps(BIN, 'nonsense'), true);
    assert.equal(env.opens[0].name, 'bk-comps-bin');
  });
});
