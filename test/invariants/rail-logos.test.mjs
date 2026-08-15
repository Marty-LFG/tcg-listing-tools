// test/invariants/rail-logos.test.mjs — every game has a rail-logo fallback asset.
//
// composeMetaFor hands the compositor `setLogoAsset: 'logos/rail/<game>.png'` whenever a set has
// no wordmark of its own. loadSetArt returns null on a missing file WITHOUT ERROR (that is its
// design — art never blocks a listing), so a deleted or misnamed asset would silently strip the
// logo from every listing of that game. This is the loud version.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES } from '../../lib/normalize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('logos/rail/', () => {
  for (const game of GAMES) {
    it(`${game} has a rail logo asset`, () => {
      const p = path.join(ROOT, 'logos', 'rail', game + '.png');
      assert.ok(fs.existsSync(p), `logos/rail/${game}.png is missing`);
      const bytes = fs.readFileSync(p);
      assert.ok(bytes.length > 1000, `logos/rail/${game}.png is ${bytes.length}B — truncated?`);
      // PNG magic — a corrupt download saved as HTML is exactly how logos/swu.svg went bad.
      assert.equal(bytes.readUInt32BE(0), 0x89504e47, `logos/rail/${game}.png is not a PNG`);
    });
  }
});
