// test/unit/labelprint.test.mjs — TSPL/ZPL job building (lib/labelprint.mjs).
// The printer expects TSPL ink bit = 0 (client sends 1=ink), so inversion is the
// invariant that decides whether labels print correctly or as photo-negatives.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { printConfig, buildTSPL, buildZPL, buildJob } from '../../lib/labelprint.mjs';

describe('printConfig', () => {
  it('disabled with no IP (GR7: tool degrades to download-only)', () => {
    const c = printConfig({});
    assert.equal(c.enabled, false);
    assert.equal(c.port, 9100);
    assert.equal(c.lang, 'tspl');
    assert.equal(c.dpi, 300);
    assert.equal(c.invert, false);
  });
  it('parses the env block', () => {
    const c = printConfig({
      LABEL_PRINTER_IP: ' 192.168.4.220 ', LABEL_PRINTER_PORT: '9101', LABEL_PRINTER_LANG: 'ZPL',
      LABEL_PRINTER_DPI: '203', LABEL_PRINTER_DENSITY: '12', LABEL_PRINTER_INVERT: 'TRUE',
    });
    assert.equal(c.enabled, true);
    assert.equal(c.ip, '192.168.4.220');
    assert.equal(c.port, 9101);
    assert.equal(c.lang, 'zpl');
    assert.equal(c.dpi, 203);
    assert.equal(c.invert, true);
  });
});

// A 2-byte-wide, 2-row bitmap: 0xFF 0x00 / 0xAA 0x55 (1 = ink, client convention).
const job = () => ({ data: Buffer.from([0xff, 0x00, 0xaa, 0x55]), widthDots: 16, heightDots: 2, wmm: 50, hmm: 30 });

describe('buildTSPL', () => {
  const cfg = printConfig({ LABEL_PRINTER_IP: 'x' });
  it('emits SIZE/GAP/DENSITY/CLS/BITMAP/PRINT and INVERTS ink bits (TSPL 0=black)', () => {
    const buf = buildTSPL([job()], cfg);
    const head = buf.toString('latin1');
    assert.match(head, /SIZE 50 mm, 30 mm/);
    assert.match(head, /GAP 3 mm, 0 mm/);
    assert.match(head, /DENSITY 10/);
    assert.match(head, /BITMAP 0,0,2,2,0,/);
    assert.match(head, /PRINT 1,1/);
    // the 4 data bytes sit between the BITMAP header and \r\nPRINT — inverted
    const at = buf.indexOf(Buffer.from('BITMAP 0,0,2,2,0,', 'latin1'));
    const data = buf.subarray(at + 17, at + 21);
    assert.deepEqual([...data], [0x00, 0xff, 0x55, 0xaa]);
  });
  it('LABEL_PRINTER_INVERT=true sends client bytes as-is', () => {
    const inv = printConfig({ LABEL_PRINTER_IP: 'x', LABEL_PRINTER_INVERT: 'true' });
    const buf = buildTSPL([job()], inv);
    const at = buf.indexOf(Buffer.from('BITMAP 0,0,2,2,0,', 'latin1'));
    assert.deepEqual([...buf.subarray(at + 17, at + 21)], [0xff, 0x00, 0xaa, 0x55]);
  });
  it('falls back to page size from config when the job has none', () => {
    const j = { ...job(), wmm: 0, hmm: 0 };
    assert.match(buildTSPL([j], cfg).toString('latin1'), /SIZE 100 mm, 50 mm/);
  });
  it('copies flow into PRINT', () => {
    const j = { ...job(), copies: 3 };
    assert.match(buildTSPL([j], cfg).toString('latin1'), /PRINT 3,1/);
  });
});

describe('buildZPL', () => {
  it('emits ^GFA hex with NO inversion (ZPL ink bit = 1, client convention)', () => {
    const cfg = printConfig({ LABEL_PRINTER_IP: 'x', LABEL_PRINTER_LANG: 'zpl' });
    const s = buildZPL([job()], cfg).toString('latin1');
    assert.match(s, /\^XA/);
    assert.match(s, /\^GFA,4,4,2,FF00AA55\^FS/);
    assert.match(s, /\^PQ1/);
  });
});

describe('buildJob dispatch', () => {
  it('routes on cfg.lang', () => {
    const tspl = printConfig({ LABEL_PRINTER_IP: 'x' });
    const zpl = printConfig({ LABEL_PRINTER_IP: 'x', LABEL_PRINTER_LANG: 'zpl' });
    assert.match(buildJob([job()], tspl).toString('latin1'), /SIZE 50 mm/);
    assert.match(buildJob([job()], zpl).toString('latin1'), /\^XA/);
  });
});
