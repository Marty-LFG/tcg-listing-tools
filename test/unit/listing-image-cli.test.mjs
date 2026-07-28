// test/unit/listing-image-cli.test.mjs — the batch CLI (scripts/compose-listing-images.mjs).
//
// The behaviours that matter for a backfill run over hundreds of scans: one bad file must not abort
// the batch, --dry-run must write nothing at all, and a re-run must be cheap rather than redoing
// work. Everything here goes through composeDir(); the main-module guard is not exercised.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, listInputs, composeDir, pool } from '../../scripts/compose-listing-images.mjs';
import { DEFAULT_CONFIG } from '../../lib/listing-image-config.mjs';
import { composeAvailable } from '../../lib/listing-image.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { sharpOrNull, fakeCard } from '../helpers/image-diff.mjs';

const sharp = await sharpOrNull();
const avail = sharp ? await composeAvailable(DEFAULT_CONFIG, 'default') : { ok: false, reasons: ['sharp missing'] };
const SKIP = sharp && avail.ok ? false : `compositor unavailable: ${avail.reasons.join('; ')}`;

describe('parseArgs', () => {
  it('parses the documented flags', () => {
    const o = parseArgs(['--in', 'a', '--out', 'b', '--variant', 'japanese', '--type', 'slab', '--language', 'Japanese', '--set', 'Mega Symphonia', '--concurrency', '8']);
    assert.equal(o.in, 'a');
    assert.equal(o.out, 'b');
    assert.equal(o.variant, 'japanese');
    assert.equal(o.type, 'slab');
    assert.equal(o.language, 'Japanese');
    assert.equal(o.setName, 'Mega Symphonia');
    assert.equal(o.concurrency, 8);
  });
  it('defaults concurrency to 4 and type to single', () => {
    const o = parseArgs(['--in', 'a', '--dry-run']);
    assert.equal(o.concurrency, 4);
    assert.equal(o.type, 'single');
    assert.equal(o.dryRun, true);
  });
  it('clamps concurrency instead of letting a typo fork 5000 composites', () => {
    assert.equal(parseArgs(['--in', 'a', '--dry-run', '--concurrency', '9999']).concurrency, 16);
    assert.equal(parseArgs(['--in', 'a', '--dry-run', '--concurrency', '8']).concurrency, 8);
    // Nonsense falls back to the default rather than to a surprising 1-wide run.
    assert.equal(parseArgs(['--in', 'a', '--dry-run', '--concurrency', '0']).concurrency, 4);
    assert.equal(parseArgs(['--in', 'a', '--dry-run', '--concurrency', '-3']).concurrency, 4);
    assert.equal(parseArgs(['--in', 'a', '--dry-run', '--concurrency', 'abc']).concurrency, 4);
  });
  it('rejects a missing --in, a missing --out, an unknown flag and a bad variant', () => {
    assert.throws(() => parseArgs(['--out', 'b']), /--in is required/);
    assert.throws(() => parseArgs(['--in', 'a']), /--out is required/);
    assert.throws(() => parseArgs(['--in', 'a', '--nope']), /unknown flag --nope/);
    assert.throws(() => parseArgs(['--in', 'a', '--dry-run', '--variant', 'ghost']), /--variant must be one of/);
  });
  it('rejects a flag whose value was swallowed by the next flag', () => {
    assert.throws(() => parseArgs(['--in', '--out', 'b']), /--in needs a value/);
  });
  it('--dry-run makes --out optional', () => {
    assert.equal(parseArgs(['--in', 'a', '--dry-run']).out, undefined);
  });
});

describe('listInputs', () => {
  it('takes a single file as-is', () => {
    const dir = tmpDir('cli-one-');
    const f = path.join(dir, 'card.jpg');
    fs.writeFileSync(f, 'x');
    assert.deepEqual(listInputs(f), [f]);
  });
  it('sweeps a directory for images only, sorted, ignoring subdirectories', () => {
    const dir = tmpDir('cli-sweep-');
    for (const n of ['b.jpg', 'a.png', 'notes.txt', 'c.webp', '.hidden']) fs.writeFileSync(path.join(dir, n), 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    assert.deepEqual(listInputs(dir).map((p) => path.basename(p)), ['a.png', 'b.jpg', 'c.webp']);
  });
});

describe('pool', () => {
  it('never runs more than `limit` workers at once', async () => {
    let live = 0, peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await pool(items, 4, async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--; return n * 2;
    });
    assert.ok(peak <= 4, `peaked at ${peak} concurrent workers, cap was 4`);
    assert.ok(peak > 1, 'never ran anything in parallel');
    assert.deepEqual(out, items.map((n) => n * 2), 'results must stay in input order');
  });
  it('handles fewer items than the limit', async () => {
    assert.deepEqual(await pool([1, 2], 8, async (n) => n + 1), [2, 3]);
  });
  it('handles an empty list without hanging', async () => {
    assert.deepEqual(await pool([], 4, async () => 1), []);
  });
});

