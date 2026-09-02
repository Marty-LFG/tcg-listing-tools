// test/invariants/runs-live-arming.test.mjs — nothing reaches the live store by a flag edit alone.
//
// THE BARRIER THAT DISAPPEARED. The plan for this module rested on four barriers between a dev run and
// the real shop and called the strongest one an ABSENCE: the live locationGid and publicationGid were
// blank, so guardPins refused whatever the flags said. Both are now populated in
// data/shopify.config.json — while that file's own comment beside them still reads "EMPTY UNTIL
// MEASURED", and guardLiveStore's docblock still says "the live pins happen to be blank on the trading
// box, which catches it". The belt is gone and the trousers still claim it is there.
//
// So this file is the positive replacement, and its central assertion is the one a flag cannot satisfy:
// the publish target comes from CONFIG, never from the request, and the store has to say what it is
// before a byte is written.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { armingState, assertArmed, assertStoreIdentity } from '../../lib/runs-arm.mjs';

const db = openDbAt(tmpFile('runs-arming.db'));

let n = 0;
function mkRun(mode = 'live', status = 'locked_published') {
  const k = ++n;
  const pid = (mode === 'dev' ? 'DEV-A' : 'A') + k;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status, locked_at, run_root, header_digest)
              VALUES (?,?,?,?,3,?, '2026-08-30T00:00:00.000Z', ?, ?)`)
    .run(pid, k, `Edition ${k}`, mode, status, 'ab'.repeat(32), 'cd'.repeat(32));
  return db.prepare('SELECT * FROM runs WHERE public_id = ?').get(pid);
}

const cfg = (over = {}) => ({
  publish: { enabled: true, store: 'dev', ...(over.publish || {}) },
  anchor: { mode: 'opentimestamps', ...(over.anchor || {}) },
});
const shop = (over = {}) => ({ publish: { enabled: true, allowLive: false, ...(over.publish || {}) } });

const codes = (s) => s.reasons.map((r) => r.code);

describe('the target comes from config, never from the request', () => {
  it('asking for the live store while config says dev is a REFUSAL, not a redirect', () => {
    // storeFor() in lib/shopify.mjs reads ?store= straight off the query string with no allowlist. A
    // runs publish must not inherit that: a target taken from a request is a target the caller chooses.
    const s = armingState(db, { runsCfg: cfg(), shopifyCfg: shop(), run: mkRun('dev'), store: 'live' });
    assert.equal(s.armed, false);
    assert.ok(codes(s).includes('store_mismatch'));
    assert.equal(s.target, 'dev', 'the target must still be the configured one');
  });

  it('and asking for nothing at all uses the configured target', () => {
    const s = armingState(db, { runsCfg: cfg(), shopifyCfg: shop(), run: mkRun('dev') });
    assert.equal(s.target, 'dev');
    assert.equal(s.armed, true, codes(s).join(', '));
  });
});

describe('both arming switches must be on, and they are separate on purpose', () => {
  it('the runs switch alone is not enough', () => {
    const s = armingState(db, { runsCfg: cfg(), shopifyCfg: shop({ publish: { enabled: false } }), run: mkRun('dev') });
    assert.ok(codes(s).includes('shopify_disarmed'));
  });

  it('and the Shopify switch alone is not enough', () => {
    // shopify.publish.enabled is already true for singles. Building this module must never silently
    // inherit "armed" from a lane that was armed for something else.
    const s = armingState(db, { runsCfg: cfg({ publish: { enabled: false } }), shopifyCfg: shop(), run: mkRun('dev') });
    assert.ok(codes(s).includes('runs_disarmed'));
  });
});

describe('a dev run can never reach the live store', () => {
  it('refused even with every live flag set', () => {
    // The schema ties mode to the DEV- prefix with a CHECK, and the prefix is inside headerDigest — so a
    // dev run's Bitcoin timestamp is self-labelling forever and must never sit against a real product.
    const s = armingState(db, {
      runsCfg: cfg({ publish: { store: 'live' } }),
      shopifyCfg: shop({ publish: { allowLive: true } }),
      run: mkRun('dev'),
    });
    assert.equal(s.armed, false);
    assert.ok(codes(s).includes('dev_run_live_store'));
  });
});

describe('the live store needs every condition, and each names itself', () => {
  const liveCfg = cfg({ publish: { store: 'live' } });

  it('refuses on allowLive alone being false', () => {
    const s = armingState(db, { runsCfg: liveCfg, shopifyCfg: shop(), run: mkRun('live') });
    assert.ok(codes(s).includes('live_not_allowed'));
  });

  it('refuses a stub anchor, which proves nothing', () => {
    const s = armingState(db, {
      runsCfg: cfg({ publish: { store: 'live' }, anchor: { mode: 'stub' } }),
      shopifyCfg: shop({ publish: { allowLive: true } }),
      run: mkRun('live'),
    });
    assert.ok(codes(s).includes('stub_anchor'));
  });

  it('refuses while the §5.7.7 sale gate is closed', () => {
    // Reused rather than restated: the gate already knows about publication state, the header digest
    // and whether the Bitcoin timestamp actually confirmed.
    const s = armingState(db, {
      runsCfg: liveCfg, shopifyCfg: shop({ publish: { allowLive: true } }), run: mkRun('live'),
    });
    assert.ok(codes(s).includes('sale_gate'), codes(s).join(', '));
  });

  it('and reports EVERY outstanding reason, not the first', () => {
    // "You cannot publish" is useless to an operator without which condition is missing — the same
    // reasoning saleGate returns {open, reasons}.
    const s = armingState(db, {
      runsCfg: cfg({ publish: { store: 'live' }, anchor: { mode: 'stub' } }),
      shopifyCfg: shop(), run: mkRun('dev'),
    });
    assert.ok(s.reasons.length >= 3, codes(s).join(', '));
    for (const r of s.reasons) {
      assert.ok(r.code && r.message, 'every reason carries a code and a sentence');
    }
  });
});

describe('the store has to say what it is', () => {
  const shopReply = (partnerDevelopment, domain = 'x.myshopify.com') => async () => ({
    ok: true, data: { shop: { name: 'X', myshopifyDomain: domain, plan: { displayName: 'P', partnerDevelopment } } },
  });

  it('accepts a dev target that answers "development store"', async () => {
    const r = await assertStoreIdentity({}, { store: 'dev', graphql: shopReply(true) });
    assert.equal(r.partnerDevelopment, true);
  });

  it('REFUSES a dev target that answers production — the check a bad .env cannot fool', async () => {
    // Every other condition derives from the same .env through the same function, so together they only
    // prove two variables differ. If the dev shop domain were pointed at production by a typo, every
    // env-derived check would pass happily and the write would land on the real shop.
    await assert.rejects(() => assertStoreIdentity({}, { store: 'dev', graphql: shopReply(false, 'real.myshopify.com') }),
      /NOT a development store/);
  });

  it('and refuses a live target that answers development, so success is never reported against the wrong shop', async () => {
    await assert.rejects(() => assertStoreIdentity({}, { store: 'live', graphql: shopReply(true) }),
      /IS a development store/);
  });

  it('a failed query is a refusal, never an assumption', async () => {
    await assert.rejects(() => assertStoreIdentity({}, { store: 'dev', graphql: async () => ({ ok: false, httpStatus: 500 }) }),
      /could not ask the dev store what it is/);
  });
});

describe('assertArmed', () => {
  it('throws one sentence and carries the whole list', async () => {
    const err = await assertArmed({}, db, {
      run: mkRun('dev'), runsCfg: cfg({ publish: { enabled: false } }), shopifyCfg: shop(),
      graphql: async () => { throw new Error('must not be reached'); },
    }).then(() => null, (e) => e);
    assert.equal(err.code, 'not_armed');
    assert.ok(Array.isArray(err.reasons) && err.reasons.length);
    assert.match(err.message, /not armed to publish/);
  });

  it('asks the store when everything else passes', async () => {
    let asked = 0;
    const r = await assertArmed({}, db, {
      run: mkRun('dev'), runsCfg: cfg(), shopifyCfg: shop(),
      graphql: async () => { asked++; return { ok: true, data: { shop: { myshopifyDomain: 'd.myshopify.com', plan: { partnerDevelopment: true } } } }; },
    });
    assert.equal(asked, 1);
    assert.equal(r.armed, true);
  });

  it('and a dry run skips ONLY the store question, not the flags', async () => {
    // A dry run returns before the first network call, so there is no store to ask. That is the only
    // exemption it gets.
    let asked = 0;
    const ok = await assertArmed({}, db, {
      run: mkRun('dev'), runsCfg: cfg(), shopifyCfg: shop(), dryRun: true,
      graphql: async () => { asked++; return { ok: true }; },
    });
    assert.equal(asked, 0);
    assert.equal(ok.dryRun, true);

    await assert.rejects(() => assertArmed({}, db, {
      run: mkRun('dev'), runsCfg: cfg({ publish: { enabled: false } }), shopifyCfg: shop(), dryRun: true,
    }), /not armed/);
  });
});
