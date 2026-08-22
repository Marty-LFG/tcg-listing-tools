// lib/grader.mjs — AI vision pass for the pre-grading tool. Dual provider: Anthropic OR OpenAI,
// whichever key is set (GRADER_PROVIDER=auto|anthropic|openai). Scores the condition pillars the
// camera CAN'T measure geometrically — corners, edges, surface — for the front AND back, plus a
// defect list. It deliberately does NOT grade centering (the browser measures that from the image).
//
// Schema v2: the guided wizard shoots up to 12 labelled images, so the model is asked per-corner
// (tl/tr/bl/br) and per-edge (top/right/bottom/left) scores per side, and each defect cites the
// shot it was seen in ("imageRef") plus a 0-1 x/y so the client can plot a marker on that photo.
// Both request shapes are accepted (v1 images had no ids — they get img1..imgN) and both reply
// shapes are normalized (a v1-flat reply passes through with granular:null), so old clients and
// old model outputs keep working: flat per-side scores are ALWAYS present, derived from the
// granular cells by min when the model went granular.
//
// Mirrors lib/pricecharting.mjs conventions: standalone, all network is server-side, and a failure
// ALWAYS returns { ok:false, error } and NEVER throws into the caller (Golden Rule 7) — a missing
// key or a provider outage must degrade the tool to centering-only, not break it.
//
// The model is the EXPLANATION layer over a measurement, never the measuring instrument: vision
// APIs downscale large images and are weak at sub-pixel judgement, so the prompt asks it to be
// conservative and to flag holo/glare uncertainty rather than over-claim a 10.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';

// The guided wizard's full run is 12 shots (front/back overview + 4 corners + edge strips + micro).
const IMAGE_CAP = 12;

const SYSTEM_BASE = [
  'You are a trading-card condition assessor assisting a pre-grading tool (PSA/BGS/CGC/SGC/TAG style).',
  'You are given photographs of one card, each identified by a shot id. Assess ONLY these three',
  'pillars, scored 1-10 (10 = flawless), separately for the FRONT and the BACK:',
  '  - corners: whitening, fraying, soft/rounded or dinged corners — score EACH corner (tl,tr,bl,br)',
  '  - edges: whitening, chipping, nicks, rough cuts — score EACH edge (top,right,bottom,left)',
  '  - surface: scratches, print/roller lines, dimples, scuffs, indentations, stains, holo wear — one score per side',
  'Score a corner or edge ONLY from an image that usably shows it: if none does, score that cell',
  'null. NEVER infer an unseen corner or edge from the ones you can see.',
  'Do NOT assess centering — it is measured geometrically elsewhere; ignore border symmetry.',
  'Be CONSERVATIVE: photos hide fine surface defects and you usually cannot see the back well.',
  'If a side is not shown, score all its cells null and lower your confidence. On holo/foil/gold/',
  'chrome, glare both hides real defects and mimics damage — say so and do not award a 10 on faith.',
  'Every defect should cite where you saw it: "imageRef" is one of the supplied shot ids, and',
  '"x","y" are fractions 0-1 of THAT image (0,0 = top-left corner), centred on the defect. Omit',
  'imageRef/x/y only when you cannot localise the defect to a single image.',
  'Reply with ONLY a JSON object, no prose, no code fences, matching exactly:',
  '{"corners":{"front":{"tl":<1-10|null>,"tr":<1-10|null>,"bl":<1-10|null>,"br":<1-10|null>},"back":{"tl":...,"tr":...,"bl":...,"br":...}},',
  '"edges":{"front":{"top":<1-10|null>,"right":<1-10|null>,"bottom":<1-10|null>,"left":<1-10|null>},"back":{"top":...,"right":...,"bottom":...,"left":...}},',
  '"surface":{"front":<1-10|null>,"back":<1-10|null>},',
  '"defects":[{"pillar":"corners|edges|surface","side":"front|back","imageRef":"<shot id>","x":<0-1>,"y":<0-1>,"location":"<e.g. top-left corner, bottom edge>","severity":"minor|moderate|major","gradeSignificant":<true|false>,"note":"<short>"}],',
  '"confidence":<0-1>,"reasoning":"<2-3 sentences on what you could and could not see>"}'
].join(' ');

// The shot roster goes in the SYSTEM prompt (not the user turn) so the id→content mapping carries
// the same authority as the scoring rules — imageRef must come from this list and nowhere else.
function systemPrompt(shots) {
  const list = (shots || []).filter(s => s && s.id);
  if (!list.length) return SYSTEM_BASE;
  const lines = list.map((s, i) => '  ' + (i + 1) + '. "' + s.id + '"' + (s.label ? ' — ' + s.label : ''));
  return SYSTEM_BASE + '\nImages are attached in this order (shot id — what it shows):\n' + lines.join('\n');
}

