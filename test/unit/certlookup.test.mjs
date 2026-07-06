// test/unit/certlookup.test.mjs — cert-lookup dispatch (lib/certlookup.mjs).
// No network: PSA's provider short-circuits without PSA_API_TOKEN, and every other
// company has no provider at all (manual + verifyUrl fallback, GR7).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { certProviders, certLookup } from '../../lib/certlookup.mjs';

describe('certProviders registry', () => {
  const reg = certProviders();
  it('loads data/grading-companies.json', () => {
    assert.ok(Array.isArray(reg.companies));
    assert.ok(reg.companies.length >= 10, `got ${reg.companies.length}`);
  });
  it('contains the majors with unique codes', () => {
    const codes = reg.companies.map((c) => c.code);
    for (const major of ['PSA', 'BGS', 'CGC', 'SGC', 'TAG']) assert.ok(codes.includes(major), major);
    assert.equal(new Set(codes).size, codes.length, 'codes must be unique');
  });
});

describe('certLookup dispatch', () => {
  it('empty cert → no_cert, no verifyUrl', async () => {
    const r = await certLookup('PSA', '', {});
    assert.equal(r.matched, false);
    assert.equal(r.reason, 'no_cert');
    assert.equal(r.verifyUrl, null);
  });
  it('PSA without a token → matched:false (provider short-circuit, no fetch)', async () => {
    const r = await certLookup('psa', '12345678', {});
    assert.equal(r.matched, false);
    assert.equal(r.company, 'PSA');
    assert.ok(r.verifyUrl && r.verifyUrl.includes('12345678'), 'verifyUrl carries the cert');
  });
  it('registered company without an API → manual + official verifyUrl', async () => {
    const r = await certLookup('BGS', '0011223344', {});
    assert.equal(r.matched, false);
    assert.equal(r.manual, true);
    assert.equal(r.reason, 'no_api');
    assert.equal(r.company, 'BGS');
  });
  it('unknown company → unknown_company, still safe', async () => {
    const r = await certLookup('NOPE', '1', {});
    assert.equal(r.matched, false);
    assert.equal(r.reason, 'unknown_company');
    assert.equal(r.verifyUrl, null);
  });
});
