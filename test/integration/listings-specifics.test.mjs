// test/integration/listings-specifics.test.mjs — pushing the tool's item specifics onto a HAND-MADE
// listing via Trading ReviseItem.
//
// The rule that shapes everything: ItemSpecifics is a COMPLETE REPLACE — "all newly input Item
// Specifics will replace all existing Item Specific values, regardless of if the values changed" —
// and there is no way to delete a single pair. So a push that sent only our names would silently
// delete every specific the seller typed by hand. Read, merge, send the union, and never treat a
// failed read as "nothing to preserve".
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DB_PATH = path.join(os.tmpdir(), 'tcg-specifics-test-' + process.pid + '.db');
process.env.TCG_TRACKER_DB = DB_PATH;
const { openDb } = await import('../../lib/db.mjs');
const { pushListingSpecifics } = await import('../../lib/listings.mjs');
const { mergeItemSpecifics, buildReviseItemInner } = await import('../../lib/ebay-trading.mjs');

const ENV = { EBAY_APP_ID: 'PRD-x', EBAY_CERT_ID: 'PRD-y', EBAY_REFRESH_TOKEN: 'fake' };
const realFetch = globalThis.fetch;
let db, sent = [];

const theirSpecifics = `<ItemSpecifics>
  <NameValueList><Name>Card Name</Name><Value>Wailord</Value><Source>ItemSpecific</Source></NameValueList>
  <NameValueList><Name>Autograph Authentication</Name><Value>None</Value><Source>ItemSpecific</Source></NameValueList>
  <NameValueList><Name>UPC</Name><Value>820650850004</Value><Source>Product</Source></NameValueList>
</ItemSpecifics>`;

function stub({ getOk = true, specifics = theirSpecifics, reviseAck = 'Success', reviseErr = '' } = {}) {
  sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/oauth2/token')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) };
    const call = (opts.headers || {})['X-EBAY-API-CALL-NAME'] || '';
    sent.push({ call, body: String(opts.body || '') });
    if (call === 'GetItem') {
      return { ok: true, status: 200, text: async () => getOk
        ? `<GetItemResponse><Ack>Success</Ack><Item><ItemID>9001</ItemID>${specifics}</Item></GetItemResponse>`
        : '<GetItemResponse><Ack>Failure</Ack><Errors><LongMessage>Call limit reached</LongMessage></Errors></GetItemResponse>' };
    }
    return { ok: true, status: 200, text: async () => `<ReviseItemResponse><Ack>${reviseAck}</Ack>${reviseErr}</ReviseItemResponse>` };
  };
}
const revise = () => sent.find((s) => s.call === 'ReviseItem');

