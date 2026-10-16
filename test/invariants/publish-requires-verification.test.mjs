// test/invariants/publish-requires-verification.test.mjs — a row nobody has physically checked cannot
// reach the storefront. That is the whole point of lib/verification.mjs, so it is asserted here rather
// than trusted to a comment.
//
// THE FAILURE THIS PREVENTS. On 2026-10-16 the owner ruled that all stock is verified by hand against
// the physical item before it goes live (bk-shopify invariant 7 in full: most of the catalogue is
// one-of-one, conditions are graded by eye, and a listing states honestly whether it shows catalogue
// art or the item's own photograph). Before this there was nowhere to record such a check — no column on
// inventory_items at all, and a sealed_items.in_hand added with DEFAULT 1 whose 147 rows read 1 because
// nobody had said otherwise. A publish path that cannot refuse an unchecked row turns the ruling into a
// sentence in a file, which is the lesson bk-shopify D-021 already paid for: an invariant written in
// markdown became real only when it became a check that fails a publish.
//
// Three halves, because three different things can rot:
//   1. a publish surface stops consulting the ledger (source scan, the shape
//      runs-reservation-guards.test.mjs established);
//   2. the override stops being deliberate and becomes a config key somebody leaves switched on;
//   3. the gate is wired but does not actually refuse (behaviour, against a real temp database).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { openDbAt } from '../../lib/db.mjs';
import { recordVerification, assertVerified } from '../../lib/verification.mjs';
import { validateProduct, toShopifyProduct } from '../../lib/channels/shopify-map.mjs';
import { validateSealedShopifyProduct } from '../../lib/sealed-shopify.mjs';

// Set before lib/shopify.mjs is imported, so its module-level config path is a temp file and the
// operator's real data/shopify.config.json is never read or touched.
const CONFIG_PATH = tmpFile('shopify.config.json', 'tcg-verify-gate-cfg-');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ defaultStore: 'dev', stores: {} }));
process.env.TCG_SHOPIFY_CONFIG = CONFIG_PATH;
const { shopifyBatchPreflight, runShopifyPublish } = await import('../../lib/shopify.mjs');
const { seedStockLabels } = await import('../../lib/inventory.mjs');

const OWNER = 'verification.mjs';
const CODE = 'unverified';
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------------------------------------------------------------------------------------------------
// 1. every publish surface consults the ledger.

// file → why it can put stock on a storefront, and which shape of guard it carries. Two shapes,
// because two of these modules are deliberately PURE (no database handle, so they cannot ask the
// ledger anything): those take a flag their caller resolves, so for them the assertion is that the
// refusal appears, not that the module is imported. Both shapes are listed explicitly, so downgrading
// one to the other is an edit to this file.
const GUARDS = [
  ['lib/shopify.mjs', 'import', 'publishes a card to the Shopify storefront, singly and in batches'],
  ['lib/sealed-shopify.mjs', 'import', 'publishes a sealed pool to the Shopify storefront'],
  ['lib/channels/shopify-map.mjs', 'code', 'pure mapper; validateProduct refuses on a flag the caller sets'],
];

