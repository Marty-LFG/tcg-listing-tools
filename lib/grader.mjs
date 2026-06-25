// lib/grader.mjs — AI vision pass for the pre-grading tool. Dual provider: Anthropic OR OpenAI,
// whichever key is set (GRADER_PROVIDER=auto|anthropic|openai). Scores the condition pillars the
// camera CAN'T measure geometrically — corners, edges, surface — for the front AND back, plus a
// defect list. It deliberately does NOT grade centering (the browser measures that from the image).
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
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

const SYSTEM = [
  'You are a trading-card condition assessor assisting a pre-grading tool (PSA/BGS/CGC/SGC/TAG style).',
  'You are given photographs of one card (and possibly close-up/microscope shots). Assess ONLY these',
  'three pillars, scored 1-10 (10 = flawless), separately for the FRONT and the BACK:',
  '  - corners: whitening, fraying, soft/rounded or dinged corners',
  '  - edges: whitening, chipping, nicks, rough cuts along the four edges',
  '  - surface: scratches, print/roller lines, dimples, scuffs, indentations, stains, holo wear',
  'Do NOT assess centering — it is measured geometrically elsewhere; ignore border symmetry.',
  'Be CONSERVATIVE: photos hide fine surface defects and you usually cannot see the back well.',
  'If a side is not shown, score it null and lower your confidence. On holo/foil/gold/chrome, glare',
  'both hides real defects and mimics damage — say so and do not award a 10 on faith.',
  'Reply with ONLY a JSON object, no prose, no code fences, matching exactly:',
  '{"corners":{"front":<1-10|null>,"back":<1-10|null>},"edges":{"front":<1-10|null>,"back":<1-10|null>},',
  '"surface":{"front":<1-10|null>,"back":<1-10|null>},',
  '"defects":[{"pillar":"corners|edges|surface","side":"front|back","location":"<e.g. top-left, bottom edge>","severity":"minor|moderate|major","gradeSignificant":<true|false>,"note":"<short>"}],',
  '"confidence":<0-1>,"reasoning":"<2-3 sentences on what you could and could not see>"}'
].join(' ');

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

function userText(context) {
  const c = context || {};
  const bits = [];
  if (c.name) bits.push('Card: ' + c.name);
  if (c.number) bits.push('No: ' + c.number);
  if (c.set) bits.push('Set: ' + c.set);
  if (c.finish) bits.push('Finish: ' + c.finish);
  const labels = (c.imageLabels || []).filter(Boolean);
  let s = 'Assess this card per the system instructions.';
  if (bits.length) s += ' ' + bits.join(' · ') + '.';
  if (labels.length) s += ' Images provided, in order: ' + labels.join(', ') + '.';
  return s;
}

async function callAnthropic(images, context, env) {
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
    body: JSON.stringify({ model, max_tokens: 1024, system: SYSTEM, messages: [{ role: 'user', content }] })
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

async function callOpenAI(images, context, env) {
  const model = (env.GRADER_MODEL || '').trim() || DEFAULT_OPENAI_MODEL;
  const content = [{ type: 'text', text: userText(context) }];
  for (const im of images) {
    content.push({ type: 'image_url', image_url: { url: 'data:' + (im.mediaType || 'image/jpeg') + ';base64,' + im.dataB64 } });
  }
  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (env.OPENAI_API_KEY || '').trim(), 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 1024, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }]
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

function normalize(parsed) {
  const p = parsed || {};
  const pillar = (o) => ({ front: clampPillar(o && o.front), back: clampPillar(o && o.back) });
  return {
    corners: pillar(p.corners),
    edges: pillar(p.edges),
    surface: pillar(p.surface),
    defects: Array.isArray(p.defects) ? p.defects.slice(0, 40).map(d => ({
      pillar: String(d.pillar || ''), side: String(d.side || ''),
      location: String(d.location || ''), severity: String(d.severity || 'minor'),
      gradeSignificant: !!d.gradeSignificant, note: String(d.note || '').slice(0, 200)
    })) : [],
    confidence: (() => { const c = +p.confidence; return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5; })(),
    reasoning: String(p.reasoning || '').slice(0, 800)
  };
}

// analyzeCard({ images:[{mediaType,dataB64}], context, env }) -> { ok, provider, model, ...pillars } | { ok:false, error }
export async function analyzeCard({ images, context, env }) {
  try {
    const provider = pickProvider(env || {});
    if (!provider) return { ok: false, error: 'no_key', message: 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env (or GRADER_PROVIDER).' };
    const imgs = (images || []).filter(im => im && im.dataB64).slice(0, 8);
    if (!imgs.length) return { ok: false, error: 'no_images', message: 'No images supplied.' };

    const res = provider === 'anthropic' ? await callAnthropic(imgs, context, env) : await callOpenAI(imgs, context, env);
    const parsed = extractJson(res.text);
    if (!parsed) return { ok: false, error: 'parse', message: 'Model did not return parseable JSON.', raw: (res.text || '').slice(0, 400) };
    return Object.assign({ ok: true, provider, model: res.model }, normalize(parsed));
  } catch (e) {
    return { ok: false, error: 'provider', message: String((e && e.message) || e) };
  }
}
