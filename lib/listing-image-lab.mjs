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
import { readJsonBody } from './req-body.mjs';
import { composeListingImage, describeCompositor, ComposeUnavailable } from './listing-image.mjs';
import {
  loadConfig, ensureConfigSeeded, resolveLayout, resolveVariant, railText,
  VARIANTS, PROFILES, DEFAULT_LAYOUT, LAYOUT_OVERRIDE_KEYS, TEXT_OVERRIDE_KEYS, ASSET_VERSION,
} from './listing-image-config.mjs';
import { clearAssetCache } from './listing-image-assets.mjs';
import { fetchCached } from './img-cache.mjs';

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
              overridable: { layout: LAYOUT_OVERRIDE_KEYS, text: TEXT_OVERRIDE_KEYS },
              status,
            });
          }

          // POST /preview { dataUrl|url, meta, options, layoutOverrides, textOverrides }
          if (p === '/preview' && method === 'POST') {
            const b = await readJsonBody(req, MAX_PREVIEW_BODY);
            const got = await readPreviewInput(b);
            if (got.error) return send(res, 400, { error: got.error });

            const cfg = loadConfig();
            const meta = b.meta && typeof b.meta === 'object' ? b.meta : {};
            // Overrides ride on the CALL, not on the saved config — the lab tunes, settings saves.
            const options = {
              cfg: requestScopedConfig(cfg, b),
              ...(b.options && b.options.variant ? { variant: b.options.variant } : {}),
            };

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
              variant: r.variant, textLines: r.textLines, card: r.card,
              layout: r.layout, bytes: r.buffer.length, ms: Date.now() - t0, source: got.source,
            });
          }

          // POST /resolve { meta, options, layoutOverrides } — geometry only, no rendering. Lets the
          // page echo the numbers live while a slider is still moving.
          if (p === '/resolve' && method === 'POST') {
            const b = await readJsonBody(req, MAX_SMALL_BODY);
            const meta = b.meta || {};
            const merged = requestScopedConfig(loadConfig(), b);
            try {
              const layout = resolveLayout(merged, meta, {});
              const variant = resolveVariant(meta, b.options || {}, merged);
              return send(res, 200, { layout, variant, textLines: railText(meta, layout) });
            } catch (e) { return send(res, 400, { error: e?.message || String(e) }); }
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
