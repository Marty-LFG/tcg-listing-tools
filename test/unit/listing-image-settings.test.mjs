// test/unit/listing-image-settings.test.mjs — the settings gate on the compositor config
// (SETTINGS['listing-image'] in lib/status.mjs).
//
// The one field with its own story here is promoStar: it changes pixels on every Black Star Promo
// listing AND re-keys their content hashes (a full re-compose + re-upload on the next pass), so a
// typo saved from the web form must be refused rather than quietly becoming a third rendering mode.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../../lib/status.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const validate = SETTINGS['listing-image'].validate;
const BASE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'listing-image.config.example.json'), 'utf8'));

describe('listing-image settings', () => {
  it('is registered and editable — without that the settings card cannot save', () => {
    assert.ok(SETTINGS['listing-image']);
    assert.equal(SETTINGS['listing-image'].file, 'listing-image.config.json');
    assert.equal(SETTINGS['listing-image'].editable, true);
  });
  it('accepts the tracked template', () => {
    assert.equal(validate(BASE), null);
  });
  it('accepts both promo star modes, and absence (loadConfig defaults it)', () => {
    assert.equal(validate({ ...BASE, promoStar: 'inverted' }), null);
    assert.equal(validate({ ...BASE, promoStar: 'normal' }), null);
    const { promoStar, ...withoutIt } = BASE;
    assert.equal(validate(withoutIt), null);
  });
  it('refuses anything else — a typo must not become a third rendering mode', () => {
    for (const bad of ['Inverted', 'white', '', 0, true]) {
      assert.match(validate({ ...BASE, promoStar: bad }) || '', /promoStar/, `accepted ${JSON.stringify(bad)}`);
    }
  });
});
