// lib/listing-image-lab.mjs — the tuning harness behind listing-image-lab.html.
//
// Drop a photo in, drag the sliders, watch the composite update. Tuning rail width and card padding
// by editing a config file and re-running a script is miserable enough that nobody does it, and
// these constants are exactly the ones that need real photos to get right.
//
// A Vite dev-server plugin, per Golden Rule 1 — there is no production backend, so every server
// route in this repo is a plugin registered in vite.config.js.
//
// The layout the lab sends is REQUEST-SCOPED and never persisted. Saving is a separate, deliberate
// act through /api/settings (settings.html), so nobody rebrands the store by dragging a slider.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonBody } from './req-body.mjs';
import { composeListingImage, describeCompositor, ComposeUnavailable } from './listing-image.mjs';
import {
  loadConfig, ensureConfigSeeded, resolveLayout, resolveVariant, railText,
  VARIANTS, PROFILES, DEFAULT_LAYOUT, LAYOUT_OVERRIDE_KEYS, TEXT_OVERRIDE_KEYS, BADGE_OVERRIDE_KEYS, ASSET_VERSION, ROOT,
} from './listing-image-config.mjs';
import { GAMES } from './normalize.mjs';
import { findGameSetArt } from './set-art-data.mjs';
import { loadRiftboundData } from './riftbound-data.mjs';
import { getSetCards as getSwuSetCards } from './swu-cards-cache.mjs';
import { clearAssetCache } from './listing-image-assets.mjs';
import { fetchCached } from './img-cache.mjs';
// The SAME derivation the publish path uses. A preview that computed its own meta would drift from
// what actually gets listed — the whole value of an in-page preview is that it is not an
// approximation — so the stock row goes through one function, here and in runPublish.
import { composeMetaFor } from './listings.mjs';
import { catalogArtFor } from './onepiece-clean-art.mjs';
import { composeBandImage, composeOgImage } from './listing-image-bands.mjs';
import { TARGETS, TARGET_IDS, SHOPIFY_TARGET_FOR, resolveTarget } from './listing-image-targets.mjs';
import { buildImageSet } from './listing-image-names.mjs';
import { storePut, storeLookup, storeUrl, isStoreExt, isDownloadName, CONTENT_TYPE } from './listing-image-store.mjs';

// A preview is a full render at full size; anything larger than this is a mistake or an attack.
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
// The BODY limit has to allow for base64 inflation (~4/3) plus the JSON envelope around it.
// readJsonBody takes the limit as an argument and does not default it — pass `undefined` and the
// `size > limit` comparison is always false, i.e. no limit at all.
const MAX_PREVIEW_BODY = Math.ceil(MAX_INPUT_BYTES * 1.4);
const MAX_SMALL_BODY = 256 * 1024;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  // Deliberately no access-control-allow-origin: the lab is same-origin only, and this endpoint
  // renders arbitrary bytes for whoever asks.
  res.end(JSON.stringify(body));
}

const pick = (src, keys) => { const o = {}; for (const k of keys) if (src && src[k] !== undefined) o[k] = src[k]; return o; };

// Overlay the request's overrides onto the saved config for THIS CALL ONLY.
//
// The distinction that matters: a body that CARRIES an overrides object replaces the saved one
// wholesale (that is how the lab clears a knob — by no longer sending it), while a body that OMITS
// the key falls back to what is saved. Replacing unconditionally meant a preview with no overrides
// silently ignored the owner's saved layout, so "Save to settings" looked like it did nothing.
function requestScopedConfig(cfg, body) {
  const out = { ...cfg };
  if (body && body.layoutOverrides !== undefined) out.layoutOverrides = pick(body.layoutOverrides, LAYOUT_OVERRIDE_KEYS);
  if (body && body.textOverrides !== undefined) out.textOverrides = pick(body.textOverrides, TEXT_OVERRIDE_KEYS);
  if (body && body.badgeOverrides !== undefined) out.badgeOverrides = pick(body.badgeOverrides, BADGE_OVERRIDE_KEYS);
  return out;
}

