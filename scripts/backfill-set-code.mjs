// scripts/backfill-set-code.mjs — fill card_facts.set_code on stock rows that have none.
//
// WHY. `bkc.set_code` is a REQUIRED field on the bk_card_identity metaobject, so a row without one gets
// no identity, and a card with no identity can never appear in the PDP condition selector — the whole
// of bk-shopify D-026. It is not a column: it lives inside inventory_items.card_facts.
//
// Only lib/stock-games.mjs ever wrote it. The three insert paths in lib/inventory.mjs (manual add, bulk
// raw import, grading promotion) never did, so every row they created has gone without. 24 found on
// 2026-08-25, the day Radiant Gardevoir published with no identity. Those paths are fixed now
// (stampSetCode) — this is the one-time repair for rows that predate the fix.
//
// IT NEVER GUESSES. Every match is a re-spelling of the name the row already carries: dropping a
// "Pokemon" prefix, a language word, or a series name the cached set list itself declares. A row it
// cannot resolve is REPORTED and left alone, because a wrong set code is worse than a blank one — it
// silently files the card into the wrong automated per-set collection (D-016/D-027 key those on
// bkc.set_code), and a card sitting in the wrong collection reads as deliberate.
//
// DRY RUN BY DEFAULT. Nothing is written without --write.
//
// Run:
//   node --disable-warning=ExperimentalWarning scripts/backfill-set-code.mjs
//   node --disable-warning=ExperimentalWarning scripts/backfill-set-code.mjs --write
//   node --disable-warning=ExperimentalWarning scripts/backfill-set-code.mjs --all      (include sold rows)
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../lib/db.mjs';
import { resolveSetCode, nameCandidates } from '../lib/set-code.mjs';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const ALL = argv.includes('--all');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// Read-only for the scan. The write pass reopens — a tool whose only job is a report should not hold a
// writable handle on the database that trades.
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const statusFilter = ALL ? '' : " AND status IN ('in_stock','listed')";
const rows = db.prepare(`
  SELECT id, sku, game, name, set_name, language, status, card_facts
    FROM inventory_items
   WHERE game = 'pokemon'${statusFilter}
     AND (card_facts IS NULL
          OR json_extract(card_facts, '$.set_code') IS NULL
          OR json_extract(card_facts, '$.set_code') = '')
   ORDER BY id`).all();
const total = db.prepare('SELECT COUNT(*) n FROM inventory_items').get().n;
db.close();

console.log(bold(`\nset_code backfill — ${WRITE ? red('WRITE') : 'dry run'}`));
console.log(dim(`  database  ${DB_PATH}`));
console.log(dim(`  scope     ${total} inventory_items · ${rows.length} pokemon row(s) with no set_code${ALL ? '' : ' (in_stock/listed)'}\n`));

if (!rows.length) { console.log(green('  nothing to do — every row already carries a set code.\n')); process.exitCode = 0; }
else {
  const resolved = [], stuck = [];
  for (const r of rows) {
    const out = resolveSetCode({ game: r.game, set_name: r.set_name, language: r.language });
    (out.code ? resolved : stuck).push({ ...r, ...out });
  }

  if (resolved.length) {
    console.log(bold('resolved'));
    for (const r of resolved) {
      console.log(`  ${green(r.code.padEnd(7))} ${String(r.id).padStart(5)}  ${(r.sku || '').padEnd(16)} ${String(r.set_name || '').slice(0, 44).padEnd(46)}`
        + (r.via && r.via !== r.set_name ? dim(`matched as "${r.via}"`) : ''));
    }
  }

  // The important half. A report that says only "unresolved" makes the operator redo the search by
  // hand, so it shows every spelling that was tried — that is usually enough to see WHY it missed.
  if (stuck.length) {
    console.log(bold(red('\nnot resolved — left alone, fix these by hand')));
    for (const r of stuck) {
      console.log(`  ${red('  ?  ')} ${String(r.id).padStart(5)}  ${(r.sku || '').padEnd(16)} ${String(r.set_name || '(no set name)').slice(0, 44)}`);
      console.log(dim(`          ${r.name || ''} · ${r.language || 'EN'} · tried: ${r.candidates.join('  |  ') || '(nothing — the row has no set name)'}`));
    }
    console.log(dim('\n  Set one by hand with (replace ID and CODE):'));
    console.log(dim("    node -e \"const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/tracker.db');"
      + "const r=db.prepare('SELECT card_facts FROM inventory_items WHERE id=?').get(ID);const f=r.card_facts?JSON.parse(r.card_facts):{};"
      + "f.set_code='CODE';db.prepare('UPDATE inventory_items SET card_facts=? WHERE id=?').run(JSON.stringify(f),ID)\""));
  }

  console.log(bold('\n──────── summary ────────'));
  console.log(`  ${green(String(resolved.length))} resolvable   ${stuck.length ? red(stuck.length + ' need a human') : '0 need a human'}`);

  if (!WRITE) {
    console.log(yellow('\n  dry run — nothing was written. Re-run with --write to apply the resolved rows.\n'));
    process.exitCode = 0;
  } else if (!resolved.length) {
    console.log(yellow('\n  nothing to write.\n'));
    process.exitCode = stuck.length ? 1 : 0;
  } else {
    const w = new DatabaseSync(DB_PATH);
    let wrote = 0;
    // One row at a time inside a transaction: the whole point is that a partial run leaves a coherent
    // database, and every row is independent of the others.
    w.exec('BEGIN');
    try {
      const sel = w.prepare('SELECT card_facts FROM inventory_items WHERE id = ?');
      const upd = w.prepare("UPDATE inventory_items SET card_facts = ?, updated_at = datetime('now') WHERE id = ?");
      for (const r of resolved) {
        // Re-read rather than trusting the scan's copy: this is the box that trades, and something else
        // may have written the row since. If it now HAS a set code, leave it — the operator wins.
        const cur = sel.get(r.id);
        let facts = {};
        try { facts = cur?.card_facts ? JSON.parse(cur.card_facts) : {}; } catch { facts = {}; }
        if (String(facts.set_code || '').trim()) continue;
        facts.set_code = r.code;
        upd.run(JSON.stringify(facts), r.id);
        wrote++;
      }
      w.exec('COMMIT');
    } catch (e) { w.exec('ROLLBACK'); console.error(red('\n  write failed, nothing changed: ' + (e?.message || e))); process.exitCode = 2; }
    w.close();
    if (process.exitCode !== 2) {
      console.log(green(`\n  wrote ${wrote} row(s).`));
      console.log(dim('  Re-publish them so Shopify gets the identity metaobject:'));
      console.log(dim(`    node --disable-warning=ExperimentalWarning scripts/publish-shopify.mjs --ids ${resolved.map((r) => r.id).join(',')} --live --force\n`));
      process.exitCode = stuck.length ? 1 : 0;
    }
  }
}
