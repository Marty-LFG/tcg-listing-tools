// test/unit/psa.test.mjs — language detection off a PSA descriptor (lib/psa.mjs).
// PSA prints the market into the Brand, not the Category, so a Japanese slab must not
// come back as EN. No network: detectLanguage is a pure string sniff.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, parseCertPage } from '../../lib/psa.mjs';

describe('detectLanguage', () => {
  it('reads JAPANESE out of the Brand even when Category is generic', () => {
    // The real bug: Category="TCG Cards", Brand carries the language.
    assert.equal(detectLanguage('POKEMON JAPANESE SV4M-FUTURE FLASH', 'TCG Cards', 'PORYGON-Z', 'ART RARE'), 'JP');
  });
  it('defaults to EN for an English slab', () => {
    assert.equal(detectLanguage('POKEMON EVOLVING SKIES', 'TCG Cards', 'UMBREON VMAX', 'ALTERNATE ART'), 'EN');
  });
  it('detects Korean and Chinese brands', () => {
    assert.equal(detectLanguage('POKEMON KOREAN SV1a-TRIPLET BEAT'), 'KO');
    assert.equal(detectLanguage('POKEMON CHINESE SV1-SCARLET EX'), 'ZH');
  });
  it('is empty-safe (no args, nulls) → EN', () => {
    assert.equal(detectLanguage(), 'EN');
    assert.equal(detectLanguage(null, undefined, ''), 'EN');
  });
  it('does not false-positive "JAPAN" inside an unrelated word', () => {
    assert.equal(detectLanguage('POKEMON JUNGLE'), 'EN');
  });
});

describe('parseCertPage', () => {
  // Mirrors the real cert page's <dt>Label</dt><dd>Value</dd> definition list (nested tags,
  // HTML entities, attributes) — this is the no-quota scrape fallback's parser.
  const html = `
    <dl>
      <div><dt class="a">Cert Number</dt><dd class="b">142716946</dd></div>
      <div><dt>Item Grade</dt><dd><span>GEM MT 10</span></dd></div>
      <div><dt>Year</dt><dd>2023</dd></div>
      <div><dt>Brand/Title</dt><dd>POKEMON JAPANESE SV4M-FUTURE FLASH</dd></div>
      <div><dt>Subject</dt><dd>PORYGON-Z</dd></div>
      <div><dt>Card Number</dt><dd>077</dd></div>
      <div><dt>Category</dt><dd>TCG Cards</dd></div>
      <div><dt>Variety/Pedigree</dt><dd>ART RARE</dd></div>
    </dl>`;
  const f = parseCertPage(html);
  it('extracts every labelled field (lowercased keys)', () => {
    assert.equal(f['brand/title'], 'POKEMON JAPANESE SV4M-FUTURE FLASH');
    assert.equal(f['subject'], 'PORYGON-Z');
    assert.equal(f['card number'], '077');
    assert.equal(f['item grade'], 'GEM MT 10');   // inner <span> stripped
    assert.equal(f['variety/pedigree'], 'ART RARE');
  });
  it('decodes HTML entities in values', () => {
    const g = parseCertPage('<dt>Brand/Title</dt><dd>POKEMON SWORD &amp; SHIELD</dd>');
    assert.equal(g['brand/title'], 'POKEMON SWORD & SHIELD');
  });
  it('empty / junk HTML → {} (never throws)', () => {
    assert.deepEqual(parseCertPage(''), {});
    assert.deepEqual(parseCertPage('<html><body>blocked</body></html>'), {});
    assert.deepEqual(parseCertPage(null), {});
  });
});