function pickProvider(env) {
  const pref = String(env.GRADER_PROVIDER || 'auto').toLowerCase();
  const hasA = !!(env.ANTHROPIC_API_KEY || '').trim();
  const hasO = !!(env.OPENAI_API_KEY || '').trim();
  if (pref === 'anthropic') return hasA ? 'anthropic' : null;
  if (pref === 'openai') return hasO ? 'openai' : null;
  // auto: prefer Anthropic, fall back to OpenAI
  if (hasA) return 'anthropic';
  if (hasO) return 'openai';
  return null;
}

// Pull a JSON object out of a model reply that may have stray prose or code fences.
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

// Accepts both request shapes: v2 [{id,mediaType,dataB64}] and v1 [{mediaType,dataB64}]. Ids are
// synthesized positionally (img1..imgN) when absent — the v1 client sends none at all, so mixed
// shapes (where a synthesized id could collide with a real one) don't occur in practice.
function normalizeImages(images) {
  const out = [];
  for (const im of images || []) {
    if (!im || !im.dataB64) continue;
    out.push({
      id: String(im.id || '') || 'img' + (out.length + 1),
      mediaType: im.mediaType || 'image/jpeg',
      dataB64: im.dataB64
    });
  }
  return out.slice(0, IMAGE_CAP);
}

// One roster entry per attached image, in attachment order. Labels come from context.shots
// [{id,label}] (v2) or positionally from the legacy context.imageLabels array (v1); an image
// nobody labelled still gets enumerated so its id is a legal imageRef.
function shotList(context, imgs) {
  const c = context || {};
  const byId = new Map();
  for (const s of Array.isArray(c.shots) ? c.shots : []) {
    if (s && s.id) byId.set(String(s.id), String(s.label || ''));
  }
  const legacy = Array.isArray(c.imageLabels) ? c.imageLabels : [];
  return imgs.map((im, i) => ({ id: im.id, label: byId.get(im.id) || String(legacy[i] || '') }));
}

function userText(context) {
  const c = context || {};
  const bits = [];
  if (c.name) bits.push('Card: ' + c.name);
  if (c.number) bits.push('No: ' + c.number);
  if (c.set) bits.push('Set: ' + c.set);
  if (c.finish) bits.push('Finish: ' + c.finish);
  let s = 'Assess this card per the system instructions.';
  if (bits.length) s += ' ' + bits.join(' · ') + '.';
  return s;
}

async function callAnthropic(images, context, env, system) {
  const model = (env.GRADER_MODEL || '').trim() || DEFAULT_ANTHROPIC_MODEL;
  const content = [{ type: 'text', text: userText(context) }];
  for (const im of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType || 'image/jpeg', data: im.dataB64 } });
  }
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': (env.ANTHROPIC_API_KEY || '').trim(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    // Opus 5 thinks by default and max_tokens caps thinking + response together, so 1024 would truncate
    // the JSON. Thinking is left on (no effort override): reading corners/edges/surface off a photo is
    // exactly the judgement call worth spending reasoning on. 6000 not 4000: the v2 reply carries 16
    // corner/edge cells plus plotted defects, so the JSON itself roughly doubled.
    body: JSON.stringify({ model, max_tokens: 6000, system, messages: [{ role: 'user', content }] })
  });
  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 300);
    try { const e = JSON.parse(text); detail = (e.error && (e.error.message || e.error.type)) || detail; } catch {}
    throw new Error('Anthropic HTTP ' + r.status + ': ' + detail);
  }
  const j = JSON.parse(text);
  const out = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { model, text: out };
}

async function callOpenAI(images, context, env, system) {
  const model = (env.GRADER_MODEL || '').trim() || DEFAULT_OPENAI_MODEL;
  const content = [{ type: 'text', text: userText(context) }];
  for (const im of images) {
    content.push({ type: 'image_url', image_url: { url: 'data:' + (im.mediaType || 'image/jpeg') + ';base64,' + im.dataB64 } });
  }
  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (env.OPENAI_API_KEY || '').trim(), 'content-type': 'application/json' },
    body: JSON.stringify({
      // max_completion_tokens, NOT max_tokens — deprecated on Chat Completions and rejected by the
      // GPT-5.x reasoning models. 2048 not 1024: reasoning tokens count against this cap too, and
      // the v2 JSON roughly doubled, so 1024 now risks a truncated reply surfacing as error:parse.
      model, max_completion_tokens: 2048, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content }]
    })
  });
  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 300);
    try { const e = JSON.parse(text); detail = (e.error && e.error.message) || detail; } catch {}
    throw new Error('OpenAI HTTP ' + r.status + ': ' + detail);
  }
  const j = JSON.parse(text);
  const out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return { model, text: out };
}

function clampPillar(v) {
  if (v == null) return null;
  const n = +v;
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(10, Math.round(n * 2) / 2));
}

