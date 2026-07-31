// test/unit/repricer-config.test.mjs — the repricer's runtime config is now server-owned
// (gitignored) and seeded from a tracked example, so the seed + backfill have to actually work: a
// deploy that removes the file, or a release that adds a key, must not leave the settings dashboard
// rendering blanks that a save would then persist over the defaults.
//
// TCG_CONFIG_DIR must be set BEFORE lib/repricer.mjs loads — configFile() resolves it at module
// scope — hence the dynamic import (same pattern as test/integration/listings-revise.test.mjs).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.tmpdir(), 'tcg-repricer-cfg-' + process.pid);
process.env.TCG_CONFIG_DIR = DIR;
fs.mkdirSync(DIR, { recursive: true });
const { ensureConfigSeeded } = await import('../../lib/repricer.mjs');

const FILE = path.join(DIR, 'repricer.config.json');
const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const write = (o) => fs.writeFileSync(FILE, JSON.stringify(o, null, 2));

before(() => { try { fs.unlinkSync(FILE); } catch {} });
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe('repricer ensureConfigSeeded', () => {
  it('creates the runtime config from the tracked example when it is missing', () => {
    try { fs.unlinkSync(FILE); } catch {}
    ensureConfigSeeded();
    const c = read();
    assert.equal(c.guardrails.never_decrease, true);
    assert.equal(c.guardrails.required_confidence, 'medium', 'high is unsatisfiable on asking-only comps');
    assert.equal(c.scan_enabled, false, 'a fresh install must not start scanning on its own');
  });

  it('back-fills a top-level key added by a later release', () => {
    const c = read(); delete c.cadence_hours; write(c);
    ensureConfigSeeded();
    assert.equal(read().cadence_hours, 24);
  });

  it('back-fills a NESTED guardrail — the case a shallow backfill would miss', () => {
    const c = read(); delete c.guardrails.min_uplift_aud; write(c);
    ensureConfigSeeded();
    assert.equal(read().guardrails.min_uplift_aud, 1.0);
  });

  it('never overwrites a value the owner set', () => {
    const c = read();
    c.cadence_hours = 6;
    c.guardrails.min_uplift_pct = 25;
    c.exclude_seller_username = 'someone-else';
    write(c);
    ensureConfigSeeded();
    const after = read();
    assert.equal(after.cadence_hours, 6);
    assert.equal(after.guardrails.min_uplift_pct, 25);
    assert.equal(after.exclude_seller_username, 'someone-else');
  });

  it('survives a corrupt file without throwing (GR7)', () => {
    fs.writeFileSync(FILE, '{ not json');
    assert.doesNotThrow(() => ensureConfigSeeded());
  });
});
