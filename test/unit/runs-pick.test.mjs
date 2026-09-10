// test/unit/runs-pick.test.mjs — the physical pick check (lib/runs-pick.mjs).
//
// THE RULE THIS FILE ENFORCES: the model advises, it never decides. A vision model misreads digits, and a
// certification number is eight of them — so a false pass here would be worse than no check, because it
// would replace a person's attention with a machine's confidence about the one field a buyer later
// verifies. Every assertion below is either "it raised the thing a human needs to see" or "it did not
// quietly decide anything".
//
// No test makes a model call. `ask` is injected, which is the same seam consumeReservation uses for its
// decrementers and for the same reason: the thing being tested is the comparison, not the provider.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { crossCheck, checkPick, SYSTEM_PROMPT, userPrompt } from '../../lib/runs-pick.mjs';
import { ROOT } from '../helpers/extract-inline.mjs';

const slab = (over = {}) => ({
  slot: 'slab', kind: 'inventory', cert_number: '78595158', display_name: 'Dark Charizard',
  grading_company: 'PSA', grade: '10', qty: '1', ...over,
});
const packs = (over = {}) => ({ slot: 'packs', kind: 'sealed', display_name: 'M3 boosters', qty: '3', ...over });
const saw = (over = {}) => ({ cert: '78595158', name: 'Dark Charizard', grader: 'PSA', grade: '10', legible: true, ...over });

describe('a correct pick raises nothing', () => {
  it('is clean when the photo agrees with the manifest', () => {
    const r = crossCheck({ expected: [slab(), packs()], seen: { slabs: [saw()], sealed: [{ count: 3 }] } });
    assert.deepEqual(r.findings, []);
    assert.equal(r.clean, true);
  });

  it('tolerates the ways a cert is actually printed and read', () => {
    // A number read off a photograph arrives punctuated or spaced. The STORED value is what gets
    // committed; this comparison only decides whether two strings name the same slab.
    for (const cert of ['7859-5158', '7859 5158', ' 78595158 ']) {
      assert.equal(crossCheck({ expected: [slab()], seen: { slabs: [saw({ cert })] } }).clean, true, cert);
    }
  });

  it('and never claims the word "verified"', () => {
    // The strongest thing this module says is that it found nothing to raise, which is a different
    // statement and is worded that way everywhere it surfaces.
    const r = crossCheck({ expected: [slab()], seen: { slabs: [saw()] } });
    assert.ok(!('verified' in r));
    assert.ok(!JSON.stringify(r).toLowerCase().includes('verified'));
  });
});

describe('what a human is shown', () => {
  it('the cert is not in the photo at all — the finding that matters most', () => {
    const r = crossCheck({ expected: [slab()], seen: { slabs: [saw({ cert: '11112222' })] } });
    assert.equal(r.clean, false);
    const missing = r.findings.find((f) => f.severity === 'missing');
    assert.equal(missing.field, 'cert_number');
    assert.equal(missing.expected, '78595158');
    assert.match(missing.detail, /none of them reads as this certification number/);
  });

  it('the right slab, the wrong grade — the PSA 8 in a run of PSA 10s', () => {
    const r = crossCheck({ expected: [slab({ grade: '10' })], seen: { slabs: [saw({ grade: '8' })] } });
    const f = r.findings.find((x) => x.field === 'grade');
    assert.equal(f.severity, 'mismatch');
    assert.equal(f.expected, '10');
    assert.equal(f.seen, '8');
  });

  it('the right slab, the wrong grader', () => {
    const r = crossCheck({ expected: [slab()], seen: { slabs: [saw({ grader: 'BGS' })] } });
    assert.equal(r.findings.find((x) => x.field === 'grading_company').severity, 'mismatch');
  });

  it('a slab in the frame that this bundle does not own', () => {
    const r = crossCheck({ expected: [slab()], seen: { slabs: [saw(), saw({ cert: '99998888' })] } });
    const f = r.findings.find((x) => x.severity === 'unexpected');
    assert.match(f.detail, /99998888.*not in this bundle/);
  });

  it('a slab the model could not read — NOT a pass and NOT a failure', () => {
    const r = crossCheck({ expected: [slab()], seen: { slabs: [saw(), { cert: null, legible: false }] } });
    assert.equal(r.clean, false);
    assert.ok(r.findings.some((f) => f.severity === 'unreadable'));
  });

  it('a matching cert whose slab the model flagged as illegible — the match is not evidence', () => {
    const r = crossCheck({ expected: [slab()], seen: { slabs: [saw({ legible: false })] } });
    const f = r.findings.find((x) => x.severity === 'unreadable');
    assert.match(f.detail, /not evidence/);
  });

  // A name read off a label differs from a catalogue name constantly — abbreviated, punctuated, with or
  // without a set suffix. So a name disagreement on a MATCHING cert is 'review', never 'mismatch'.
  it('a name that reads differently on a matching cert is a look, not a failure', () => {
    const r = crossCheck({ expected: [slab()], seen: { slabs: [saw({ name: 'Charizard (Dark)' })] } });
    const f = r.findings.find((x) => x.field === 'display_name');
    assert.equal(f.severity, 'review');
  });
});