// Decode whatever the page sent: a pasted data URL, a URL to fetch through the shared image cache,
// or a path already on disk. Exported so the shape is unit-testable without a server.
export async function readPreviewInput(body, { fetchImpl } = {}) {
  if (body.dataUrl) {
    const m = String(body.dataUrl).match(/^data:([^;]*);base64,([\s\S]+)$/);
    if (!m) return { error: 'dataUrl must be a base64 data: URL' };
    const buffer = Buffer.from(m[2], 'base64');
    if (!buffer.length) return { error: 'dataUrl decoded to nothing' };
    if (buffer.length > MAX_INPUT_BYTES) return { error: `image is ${(buffer.length / 1e6).toFixed(1)}MB; the cap is ${MAX_INPUT_BYTES / 1e6}MB` };
    return { buffer, source: 'upload' };
  }
  if (body.url) {
    if (!/^https?:\/\//i.test(body.url)) return { error: 'url must be http(s)' };
    const got = await fetchCached(body.url, fetchImpl ? { fetchImpl } : {});
    if (!got.buffer) return { error: 'could not fetch that image (HTTP ' + (got.httpStatus || '?') + ')' };
    return { buffer: got.buffer, source: 'url:' + got.status };
  }
  return { error: 'send dataUrl or url' };
}

// --- sample cards for rail-previews.html -----------------------------------------------------
//
// The previews page browses REAL rails for any game, so each sample carries a stockRow shaped
// exactly like the rows the builders/uploader write ("Name (CODE)" set names included) — the
// /preview route runs it through composeMetaFor, so what the page shows is what publish produces.
// Sources are the LOCAL card caches only (data/<game>-cards, the baked rosters): no upstream
// calls, and the browsable universe is honestly "the sets this store has touched".

const readJsonFile = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const listJsonFiles = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; } };

// One cached card -> { label, sub, art, stockRow } | null. Pure per game (ctx carries what the
// card itself lacks), exported for offline tests.
export function sampleFromCard(game, card, ctx = {}) {
  if (!card) return null;
  if (game === 'pokemon') {
    const set = card.set || {};
    const art = card.images && (card.images.large || card.images.small);
    if (!art || !card.name) return null;
    return {
      label: card.name, sub: `${set.name || '?'} · ${card.number}`, art,
      stockRow: { game, name: card.name, set_name: set.name || '', set_code: set.ptcgoCode || set.id || '', number: String(card.number || ''), rarity: card.rarity || '', language: 'EN' },
    };
  }
  if (game === 'mtg') {
    const faces = Array.isArray(card.card_faces) ? card.card_faces[0] : null;
    const uris = card.image_uris || (faces && faces.image_uris) || null;
    const art = uris && (uris.large || uris.normal);
    const code = String(card.set || ctx.setId || '').toUpperCase();
    if (!art || !card.name) return null;
    return {
      label: card.name, sub: `${card.set_name || code} · ${card.collector_number}`, art,
      stockRow: { game, name: card.name, set_name: `${card.set_name || code} (${code})`, number: String(card.collector_number || ''), rarity: card.rarity || '', language: String(card.lang || 'en').toUpperCase() },
    };
  }
  if (game === 'lorcana') {
    const set = card.set || {};
    const d = card.image_uris && card.image_uris.digital;
    const art = d && (d.large || d.normal);
    if (!art || !card.name) return null;
    const name = card.version ? `${card.name} - ${card.version}` : card.name;
    return {
      label: name, sub: `${set.name || '?'} · ${card.collector_number}`, art,
      stockRow: { game, name, set_name: `${set.name || ''} (${set.code || ''})`, number: String(card.collector_number || ''), rarity: card.rarity || '', language: 'EN' },
    };
  }
  if (game === 'swu') {
    if (!card.FrontArt || !card.Name) return null;
    const code = String(card.Set || ctx.setId || '').toUpperCase();
    const setName = ctx.setName || code;
    const name = card.Subtitle ? `${card.Name}, ${card.Subtitle}` : card.Name;
    const variant = card.VariantType && !/^normal$/i.test(card.VariantType) ? card.VariantType : '';
    return {
      label: name, sub: `${setName} · ${card.Number}${variant ? ' · ' + variant : ''}`, art: card.FrontArt,
      stockRow: { game, name, set_name: `${setName} (${code})`, number: String(card.Number || ''), rarity: card.Rarity || '', variant, language: 'EN' },
    };
  }
  if (game === 'onepiece') {
    if (!card.card_image || !card.card_name) return null;
    return {
      label: card.card_name, sub: `${card.set_name || '?'} · ${card.card_set_id}`, art: card.card_image,
      stockRow: { game, name: card.card_name, set_name: `${card.set_name || ''} (${card.set_id || ''})`, number: String(card.card_set_id || ''), rarity: card.rarity || '', variant: '', language: 'EN' },
    };
  }
  if (game === 'riftbound') {
    const set = ctx.set || {};
    if (!card.img || !card.name) return null;
    return {
      label: card.name, sub: `${set.name || '?'} · ${card.num}${card.rarity ? ' · ' + card.rarity : ''}`, art: card.img,
      stockRow: { game, name: card.name, set_name: `${set.name || ''} (${set.code || ''})`, number: String(card.num || ''), rarity: card.rarity || '', language: 'EN' },
    };
  }
  return null;
}

