// lib/ndjson.mjs — the one NDJSON streaming-response helper.
//
// Lifted verbatim out of lib/bulk.mjs (where it was module-private — bulkPlugin is that file's only
// export) so lib/listings.mjs can stream a batch publish without depending backwards on the bulk
// plugin. Same wire format both sides already speak: one JSON object per line, a terminating
// {summary} record, and errors as {warning}/{error} lines rather than a mid-stream 500 (GR7) —
// the status line is long gone by the time a row fails.
//
// The client reader is consumeNdjson() in bulk-listing-builder.html / stock-runner.html.
export function ndjsonStart(res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'access-control-allow-origin': '*', 'cache-control': 'no-cache' });
  return (obj) => res.write(JSON.stringify(obj) + '\n');
}
