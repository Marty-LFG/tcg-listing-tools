// test/unit/grader.test.mjs — pure seams of the AI vision pass (lib/grader.mjs): provider pick,
// reply-JSON extraction, and the v1/v2 dual-shape normalizer. No network — analyzeCard's provider
// calls are exercised live through the grader page, not here; everything below is what makes a
// model reply safe to hand to the client (clamps, null-preservation, plottable-defect hygiene).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCard, pickProvider, extractJson, normalize, normalizeImages, shotList, systemPrompt } from '../../lib/grader.mjs';

describe('pickProvider', () => {
  it('only ANTHROPIC_API_KEY → anthropic', () => {
    assert.equal(pickProvider({ ANTHROPIC_API_KEY: 'sk-a' }), 'anthropic');
  });
  it('only OPENAI_API_KEY → openai', () => {
    assert.equal(pickProvider({ OPENAI_API_KEY: 'sk-o' }), 'openai');
  });
  it('both keys + GRADER_PROVIDER=openai → openai (explicit pref beats the auto order)', () => {
    assert.equal(pickProvider({ ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o', GRADER_PROVIDER: 'openai' }), 'openai');
  });
  it('both keys, auto → anthropic (documented preference)', () => {
    assert.equal(pickProvider({ ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' }), 'anthropic');
  });
  it('neither key → null (the no_key path)', () => {
    assert.equal(pickProvider({}), null);
    assert.equal(pickProvider({ ANTHROPIC_API_KEY: '   ' }), null); // whitespace is not a key
  });
  it('explicit pref with the wrong key → null, never a silent provider switch', () => {
    assert.equal(pickProvider({ GRADER_PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk-o' }), null);
  });
});

describe('extractJson', () => {
  it('plain JSON', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  });
  it('fenced ```json block', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  });
  it('prose-wrapped braces', () => {
    assert.deepEqual(extractJson('Here is the assessment: {"a":{"b":2}} — hope that helps.'), { a: { b: 2 } });
  });
  it('garbage / empty → null, never a throw (GR7)', () => {
    assert.equal(extractJson('no json here'), null);
    assert.equal(extractJson('{broken'), null);
    assert.equal(extractJson(''), null);
    assert.equal(extractJson(null), null);
  });
});

// A full v1-flat reply, as today's model prompt produced.
const V1 = {
  corners: { front: 9, back: 8 },
  edges: { front: 8.5, back: 8 },
  surface: { front: 9, back: null },
  defects: [{ pillar: 'corners', side: 'front', location: 'top-left', severity: 'minor', gradeSignificant: false, note: 'light whitening' }],
  confidence: 0.7,
  reasoning: 'Front shown clearly; back not supplied.'
};

describe('normalize — v1 flat shape (backward compatible)', () => {
  it('passes flat scores through, granular is null', () => {
    const n = normalize(V1, ['img1']);
    assert.deepEqual(n.corners, { front: 9, back: 8 });
    assert.deepEqual(n.edges, { front: 8.5, back: 8 });
    assert.deepEqual(n.surface, { front: 9, back: null });
    assert.equal(n.granular, null);
    assert.equal(n.confidence, 0.7);
  });
  it('clamps out-of-range and snaps to 0.5 steps; junk → null', () => {
    const n = normalize({ corners: { front: 11, back: 0.2 }, edges: { front: 8.3, back: 'x' } });
    assert.equal(n.corners.front, 10);
    assert.equal(n.corners.back, 1);
    assert.equal(n.edges.front, 8.5);
    assert.equal(n.edges.back, null);
  });
  it('empty / null parse → all-null pillars, defaults, no throw', () => {
    const n = normalize(null);
    assert.deepEqual(n.corners, { front: null, back: null });
    assert.equal(n.granular, null);
    assert.deepEqual(n.defects, []);
    assert.equal(n.confidence, 0.5);
    assert.equal(n.reasoning, '');
  });
});

describe('normalize — v2 granular shape', () => {
  it('derives the flat aggregate as MIN of non-null cells (worst corner sets the score)', () => {
    const n = normalize({ corners: { front: { tl: 9, tr: 9.5, bl: 8, br: 9 } } });
    assert.equal(n.corners.front, 8);
    assert.deepEqual(n.granular.corners.front, { tl: 9, tr: 9.5, bl: 8, br: 9 });
  });
  it('null cells pass through unguessed and are skipped by the aggregate', () => {
    const n = normalize({
      corners: { front: { tl: 9, tr: null, bl: 8.5, br: null }, back: { tl: null, tr: null, bl: null, br: null } },
      edges: { front: { top: 9, right: 9, bottom: null, left: 7.5 } }
    });
    assert.equal(n.granular.corners.front.tr, null);
    assert.equal(n.corners.front, 8.5);          // min of the seen cells only
    assert.equal(n.corners.back, null);          // all cells null → no fabricated per-side score
    assert.deepEqual(n.granular.corners.back, { tl: null, tr: null, bl: null, br: null });
    assert.equal(n.edges.front, 7.5);
    assert.equal(n.edges.back, null);            // side absent entirely
    assert.equal(n.granular.edges.back, null);
  });
  it('cells are clamped like flat scores (range + 0.5 snap, junk → null)', () => {
    const n = normalize({ edges: { front: { top: 12, right: 0, bottom: 8.3, left: 'meh' } } });
    assert.deepEqual(n.granular.edges.front, { top: 10, right: 1, bottom: 8.5, left: null });
    assert.equal(n.edges.front, 1);
  });
  it('mixed reply: granular corners + flat edges — both usable, granular.edges null', () => {
    const n = normalize({
      corners: { front: { tl: 9, tr: 9, bl: 9, br: 8.5 }, back: { tl: 8, tr: 8, bl: 8, br: 8 } },
      edges: { front: 8, back: 7 },
      surface: { front: 9, back: 8 }
    });
    assert.equal(n.corners.front, 8.5);
    assert.equal(n.corners.back, 8);
    assert.deepEqual(n.edges, { front: 8, back: 7 });
    assert.notEqual(n.granular, null);
    assert.equal(n.granular.edges, null);
    assert.deepEqual(n.granular.corners.back, { tl: 8, tr: 8, bl: 8, br: 8 });
    assert.deepEqual(n.surface, { front: 9, back: 8 }); // surface stays per-side in v2
  });
});

describe('normalize — plottable defects', () => {
  const IDS = ['front', 'back', 'corner-tl'];
  it('valid imageRef keeps the plot trio, x/y clamped to [0,1]', () => {
    const n = normalize({ defects: [{ pillar: 'surface', side: 'front', imageRef: 'front', x: 1.4, y: -0.2, note: 'scratch' }] }, IDS);
    const d = n.defects[0];
    assert.equal(d.imageRef, 'front');
    assert.equal(d.x, 1);
    assert.equal(d.y, 0);
    assert.equal(d.note, 'scratch');
  });
  it('imageRef outside the supplied id set → trio dropped, defect KEPT', () => {
    const n = normalize({ defects: [{ pillar: 'edges', side: 'back', imageRef: 'hallucinated', x: 0.5, y: 0.5, location: 'top edge', severity: 'moderate', gradeSignificant: true, note: 'nick' }] }, IDS);
    assert.equal(n.defects.length, 1);
    const d = n.defects[0];
    assert.equal('imageRef' in d, false);
    assert.equal('x' in d, false);
    assert.equal('y' in d, false);
    assert.equal(d.location, 'top edge');
    assert.equal(d.gradeSignificant, true);
  });
  it('non-numeric coords cannot plot → trio dropped together, defect kept', () => {
    const n = normalize({ defects: [{ pillar: 'surface', side: 'front', imageRef: 'front', x: 'left-ish', y: 0.5, note: 'dimple' }] }, IDS);
    assert.equal('imageRef' in n.defects[0], false);
    assert.equal(n.defects[0].note, 'dimple');
  });
  it('no id set supplied (v1 caller) → every imageRef dropped, defects kept', () => {
    const n = normalize({ defects: [{ pillar: 'surface', side: 'front', imageRef: 'front', x: 0.5, y: 0.5 }] });
    assert.equal(n.defects.length, 1);
    assert.equal('imageRef' in n.defects[0], false);
  });
  it('defect cap holds at 40', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ pillar: 'surface', side: 'front', note: 'd' + i }));
    assert.equal(normalize({ defects: many }).defects.length, 40);
  });
  it('reasoning truncates at 800 chars', () => {
    assert.equal(normalize({ reasoning: 'r'.repeat(2000) }).reasoning.length, 800);
  });
});

describe('normalizeImages — request-shape compatibility + the 12-image cap', () => {
  it('v1 shape {mediaType,dataB64} → ids synthesized img1..imgN', () => {
    const out = normalizeImages([{ mediaType: 'image/png', dataB64: 'AAA' }, { dataB64: 'BBB' }]);
    assert.deepEqual(out.map(im => im.id), ['img1', 'img2']);
    assert.equal(out[0].mediaType, 'image/png');
    assert.equal(out[1].mediaType, 'image/jpeg'); // default preserved
  });
  it('v2 shape keeps caller ids', () => {
    const out = normalizeImages([{ id: 'front', dataB64: 'AAA' }, { id: 'corner-tl', dataB64: 'BBB' }]);
    assert.deepEqual(out.map(im => im.id), ['front', 'corner-tl']);
  });
  it('entries without dataB64 are dropped BEFORE ids are synthesized (no gaps in imgN)', () => {
    const out = normalizeImages([{ dataB64: '' }, { dataB64: 'AAA' }, null, { dataB64: 'BBB' }]);
    assert.deepEqual(out.map(im => im.id), ['img1', 'img2']);
  });
  it('caps at 12 (the guided wizard\'s full run), up from the old 8', () => {
    const out = normalizeImages(Array.from({ length: 15 }, (_, i) => ({ id: 's' + i, dataB64: 'x' })));
    assert.equal(out.length, 12);
    assert.equal(out[11].id, 's11');
  });
  it('no images → empty (the no_images path)', () => {
    assert.deepEqual(normalizeImages(null), []);
  });
});

describe('analyzeCard — pre-network guard rails (no provider call is ever reached)', () => {
  it('no key → { ok:false, error:"no_key" }, never a throw', async () => {
    const r = await analyzeCard({ images: [{ dataB64: 'x' }], env: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no_key');
  });
  it('key but no usable images → { ok:false, error:"no_images" }', async () => {
    const r = await analyzeCard({ images: [{ id: 'front' }], env: { ANTHROPIC_API_KEY: 'sk-a' } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no_images');
  });
});

describe('shotList / systemPrompt — the id roster the model may cite', () => {
  const IMGS = [{ id: 'front', dataB64: 'a' }, { id: 'back', dataB64: 'b' }];
  it('v2 context.shots labels by id', () => {
    const shots = shotList({ shots: [{ id: 'back', label: 'Back of card' }, { id: 'front', label: 'Front of card' }] }, IMGS);
    assert.deepEqual(shots, [{ id: 'front', label: 'Front of card' }, { id: 'back', label: 'Back of card' }]);
  });
  it('legacy imageLabels maps positionally; unlabelled images still enumerate', () => {
    const shots = shotList({ imageLabels: ['Front'] }, IMGS);
    assert.deepEqual(shots, [{ id: 'front', label: 'Front' }, { id: 'back', label: '' }]);
  });
  it('systemPrompt enumerates every supplied shot id and keeps the standing rules', () => {
    const s = systemPrompt([{ id: 'front', label: 'Front of card' }, { id: 'corner-tl', label: '' }]);
    assert.ok(s.includes('"front" — Front of card'));
    assert.ok(s.includes('"corner-tl"'));
    assert.ok(/centering/i.test(s));           // still forbidden
    assert.ok(s.includes('"tl"'));             // per-corner cells asked for
    assert.ok(s.includes('imageRef'));         // plottable defects asked for
    assert.ok(/null/.test(s));                 // unseen cells must be null, never guessed
  });
});