function collectSamples(game) {
  const out = [];
  const push = (s) => { if (s) out.push(s); };
  if (game === 'pokemon') {
    for (const f of listJsonFiles(path.join(ROOT, 'data', 'pkm-cards'))) {
      const doc = readJsonFile(path.join(ROOT, 'data', 'pkm-cards', f));
      for (const c of (doc && doc.cards) || []) push(sampleFromCard('pokemon', c));
    }
    // The baked Mega Evolution Promo roster — absent from pokemontcg.io, art off the keyless CDN.
    const mep = readJsonFile(path.join(ROOT, 'data', 'pokemon-mep.json'));
    for (const c of (mep && mep.cards) || []) {
      if (!c.img) continue;
      const bare = parseInt(c.number, 10);
      push({
        label: c.name, sub: `Mega Evolution Promo · ${c.number}`, art: `https://images.scrydex.com/pokemon/mep-${bare}/large`,
        stockRow: { game: 'pokemon', name: c.name, set_name: 'Mega Evolution Promo', set_code: 'mep', number: String(c.number), rarity: c.rarity || 'Promo', language: 'EN' },
      });
    }
  } else if (game === 'riftbound') {
    let doc = null;
    try { doc = loadRiftboundData(); } catch { doc = null; }
    for (const set of Object.values(doc || {})) {
      for (const c of (set && set.cards) || []) push(sampleFromCard('riftbound', c, { set }));
    }
  } else {
    const dirs = { mtg: 'mtg-cards', lorcana: 'lorcana-cards', swu: 'swu-cards', onepiece: 'onepiece-cards' };
    for (const f of listJsonFiles(path.join(ROOT, 'data', dirs[game]))) {
      const doc = readJsonFile(path.join(ROOT, 'data', dirs[game], f));
      const setId = (doc && doc.setId) || f.replace(/\.json$/, '');
      const setName = game === 'swu' ? ((findGameSetArt('swu', { code: setId }) || {}).name || setId.toUpperCase()) : undefined;
      for (const c of (doc && doc.cards) || []) {
        const s = sampleFromCard(game, c, { setId, setName });
        // One Piece thumbnails show the CLEAN TCGplayer scan wherever the bake maps one —
        // exactly what the composite will use — instead of Bandai's SAMPLE-watermarked art.
        if (s) s.art = catalogArtFor(s.stockRow, s.art);
        push(s);
      }
    }
  }
  return out;
}

