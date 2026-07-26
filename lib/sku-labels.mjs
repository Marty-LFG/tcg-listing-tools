// lib/sku-labels.mjs — the physical stock label series ("Custom label" on eBay).
//
// THE SCHEME (the owner's shelf system, not something this tool invented):
//
//     AAA-001 … AAA-099, then AAB-001 … AAB-099, then AAC-001 … and so on.
//
// Three letters, a dash, then a number 001-099. NINETY-NINE per block, not 999 — the block rolls at
// 099. Letters advance like an odometer, AAZ → ABA → ABB, so the series runs to ZZZ-099 (1,739,925
// labels, which is not a limit anyone will meet).
//
// TWO RULES THAT MATTER MORE THAN THE FORMAT:
//   1. Numbers are NEVER reused. A retired label stays retired — sell the card, the label dies with
//      it. So allocation is a monotonic counter, never "find the first free slot". A reused label
//      would point at a card that is no longer in that slot, which is worse than a gap.
//   2. The counter can be SEEDED but never rewound. seedLabelSeq() takes the max of what it is told
//      and what it already holds, so a bad seed can skip numbers but can never hand out one that is
//      already on a shelf or bound to a live eBay listing.
//
// The labels predate this tool — the owner's ~163 hand-made eBay listings carry them (AAC-084 was
// the highest at the time of writing) and our DB has never seen one. So the counter has to be seeded
// from eBay or by hand before the first allocation, which is what lib/inventory.mjs's /labels routes
// are for. Pure module, no DB: everything here is a function of a sequence number so it can be
// exhaustively tested offline.

export const LABEL_PER_BLOCK = 99;          // 001-099, then the letters advance
export const LABEL_RE = /^([A-Z]{3})-(\d{1,3})$/;

// Block index → three letters, base-26 odometer. 0 = AAA, 1 = AAB, 26 = ABA, 17575 = ZZZ.
export function blockLetters(block) {
  let b = Math.floor(block), out = '';
  for (let i = 0; i < 3; i++) { out = String.fromCharCode(65 + (b % 26)) + out; b = Math.floor(b / 26); }
  return out;
}
export function lettersToBlock(letters) {
  const s = String(letters || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) return null;
  return (s.charCodeAt(0) - 65) * 676 + (s.charCodeAt(1) - 65) * 26 + (s.charCodeAt(2) - 65);
}

// The nth label ever issued (n is 1-based): 1 => AAA-001, 99 => AAA-099, 100 => AAB-001.
export function labelFor(seq) {
  const n = Math.floor(seq);
  if (!(n >= 1)) return null;
  const idx = n - 1;
  const block = Math.floor(idx / LABEL_PER_BLOCK);
  if (block > 17575) return null;                          // past ZZZ — refuse rather than wrap
  return blockLetters(block) + '-' + String((idx % LABEL_PER_BLOCK) + 1).padStart(3, '0');
}

// The inverse: which allocation number is this label? Returns null for anything off-scheme, so a
// BK-PKM-000010 or a hand-written "AAC-084-B" can never move the counter.
export function seqForLabel(label) {
  const m = LABEL_RE.exec(String(label || '').trim().toUpperCase());
  if (!m) return null;
  const block = lettersToBlock(m[1]);
  const num = parseInt(m[2], 10);
  if (block == null || !(num >= 1 && num <= LABEL_PER_BLOCK)) return null;   // 000 and 100+ are off-scheme
  return block * LABEL_PER_BLOCK + num;
}

// Highest allocation number across a mixed bag of SKUs — our own BK-* labels, the owner's AAC-*
// ones, and whatever else eBay hands back. Anything unparseable is ignored rather than guessed at.
export function maxLabelSeq(skus) {
  let max = 0;
  for (const s of skus || []) { const n = seqForLabel(s); if (n && n > max) max = n; }
  return max;
}

// What the NEXT label would be, without allocating it. For the settings display.
export const peekNextLabel = (seq) => labelFor((seq || 0) + 1);
