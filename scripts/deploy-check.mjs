// scripts/deploy-check.mjs <expected-commit> — waits for the restarted dev server and proves it is
// serving the code on disk: /api/status must report the expected commit AND plugins.stale false.
// The commit alone is not enough (AGENTS.md §20: a stale process can report the new commit while
// running the old plugin list), which is why both are checked. Exit 0 only when both hold.
const want = String(process.argv[2] || '').slice(0, 7);
const url = 'http://127.0.0.1:5273/api/status';
const deadline = Date.now() + 120_000;
let last = 'no answer yet';

while (Date.now() < deadline) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const s = await r.json();
      const commit = s?.version?.commit || '?';
      const stale = s?.plugins?.stale;
      last = `commit ${commit}, stale ${stale}, ${s?.plugins?.plugins_running ?? '?'} plugins`;
      if ((!want || commit.startsWith(want)) && stale === false) {
        console.log(`\nDEPLOYED: ${last}`);
        process.exit(0);
      }
    } else {
      last = `HTTP ${r.status}`;
    }
  } catch (e) {
    last = e.message;
  }
  await new Promise((res) => setTimeout(res, 3000));
}
console.error(`\nNOT CONFIRMED after 2 minutes (wanted ${want || 'any commit'}): ${last}`);
process.exit(1);
