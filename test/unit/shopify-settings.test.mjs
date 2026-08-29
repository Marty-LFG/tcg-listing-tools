// test/unit/shopify-settings.test.mjs — the settings gate on the Shopify channel config
// (SETTINGS.shopify in lib/status.mjs).
//
// WHY THIS VALIDATOR EARNS A TEST. Every refusal below currently fails at PUBLISH time instead —
// mid-batch, after images have been staged to a store Shopify gives no bulk delete for — and the
// operator's only clue is a GraphQL userError. Moving the failure to save time only helps if the
// rules stay right, and two of them are the kind that read as pedantry until they cost something:
//
//   · `status` is compared with === 'DRAFT' in lib/shopify.mjs. A saved 'draft' is therefore ACTIVE,
//     which is the difference between a hidden product and one on sale.
//   · `allowLive` is checked with === true by guardLiveStore. A saved string 'true' is truthy to a
//     careless reader and false to the guard — the worst possible split, because it LOOKS armed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../../lib/status.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const validate = SETTINGS.shopify.validate;
const BASE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shopify.config.example.json'), 'utf8'));
const cfg = (over = {}) => JSON.parse(JSON.stringify({ ...BASE, ...over }));
const withPublish = (p) => { const c = cfg(); Object.assign(c.publish, p); return c; };

describe('shopify settings gate', () => {
  it('is registered and editable — without that the settings card cannot save', () => {
    assert.equal(SETTINGS.shopify.file, 'shopify.config.json');
    assert.equal(SETTINGS.shopify.editable, true);
  });

  it('accepts the shipped example, which is what a fresh checkout seeds', () => {
    assert.equal(validate(BASE), null);
  });

  // --- the two that are dangerous precisely because they look fine -------------------------------
  it("refuses a lowercase 'draft', which the publish path would read as ACTIVE", () => {
    assert.match(validate(withPublish({ status: 'draft' })) || '', /exactly 'ACTIVE' or 'DRAFT'/);
    assert.match(validate(withPublish({ status: 'Draft' })) || '', /exactly 'ACTIVE' or 'DRAFT'/);
    assert.equal(validate(withPublish({ status: 'DRAFT' })), null);
    assert.equal(validate(withPublish({ status: 'ACTIVE' })), null);
  });

  it("refuses a stringy allowLive, which guardLiveStore reads as false while looking armed", () => {
    assert.match(validate(withPublish({ allowLive: 'true' })) || '', /allowLive must be boolean/);
    assert.match(validate(withPublish({ allowLive: 1 })) || '', /allowLive must be boolean/);
    assert.equal(validate(withPublish({ allowLive: true })), null);
    assert.equal(validate(withPublish({ allowLive: false })), null);
  });

  it('treats an ABSENT allowLive as legitimate, because the guard requires === true', () => {
    const c = cfg(); delete c.publish.allowLive;
    assert.equal(validate(c), null, 'absent means off; refusing it would break every older config file');
  });

  // --- the rest of the typo surface --------------------------------------------------------------
  it('refuses a store name that is not one of the two that exist', () => {
    assert.match(validate(cfg({ defaultStore: 'prod' })) || '', /must be 'dev' or 'live'/);
    assert.match(validate(cfg({ defaultStore: '' })) || '', /must be 'dev' or 'live'/);
  });

  it('refuses a non-boolean publish.enabled', () => {
    assert.match(validate(withPublish({ enabled: 'yes' })) || '', /enabled must be boolean/);
  });

  it('refuses a pin that is the wrong KIND of GID', () => {
    const c = cfg(); c.stores.dev.locationGid = 'gid://shopify/Product/1';
    assert.match(validate(c) || '', /must be empty or start with gid:\/\/shopify\/Location\//);
    const d = cfg(); d.stores.dev.publicationGid = 'gid://shopify/Location/1';
    assert.match(validate(d) || '', /must be empty or start with gid:\/\/shopify\/Publication\//);
  });

  it('allows an EMPTY pin, because that is how a store stays deliberately unreachable', () => {
    const c = cfg();
    c.stores.live.locationGid = '';
    c.stores.live.publicationGid = '';
    assert.equal(validate(c), null, 'live ships unpinned on purpose — guardPins refuses it at request time');
  });

  // --- the one rule that is about consequence rather than shape ----------------------------------
  //
  // It does not forbid going live; the owner is allowed to do that. It refuses to let the combination
  // arrive by ACCIDENT — armed, pointed at live, live writes permitted, and nobody has yet measured
  // which location and publication the products would land on.
  it('refuses live+armed+allowed while the live store has no pins', () => {
    const c = cfg({ defaultStore: 'live' });
    c.publish.enabled = true; c.publish.allowLive = true;
    c.stores.live.locationGid = ''; c.stores.live.publicationGid = '';
    assert.match(validate(c) || '', /live store has no pins/);
  });

  it('allows the same combination once live IS pinned — this is a guard, not a ban', () => {
    const c = cfg({ defaultStore: 'live' });
    c.publish.enabled = true; c.publish.allowLive = true;
    c.stores.live.locationGid = 'gid://shopify/Location/76355764358';
    c.stores.live.publicationGid = 'gid://shopify/Publication/146764234886';
    assert.equal(validate(c), null);
  });

  it('does not fire the live rule when any one leg is missing', () => {
    const legs = [
      { defaultStore: 'dev', enabled: true, allowLive: true },     // not pointed at live
      { defaultStore: 'live', enabled: false, allowLive: true },   // not armed
      { defaultStore: 'live', enabled: true, allowLive: false },   // live writes not permitted
    ];
    for (const l of legs) {
      const c = cfg({ defaultStore: l.defaultStore });
      c.publish.enabled = l.enabled; c.publish.allowLive = l.allowLive;
      c.stores.live.locationGid = ''; c.stores.live.publicationGid = '';
      assert.equal(validate(c), null, JSON.stringify(l));
    }
  });

  // apply() is what the save bar echoes back. It must never say "saved" and leave the operator
  // wondering whether a restart is owed — loadConfig re-reads per request, so none is.
  it('reports the resulting posture back to the operator, including the live one', () => {
    const armed = SETTINGS.shopify.apply(withPublish({ enabled: true, status: 'DRAFT', allowLive: true }));
    assert.match(armed, /no restart needed/);
    assert.match(armed, /publishing ARMED as DRAFT/);
    assert.match(armed, /LIVE WRITES ALLOWED/);
    const off = SETTINGS.shopify.apply(withPublish({ enabled: false, allowLive: false }));
    assert.match(off, /publishing off/);
    assert.match(off, /live writes blocked/);
  });
});