describe('composeDir', { skip: SKIP }, () => {
  let inDir;
  before(async () => {
    inDir = tmpDir('cli-in-');
    for (const [name, w, h] of [['one', 733, 1024], ['two', 700, 1200], ['three', 600, 840]]) {
      fs.writeFileSync(path.join(inDir, name + '.jpg'), await fakeCard(w, h));
    }
  });

  it('composes every image and reports a summary', async () => {
    const out = tmpDir('cli-out-');
    const s = await composeDir({ in: inDir, out, type: 'single', concurrency: 4, cfg: DEFAULT_CONFIG });
    assert.equal(s.processed, 3);
    assert.equal(s.skipped, 0);
    assert.equal(s.failed, 0);
    for (const n of ['one', 'two', 'three']) {
      const f = path.join(out, n + '.jpg');
      assert.ok(fs.existsSync(f), `${n}.jpg not written`);
      const m = await sharp(f).metadata();
      assert.deepEqual([m.width, m.height], [1600, 1600]);
    }
  });

  it('--dry-run writes absolutely nothing', async () => {
    const out = tmpDir('cli-dry-');
    const s = await composeDir({ in: inDir, out, type: 'single', concurrency: 2, dryRun: true, cfg: DEFAULT_CONFIG });
    assert.equal(s.processed, 3);
    assert.equal(s.failed, 0);
    assert.deepEqual(fs.readdirSync(out), [], 'dry run left files behind');
    assert.ok(s.results.every((r) => r.dryRun && r.contentHash), 'dry run should still report the hash it would use');
  });

  it('a second run skips what already exists, and --force redoes it', async () => {
    const out = tmpDir('cli-skip-');
    await composeDir({ in: inDir, out, type: 'single', concurrency: 4, cfg: DEFAULT_CONFIG });
    const again = await composeDir({ in: inDir, out, type: 'single', concurrency: 4, cfg: DEFAULT_CONFIG });
    assert.equal(again.skipped, 3);
    assert.equal(again.processed, 0);
    const forced = await composeDir({ in: inDir, out, type: 'single', concurrency: 4, force: true, cfg: DEFAULT_CONFIG });
    assert.equal(forced.processed, 3);
    assert.equal(forced.skipped, 0);
  });

  it('one unreadable file fails alone — the rest of the batch still lands', async () => {
    const dir = tmpDir('cli-bad-');
    fs.writeFileSync(path.join(dir, 'good.jpg'), await fakeCard(733, 1024));
    fs.writeFileSync(path.join(dir, 'broken.jpg'), 'this is not an image');
    const out = tmpDir('cli-bad-out-');
    const s = await composeDir({ in: dir, out, type: 'single', concurrency: 2, cfg: DEFAULT_CONFIG });
    assert.equal(s.processed, 1);
    assert.equal(s.failed, 1);
    assert.ok(fs.existsSync(path.join(out, 'good.jpg')), 'the good file must still be written');
    const bad = s.results.find((r) => r.status === 'failed');
    assert.match(bad.file, /broken\.jpg$/);
    assert.ok(bad.error, 'a failure must carry a reason');
  });

  it('forwards metadata into the rail text and the variant choice', async () => {
    const out = tmpDir('cli-meta-');
    const s = await composeDir({ in: inDir, out, type: 'single', language: 'Japanese', setName: 'Mega Symphonia', concurrency: 4, cfg: DEFAULT_CONFIG });
    assert.ok(s.results.every((r) => r.variant === 'japanese'), 'language Japanese should pick the japanese rails');
  });

  it('an explicit --variant overrides what the metadata would pick', async () => {
    const s = await composeDir({ in: inDir, dryRun: true, type: 'single', language: 'Japanese', variant: 'default', concurrency: 4, cfg: DEFAULT_CONFIG });
    assert.ok(s.results.every((r) => r.variant === 'default'));
  });

  it('creates the output directory if it does not exist', async () => {
    const out = path.join(tmpDir('cli-mk-'), 'nested', 'deeper');
    const s = await composeDir({ in: inDir, out, type: 'single', concurrency: 4, cfg: DEFAULT_CONFIG });
    assert.equal(s.processed, 3);
    assert.equal(fs.readdirSync(out).length, 3);
  });
});