describe('every surface that puts stock on the storefront consults the verification ledger', () => {
  for (const [file, shape, why] of GUARDS) {
    it(`${file} (${why})`, () => {
      const s = src(file);
      if (shape === 'import') {
        const specifiers = [`from './${OWNER}'`, `from '../${OWNER}'`];
        assert.ok(specifiers.some((spec) => s.includes(spec)), `${file} must import lib/${OWNER} — it ${why}`);
      } else {
        assert.ok(s.includes(CODE), `${file} must refuse with '${CODE}' — it ${why}`);
      }
    });
  }

  // The refusal has to be in the SAME list as "no price" and "no identity_key", not in a gate of its
  // own. One gate is the point: a fourth caller inherits every refusal at once, or inherits none.
  it('the mapper refuses it in the same errors list as no-price and no-identity_key', () => {
    const s = src('lib/channels/shopify-map.mjs');
    const start = s.indexOf('export function validateProduct');
    assert.ok(start > 0, 'validateProduct moved or was renamed');
    const body = s.slice(start, s.indexOf('\nexport ', start + 10) > 0 ? s.indexOf('\nexport ', start + 10) : undefined);
    assert.match(body, /errors\.push\(String\(item\.unverified\)\)/,
      'the verification refusal must push onto the same errors array the other refusals use');
    assert.match(body, /no price/, 'the slice is the right function');
    assert.match(body, /no identity_key/);
  });

  // Refused before the shelf label is peeked and claimed, for the reason the reservation is: a label is
  // spent and a 'pending' mirror row is written on the way past, and neither unwinds.
  it('lib/shopify.mjs refuses BEFORE it claims a shelf label', () => {
    const s = src('lib/shopify.mjs');
    const from = s.indexOf('export async function runShopifyPublish');
    assert.ok(from > 0, 'runShopifyPublish moved or was renamed');
    const body = s.slice(from, s.indexOf('\nexport ', from + 10));
    const gate = body.indexOf('assertVerified(');
    const label = body.indexOf('reserveShelfLabel(');
    assert.ok(gate > 0, 'runShopifyPublish does not consult the ledger at all');
    assert.ok(label > 0, 'reserveShelfLabel moved; this ordering check has gone blind');
    assert.ok(gate < label, 'the refusal must come first, or every refused row burns a shelf label');
  });

  // A refusal that never reached the store is a different thing to an operator than a failure at the
  // store: one is a binder to open, the other is a look at Shopify.
  it('the batch counts an unverified row as REFUSED, not as failed', () => {
    const s = src('lib/shopify.mjs');
    const from = s.indexOf('export async function runShopifyBatchPublish');
    const body = s.slice(from, s.indexOf('\nexport ', from + 10) > 0 ? s.indexOf('\nexport ', from + 10) : undefined);
    assert.match(body, /const refused = [^;]*out\.code === 'unverified'/s,
      "'unverified' must join the refusal codes, or a card in an unopened binder is reported as a Shopify failure");
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. the override stays deliberate.

describe('the override is the owner asking, never a setting left switched on', () => {
  // Every lib module that mentions it, with comments stripped: a file EXPLAINING that the override must
  // not come from config is the outcome this test wants, and failing it for saying so would teach the
  // next person to delete the explanation rather than the code.
  const libFiles = (dir = path.join(ROOT, 'lib'), acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) libFiles(full, acc);
      else if (e.name.endsWith('.mjs')) acc.push(path.relative(ROOT, full));
    }
    return acc;
  };
  const code = (f) => src(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

  const mentions = libFiles().filter((f) => /allowUnverified|allow_unverified/.test(code(f)));

  it('finds the modules that carry it, so the scan below is not silently empty', () => {
    assert.ok(mentions.length >= 3, `only ${mentions.length} modules mention the override — did it move?`);
  });

  for (const f of mentions) {
    it(`${f} does not read the override from config or the environment`, () => {
      const bad = code(f).split(/\r?\n/).filter((line) => /allowUnverified|allow_unverified/.test(line)
        && /process\.env|loadShopifyConfig|cfg\.|config\.|\.publish\b/.test(line));
      assert.deepEqual(bad, [],
        `${f} sources the verification override from configuration:\n  ${bad.join('\n  ')}\n`
        + 'It must come from the request, per call, so it cannot be left on and forgotten.');
    });
  }

  it('and it is recorded wherever it is honoured, so a waiver is answerable afterwards', () => {
    const s = src(`lib/${OWNER}`);
    const from = s.indexOf('export function assertVerified');
    const body = s.slice(from, s.indexOf('\nexport ', from + 10));
    assert.match(body, /INSERT INTO stock_verifications/,
      'an override that writes nothing is a hidden override with extra steps');
    assert.match(body, /console\.warn/, 'and it is said out loud, not only written to a table');
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. it actually refuses. A detector that cannot fail is a comment with a green tick next to it.

let tmpDir, db;
const CFG = {
  defaultStore: 'dev',
  stores: { dev: { locationGid: 'gid://shopify/Location/1', publicationGid: 'gid://shopify/Publication/2' } },
  publish: { enabled: true, status: 'ACTIVE' },
  collections: {},
};

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-verify-gate-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
  seedStockLabels(db, 294);
});
after(() => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.unlinkSync(CONFIG_PATH); } catch { /* already gone */ }
});

// A card that is publishable in every OTHER respect: real label, price, condition, identity, image.
// That is what makes the assertion mean something — the only thing wrong with it is that nobody has
// looked at it.
let cardSeq = 0;
function publishableCard() {
  const sku = 'AAC-' + String(++cardSeq + 400).padStart(3, '0');
  return Number(db.prepare(`INSERT INTO inventory_items
    (sku, game, identity_key, name, set_name, set_code, number, rarity, variant, language, condition,
     quantity, target_price_cents, image_url, status)
    VALUES (?,'pokemon',?,'Pikachu','Base Set','BS1',?,'Common','Regular','EN','Near Mint',1,1299,
            'https://images.pokemontcg.io/base1/58.png','in_stock')`)
    .run(sku, 'base1-' + cardSeq, cardSeq + '/102').lastInsertRowid);
}
const verify = (kind, id) => {
  db.exec('BEGIN');
  try { recordVerification(db, { kind, itemId: id, outcome: 'verified', actor: 'test' }); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

describe('an unverified row cannot be published', () => {
  it('the preflight refuses it, and names verification rather than something else', () => {
    const id = publishableCard();
    const [row] = shopifyBatchPreflight(db, CFG, { itemIds: [id], store: 'dev' }).rows;
    assert.equal(row.ok, false, 'a card nobody has checked came back publishable');
    assert.ok(row.errors.some((e) => /never been checked against the physical item/.test(e)),
      'refused, but not for the right reason: ' + row.errors.join(' · '));
  });

  it('and the SAME row passes the preflight once somebody has checked it', () => {
    const id = publishableCard();
    verify('inventory', id);
    const [row] = shopifyBatchPreflight(db, CFG, { itemIds: [id], store: 'dev' }).rows;
    assert.deepEqual(row.errors, [], 'the gate is refusing a verified row');
    assert.equal(row.ok, true);
  });

  it('runShopifyPublish refuses with code "unverified", before it calls anything', async () => {
    const id = publishableCard();
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
    const out = await runShopifyPublish({
      env: {}, db, base: 'http://127.0.0.1:1', cfg: CFG, item, store: 'dev',
      // A fetch that throws if it is ever reached: the refusal must cost no round trip and stage no
      // permanent Shopify file.
      fetchImpl: () => { throw new Error('the publish path reached the network for an unverified row'); },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'unverified');
    assert.equal(out.steps.at(-1).step, 'verification');
  });

  it('the override publishes it, says so in a warning, and leaves the row unverified', async () => {
    const id = publishableCard();
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
    const out = await runShopifyPublish({
      env: {}, db, base: 'http://127.0.0.1:1', cfg: CFG, item, store: 'dev',
      allowUnverified: true, actor: 'marty',
      // Still no network: this asserts the GATE let it past, not that a publish succeeds. The run
      // fails later, at compose, which is exactly where a publish with no Shopify behind it should.
      fetchImpl: () => { throw new Error('no store in this test'); },
    });
    assert.notEqual(out.code, 'unverified', 'the override did not let the row past the gate');
    assert.equal(assertVerified(db, 'inventory', id).code, 'unverified',
      'the override laundered the row into verified; it must authorise one publish only');
  });

  it('a sold row is still refused on BOTH counts, so verifying one cannot unlock the other', () => {
    const id = publishableCard();
    verify('inventory', id);
    db.prepare("UPDATE inventory_items SET status = 'sold' WHERE id = ?").run(id);
    const [row] = shopifyBatchPreflight(db, CFG, { itemIds: [id], store: 'dev' }).rows;
    assert.equal(row.ok, false);
    assert.ok(row.errors.some((e) => /marked SOLD/.test(e)));
  });
});

// The negative controls. Both validators are pure, so the flag is the whole contract between them and
// their callers, and a flag that is read but not acted on would pass every test above.
describe('the pure validators act on the flag, not merely accept it', () => {
  it('validateProduct refuses when the caller sets it, and does not when it does not', () => {
    const id = publishableCard();
    verify('inventory', id);
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
    const product = toShopifyProduct(item, { collections: [], status: 'ACTIVE' });
    assert.deepEqual(validateProduct(product, item).errors, [], 'the fixture is not otherwise publishable');
    assert.deepEqual(
      validateProduct(product, { ...item, unverified: 'nobody has looked at this' }).errors,
      ['nobody has looked at this'],
      'the mapper ignored the flag its caller sets, so every lane publishing through it is unguarded');
  });

  it('validateSealedShopifyProduct refuses when the caller sets it', () => {
    const product = { kind: 'sealed', sku: 'BKS-X', quantity: 2, price_cents: 1000, title: 'Box', handle: 'box', weight_grams: 900, imageSources: ['x'] };
    const pool = { product_type: 'booster_box' };
    assert.deepEqual(validateSealedShopifyProduct(product, pool).errors, [], 'the fixture is not otherwise publishable');
    assert.deepEqual(
      validateSealedShopifyProduct(product, { ...pool, unverified: '2 rows unchecked' }).errors,
      ['2 rows unchecked']);
  });
});