const CORNER_KEYS = ['tl', 'tr', 'bl', 'br'];
const EDGE_KEYS = ['top', 'right', 'bottom', 'left'];

// One side of a granular pillar: an object of cells → each clamped (null passes through — the
// model saying "not shown" must survive normalization, never turn into a number). A non-object
// (v1-flat number, or absent) → null, meaning "this side did not come back granular".
function granularSide(o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const k of keys) out[k] = clampPillar(o[k]);
  return out;
}

// The flat per-side score old clients read, derived as the MIN of the non-null cells: graders
// score the worst corner/edge, not the average. All cells null → null (nothing usable was seen).
function aggregateSide(cells) {
  const seen = Object.values(cells).filter(v => v != null);
  return seen.length ? Math.min(...seen) : null;
}

// A pillar that may arrive granular (v2: {front:{tl..},back:{..}}) or flat (v1: {front:9,back:8})
// per side — even mixed across sides. Returns the granular cells (null side where flat) and the
// flat aggregate that is always present.
function pillarGroup(o, keys) {
  const g = {
    front: granularSide(o && o.front, keys),
    back: granularSide(o && o.back, keys)
  };
  const anyGranular = !!(g.front || g.back);
  return {
    granular: anyGranular ? g : null,
    flat: {
      front: g.front ? aggregateSide(g.front) : clampPillar(o && o.front),
      back: g.back ? aggregateSide(g.back) : clampPillar(o && o.back)
    }
  };
}

// normalize(parsed, imageIds) — imageIds is the list of shot ids actually sent, the only legal
// imageRef targets. Flat corners/edges/surface are always present (v1 result shape unchanged);
// `granular` is null unless the model returned per-cell scores somewhere.
function normalize(parsed, imageIds) {
  const p = parsed || {};
  const ids = new Set(imageIds || []);
  const corners = pillarGroup(p.corners, CORNER_KEYS);
  const edges = pillarGroup(p.edges, EDGE_KEYS);
  return {
    corners: corners.flat,
    edges: edges.flat,
    surface: { front: clampPillar(p.surface && p.surface.front), back: clampPillar(p.surface && p.surface.back) },
    granular: (corners.granular || edges.granular) ? { corners: corners.granular, edges: edges.granular } : null,
    defects: Array.isArray(p.defects) ? p.defects.slice(0, 40).map(d => {
      const out = {
        pillar: String(d.pillar || ''), side: String(d.side || ''),
        location: String(d.location || ''), severity: String(d.severity || 'minor'),
        gradeSignificant: !!d.gradeSignificant, note: String(d.note || '').slice(0, 200)
      };
      // Plot fields only when they can actually plot: an imageRef outside the supplied id set (or
      // coords that aren't numbers) would pin a marker on the wrong photo, so the trio is dropped
      // together — but the defect itself is KEPT; the observation is real even when unplaceable.
      const ref = d.imageRef == null ? '' : String(d.imageRef);
      const x = +d.x, y = +d.y;
      if (ref && ids.has(ref) && Number.isFinite(x) && Number.isFinite(y)) {
        out.imageRef = ref;
        out.x = Math.max(0, Math.min(1, x));
        out.y = Math.max(0, Math.min(1, y));
      }
      return out;
    }) : [],
    confidence: (() => { const c = +p.confidence; return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5; })(),
    reasoning: String(p.reasoning || '').slice(0, 800)
  };
}

// analyzeCard({ images:[{id?,mediaType,dataB64}], context, env }) ->
//   { ok, provider, model, corners, edges, surface, granular, defects, ... } | { ok:false, error }
// context.shots:[{id,label}] names each image for the prompt (legacy context.imageLabels accepted).
export async function analyzeCard({ images, context, env }) {
  try {
    const provider = pickProvider(env || {});
    if (!provider) return { ok: false, error: 'no_key', message: 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env (or GRADER_PROVIDER).' };
    const imgs = normalizeImages(images);
    if (!imgs.length) return { ok: false, error: 'no_images', message: 'No images supplied.' };

    const system = systemPrompt(shotList(context, imgs));
    const res = provider === 'anthropic' ? await callAnthropic(imgs, context, env, system) : await callOpenAI(imgs, context, env, system);
    const parsed = extractJson(res.text);
    if (!parsed) return { ok: false, error: 'parse', message: 'Model did not return parseable JSON.', raw: (res.text || '').slice(0, 400) };
    return Object.assign({ ok: true, provider, model: res.model }, normalize(parsed, imgs.map(im => im.id)));
  } catch (e) {
    return { ok: false, error: 'provider', message: String((e && e.message) || e) };
  }
}

// Internal seams exported for tests (pure — no network).
export { pickProvider, extractJson, normalize, normalizeImages, shotList, systemPrompt };