// Packs are the weak case and the module says so. Three packs of the right set is confirmable from a
// photograph; WHICH physical pack is not. So a pack is counted, never matched, and never fails.
describe('packs are reported, not matched', () => {
  it('a count disagreement is a review', () => {
    const r = crossCheck({ expected: [packs({ qty: '3' })], seen: { sealed: [{ count: 2 }] } });
    const f = r.findings.find((x) => x.field === 'sealed_count');
    assert.equal(f.severity, 'review');
    assert.match(f.detail, /which physical pack is which cannot be read from a picture/);
  });

  it('and no pack finding is ever a mismatch or a missing', () => {
    const r = crossCheck({ expected: [packs({ qty: '3' })], seen: { sealed: [{ count: 1 }] } });
    for (const f of r.findings) assert.ok(['review', 'unreadable'].includes(f.severity), f.severity);
  });
});

describe('the prompt asks what is visible, never whether it matches', () => {
  it('tells the model it does not know what was expected', () => {
    assert.match(SYSTEM_PROMPT, /You are NOT being asked whether anything matches/);
    assert.match(SYSTEM_PROMPT, /Do not .*guess|do not guess/i);
  });

  it('and the user message carries no expected values', () => {
    // A model given the answer will agree with it. The expected certs, names and grades are never sent —
    // every comparison happens in code, after the reading.
    const u = userPrompt('E1-007', ['slab', 'packs', 'art']);
    assert.match(u, /E1-007/);
    assert.ok(!u.includes('78595158'));
    assert.match(u, /Do not say whether anything is correct/);
  });
});

describe('the check degrades rather than passing', () => {
  it('a dead provider is not a clean bundle', async () => {
    const r = await checkPick({ bundleLabel: 'E1-001', expected: [slab()], images: [{ dataB64: 'x' }],
      ask: async () => ({ ok: false, error: 'no_key', message: 'no key' }) });
    assert.equal(r.ok, false);
    assert.equal(r.clean, false, 'a check that could not run must never look like a pass');
    assert.equal(r.advisory, true);
  });

  it('every response carries advisory:true, so no caller can treat it as an authority by forgetting', async () => {
    const good = await checkPick({ bundleLabel: 'E1-001', expected: [slab()], images: [{ dataB64: 'x' }],
      ask: async () => ({ ok: true, provider: 'anthropic', model: 'm', json: { slabs: [saw()] } }) });
    assert.equal(good.advisory, true);
    assert.equal(good.clean, true);
  });

  it('passes the images and prompts through, and nothing else', async () => {
    let got = null;
    await checkPick({ bundleLabel: 'E1-002', slots: ['slab'], expected: [slab()], images: [{ dataB64: 'abc' }],
      ask: async (args) => { got = args; return { ok: true, json: { slabs: [saw()] } }; } });
    assert.deepEqual(got.images, [{ dataB64: 'abc' }]);
    assert.equal(got.system, SYSTEM_PROMPT);
    assert.ok(!JSON.stringify(got).includes('78595158'), 'an expected cert reached the model');
  });
});

// THE GATE FOR R1-3: a photo mismatch is surfaced for a human and NEVER auto-applied. Asserted
// structurally, because it is a property of the module rather than of any one call: there is nothing in
// this file that could write, and no database handle for it to write through.
describe('the module cannot apply anything, by construction', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'runs-pick.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

  it('issues no write of any kind', () => {
    for (const sql of ['INSERT', 'UPDATE ', 'DELETE']) {
      assert.ok(!code.includes(sql), `runs-pick.mjs contains ${sql} — it advises, it does not decide`);
    }
  });

  it('takes no database handle, so it has nothing to write through', () => {
    assert.ok(!/\bdb\b/.test(code), 'runs-pick.mjs names a database handle');
    assert.ok(!code.includes('openDb'), 'runs-pick.mjs opens a database');
  });

  it('imports nothing that could write', () => {
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(imports, ['./runs-canonical.mjs'], 'the only static import is the encoding primitives');
  });
});