before(() => {
  try { fs.unlinkSync(DB_PATH); } catch {}
  db = openDb();
  const it = db.prepare(`INSERT INTO inventory_items (game,identity_key,name,set_name,number,variant,language,condition,quantity,status,sku,created_at,updated_at)
    VALUES ('pokemon','sv9-162','Wailord','Journey Together','162/159','Holo','EN','Ungraded, Near Mint',1,'in_stock','AAC-084',datetime('now'),datetime('now'))`).run();
  const ins = db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings (listing_id,sku,title,state,created_via,item_id) VALUES (?,?,?,?,?,?)`);
  ins.run('9001', 'AAC-084', 'Pokemon Wailord 162/159', 'active', 'manual', Number(it.lastInsertRowid));
  ins.run('9002', 'AAC-085', 'Unlinked one', 'active', 'manual', null);
  ins.run('9003', 'BK-1', 'Ours', 'active', 'tool', Number(it.lastInsertRowid));
  ins.run('9004', 'AAC-086', 'Ended one', 'ended', 'manual', Number(it.lastInsertRowid));
});
afterEach(() => { globalThis.fetch = realFetch; });
after(() => { try { fs.unlinkSync(DB_PATH); } catch {} });

describe('mergeItemSpecifics', () => {
  const theirs = [{ name: 'Card Name', values: ['Wailord'], source: 'ItemSpecific' },
    { name: 'Autograph Authentication', values: ['None'], source: 'ItemSpecific' },
    { name: 'UPC', values: ['820650850004'], source: 'Product' }];

  it('keeps what the seller typed that we have nothing to say about', () => {
    const { specifics } = mergeItemSpecifics(theirs, { 'Set': ['Journey Together'] });
    const names = specifics.map((s) => s.name);
    assert.ok(names.includes('Autograph Authentication'), 'a hand-typed specific must survive the replace');
    assert.ok(names.includes('Set'));
  });
  it('ours wins on a name we both have', () => {
    const { specifics } = mergeItemSpecifics(theirs, { 'Card Name': ['Wailord ex'] });
    assert.deepEqual(specifics.find((s) => s.name === 'Card Name').values, ['Wailord ex']);
  });
  it('never overrides a catalog-sourced pair', () => {
    const { specifics } = mergeItemSpecifics(theirs, { 'UPC': ['999'] });
    assert.deepEqual(specifics.find((s) => s.name === 'UPC').values, ['820650850004']);
  });
  it('caps at the schema limit and reports what it dropped', () => {
    const many = {}; for (let i = 0; i < 60; i++) many['Aspect ' + i] = ['v'];
    const r = mergeItemSpecifics([], many, { max: 45 });
    assert.equal(r.specifics.length, 45);
    assert.equal(r.dropped, 15);
  });
  it('drops empty values rather than sending blanks', () => {
    const { specifics } = mergeItemSpecifics([], { 'Set': [''], 'Game': ['Pokémon TCG'] });
    assert.deepEqual(specifics.map((s) => s.name), ['Game']);
  });
});

describe('buildReviseItemInner', () => {
  it('puts VerifyOnly OUTSIDE Item, where the WSDL has it', () => {
    const x = buildReviseItemInner({ itemId: '9001', specifics: [{ name: 'Set', values: ['Base'] }], verifyOnly: true });
    assert.match(x, /<\/Item><VerifyOnly>true<\/VerifyOnly>$/);
    assert.match(x, /<Item><ItemID>9001<\/ItemID><ItemSpecifics>/);
  });
  it('omits VerifyOnly when applying for real', () => {
    assert.doesNotMatch(buildReviseItemInner({ itemId: '9001', specifics: [{ name: 'A', values: ['b'] }] }), /VerifyOnly/);
  });
});

describe('pushListingSpecifics', () => {
  it('dry runs by default and sends the MERGED set, not just ours', async () => {
    stub();
    const r = await pushListingSpecifics(ENV, db, { listingId: '9001' });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.match(revise().body, /<VerifyOnly>true<\/VerifyOnly>/, 'a dry run must not persist');
    assert.match(revise().body, /Autograph Authentication/, 'the seller\'s own specific must be in the payload');
    assert.match(revise().body, /820650850004/, 'the catalog pair too');
    assert.ok(r.changes.some((c) => c.state === 'added'), 'and ours are added');
  });

  it('applies for real only when asked', async () => {
    stub();
    const r = await pushListingSpecifics(ENV, db, { listingId: '9001', dryRun: false });
    assert.equal(r.ok, true);
    assert.doesNotMatch(revise().body, /VerifyOnly/);
  });

  it('ABORTS when the current specifics cannot be read — never wipes on a failed read', async () => {
    stub({ getOk: false });
    const r = await pushListingSpecifics(ENV, db, { listingId: '9001' });
    assert.equal(r.ok, false);
    assert.match(r.error, /could not read/);
    assert.equal(revise(), undefined, 'nothing may be sent when we do not know what is there');
  });

  it('handles a listing that genuinely has no specifics yet', async () => {
    stub({ specifics: '' });                      // eBay omits the node entirely
    const r = await pushListingSpecifics(ENV, db, { listingId: '9001' });
    assert.equal(r.ok, true);
    assert.equal(r.before, 0);
    assert.ok(r.after > 0);
  });

  it('names a stale legacy value instead of returning a bare failure', async () => {
    // 5028 fails the WHOLE call, because the container is all-or-nothing.
    stub({ reviseAck: 'Failure', reviseErr: '<Errors><ErrorCode>5028</ErrorCode><LongMessage>Invalid value found for Item Specific "Model".</LongMessage><SeverityCode>Error</SeverityCode></Errors>' });
    const r = await pushListingSpecifics(ENV, db, { listingId: '9001' });
    assert.equal(r.ok, false);
    assert.equal(r.staleValue, true);
    assert.match(r.error, /no longer valid for this category/);
  });

  it('refuses an unlinked listing, one of ours, and an ended one', async () => {
    stub();
    const unlinked = await pushListingSpecifics(ENV, db, { listingId: '9002' });
    assert.equal(unlinked.code, 'unlinked');
    stub();
    assert.equal((await pushListingSpecifics(ENV, db, { listingId: '9003' })).code, 'wrong_api');
    stub();
    assert.match((await pushListingSpecifics(ENV, db, { listingId: '9004' })).error, /active/);
    assert.equal(sent.length, 0, 'refusals happen before eBay is touched');
  });
});