export async function gameSamples(game, q = '', limit = 24) {
  // SWU has no stock/enumerate lane, so a host that has never browsed a set in the builder has an
  // EMPTY swu-cards dir and the page would show nothing at all. Warm the first set through the
  // cache layer once (it fetches from swu-db and PERSISTS, so this is a one-time cost per host).
  if (game === 'swu' && !listJsonFiles(path.join(ROOT, 'data', 'swu-cards')).length) {
    try { await getSwuSetCards('sor'); } catch { /* offline host — the empty state stands */ }
  }
  const all = collectSamples(game);
  const ql = String(q || '').trim().toLowerCase();
  if (ql) {
    const hit = (s) => s.label.toLowerCase().includes(ql) || s.sub.toLowerCase().includes(ql) || String(s.stockRow.number).toLowerCase().includes(ql);
    return { total: all.length, samples: all.filter(hit).slice(0, limit) };
  }
  // No query: an even spread across everything cached, so the page opens on variety (several
  // sets) rather than the first N collector numbers of one file.
  if (all.length <= limit) return { total: all.length, samples: all };
  const step = all.length / limit;
  const spread = [];
  for (let i = 0; i < limit; i++) spread.push(all[Math.floor(i * step)]);
  return { total: all.length, samples: spread };
}

export function listingImageLabPlugin() {
  return {
    name: 'listing-image-lab',
    configureServer(server) {
      // Recreate the gitignored server-owned config a fresh clone or a deploy will not have, so
      // /api/settings can read and write it. Same shape as listings/postsale/refresh.
      ensureConfigSeeded();
      server.middlewares.use('/api/listing-image', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const p = url.pathname.replace(/\/+$/, '') || '/';
          const method = req.method;
          if (method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
            res.setHeader('access-control-allow-headers', 'content-type');
            return res.end();
          }

          // GET /file/<sha256>.<ext>[/<download-name>] — the content-addressed store.
          //
          // Dispatched HERE rather than registered as its own middleware: connect matches by
          // REGISTRATION ORDER, not longest prefix, so a second use('/api/listing-image/file') would
          // be shadowed by this handler entirely. Same trap vite.config.js documents for /api/rbs
          // before /api/rb.
          const fileMatch = /^\/file\/([0-9a-f]{64})\.([a-z0-9]+)(?:\/([^/]+))?$/.exec(p);
          if (fileMatch && method === 'GET') {
            const [, hash, ext, rawName] = fileMatch;
            if (!isStoreExt(ext)) return send(res, 404, { error: 'not found' });
            const hit = storeLookup(hash, [ext]);
            if (!hit) return send(res, 404, { error: 'not found' });
            let body;
            try { body = fs.readFileSync(hit.file); } catch { return send(res, 404, { error: 'not found' }); }
            res.statusCode = 200;
            res.setHeader('content-type', CONTENT_TYPE[hit.ext] || 'application/octet-stream');
            res.setHeader('content-length', String(body.length));
            // Content-addressed, so this is free AND correct: the bytes at this URL cannot change.
            res.setHeader('cache-control', 'public, max-age=31536000, immutable');
            // The name is re-serialised from a validated value, never echoed — an unchecked one is
            // a header-injection hole, and it plays no part in finding the bytes.
            let name = '';
            try { name = decodeURIComponent(rawName || ''); } catch { name = ''; }
            if (isDownloadName(name)) res.setHeader('content-disposition', `inline; filename="${name}"`);
            return res.end(body);
          }

          // GET /targets — the output-frame registry, for the pages that offer a target picker.
          if (p === '/targets' && method === 'GET') {
            const cfg = loadConfig();
            return send(res, 200, {
              targets: TARGET_IDS.map((id) => {
                const t = TARGETS[id];
                const f = t.frame({ canvas: cfg.layoutOverrides?.canvas || 1600 });
                return { id, channel: t.channel, rails: t.rails, width: f.width, height: f.height, format: t.format, ext: t.ext };
              }),
              shopifyTargetFor: SHOPIFY_TARGET_FOR,
              shopify: cfg.shopify,
            });
          }

          // POST /build { stockRow|meta, dataUrl|url, sku, targets:[...] }
          // Renders the requested frames, writes them to the content-addressed store and returns
          // the ordered manifest — filenames, alt text and URLs — that a Shopify push consumes.
          if (p === '/build' && method === 'POST') {
            const b = await readJsonBody(req, MAX_PREVIEW_BODY);
            if (b && b.stockRow && !b.dataUrl) b.url = catalogArtFor(b.stockRow, b.url);
            const got = await readPreviewInput(b);
            if (got.error) return send(res, 400, { error: got.error });
            const meta = b.meta || (b.stockRow ? composeMetaFor(b.stockRow) : {});
            const cfg = loadConfig();
            // Catalog art arrives pre-cropped and the trim detector eats real art off a borderless
            // printing, so the same rule the publish path uses applies here.
            const options = { cfg };
            if (got.source && got.source.startsWith('url')) options.trim = false;

            const wanted = Array.isArray(b.targets) && b.targets.length
              ? b.targets
              : [SHOPIFY_TARGET_FOR[meta.productType || 'single'] || SHOPIFY_TARGET_FOR.single];
            const rendered = [];
            const warnings = [];
            for (const id of wanted) {
              let target;
              try { target = resolveTarget(id); } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
              try {
                const r = target.id === 'og-card'
                  ? await composeOgImage(got.buffer, meta, options)
                  : await composeBandImage(got.buffer, meta, { ...options, target: target.id });
                storePut(r.contentHash, target.ext, r.buffer);
                rendered.push({ view: b.viewFor?.[id] || (target.id === 'og-card' ? 'og' : 'front'), target: target.id, result: { ...r, ext: target.ext } });
              } catch (e) {
                // GR7: one frame failing must not lose the others.
                warnings.push(`${id}: ${e instanceof ComposeUnavailable ? 'unavailable' : 'failed'} — ${e?.message || e}`);
              }
            }
            if (!rendered.length) return send(res, 503, { error: 'nothing could be rendered', warnings });
            let manifest;
            try {
              manifest = buildImageSet({ item: b.stockRow || {}, meta, sku: b.sku || (b.stockRow && b.stockRow.sku), rendered, urlFor: storeUrl });
            } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
            return send(res, 200, { manifest, warnings, source: got.source });
          }

          // GET /config — everything the page needs to build its controls and show readiness.
          if (p === '/config' && method === 'GET') {
            const cfg = loadConfig();
            const status = await describeCompositor(cfg);
            return send(res, 200, {
              assetVersion: ASSET_VERSION,
              config: cfg,
              defaults: DEFAULT_LAYOUT,
              profiles: PROFILES,
              variants: VARIANTS,
              overridable: { layout: LAYOUT_OVERRIDE_KEYS, text: TEXT_OVERRIDE_KEYS, badge: BADGE_OVERRIDE_KEYS },
              status,
            });
          }

          // POST /preview { dataUrl|url, meta, options, layoutOverrides, textOverrides }
          if (p === '/preview' && method === 'POST') {
            const b = await readJsonBody(req, MAX_PREVIEW_BODY);
            // The publish path swaps One Piece art for the clean TCGplayer scan (buildRowIn), so
            // the preview must too — "not an approximation" is the page's whole contract, and the
            // uploader only knows the optcgapi URL. An owner-photo dataUrl still wins, exactly as
            // staged photos replace catalog art at publish.
            if (b && b.stockRow && !b.dataUrl) b.url = catalogArtFor(b.stockRow, b.url);
            const got = await readPreviewInput(b);
            if (got.error) return send(res, 400, { error: got.error });

            const cfg = loadConfig();
            // `stockRow` is what the uploader sends: the row it is about to save. Running it through
            // composeMetaFor means the preview is byte-identical to what publish will produce.
            // Explicit `meta` still wins, so the lab can drive arbitrary combinations.
            //
            // card_facts is merged FIRST, exactly as itemToListing does before its own
            // composeMetaFor call (lib/listings.mjs). The uploader sends card_facts as a JSON
            // string, so set_code — which is not a column, only a fact — was invisible here. For an
            // English row that went unnoticed because findIntlSet matches on set_name too; for a
            // non-English row whose set_name is a printed code it resolved nothing, and the preview
            // drew ENGLISH rails for a card that publishes with Japanese ones. A preview this page
            // promises is "not an approximation" must not diverge from publish.
            const stockRow = b.stockRow && typeof b.stockRow === 'object' ? { ...b.stockRow } : null;
            if (stockRow && stockRow.card_facts) {
              // A string is what the uploader posts and what the DB stores; an object is what a
              // hand-rolled call is likely to send. Accept either rather than silently merging
              // neither, which is the failure mode this block exists to remove.
              try {
                const f = typeof stockRow.card_facts === 'string' ? JSON.parse(stockRow.card_facts) : stockRow.card_facts;
                if (f && typeof f === 'object') Object.assign(stockRow, f);
              } catch {}
            }
            const meta = b.meta && typeof b.meta === 'object' ? b.meta
              : stockRow ? composeMetaFor(stockRow)
                : {};
            // Overrides ride on the CALL, not on the saved config — the lab tunes, settings saves.
            const options = {
              cfg: requestScopedConfig(cfg, b),
              ...(b.options && b.options.variant ? { variant: b.options.variant } : {}),
            };

            // URL sources are catalog art and skip the trim detector, exactly as publish does
            // (borderless printings lose real art to it); an UPLOADED photo keeps the trim,
            // exactly as the owner-photo path does.
            if (got.source && got.source.startsWith('url')) options.trim = false;

            const t0 = Date.now();
            let r;
            try { r = await composeListingImage(got.buffer, meta, options); }
            catch (e) {
              // A bad slider combination is a 400, not a 500: the owner asked for geometry that
              // cannot close, and the page should say so next to the slider that did it.
              const unavailable = e instanceof ComposeUnavailable;
              return send(res, unavailable ? 503 : 400, { error: e?.message || String(e), unavailable });
            }
            return send(res, 200, {
              dataUrl: 'data:image/jpeg;base64,' + r.buffer.toString('base64'),
              width: r.width, height: r.height,
              contentHash: r.contentHash, composeVersion: r.composeVersion,
              variant: r.variant, textLines: r.textLines, card: r.card, badge: r.badge,
              layout: r.layout, bytes: r.buffer.length, ms: Date.now() - t0, source: got.source,
            });
          }

          // POST /resolve { meta, options, layoutOverrides } — geometry only, no rendering. Lets the
          // page echo the numbers live while a slider is still moving.
          if (p === '/resolve' && method === 'POST') {
            const b = await readJsonBody(req, MAX_SMALL_BODY);
            const meta = b.meta || (b.stockRow ? composeMetaFor(b.stockRow) : {});
            const merged = requestScopedConfig(loadConfig(), b);
            try {
              const layout = resolveLayout(merged, meta, {});
              const variant = resolveVariant(meta, b.options || {}, merged);
              return send(res, 200, { layout, variant, textLines: railText(meta, layout) });
            } catch (e) { return send(res, 400, { error: e?.message || String(e) }); }
          }

          // GET /samples?game=&q=&limit= — cached cards shaped into publish-identical stockRows
          // for rail-previews.html. Local reads only; the browsable universe is the sets this
          // store has actually touched.
          if (p === '/samples' && method === 'GET') {
            const game = String(url.searchParams.get('game') || 'pokemon').toLowerCase();
            if (!GAMES.includes(game)) return send(res, 400, { error: `unknown game: ${game} (have: ${GAMES.join(', ')})` });
            const q = url.searchParams.get('q') || '';
            const limit = Math.max(1, Math.min(60, parseInt(url.searchParams.get('limit'), 10) || 24));
            const r = await gameSamples(game, q, limit);
            return send(res, 200, { game, total: r.total, samples: r.samples });
          }

          // POST /reload-assets — pick up freshly dropped rail art without restarting the server.
          if (p === '/reload-assets' && method === 'POST') {
            clearAssetCache();
            const status = await describeCompositor(loadConfig());
            return send(res, 200, { ok: true, status });
          }

          return send(res, 404, { error: 'unknown listing-image route: ' + p });
        } catch (e) {
          console.error('[listing-image-lab] error:', e?.message || e);
          return send(res, 500, { error: 'listing-image lab error', detail: String(e?.message || e) });
        }
      });
      console.log('[listing-image-lab] API /api/listing-image · lab at /listing-image-lab.html');
    },
  };
}
