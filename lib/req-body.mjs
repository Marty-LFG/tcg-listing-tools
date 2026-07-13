// lib/req-body.mjs — shared JSON request-body reader for the grader/print middlewares in
// vite.config.js. Moved verbatim from there. Do NOT unify with lib/catalog.mjs's separate copy —
// that one has different limit/error semantics; reconciling them is a follow-up, not this refactor.
export function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('payload too large (> ' + Math.round(limitBytes / 1e6) + 'MB)')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
