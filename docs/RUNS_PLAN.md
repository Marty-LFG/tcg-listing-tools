# Keeper's Runs — design specification

**Status: REVISION 5 — BUILD CANDIDATE. Nothing here is implemented yet.**

Revision 5 closes the external review programme. Four rounds, two independent agents per round, each
reimplementing `BKR1` from the prose. **The cryptographic core matched every published value in every
round and no arithmetic defect was ever found in §4.**

Revision 5 fixes the implementation defects the final round surfaced — a verifier that never evaluated the
claims it published, a Tier C check that permitted two chases in one bundle, a `seal_serial` attribute the
schema made impossible, an unreproducible fixture, an amendment path that risked AES-GCM nonce reuse — and
adopts the owner's decisions on pricing and disclosure.

**It also settles what this system does and does not prove.** §2 is the authority. In short: contents are
proven; allocation rests on a committed and anchored policy, not on cryptography, and §2.1 says so without
hedging. Three allocation mechanisms were designed and discarded across revisions 1–4 before reaching that
conclusion; §7.5 records why.

**§7.5 records the disposition of the final review round.** §12 lists what remains open.

It assumes no prior knowledge of the business, the product, or the software it will be built into. Terms are
defined on first use. Every example value is invented; none corresponds to real stock.

---

## 1. Concept and commercial context

### 1.1 The domain, from scratch

Collectible trading cards sell as **singles** (one card) or **sealed product** (unopened manufacturer
packaging — a *booster pack* holds a handful of random cards).

A valuable single is often **graded**: sent to a third-party company that authenticates it, assesses
condition on a numeric scale, and seals it in a tamper-evident case. A graded card in its case is a
**slab**. Each slab carries a unique **certification number** ("cert"), printed on its label and verifiable
on the grading company's public website. The dominant grader uses a 1–10 scale where **10** is the top
grade. A cert is the only unambiguous identifier a card has: a name is not, because a seller may hold
several physically distinct copies of the same card.

Cards have a **rarity**. Several matter here, all denoting full-art or alternate-art versions of ordinary
cards, printed at low ratios and priced far above the base card. The Japanese names include **AR** ("Art
Rare"), **SAR** ("Special Art Rare") and a distinct Mega-era **attack rare** classification;
English-language catalogues call the first two "Illustration Rare" and "Special Illustration Rare".

**The same physical card carries different rarity names depending on which catalogue you ask**, and some
abbreviations collide outright — "AR" denotes both "Art Rare" and the unrelated, much older "Amazing Rare".
This is a live source of bugs and is addressed in §11.1.

### 1.2 The product

**Keeper's Runs** is a product line from a trading-card retailer selling online and at in-person events:
numbered, fixed-size editions of **mystery bundles** at a single fixed price.

A **run** (or *edition*) is a fixed number of bundles — the first is 25. Each **bundle** is a sealed parcel
with a fixed component set. For the first edition:

| Slot | Contents |
| --- | --- |
| Slab | 1 graded card |
| Packs | 3 sealed Japanese booster packs |
| Art card | 1 AR or SAR |

Most bundles contain an ordinary slab. A few contain a substantially more valuable **chase** card.

### 1.3 Chases replace, never add

A chase slab occupies the *same single slab slot* as an ordinary one, never an extra item. The intent is
that every bundle in a run has the same component count, so it cannot be picked out by handling.

**The database enforces component count, not grams or millimetres.** Different slab case types, different
pack products, or a raw versus graded art card are physically distinguishable by weight or profile.
Physical uniformity is an **operational requirement on whoever packs the run**, verified by hand, and is
explicitly *not* a property this system guarantees. §8.6 carries it as a residual risk, and §5.6.6 explains
why revision 4 no longer relies on it for any fairness argument.

### 1.4 What "Provably Packed" claims

> Before any bundle went on sale, we published a cryptographic commitment to the contents of every numbered
> bundle. When yours arrives you can check that what you received is what we committed to, and that we
> could not have changed it afterwards.

Note what that claim is about: **contents**. §2 separates it carefully from claims about allocation and
about physical reality, which are weaker and are stated as such.

### 1.5 Editions differ

The three-slot composition is **the first edition's shape, not the product's**. The identity rule is *every
bundle within a run is identical*, not *every bundle ever*. §3 explains why that drives the design.

---

## 2. What is being promised, precisely

Six claims of genuinely different strength. Conflating them is the main way a scheme like this becomes
dishonest, so they are separated here and stay separated in the implementation.

| # | Claim | Example | Strength |
| --- | --- | --- | --- |
| 1 | **Bundle contents** | "Bundle 007 was committed to hold exactly these items" | **Proven** to the holder, against a commitment that provably predates the sale |
| 2 | **Composition** | "Every bundle held the components the guarantee describes" | **Proven** at close, for every clause of the published guarantee and every bundle, without revealing which card is where |
| 3 | **Named chases present** | "These five named cards are in this run, one per bundle" | **Proven** at close, in full, including a multiset check (§5.5.2) |
| 4 | **You chose your own number** | "You selected your number yourself, from the set the ledger shows was unsold" | **Proven as a mechanism.** The buyer selects; we cannot assign. It is **not** a claim that we cannot influence which numbers the public finds attractive — §2.1 |
| 5 | **One price, no withdrawals, no self-purchase** | "Every number cost the same, none was withheld, and we bought none" | **Committed and anchored policy, not a proof.** The ledger shows every number sold at a single run-wide price; it cannot distinguish an arm's-length buyer from us — §2.1 |
| 6 | **Provenance** | "We owned these cards, and the card in the case is what the label says" | **Recorded, not proven.** §8.4 |

### 2.1 Claims withdrawn or narrowed, and why

Recorded prominently because a reader of an earlier revision will look for them.

**"Fair allocation" as a randomness property is withdrawn, and replaced by claim 4.** Revision 3 assigned
each purchase from a Bitcoin block postdating it. Two independent reviews broke that four ways: the
`occurredAt` feeding block selection was seller-authored and the ledger only periodically anchored, so the
input stayed mutable after the seed existed; Bitcoin header timestamps are miner-set, non-monotonic and may
be post-dated up to two hours, so the "future" block might already exist; cancellations were a retry
oracle; and none of it stopped the seller **buying** the bundles it wanted.

Revision 4 removes the randomness rather than repairing it. **The buyer chooses.** That is a stronger claim
for the buyer — nobody can steer them — and it deletes the entire class of attack above. §5.6 is the
argument.

**Claim 5 is honestly weak, and revision 3 overstated it.** `unsoldPolicy` forbids withdrawing a bundle
from sale; it does not forbid **buying** it. "Sold" includes "sold to the seller", so a ledger showing every
bundle sold does not establish that every bundle went to an arm's-length buyer. Revision 3 called this
"detectable and attributable". It is not: withdrawal is visible, self-purchase is not.

Buyer-choice makes self-dealing *easier*, not harder, because a seller who knows the map can pick a chase
directly rather than waiting for a chase-heavy remainder. That is stated here rather than buried. The
mitigation is a committed policy (§5.6.6), not a proof, and it is labelled as such throughout.

**"Exactly N of M bundles contain a chase" remains withdrawn.** `bundle.is_chase` is a seller-set bit;
opening it proves N bundles carry the value `1`. The buyer-harmful direction is closed — the N labelled
bundles are opened in full at close — but nothing rules out an additional unadvertised chase. Claim 3
states what is actually proven. Closing the gap needs zero-knowledge proofs, which are available and are
rejected on proportionality for a 25-unit run; **revision 1's word "unavoidable" was wrong and stays
withdrawn.**

**"Exact contents" is narrowed.** Sealed packs are not individually identified. The system commits
**product identity and quantity**, never which physical pack.

**"Nothing is sent to the seller" is narrowed** to *"an honest verification page sends neither the code nor
the bundle index"*. Fetching the blob file necessarily discloses IP, time and run identity, and a malicious
page could exfiltrate anything. §8.2.

### 2.2 Non-negotiable business constraints

1. **No monetary values in any customer-facing bundle material, ever** — listings, promotional material,
   inserts, public API responses. Chase cards are named by card and grade only.
2. **Odds as exact counts, never ratios or percentages.** A consumer-law and gambling-optics requirement in
   the operating jurisdiction. Copy must match what §2 says is proven: the count form describes the *named
   chases*, per claim 3.
3. **A published guarantee must be literally true of the manifest**, and must be *generated* from the
   structured claims rather than written alongside them (§11.2).
4. **Language and origin disclosed, not omitted.**

---

## 3. The per-run composition model

Each run declares its own **composition**: an ordered list of slot specifications, fixed at creation,
immutable once locked, and **committed in the anchored header** (§5.1) so an independent verifier can check
that a bundle's attribute set is exactly what the composition implies.

| Field | Meaning |
| --- | --- |
| `slot` | Machine name, `[a-z0-9_]{1,32}` (§4.4) |
| `label` | Human name, used in generated guarantee text |
| `kind` | Which category of stock supplies it — `inventory` or `sealed` |
| `qty_per_bundle` | Units every bundle must hold |
| `max_lines` | Fixed number of attribute lines every bundle emits for this slot (§4.5), 1–99 |
| `singleton` | The slot holds exactly one physical object |
| `requires_cert` | Bound items must carry a certification number |
| `is_chase_slot` | The slot a chase replaces into — exactly one per run |

Ordering is by an explicit integer `sort_order`, unique within a run; `compositionCanonical` iterates in
ascending `sort_order`.

First edition:

| slot | kind | qty | max_lines | singleton | requires_cert | is_chase_slot |
| --- | --- | --- | --- | --- | --- | --- |
| `slab` | inventory | 1 | 1 | yes | yes | **yes** |
| `packs` | sealed | 3 | 3 | no | no | no |
| `art` | inventory | 1 | 1 | yes | no | no |

**Why composition is data.** Hard-coding the shape would make a differently-shaped second edition a schema
migration *and* a second serialisation format, hence a **second verifier** deployed to the storefront
forever alongside the first. As data, a second edition is a configuration change and the verifier never
changes.

---

## 4. Cryptographic specification (`BKR1`)

Complete enough to reimplement the verifier with no reference to source code. **The scheme must be secure
against an adversary who has read every word of this document.**

Primitives: SHA-256, HMAC-SHA-256, PBKDF2-HMAC-SHA-256, AES-256-GCM.

### 4.1 Encoding

```
ns(s) = decimal(byteLength(s, UTF-8)) + ":" + s + ","
```

Verified: `ns("Iono: 7,3")` = `"9:Iono: 7,3,"`; `ns("")` = `"0:,"`.

Length prefixes mean no value can break the framing. JSON is not used because key order is insertion order —
stable today, silently reordered by a future refactor, and a reordering changes every published hash.

### 4.2 Value normalisation — exact rules

**Input type.** Attribute values are **strings only**. Producers convert to string before encoding using
§4.3's grammars. `null` and `undefined` become the empty string. Booleans, numbers, arrays and objects are
invalid input and must be rejected rather than stringified by language default.

**Normalisation form.** Unicode NFC.

**Trimming.** Strip from both ends **only** these six code points:

```
U+0009 TAB   U+000A LF   U+000B VT   U+000C FF   U+000D CR   U+0020 SPACE
```

Explicitly **not** trimmed: U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F,
U+3000, U+FEFF. This is not pedantry — measured, JavaScript's `String.prototype.trim` strips U+3000,
U+FEFF **and** U+00A0, none of which this rule strips, and Python's `str.strip` strips a different set
again. Delegating to a runtime would make two conforming implementations disagree. §4.10.3 pins it with a
vector that actually diverges.

**Well-formedness.** A value containing an unpaired UTF-16 surrogate or U+0000 is **invalid**. Producers
and verifiers must reject rather than substitute U+FFFD, because browsers silently replace lone surrogates
when encoding to UTF-8 while strict server encoders throw.

**Ordering.** Attribute names sort **byte-wise over their UTF-8 encoding**. §4.4's slot-name restriction
keeps every name ASCII. **Duplicate attribute names are invalid** and a verifier must reject a bundle
containing one, since sort stability would otherwise change the root.

**Header strings** — guarantee text, policy text, labels, dates — are subject to the same normalisation and
well-formedness rules before entering any digest.

**Hex strings** — roots, digests, salts, ledger hashes, code leaves — are **lowercase** everywhere they are
encoded or compared.

### 4.3 Numeric and identifier grammars

| Value | Grammar |
| --- | --- |
| `grade` | Decimal, digits `0-9` and at most one `.`. No sign, no exponent, no leading zeros except a bare `0`, at least one digit before and after any `.`, no trailing fractional zeros. Range `0` to `10`. `10` → `"10"`, `9.5` → `"9.5"`. Invalid: `"10.0"`, `"09"`, `".5"`, `"0."`, `"1e1"`, `"-0"`, `NaN`, `Infinity` |
| `qty` | Positive integer, no leading zeros, no sign |
| `run.edition`, `unit_count`, `max_lines`, `qty_per_bundle`, ladder `rank`, ledger `seq`, amendment `seq` | Positive integer, no leading zeros, no sign |
| `bundle.no` | Zero-padded to exactly 3 digits. Bundle numbers are `1..999`, contiguous, unique. Above 999 requires a new `canon` version |
| Dates | RFC 3339 **instants**, UTC, `Z` suffix mandatory, millisecond precision — `2027-03-31T23:59:59.000Z`, never a bare `YYYY-MM-DD` |

**These grammars apply to populated lines only.** A padded line (§4.4) emits every field as the empty
string, including numeric fields. Revision 3 required both, a literal contradiction a reviewer caught: an
empty `qty` cannot satisfy "positive integer". A verifier checks grammars **after** classifying the line.

Grades that are not decimal — some graders issue non-numeric designations — **cannot be represented** by
`BKR1`, and a run containing one cannot lock. Stated rather than left to be discovered.

### 4.4 A bundle is a sorted list of named attributes

A bundle decomposes into named attributes committed separately. That is what makes selective disclosure
(§4.9) possible, and it cannot be retrofitted after lock.

Every line contributes the same **15 fields**, always all fifteen, empty where inapplicable:

```
kind, display_name, game, identity_key, set_code, card_number, rarity,
language, finish, product_type, upc, grading_company, grade, cert_number, qty
```

Attribute names:

```
run.public_id | run.edition | bundle.no | bundle.label | bundle.is_chase | bundle.seal_serial
slot.<slot>.<ii>.<field>     for every slot, ii = 00 .. max_lines-1, each of the 15 fields
```

`bundle.seal_serial` is the tamper-evident seal applied to that parcel: **16 lowercase hex characters,
random per bundle**, never a contiguous block. Revision 4 required it in §8.5 while §4.4's closed name set
had no such attribute and §4.5 made a verifier reject extras — so a conforming producer could not satisfy
the document. Both reviewers found the contradiction. It is opened at tier C (chase bundles only, and only
after delivery) and at tier D.

`bundle.is_chase` takes exactly `0` or `1`; any other value is invalid.

Then sorted per §4.2. Slot names are `[a-z0-9_]{1,32}`, keeping names ASCII; the line index is zero-padded
to two digits so `slot.packs.02` sorts before `slot.packs.10`, hence `max_lines ≤ 99`.

**Line assignment.** A slot's lines come from the distinct stock rows bound to it: **one line per distinct
stock row**, `qty` being the units drawn from that row — so three packs from a single product are **one
line with `qty` = 3**, never three lines. Lines are sorted ascending by **byte-wise comparison of the UTF-8
encoding of `ns(field₁) ‖ … ‖ ns(field₁₅)`** in the field order above, then assigned indices `00`, `01`, …
Populated lines always precede padding.

**Populated versus padded, normatively.** A line is **populated** iff its `qty` is non-empty. A populated
line must have non-empty `kind` and `qty` satisfying §4.3. A **padded** line must have **all fifteen fields
empty**. Any other combination is invalid and a verifier must reject it.

### 4.5 Padding: every bundle emits the identical attribute set

Every bundle emits attributes for **all** `max_lines` of every slot; unused lines emit all fifteen fields as
empty strings. There is deliberately **no attribute recording how many lines are populated**.

**Why.** Where bundles legitimately differ in structure — one holding three packs of one product, another
two products — an unpadded encoding gives them different attribute counts, differently-shaped trees, and
therefore **different proof lengths**. Proof length is published whenever an attribute is opened, so an
observer would learn each bundle's internal structure from a disclosure designed to reveal one attribute.

Because the composition is committed in the header, a verifier derives the exact attribute name set a
bundle must have and **rejects any bundle with a missing, extra or duplicated attribute**.

**Honest limit.** Padding conceals structure *before close*. Tier B (§5.5) opens `qty` on every line, which
necessarily reveals the pack split. §5.5.1 states the design rule that makes that disclosure carry no
signal, and §8.16 records that the rule is a policy, not a cryptographic binding.

### 4.6 Salts

Each bundle has one **bundle salt**: 32 bytes from a cryptographically secure source, generated at lock,
stored server-side, never published. §5.3 covers how it reaches a buyer.

Per-attribute salts are **derived, not stored**:

```
attrSalt(name) = HMAC-SHA256(key = bundleSalt, message = UTF8("BKR1/attr/" + name))
```

encoded as lowercase hex when used. HMAC is a pseudorandom function, so **publishing one attribute's salt
reveals neither the bundle salt nor any other attribute's salt** — the property that makes §4.9 safe, and
the reason for HMAC rather than `SHA256(bundleSalt ‖ name)`.

Salts are mandatory and full-length: contents are drawn from a small, publicly known pool, so an unsalted
commitment set is exhaustible in milliseconds.

**All bundle salts in a run must be distinct**, checked at lock. Collision between independent 256-bit
values is negligible, but a reviewer showed that *deliberate* reuse would let a legitimate holder identify
the sibling bundle by matching a derived attribute salt in the close-out, and then dictionary-test its
hidden commitments. Requiring distinctness makes §7's "cryptographically nothing transfers" unconditional
rather than probabilistic.

### 4.7 Commitments and domain separation

```
commit(name, value) = SHA-256( 0x02 || UTF8( ns(name) || ns(attrSaltHex) || ns(value) ) )
node(left, right)   = SHA-256( 0x01 || left || right )      // 32-byte inputs, raw concatenation
leaf(bundle)        = SHA-256( 0x00 || bundleRoot )
codeLeaf(i)         = SHA-256( 0x04 || blobKey(i) )         // §5.3 — NOT a function of the raw code
headerDigest        = SHA-256( 0x03 || UTF8( … ) )          // §5.1
ledgerHash(i)       = SHA-256( 0x05 || UTF8( … ) )          // §5.6.2
rarityTableHash     = SHA-256( 0x06 || UTF8( … ) )          // §11.1
```

The one-byte prefixes are a second-preimage defence: without them a 64-byte "leaf" that is really two
concatenated node hashes verifies as a leaf. `0x02` stops an attribute commitment being read as an internal
node; `0x03`–`0x06` separate the header, code, ledger and rarity-table domains.

### 4.8 Tree construction and the odd-node rule

Two levels:

1. **Per bundle** — a Merkle tree over `commit(a)` for each attribute in sorted name order → `bundleRoot`.
2. **Per run** — a Merkle tree over `leaf(bundle)` in ascending bundle-number order → `runRoot`.

Both pair nodes left to right; **if a level has an odd number of nodes, the last is promoted unchanged.**

- **Not Bitcoin's rule.** Bitcoin duplicates the final hash on an odd level, admitting CVE-2012-2459 where
  two different leaf sets give the same root. §4.10.1 shows our root differs from the duplicate-last root.
- **Not RFC 6962's `MTH`**, which splits at the largest power of two below *n*. We borrow that RFC's
  domain-separation prefixes and specify our own shape.

**Edge cases:** `n = 0` is **invalid**. `n = 1`: the root **is** the sole input, unhashed; the proof is
empty. `n = 2`: `root = node(x₀, x₁)`, one step each.

**Duplicate leaves are invalid** at both levels — a verifier must reject a run with two identical
`leaf(bundle)` values or two identical `codeLeaf` values.

The same construction serves the attribute tree, the run tree and `codesCommit`.

### 4.9 Proofs, membership and selective disclosure

```
step = { hash: <lowercase hex>, side: "L" | "R" }        // side = which side the SIBLING is on

h = leaf
for each step:  h = (side == "L") ? node(step.hash, h) : node(h, step.hash)
accept if h == root
```

**A promoted node contributes no step at that level.** For 25 bundles the longest run-tree proof is 5 steps.

**A membership proof is not complete without its index.** A verifier must be told the claimed index and
tree size, must check that the step count and the L/R pattern are **exactly** those the §4.8 construction
produces for that `(index, size)`, and must check the asserted index against the public leaf list. Revision
3 specified only the hash walk, which let one valid opening be replayed under several different labels
(§5.5.2).

To open attribute `a` of bundle `b`, publish the name and value, `attrSalt(a)`, the proof from `commit(a)`
to `bundleRoot(b)` with its index and size, and the proof from `leaf(b)` to `runRoot` with its index and
size. **A fabricated value has no valid proof**, so a dishonest partial disclosure is impossible — only a
*selective* one, which §5.5 constrains.

**Proof lengths are uniform only where uniformity is claimed:** within a run, a given attribute name sits at
the same index in every bundle, so its proof length is identical across bundles. Lengths do vary by
attribute position and by bundle index, both of which are public.

### 4.10 Test vectors

Two fixtures. **EX1** is small enough to check by hand. **EX2** exercises the real first-edition shape —
multiple slots, `max_lines > 1`, populated and padded lines, and line sorting — which three review rounds
correctly flagged as never having been vectored. All values invented.

#### 4.10.1 EX1 — hand-checkable, single slot

Run `EX1`, edition `1`, `unit_count` 3, composition `slab` only with `max_lines` 1 → 20 attributes.

Bundle salts (fixture constants; a real run uses random values):

```
bundle 1: 00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff
bundle 2: 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0
bundle 3: aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
```

| name | value | attrSalt | commit |
| --- | --- | --- | --- |
| `bundle.is_chase` | `0` | `13eb1ad54e74b08f0ae91d555518619fe0f81cda291652ae57e116000a3ec01c` | `0cce6dead2f4bc63a8dc20c4d56b8e3d216609311f2ed8990f1da6233ed0020c` |
| `bundle.label` | `EX1-001` | `80db1ff3f41915d9e877619522b33eba1e85c0986d7ec1f0fdad368632b266a8` | `ed6bfcd15d3f710b7cec92ea4ae340566939d1eb39d82a5052d792a146f309c2` |
| `bundle.no` | `001` | `d50e7fd3098a7d3189dace785202e47307ffa7dc72381d2ebcd2d19d5c8d04fb` | `d70d0ba68e497e80196615b6d3dc5023313c2fd83cf483d0190fdc759af29918` |
| `run.edition` | `1` | `cfedf80d822f444fe4fd4ede5182a6cc6e8fff02f37fc099bfe84a157bed7263` | `7eb19470fad1fcc33f6871408923ee9f807e0f5dfddb752afbb6b71eba4a8abd` |
| `run.public_id` | `EX1` | `ce1f56fce04df78d025d1826ae21bad8db51d31fd2a65dd5a9e748c6f6123620` | `5a9db44a6bea5b27827e3ea8d23a709d75189f1d10977271f9b74b7d514724ce` |
| `slot.slab.00.card_number` | `101` | `3f92c3b8671b33d53dd8b2d36effb9a0eda8283cb874f96a17b177af49d280fd` | `0fca3d04b8217747ef8e99ef15f2ea134ce26dc0a1740c9ebe4d5304780572c9` |
| `slot.slab.00.cert_number` | `00000001` | `9ca0deb29bc77943425d7ce4d6a7e2d87eccd79b786a11f148b7fa04eb28d014` | `c079e02fc0810ff66988c4d0d3d98364e1fe57029c97671d485ba748b28ce461` |
| `slot.slab.00.display_name` | `Sample Card Alpha` | `18a02503ca3c5d73b2ee2dbce2a7d496c70ab453ac9295d8dbe0cc0c0b99c01c` | `830e39c834de1ad7fb5e2cf2b55826094da382af6eb23c0dc373c137e80c9e32` |
| `slot.slab.00.finish` | `holo` | `89da579dfb3a7d186b7028bed5afedaef00bc2cc08f37fb6869ee55ee2cbe44d` | `e3c4a2ad760d2a4af25071230bca28e5ca9bf58539b1006294b606f8c3f89cb3` |
| `slot.slab.00.game` | `pokemon` | `7467da577864b79ec1fd99821b540d8124a978f6f946b918113f80f4e7b6af7e` | `1562167877d28e2bfd5aa4d9afcf9a0b0d766ca23ea2e240c2eccaa970c4cc90` |
| `slot.slab.00.grade` | `10` | `ce6d7a6c5062914f36b6c18f686a89ea53ec8bfd6d1ab21f4b74090104549ad0` | `2af00e58d970cfeeef8267fd0775eb3420bdf393dbee33514d2434b9f8633220` |
| `slot.slab.00.grading_company` | `PSA` | `ab3b46001b6c73135d9fed1cfacea7eb258020ac3eb26bd96dcafa794717b5a8` | `84c5c72da4a7ad35dc4b7519f870c0ce933f2f2ce67f2f94702b8e40137bfd05` |
| `slot.slab.00.identity_key` | `ex1-001` | `3514dd34771543baf62e577e84dd56abd3f33afc3a85b371ca1f3798362fc801` | `4b791071095eaf47016641f3744e9a664301234b8f2d72dabdffc7bdd954de48` |
| `slot.slab.00.kind` | `inventory` | `235eb06affcc5f9fd0131c44df482f4b6df919ca94e69ce424370aeac676f57b` | `b3f36ade9bb0b14c9328d687c8af544d11b155bd543647827cf065b19a081719` |
| `slot.slab.00.language` | `JA` | `819d592e5825607a9045b3486dbf5fc74733ec271c44aceb0485685c2ac4fd1f` | `d958e2afe3c716ef2a725d9ce726e35f944bf41b2a99dacd53d1a1e25e298c74` |
| `slot.slab.00.product_type` | *(empty)* | `da55081e5ec56ed8e711f0914debdf0bde6445079a9ef58389514bf58742b96d` | `a79a151beeb2939d327b4abb233c1d180654d2e39ae68ecad97deb317fd7a472` |
| `slot.slab.00.qty` | `1` | `9d1a504c0819f2c438e98dc4ca6ab4691ab033ae697a08367a3e00cb1b6c5159` | `76f7c9032e476cd3d41c69bb5f2ea9fa17ac9c0ce515ecbe4266e27a5ec6e3a6` |
| `slot.slab.00.rarity` | `Art Rare` | `a9ed6d2adac7cb4552a1739c200869460d26fd0767b038f5e992d680dfa8db70` | `52b46cec1bb6ad7addb41cddb1b622081b9ca9721cd6b97f3a15361a8a575963` |
| `slot.slab.00.set_code` | `EXS` | `6fe6ad87830e5c005b17e442ea17d2abad19ba65d27810d89ced19d81bf8173a` | `bf3b1ef2cd4cc7e99e181f6fbe92daea163368f4c07a5054bea16e8bc979cd5e` |
| `slot.slab.00.upc` | *(empty)* | `ee9203bf7ee9daea2382796ff5dd83cb917f7b07763e8a6e03aca835be798fae` | `3b15368aa18a22eb30608ce926f2a170a2f95c47b1fd1da1c5afd9178311d785` |

Bundles 2 and 3 use the same field names with these values:

| name | bundle 2 | bundle 3 |
| --- | --- | --- |
| `bundle.is_chase` | `1` | `0` |
| `bundle.label` | `EX1-002` | `EX1-003` |
| `bundle.no` | `002` | `003` |
| `slot.slab.00.card_number` | `202` | `303` |
| `slot.slab.00.cert_number` | `00000002` | `00000003` |
| `slot.slab.00.display_name` | `Sample Card Beta` | `Sample Card Gamma` |
| `slot.slab.00.finish` | `holo` | *(empty)* |
| `slot.slab.00.identity_key` | `ex1-002` | `ex1-003` |
| `slot.slab.00.rarity` | `Special Art Rare` | `Art Rare` |

All other fields as bundle 1: `run.public_id` `EX1`, `run.edition` `1`, `game` `pokemon`, `set_code` `EXS`,
`language` `JA`, `grading_company` `PSA`, `grade` `10`, `kind` `inventory`, `qty` `1`, `product_type` and
`upc` empty.

```
bundle 1  bundleRoot = ed018f5c1791fe1590a93a8e663708f3942fb4b7c25de331f0113ab111ef2d78
          leaf       = cb3640bd3758ca3a31ad0d44ddae6f65b196aaf41e23e2704bb876e0ec9ff522
bundle 2  bundleRoot = fae0269d14ce14ff7ad1b1c156fe9948083369dd467e1e747c0808aa4c3da9c0
          leaf       = 3156a3eb3bb166c9344ef5aea8faa16d3b682533480c25a7df69722fbedb00a4
bundle 3  bundleRoot = f276439e7ae9698426f09197d4fad28cec1fbff297595578255d8add36800e04
          leaf       = d3e3f456b547c6a0ec351be6d91733b15523373b43f635b5045276e52f25b56a

node(leaf1, leaf2) = 9d10f39067ed1e44805d3c25c270605ba46896ff5930a9eb33cda49bf76fd021
runRoot            = 4da578566753734fc1841e9719ea652f44fbc261366e5926c8a92b4eeaea04fd
```

Run-tree proof, bundle 2 (index 1 of 3), two steps:

```json
[ { "hash": "cb3640bd3758ca3a31ad0d44ddae6f65b196aaf41e23e2704bb876e0ec9ff522", "side": "L" },
  { "hash": "d3e3f456b547c6a0ec351be6d91733b15523373b43f635b5045276e52f25b56a", "side": "R" } ]
```

Bundle 3 (index 2 of 3, the promoted odd node), one step — the promoted level contributes nothing:

```json
[ { "hash": "9d10f39067ed1e44805d3c25c270605ba46896ff5930a9eb33cda49bf76fd021", "side": "L" } ]
```

Attribute-tree proof, opening `bundle.is_chase` on bundle 1 (index 0 of 20), five steps:

```json
[ { "hash": "ed6bfcd15d3f710b7cec92ea4ae340566939d1eb39d82a5052d792a146f309c2", "side": "R" },
  { "hash": "8a176566d931017c24ff7fa03c62897be22c97c22e8dc85ce6748dab2ea1c6f6", "side": "R" },
  { "hash": "f3ac6b1690a196241caa0787fd2689932a9fed73b004141f20c41cfa20d07832", "side": "R" },
  { "hash": "556e4255d33d10446a46e470b17124ba4c9e82f4d388763e50d7e19026b9fe61", "side": "R" },
  { "hash": "0378f424ae353b52dd15f7a9fdba6707917b138e4006146ebffc36d5842b0c44", "side": "R" } ]
```

Tree edge cases and the odd-node rule:

```
n = 1, sole input 00…00 (32 bytes of 0x00)
   root  = 0000000000000000000000000000000000000000000000000000000000000000   (the input, unhashed)
   proof = []

n = 2, inputs 00…00 and 11…11
   root  = a7b6a88afe611b23a8bb9836e3cd13ba706cb05d6de647d92bf05bb0aace72ee
   proof for index 0 = [ { "hash":
     "1111111111111111111111111111111111111111111111111111111111111111", "side": "R" } ]

same three EX1 leaves, two rules:
   promote-odd-node (this spec) = 4da578566753734fc1841e9719ea652f44fbc261366e5926c8a92b4eeaea04fd
   duplicate-last (Bitcoin)     = 776f7bdf154fe3caee91170b9752082a33fa1114c290761875082127767fa2bf
```

#### 4.10.2 EX2 — the realistic fixture, stated field by field

Run `EX2`, edition `1`, `unit_count` 3. Composition **exactly as §3 declares for the first edition**:
`slab` (`max_lines` 1), `packs` (`max_lines` 3), `art` (`max_lines` 1). **81 attributes per bundle,
identical name set across all three** — verified. Bundle salts are the §4.10.1 constants.

Revision 4's EX2 could not be reproduced: it omitted every `identity_key`, pack `game`, and the three
composition labels, and it used `max_lines` 2 while §3 declared 3. Both reviewers failed to reconstruct it,
one recovering the *shape* of the omission by byte arithmetic — deltas of 21/28/21 being exactly seven
bytes per populated line. Every value is therefore stated below. Fields not listed for a line are the
**empty string**.

**Composition labels** (needed for `compositionCanonical`): `Graded slab`, `Sealed packs`, `Art card`.

**Core attributes**

| attribute | bundle 1 | bundle 2 | bundle 3 |
| --- | --- | --- | --- |
| `bundle.is_chase` | `0` | `1` | `0` |
| `bundle.label` | `EX2-001` | `EX2-002` | `EX2-003` |
| `bundle.no` | `001` | `002` | `003` |
| `bundle.seal_serial` | `5b3f9a2c74e18d60` | `a04c17e9b5230fd8` | `c72e58b1039af64d` |
| `run.edition` | `1` | `1` | `1` |
| `run.public_id` | `EX2` | `EX2` | `EX2` |

**Slab line** (`slot.slab.00.*`) — populated in every bundle

| field | bundle 1 | bundle 2 | bundle 3 |
| --- | --- | --- | --- |
| `kind` | `inventory` | `inventory` | `inventory` |
| `display_name` | `Sample Card Alpha` | `Sample Card Beta` | `Sample Card Gamma` |
| `game` | `pokemon` | `pokemon` | `pokemon` |
| `identity_key` | `ex2-001` | `ex2-002` | `ex2-003` |
| `set_code` | `EXS` | `EXS` | `EXS` |
| `card_number` | `101` | `202` | `303` |
| `rarity` | `Art Rare` | `Special Art Rare` | `Mega Attack Rare` |
| `language` | `JA` | `JA` | `JA` |
| `finish` | `holo` | `holo` | `holo` |
| `product_type` | *(empty)* | *(empty)* | *(empty)* |
| `upc` | *(empty)* | *(empty)* | *(empty)* |
| `grading_company` | `PSA` | `PSA` | `PSA` |
| `grade` | `10` | `10` | `10` |
| `cert_number` | `00000001` | `00000002` | `00000003` |
| `qty` | `1` | `1` | `1` |

**Art line** (`slot.art.00.*`) — populated in every bundle. `kind` `inventory`, `game` `pokemon`,
`set_code` `EXS`, `language` `JA`, `qty` `1`; `finish`, `product_type`, `upc`, `grading_company`, `grade`
and `cert_number` are **empty**.

| field | bundle 1 | bundle 2 | bundle 3 |
| --- | --- | --- | --- |
| `display_name` | `Sample Art One` | `Sample Art Two` | `Sample Art Three` |
| `identity_key` | `ex2-a01` | `ex2-a02` | `ex2-a03` |
| `card_number` | `201` | `202` | `203` |
| `rarity` | `Art Rare` | `Special Art Rare` | `Art Rare` |

**Pack lines** (`slot.packs.<ii>.*`). Every populated pack line has `kind` `sealed`, `game` `pokemon`,
`language` `JA`, `product_type` `booster_pack`, and **empty** `identity_key`, `card_number`, `rarity`,
`finish`, `grading_company`, `grade` and `cert_number`. Two products appear:

- **A** — `display_name` `Sample Pack Set A`, `set_code` `SPA`, `upc` `0000000000001`
- **B** — `display_name` `Sample Pack Set B`, `set_code` `SPB`, `upc` `0000000000002`

| bundle | line 00 | line 01 | line 02 |
| --- | --- | --- | --- |
| 1 | A, `qty` `3` | **padding, all 15 empty** | **padding, all 15 empty** |
| 2 | A, `qty` `2` | B, `qty` `1` | **padding, all 15 empty** |
| 3 | B, `qty` `3` | **padding, all 15 empty** | **padding, all 15 empty** |

Bundle 2's two populated lines sort A before B by the §4.4 rule.

**Results**

```
bundle 1  bundleRoot = bd61cbf4bb9d1b9e67442cb963e320500381c3f4ef1e271215aafdf1495e1e6d
          leaf       = c84e770288da8ca953e339b66abbf6d43aa8c258565a9444d37ce0d14bf8cffc
bundle 2  bundleRoot = 058964282ee22d7b07bff676e1157bb1fe164095a20708df98b9f84f38848c40
          leaf       = 4b273f0c49964d21620a7930debfb1a4d750b6e8f43c58ea1d2abec41242ad76
bundle 3  bundleRoot = 245a743612998bc13674eaac9629fbe827c158db23b61bd6e79b6784b54238b2
          leaf       = 0372bdf5f5fd1cd0483b6c1b154a6b753d30b0e858ba6b946c144bec766bc7f8

runRoot = 221c209209bc900c52555cba31fbe5da1581c7ab5ce6f244ee735413aaf70587
```

#### 4.10.3 Normalisation

Revision 3's normalisation vector was **inert** — its ideographic space was interior, so no implementation
touched it, and the markdown source held a precomposed `é` and a literal backslash-`t` rather than the
combining sequence and tab its annotation described. Both reviewers caught it. This one diverges.

```
input code points:
  U+3000 U+0050 U+006F U+006B U+00E9 U+006D U+006F U+006E U+0020
  U+0043 U+0061 U+0066 U+0065 U+0301 U+0009
  — leading IDEOGRAPHIC SPACE, "Pok" + precomposed é + "mon", space,
    "Caf" + e + COMBINING ACUTE, trailing TAB

after §4.2 (NFC, then the six-code-point trim):
  U+3000 U+0050 U+006F U+006B U+00E9 U+006D U+006F U+006E U+0020
  U+0043 U+0061 U+0066 U+00E9
  — the leading U+3000 SURVIVES, the trailing TAB is removed, e+U+0301 composes to U+00E9

ns(value)          = "17:　Pokémon Café,"        (17 UTF-8 bytes)
SHA-256(ns(value)) = c5ff46436f52110a739af532856342fa623a30392114b32410717ad22bddd597

An implementation delegating to JavaScript's trim() strips the leading U+3000 and produces
SHA-256            = 2567d62c63fb678b1546a7ccb5c2b89a7ffe85c62562f79331e3e5806e99ac80
```

---

## 5. Published artifacts

### 5.1 The header digest — what is anchored

```
headerDigest = SHA-256( 0x03 || UTF8(
      ns("BKR1-HEADER") || ns(public_id) || ns(edition) || ns(unit_count) || ns(canon)
   || ns(runRootHex) || ns(codesCommitHex) || ns(blobHashHex)
   || ns(compositionCanonical) || ns(chaseLadderCanonical) || ns(claimsCanonical)
   || ns(guaranteeText) || ns(rarityTableVersion) || ns(rarityTableHash)
   || ns(closeByDate) || ns(salesCloseAt) || ns(unsoldPolicy) ) )
```

Sub-encodings, each a concatenation of `ns()` fields:

```
compositionCanonical = for each spec in ascending sort_order:
    ns(slot) ns(label) ns(kind) ns(qty_per_bundle) ns(max_lines)
    ns(singleton) ns(requires_cert) ns(is_chase_slot)         // booleans as "0"/"1"

chaseLadderCanonical = for each ladder entry in ascending rank (ranks unique, contiguous from 1):
    ns(rank) ns(card_name) ns(set_code) ns(card_number) ns(language)
    ns(grading_company) ns(grade)

claimsCanonical      = for each claim sorted by (claim_type, subject), both byte-wise:
    ns(claim_type) ns(subject) ns(operator) ns(value)
    — (claim_type, subject) pairs are UNIQUE; a duplicate is invalid.
      A set-valued `value` is comma-joined, members sorted byte-wise, no spaces.
```

**`blobHashHex` is new in revision 4** and is `SHA-256` of the complete blob file (§5.3.2). Revision 3 left
the ciphertext entirely unbound, so it could be created after buyers were known, replaced, selectively
corrupted, or served differently to different viewers, with no mirror able to identify the authoritative
pre-sale bytes. Encryption is local, so the file is built in lock phase 1 and its hash sits inside the
anchored digest.

`rarityTableHash` accompanies the version because a version label pins nothing a verifier can check; the
table is also published in full (§11.1).

**Exceptions, stated explicitly.** `anchors` cannot be inside the digest they anchor. `v` is the artifact
schema version and is **also** outside; a verifier must therefore treat `v` as untrusted and must not let it
select parsing rules that change any hashed interpretation — the only permitted use is refusing a version
it does not implement.

**What is anchored is `headerDigest`, as 32 raw bytes** — not hex text, not a JSON document.

**Test vector**, using the EX2 fixture, the codes and blob file of §5.3, and the rarity table of §11.1:

```
compositionCanonical  = "4:slab,11:Graded slab,9:inventory,1:1,1:1,1:1,1:1,1:1,
                         5:packs,12:Sealed packs,6:sealed,1:3,1:3,1:0,1:0,1:0,
                         3:art,8:Art card,9:inventory,1:1,1:1,1:1,1:0,1:0,"   (156 bytes, one string)
chaseLadderCanonical  = "1:1,16:Sample Card Beta,3:EXS,3:202,2:JA,3:PSA,2:10,"
claimsCanonical       = "6:grader,4:slab,2:eq,3:PSA,8:language,6:bundle,2:eq,2:JA,
                         9:min_grade,4:slab,3:gte,2:10,
                         9:rarity_in,4:slab,2:in,42:ART_RARE,MEGA_ATTACK_RARE,SPECIAL_ART_RARE,
                         10:slot_count,6:bundle,2:eq,20:art:1,packs:3,slab:1,"
                        (one string, wrapped here for width)

runRoot         = 221c209209bc900c52555cba31fbe5da1581c7ab5ce6f244ee735413aaf70587
codesCommit     = c0c03deb405fc4a7643c6669ebecc8af9abb27a35fc7189bac1f22608dab05f4
blobHash        = 895e997da12d0d21c3e6c9b6c6f1dd374ea4bf96c51bd193cae4c6fef18f8257
rarityTableHash = ca971d5d15666d83cfeb4b451dc3bd99d6639e7eeee70c23002c39a7d28d83e0
headerDigest    = 829a795eaca64d6ccf56b6898e0e51f495f450a70b34e9577c04ccaa685d2231
```

with `rarityTableVersion` = `rarity-v1`, `closeByDate` = `2027-03-31T23:59:59.000Z`, `salesCloseAt` =
`2027-01-31T23:59:59.000Z`, the §11.2 guarantee text, and

```
unsoldPolicy = "Every bundle in a run is sold at one price shared by every remaining number.
                No bundle is withdrawn from sale, priced differently from any other, or
                purchased by the seller or an affiliate."
```

**This fixture is a conforming manifest**, and unlike revision 4's it is reproducible from the prose alone. Revision 3's was not: both reviewers found its slab-only
composition and three-claim set bound to a guarantee promising packs and an art card, with no language
claim despite Japanese contents, so §11's own lock rules would have refused it. The vector hashed correctly
while describing a run no conforming producer could create. EX2 has the composition the guarantee describes
and the five claims the guarantee is generated from, including the mandatory language claim.

### 5.2 The commitment — published once, at lock, before any sale

```json
{
  "v": 2,
  "run": "EX2", "edition": 1, "unit_count": 3, "canon": "BKR1",
  "header_digest": "<hex>", "root": "<hex>",
  "codes_commit": "<hex>", "code_leaves": ["<hex>", "…unit_count entries, bundle order…"],
  "blob_hash": "<hex>", "blob_length": 12388,
  "leaves": ["<hex>", "…unit_count entries, bundle-number order…"],
  "composition": [ … ], "chase_ladder": [ … ], "claims": [ … ],
  "guarantee": "…",
  "rarity_table_version": "rarity-v1", "rarity_table_hash": "<hex>",
  "rarity_table": [ { "source": "art rare", "class": "ART_RARE" }, … ],
  "close_by": "2027-03-31T23:59:59.000Z",
  "sales_close_at": "2027-01-31T23:59:59.000Z",
  "unsold_policy": "…",
  "anchors": [ … ]
}
```

A verifier recomputes `header_digest` from these fields and rejects any mismatch.

Contains **no contents, no salts, no verification codes, no parcel identifiers, no monetary values, and no
per-bundle state.** Merkle proofs are not published because every proof derives from `leaves` and
`code_leaves`.

**Published exactly once and never republished.** Were it reissued as bundles shipped, an observer
archiving successive versions could diff them and identify which bundle changed.

`chase_ladder` fixes publicly, before any sale, which cards count as chases — by set code, card number,
language, grader and grade, never by name alone, because §1.1 establishes names are ambiguous.

An amendment (§10.5) publishes a **separate, new** commitment; it never rewrites this one.

### 5.3 Verification codes and the blob file

Each bundle has a **verification code**: **26 Crockford base32 characters (130 bits)** from a
cryptographically secure source, generated at lock, printed on the insert inside that parcel, displayed as
six hyphen-separated groups of four followed by a pair.

100 bits was already sufficient given that no un-iterated function of the code is exposed anywhere
(§5.3.1). 130 bits is insurance against a future entropy or RNG failure rather than against the analysis in
§5.3.5, and it costs only six extra characters on the rare occasion someone types a code instead of
scanning the QR. Both reviewers recommended it.

**Canonicalisation.** Remove exactly the ASCII characters `-` (U+002D) and space (U+0020) — no other
separator, and Unicode confusables are rejected rather than mapped. Uppercase ASCII letters only. Apply
Crockford aliases `I`,`L` → `1` and `O` → `0`. The generation alphabet is Crockford's 32 symbols
`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, which excludes `I`, `L`, `O` and `U`. The result must be exactly 26
characters from that alphabet; anything else is invalid. **Every formula takes
`canonicalCode`.** There is no check symbol — AES-GCM authentication fails cleanly on a mistyped code.

**Codes must be distinct** within a run. Duplicates are invalid: two identical codes yield one key, which
would break the claim that cross-entry nonce collisions are harmless.

```
blobKey(i)   = PBKDF2-HMAC-SHA-256( password = UTF8(canonicalCode_i),
                                    salt     = UTF8("BKR1/key/" + public_id),
                                    c = 600000, dkLen = 32 )
codeLeaf(i)  = SHA-256( 0x04 || blobKey(i) )
codesCommit  = merkleRoot( codeLeaf(0) … codeLeaf(n-1) )    // bundle-number order
```

#### 5.3.1 `codeLeaf` derives from the KDF output, not the code

**Revision 3 defined `codeLeaf = SHA-256(0x04 ‖ ns(code))` — one un-iterated hash of the very secret PBKDF2
protects.** Both reviewers found it, and it is the same class of object revision 2's redesign had just
removed in the form of a code-derived filename. Two exposures: publishing `code_leaves`, which §6 requires
since membership proofs must come from somewhere, would hand an attacker 25 fast targets; and even
delivered privately, every buyer's proof carries a neighbour's raw leaf, giving each buyer a fast verifier
for another bundle's code.

Measured locally: the raw-code leaf costs **37.8 µs**; the KDF-derived leaf costs **64 ms** — and against
dedicated hardware the gap is the full 600,000-iteration factor, restoring the work factor §7 claims.

Because the leaf now costs a full PBKDF2 per candidate, **`code_leaves` is published** in the commitment
and clients derive membership proofs exactly as they do for `leaves`. That also resolves the delivery
question revision 3 left open, under which §6's membership check was literally unimplementable.

#### 5.3.2 One file, no filename derivation

All bundle blobs live in a single object. No filename is derived from any code — revision 1's defect, which
made the name a single-SHA verifier for a PBKDF2-protected secret.

```
BKR1BLOBS                       9-byte ASCII magic
version   : uint8               = 2
count     : uint16 big-endian   = unit_count
blobLen   : uint32 big-endian   = L, identical for every entry
then count entries, ascending bundle-number order:
    nonce  : 12 bytes           random, unique per entry
    ct     : L bytes
    tag    : 16 bytes
```

A parser **must** validate the magic, a version it implements, `count == unit_count`, `L` within a sane
bound, an exact total length of `16 + count × (L + 28)` with no trailing bytes, and that **exactly one**
entry authenticates under the derived key. The container header is unauthenticated before key discovery, so
a malformed `count` or `L` must not be allowed to drive unbounded allocation.

The buyer derives their key once and trial-decrypts entries until a GCM tag authenticates. **A conforming
page attempts every entry regardless**, so the number of attempts cannot leak the bundle index by timing.

Beyond removing the fast verifier, one file removes **per-blob CDN access logs** — an observer could
otherwise record that an address fetched a given blob and combine that with the close-out — and
**upload-order metadata** mapping opaque names to bundle order.

The object must be served with permissive CORS headers, because the independently hosted verifier of §8.2
fetches it cross-origin.

#### 5.3.3 Plaintext, padding and nonces

```
plaintextBody = ns("BKR1-BLOB") || ns(public_id) || ns(pad3(bundle_no))
             || ns(bundleSaltHex) || ns(attributeCount)
             || for each attribute in sorted name order:  ns(name) || ns(value)

framed = uint32 big-endian byteLength(plaintextBody) || plaintextBody || 0x00 padding to length L
L      = 4096 bytes, a GLOBAL CONSTANT for every run of this canon version
```

**`L` is a global constant, not a per-run value.** Revision 4 derived it from the largest record in the
run, which had two problems: it disclosed that largest record's size, and it left Edition 1 with roughly
160 bytes of headroom on the tightest bundle — so an amendment replacing a card with a longer name could
be refused outright with no recovery. A fixed 4096 gives every bundle well over a kilobyte of slack and
makes entry size identical **across editions**, so nothing can be inferred by comparing runs.

A body that would exceed `L` cannot be locked. At Edition 1's ~2.6KB records that is not a live
constraint; a future composition with many more lines would need a new `canon` version.

**`L` therefore never changes, amendments included.** An amendment whose body would
exceed it is refused rather than re-padding every entry. This matters because re-padding means
re-encrypting, and an implementer who reused each entry's nonce "because the plaintext is the same" would
reuse a GCM key/nonce pair across different plaintexts — leaking their XOR and the authentication key.
§10.5 gives the amendment rules that follow from this.

**AEAD:** AES-256-GCM, `aad = ns("BKR1") || ns(public_id) || ns(unit_count)`. **Nonce:** 12 bytes from a
cryptographically secure source, fresh per entry. Each entry has its own key, so a cross-entry collision is
harmless *given distinct codes*; an entry is encrypted exactly once. An all-zero nonce is not forbidden in
principle — uniqueness under a key is the property that matters — but production uses random nonces.

#### 5.3.4 Vectors

EX2 fixture, invented codes, **all-zero nonces which are a fixture artefact only**:

```
codes = K7M4-QX92-3RTB-9F5W-2HJD-X8N6-PV
        R3ND-8T6V-XA2Q-Z5W7-M4KC-H9J2-BF
        B9F2-H5J8-K3M6-N7P4-Q1RS-TVWX-YZ

blobKey[0]  = 26f284ca7942f63636fa659b7270a75ec0e758ff3257b16388768ded8fc33989
blobKey[1]  = e12ee8f282dfec70bde95da385ca2e8ffbc85b134807cf5b477150b5bf1f7f00
blobKey[2]  = 0eb39bdcfe081e9336c9c1449201fa12d0900cb258cb7bf3814fbf88bb919981

codeLeaf[0] = 28dad5a08119ef13d3f15e276cc764cb736b7e2e32cb219aa761c979a436e84e
codeLeaf[1] = 0984872b74d624b49af9af303776acb40c354130e58021d735d56d2eefdef60f
codeLeaf[2] = 99472dca8d9298a789fb043c17c8f5d7656603c1f1eb06f5a4ae40db6caa12f5
codesCommit = c0c03deb405fc4a7643c6669ebecc8af9abb27a35fc7189bac1f22608dab05f4

proof for code index 1 of 3:
[ { "hash": "28dad5a08119ef13d3f15e276cc764cb736b7e2e32cb219aa761c979a436e84e", "side": "L" },
  { "hash": "99472dca8d9298a789fb043c17c8f5d7656603c1f1eb06f5a4ae40db6caa12f5", "side": "R" } ]

plaintextBody lengths = 2572, 2653, 2583      L = 4096
blob file length      = 12388      (16 + 3 x (4096 + 28))
entry 0 GCM tag       = 2c9e203d4edebffd3b75089555ced97a
blobHash              = 895e997da12d0d21c3e6c9b6c6f1dd374ea4bf96c51bd193cae4c6fef18f8257
```

#### 5.3.5 Why 100 bits

With no server the attack is offline, so the threat model is dedicated SHA-256 hardware. At 10²⁰ hashes/s
and 600,000 PBKDF2 iterations:

```
10^20 / 600,000 = 1.67 × 10^14 candidate codes per second
60-bit code, mean search   ≈ 58 minutes
100-bit code, mean search  ≈ 1.2 × 10^8 years
130-bit code, mean search  ≈ 1.3 × 10^17 years   (the length actually used)
```

Two qualifications. Each PBKDF2 iteration is an HMAC, so the true rate is nearer 8 × 10¹³/s — conservative
for the attacker, so the figures stand as an upper bound. And the KDF salt is per-run, not per-bundle, so
one derivation tests every entry: with *K* codes in a space of *N* the expected search is *N*/(*K*+1) =
2¹⁰⁰/26 ≈ 2⁹⁵·³, about **9.3 × 10⁶ years**. Immaterial, but the two barriers are **not** independent and
this document does not claim they are. A per-bundle salt is unavailable because the buyer does not know
their bundle number until after decryption.

PBKDF2 is retained: at 100 bits entropy dominates, and Argon2id would add a third-party dependency to the
one page that must be trustworthy. Both reviewers agree, conditional on no un-iterated function of the code
being exposed anywhere — which §5.3.1 now enforces.

### 5.4 Code transport

The code travels in the **URL fragment**, stripped before dereferencing under RFC 3986 and never sent in an
HTTP request:

```
https://<storefront>/pages/verify#r=EX2&c=K7M4-QX92-3RTB-9F5W-2HJD-X8N6-PV
```

The run identifier is included because key derivation needs it.

The fragment stops HTTP and CDN logging. It does **not** stop malicious page JavaScript, browser history
sync, a QR-scanner app, a screenshot, or an unboxing photograph — and a Content-Security-Policy does not
restrain compromised same-origin code. The code is a bearer secret and buyers must be told so. §8.2.

### 5.5 The close-out disclosure

Published when the run **closes** — every bundle sold and shipped (§5.6.6) — **plus a delivery grace period
of 21 days after the final dispatch**, because "shipped" is not "delivered" and publishing assignments while
parcels are in transit identifies who is receiving a valuable one.

| Tier | Opens | Proves | Stays sealed |
| --- | --- | --- | --- |
| **A** | `bundle.is_chase` for all bundles | N bundles are **labelled** chase (§2.1 — not that only N contain one) | every card identity |
| **B** | For all bundles, **every attribute any published claim references**, across every slot and line (§5.5.1) | **Every clause of the published guarantee**, for every bundle | `display_name`, `identity_key`, `set_code`, `card_number`, `cert_number`, `upc`, `finish` |
| **C** | Every attribute of the labelled-chase bundles | **Claim 3**, in full, with the multiset check of §5.5.2 | the ordinary bundles' contents |
| **D** | Everything | Full audit | Nothing |

Default is **A + B + C**.

#### 5.5.1 The claim-to-attribute rule, normatively

Revision 3 said tier B opens "whatever the published claims reference, derived mechanically from
`claimsCanonical`" without stating the mapping, so an implementer would open too little. The mapping:

| claim_type | opens, for every bundle |
| --- | --- |
| `grader` | `grading_company` on every line of the subject slot, plus `kind` and `qty` |
| `min_grade` | `grade`, plus `kind` and `qty` |
| `language` | `language` on every line of every slot, plus `kind` and `qty` |
| `rarity_in` | `rarity`, plus `kind` and `qty` |
| `packs_language` | `language` and `product_type` on every line of the named slot, plus `kind` and `qty` |
| `slot_count` | `kind` and `qty` on every line of every slot |

Where a claim's subject is a slot whose composition `kind` is `sealed`, `product_type` is opened too. A
reviewer showed that opening only `kind`, `qty` and `language` under a slot *named* `packs` proves a
quantity under a namespace, not that the committed product is a booster pack: a line with
`product_type = deck_box` would satisfy every field then opened while the guarantee said "booster packs".

`kind` and `qty` accompany every claim because they establish **occupancy**: without them a claim's values
could sit on an otherwise-empty padded line. Subject `bundle` means every slot; a slot name means that slot.

**A consequence, and the rule that neutralises it.** Opening `qty` on every pack line reveals each bundle's
pack structure — the structure §4.5's padding conceals. It is disclosed only at close, and is harmless
**provided pack composition is assigned independently of chase placement**. That independence is a binding
design rule; where practical, packs should be uniform across a run, making the disclosure vacuous. §8.16
records honestly that this is a policy, not a cryptographic binding, and that a malicious seller could
deliberately encode `is_chase` in pack structure.

**Rarity is opened for every bundle**, mapped to a class through the published table (§11.1) before the
claim is tested. This publicly ranks ordinary bundles by their main price driver once the run closes —
accepted deliberately, since the guarantee names a rarity and proving a claim means opening what it rests
on. §8.13.

#### 5.5.2 Close-out verification obligations

A close-out artifact is not a bag of proofs. A verifier **must**:

- for every opening, check the index and tree size, and that the step count and L/R pattern are exactly
  those §4.8 produces for that `(index, size)`;
- check the reconstructed leaf equals `leaves[index]` from the commitment;
- **compute the exact expected opening set and require it exactly.** Revision 4 said "every index exactly
  once", which a literal implementation rejects on every valid tier-B artifact, because one bundle
  contributes many attribute openings all carrying the same run-tree index. The unit is the pair
  `(bundle index, attribute name)`. Derive the required attribute names from `claimsCanonical` and
  `compositionCanonical` via §5.5.1, then require **exactly one opening for every
  `(bundle index, required attribute name)` pair, with no extras and none missing**;
- **evaluate every claim over the opened values, and refuse on any counterexample.** Revision 4 checked
  only that openings were structurally valid. A seller could therefore commit `slot.slab.00.grade = "9"`,
  publish the claim `min_grade slab gte 10`, open the `9` honestly with correct salt and proofs, and pass
  every listed check. The public verifier exists precisely to constrain a dishonest producer, so it must
  run the evaluators of §11.2, not merely trust that the producer ran them;
- for tier C, require **all** of: the opened index set equals exactly the indices whose tier-A value is
  `1`; each such bundle contributes **exactly one** ladder match, and that match is in the run's unique
  `is_chase_slot`; and the matches form a **bijection** with `chase_ladder`. Revision 4 required only a
  global multiset equality, which a reviewer showed passes when two ladder cards sit in one labelled
  bundle and none in another — claim 3's "one per bundle" would have been false while the check passed.

#### 5.5.3 What A + B + C reveals jointly

The tiers are not independent privacy envelopes. B attaches a grader/grade/language/rarity/pack profile to
every bundle; C gives exact identities for the chase-labelled ones; subtracting C from an archived
inventory pool shrinks the candidate set for every B profile; one legitimate holder subtracts one more; and
deterministic line sorting adds ordering constraints among hidden values. Effective anonymity is the size of
the candidate class *after* all of that, not before. This requires auxiliary inventory knowledge and is a
composition attack, not a break of SHA-256. §8.10.

### 5.6 Allocation — the buyer chooses

**Revision 4 deletes the randomised allocation entirely.** Revisions 1 and 3 each tried and each failed: a
sealed permutation the seller generated and therefore knew, then a per-purchase Bitcoin beacon whose seed
input was seller-authored and whose "future" block might already exist. Two independent reviews broke both.

The replacement is simpler and stronger for the buyer: **every buyer picks their own bundle number from
those still available**, online and in person alike.

#### 5.6.1 What this deletes, and what it delivers

Deleted outright, along with every attack against them: beacon seeds, `occurredAt` grinding, Bitcoin header
timestamps being miner-set and non-monotonic, post-dated blocks that already exist, confirmation depth,
reorg handling, canonical-chain and byte-order rules, modulo bias, miner withholding, cancel-and-re-roll,
and the race between a pending online draw and an event opening.

Delivered: **claim 4, as stated.** The buyer selects; we cannot decide which bundle they receive. That is
also a claim a buyer understands immediately, which the beacon never was.

Bundle numbers are opaque to buyers — choosing 7 over 12 carries no information — so a buyer's choice is
subjectively a random draw while being objectively outside our control.

#### 5.6.2 The committed sale ledger

Every event appends an entry. Entries are chained, and **the run identifier is inside the hash** so a chain
cannot be replayed across runs:

```
ledgerHash(0) = "0000…0000"   (64 lowercase hex zeros)
ledgerHash(i) = SHA-256( 0x05 || UTF8( ns(public_id) || ns(ledgerHash(i-1)) || ns(seq) || ns(kind)
                                     || ns(ref) || ns(occurredAt) || ns(bundleNo) || ns(qty)
                                     || ns(detail) ) )
```

`ledgerHash(i-1)` is encoded as **64 lowercase hex characters**, not raw bytes.

| field | meaning |
| --- | --- |
| `seq` | 1-based ordinal over **sale entries only**, strictly increasing, no gaps. **`0` for every non-sale entry, cancellations included.** Revision 4's vector used `3` on a cancel, contradicting its own prose — the third revision running with a ledger-vector defect, caught by both reviewers |
| `kind` | `sale_online`, `sale_in_person`, `cancel`, `reprice`, `pause`, `resume` |
| `ref` | For a sale, a **random 128-bit receipt token, lowercase hex**, issued to that buyer and printed on their confirmation. For a cancellation, the token of the entry being cancelled. Empty otherwise |
| `occurredAt` | RFC 3339 instant, UTC, milliseconds |
| `bundleNo` | **The bundle number chosen**, zero-padded to 3. Empty for `pause` and `resume` |
| `qty` | `1` for a sale, `0` otherwise |
| `detail` | Event identifier, cancellation reason, or for `pause` the committed set of bundle numbers taken to an event |

**`ref` is a random token, not a hashed order number.** Revision 3 used `SHA-256(order id)` and called it
privacy-preserving; both reviewers pointed out storefront order numbers are short and sequential, so the
preimage space is a few thousand values and anyone recovers ordinal ↔ order number instantly. A random
token is disclosed only to that buyer, who can still locate their own entry.

**`bundleNo` is inside the hash.** Revision 3 said the ledger "records the bundle number chosen" while the
hash formula had no such field, so the chain did not commit the thing it claimed to audit.

`ledgerHash(n)` is anchored **at each entry or small batch**, not merely "periodically", and the first entry
is anchored immediately — otherwise the gap between a sale and its anchor is exactly where a rewritten
history lives.

**Cancellations** append a `cancel` entry naming the original token and releasing its bundle number back to
the available set. The ledger is append-only; nothing is rewritten. **A cancellation is only valid before
dispatch.** A post-dispatch return is not a release: a parcel whose contents one person has already seen
must never go back on sale, and nothing in revision 4 prevented that.

**Pricing is run-wide.** Every unsold number carries the same price at every instant. A price change is a
`reprice` entry applying to the whole remaining set, anchored like any other. Revision 4's policy permitted
per-bundle discounts and per-bundle auctions, which on a one-variant-per-number storefront is a lawful and
invisible way to route the public away from the chases — a reviewer's sharpest finding, and one our own
anchored policy authorised. Prices never appear in a public artifact (§2.2 guardrail 1); the `reprice`
entry records only that a run-wide change occurred and when.

**Entries are published live, not merely anchored.** Anchoring proves order; publication is what lets a
buyer told "7 is gone" check that 7 was genuinely sold. An entry is public as soon as it is written.

**Every unsold number is purchasable at all times outside a `pause`.** The ledger refutes a false *sold*
but records nothing about a number simply never offered, so this is committed policy rather than a
derivable fact — an honest limit, listed in §8.18.

#### 5.6.3 The ledger is the availability proof

Buyer-choice introduces one new steering vector: **lying about availability** — a buyer asks for 7, we want
to keep 7, we say it is taken.

The ledger closes this at no cost. Every sale records its chosen number, so **the available set at any
moment is derivable by anyone** from the anchored chain. A buyer told "7 is gone" can check that 7 was
genuinely sold to an earlier `seq`, and a buyer shown a restricted set can compare it against what the
ledger says remained. Availability becomes verifiable rather than asserted.

Online this is enforced structurally as well: the run is listed as **one variant per bundle number, one unit
each**, so the storefront's own inventory prevents a number being sold twice and displays the true remaining
set. That also removes the channel-locking race entirely — a number sold in person is a variant set to zero,
and no pending draw exists to collide with it.

#### 5.6.4 In-person events

The buyer picks from the parcels present. Two rules:

1. **All unsold bundles travel**, and the set present is committed in the `pause` entry's `detail`. A seller
   bringing only a subset regains selection control, and the committed set makes a shortfall checkable
   against the ledger's available set.
2. **The online channel is closed for the session**, recorded by the `pause` and `resume` entries.

Parcels must be identifiable at the table for a buyer to choose one, so bundle numbers are visible at
events. §8.17 records the exposure that creates.

#### 5.6.5 Vectors

EX2 fixture, invented tokens. Empty fields encode as `ns("")` = `0:,`.

```
kind             seq  ref                               occurredAt                bundle qty  detail
sale_online      1    a1b2c3d4e5f60718293a4b5c6d7e8f90  2026-09-01T10:00:00.000Z  002    1    (empty)
  -> 255db3441ab840f9ecad6d6003a2d61cd22b5dc61496c4f19fb4153a7d677d5e
reprice          0    (empty)                           2026-09-02T09:00:00.000Z  (empty) 0   run-wide price change
  -> d6d0ab9b48e64cb4916332a2d0ec1d4a42d38e3c2e0980cf435a31c659aef058
pause            0    (empty)                           2026-09-03T08:00:00.000Z  (empty) 0   event-melbourne;present=001,003
  -> 1cf85148bd734f398b3ea9ad8ea69325854dd083729468a2daa46066c8dbbfe8
sale_in_person   2    9f8e7d6c5b4a39281706f5e4d3c2b1a0  2026-09-03T11:20:00.000Z  003    1    event-melbourne
  -> 24f9150ba3d05429d8f00ac7b15b179f596f45355bf52609ace113d49a9f6c37
resume           0    (empty)                           2026-09-03T17:00:00.000Z  (empty) 0   event-melbourne
  -> aef2d1fbdbbd1528513417102c2f712355d8fadf161f842eb2e868ee042cfd76
cancel           0    9f8e7d6c5b4a39281706f5e4d3c2b1a0  2026-09-04T09:00:00.000Z  003    0    buyer requested refund
  -> b57e154ecb04a0b89e119b240a7e6c33dd97cb786fe622ead839a3c7a8a76328
```

`detail` grammar: a semicolon-separated list of `key=value` pairs, or a bare event identifier. For `pause`,
`present=` carries the comma-joined ascending list of zero-padded numbers taken to the event. Keys and
values are restricted to `[A-Za-z0-9_.,=-]`.

Revision 4's vector used `seq = 3` on the cancel while its prose said non-sale entries carry `0`; both
reviewers caught it and one computed the conforming value, which reproduced exactly on independent check.
Revision 5's cancel carries `0`, and the whole chain is regenerated above.

#### 5.6.6 What this does not fix: self-dealing

**We know which numbers hold the chases, because we packed them.** Buyer-choice is fair among parties with
equal ignorance, and we are never ignorant. So nothing here stops us **buying** a chase — and buyer-choice
makes that *easier* than the beacon did, since we can take bundle 7 on day one rather than waiting for a
chase-heavy remainder.

This is not fixable by cryptography while we hold the manifest, which we must in order to commit to it at
all. Revision 3 claimed the committed sales policy made withholding "detectable and attributable"; that was
true of *withdrawal* and false of *purchase*, and both reviewers said so.

What is committed instead, in the anchored header:

```
unsoldPolicy = "Every bundle in a run is sold at one price shared by every remaining number.
                No bundle is withdrawn from sale, priced differently from any other, or
                purchased by the seller or an affiliate."
```

Three consequences, none of them a proof:

1. A run cannot close until every bundle number appears as sold in the published ledger — mechanically
   checkable.
2. Withdrawing a bundle is a visible breach of an anchored rule.
3. Self-purchase is a **stated commitment**, so breaching it is a false published statement rather than an
   unaddressed possibility.

**Claim 5 is labelled weak in §2 for exactly this reason.** A ledger row cannot distinguish an arm's-length
buyer from us. Options that would change that — independent custody of the tail, a compulsory third-party
no-reserve auction, externally signed order evidence — are real, cost money and add a third party, and are
recorded in §12.1 rather than dismissed.

### 5.7 Anchoring

An anchor makes *"this digest existed before time T"* checkable by someone who does not trust the seller.
**What is anchored is `headerDigest`, as 32 raw bytes**, and separately each ledger checkpoint.

#### 5.7.1 Anchor portability

The anchor is replaceable and should be evaluated separately. Scheme security rests on SHA-256 and the
salts. Changing it affects the submission client, one display branch, and this section. Anchor records carry
a `method` discriminator with generic receipt, height, transaction and URL fields.

**"Anchored" is a set of independent claims, not one.**

#### 5.7.2 The anchor set

1. **A keyless timestamping calendar** (OpenTimestamps, into Bitcoin), submitted to multiple calendars.
   **The header's timestamp must be CONFIRMED — not merely submitted — before sales open** (§5.7.7).
2. **A dated public post** carrying the digest.
3. **A public, independently-archived record** — a commit to a public repository, or a web-archive
   snapshot of the commitment.

Ledger entries are submitted to the same calendars as they are written, batched at most hourly. Their
confirmations arrive asynchronously and nothing waits on them: the ordering that matters is
*header confirmed before the first sale*, and §5.7.7 establishes that directly.

#### 5.7.3 Why there is no transparency log

Revisions 3 and 4 required a transparency-log inclusion proof, for two reasons: an immediately
verifiable anchor so sales could open the moment a run locked, and amendment discovery. Revision 5 drops
it, and both reasons dissolve rather than being traded away.

**The immediacy requirement was self-inflicted.** A calendar attestation proves nothing to an outsider
while it is pending, which is why revision 2's "submitted is enough" gate was wrong. But the fix does not
have to be a second anchoring system — it can simply be **waiting**. A run is locked on a planned date and
sales open once the Bitcoin timestamp confirms, typically within hours. The gap costs nothing for a run
launched to a schedule, and it buys an anchor that is independently verifiable by anyone with a Bitcoin
node and no account, key, identity or monitoring infrastructure anywhere in the system.

**What a log would have cost.** A stable public signing identity — under Sigstore's keyless flow, a
personal Google or GitHub account that becomes permanently enumerable — plus an entry schema, key
rotation, a monitor, and consistency-proof checking. Both reviewers also established that a log **cannot
detect a candidate the seller never submitted**, and that enumeration by an arbitrary run identifier is not
a service such logs reliably offer. It was buying less than it appeared to.

**Amendment discovery** therefore rests on publication rather than enumeration: every header, original and
amended, is published at a stable well-known location for the run and carries its predecessor's digest
(§10.5), and the dated public post names each new digest. An amendment that is never published is
undiscoverable — which was **also true with a log**, since an unlogged header is invisible to it. §8.21.

**Under buyer-choice, lock-time grinding buys nothing anyway**: chase placement is chosen directly rather
than drawn, so there is no random outcome to re-roll. Chase numbers are still randomised at lock, but only
to avoid a guessable pattern, not as a security property.

**Abandonment.** Lock phase 2 can fail after a digest has been submitted for timestamping. An abandoned
digest is simply never published, and only a published header is authoritative. Because sales cannot open
until the published header's timestamp has confirmed, an abandoned submission has no path to becoming the
commitment.

#### 5.7.4 Scope limit

**We submit and store receipt bytes verbatim; we do not implement receipt verification.** A hand-rolled
parser bug could produce a *false claim about anchoring*, worse than not anchoring. The page links the
official independent verifier and offers the receipt for download.

#### 5.7.5 The upgrade is mandatory

A calendar returns an **incomplete attestation**, self-contained only after upgrading. **An un-upgraded
receipt is not a durable anchor** — verifying it needs the calendar to still exist and hold its aggregation
data. A background job upgrades every receipt and stores the upgraded bytes; an anchor is not reported
confirmed until upgraded; one still un-upgraded after a defined interval raises an alert.

#### 5.7.6 The upgraded receipt is published

Storing it only in our database would make verification contingent on our infrastructure surviving. It is
published alongside the commitment, content-addressed. Until upgrade completes the incomplete attestation is
published and labelled pending, then replaced. **This is the only published artifact ever revised**, and it
is safe to revise because it carries no per-bundle information.

#### 5.7.7 The sale gate

Sales are refused until **all** of the following hold: the run is locked; the header, commitment and blob
file are published; and **the header's OpenTimestamps attestation has been upgraded to a confirmed Bitcoin
block**. The confirmed timestamp is the evidence that the commitment predates every sale, and it is
checkable by anyone with a Bitcoin node and no account anywhere.

Revision 2 opened sales on a pending submission, which proves nothing to an outsider. Revisions 3 and 4
patched that with a transparency log; revision 5 waits instead (§5.7.3).

The public page reports `pending` or `confirmed in block N` honestly and never says "anchored" for
something in flight.

---

## 6. The verification flow

The parcel contains an insert carrying the verification code in grouped form, a QR of the fragment URL, the
first 16 hex characters of `headerDigest`, and instructions. It carries **no monetary values**. The printed
digest prefix is a human cross-check, not a security control.

1. The buyer scans the QR, or types the code.
2. The page fetches the commitment and **recomputes `headerDigest`** from its fields, rejecting a mismatch.
3. It fetches the blob file, **checks `SHA-256(file)` equals the committed `blob_hash`**, validates the
   container per §5.3.2, derives `blobKey`, and trial-decrypts every entry — yielding the bundle salt,
   attributes and number.
4. It computes `codeLeaf = SHA-256(0x04 ‖ blobKey)` and verifies membership in `codes_commit` at index
   `bundle_no − 1`, using `code_leaves` from the commitment.
5. It rebuilds every attribute commitment, the attribute tree, the leaf, and the run-tree proof, and walks
   to `runRoot`.
6. **It displays every committed slot** and asks the buyer to confirm each against the physical contents.
   The certification number is typed and compared **in the browser**.
7. It shows any amendment affecting this bundle, the anchor state, the buyer's own ledger entry located by
   their receipt token, and a link to the independent verifier.
8. **It offers a download of the buyer's own opening** — salt, attributes, both proofs, the commitment and
   the anchor receipt, as one self-contained file — so verification survives us.

**Two distinct results, never merged:**

- *"This record was committed before the run went on sale"* — proven cryptographically.
- *"The physical contents match that record"* — asserted by the buyer, item by item, in step 6.

A wrong code fails at decryption and a wrong certification number fails at comparison, both client-side.

### 6.1 Verifier obligations

A conforming verifier **must** perform all of the following and refuse on any failure.

- `headerDigest` recomputed from the commitment equals the published and anchored value.
- The header's timestamp is **confirmed**, and its block precedes the first ledger entry's `occurredAt`.
- `length(leaves) == unit_count`; `length(code_leaves) == unit_count`; no duplicates in either.
- The Merkle root over `leaves` equals `root`; over `code_leaves` equals `codes_commit`.
- `SHA-256(blob file)` equals `blob_hash`, and the container parses per §5.3.2.
- `leaves[bundle_no − 1]` equals the leaf recomputed from the decrypted blob — **the check that binds a blob
  to its position**.
- Every membership proof is checked with its index and tree size, including step count and L/R pattern.
- The decrypted `run.public_id` and `bundle.no` match the commitment and the blob's position.
- The attribute name set is exactly what `compositionCanonical` implies; populated and padded lines satisfy
  §4.4; §4.3 grammars hold on populated lines only.
- `codeLeaf` derived from `blobKey` is present in `codes_commit` at index `bundle_no − 1`.
- `rarityTableHash` recomputed from the published table matches the header.
- **The decrypted `bundle.no` equals the `bundleNo` on the ledger entry carrying the buyer's receipt
  token.** This is the parcel-to-choice binding, and revision 4 omitted it — nothing stopped staff handing
  bundle 12's parcel to the buyer who chose 7, and no artifact recorded the mismatch.
- The ledger chain recomputes from its published entries, each entry's anchor verifies, and `blob_length`
  equals the fetched byte count.
- **Every claim in `claims` evaluates true over the values this verifier has opened.** The structured
  claims are the security boundary (§11.2); the English guarantee is a rendering of them and is committed
  so it cannot be swapped, but a verifier judges the claims, not the prose.
- Every attribute value satisfies §4.2 well-formedness, and quantities sum to `qty_per_bundle` per slot,
  line `kind` matches the composition's slot `kind`, singleton slots hold one populated line, and
  `requires_cert` slots carry a non-empty `cert_number`.

The certification number is compared against the physical slab by the buyer, and the page **must direct them
to confirm that certificate on the grading company's own site**, which displays the graded card's image. A
cert number is visible in photographs, so a string comparison proves only that we committed to that number,
never that the slab in hand is genuine.

---

## 7. Threat model

| Attack | Why it fails |
| --- | --- |
| **I know a chase card's certification number — which bundle holds it?** | No input anywhere pairs a bundle number with a certification number. Verification is a static fetch keyed on a 100-bit code in a URL fragment, and the cert never leaves the browser. Note tier C deliberately pairs chase certs with bundles **at close**. |
| Guess a verification code | 100 bits through 600,000 PBKDF2 iterations, offline, **with no un-iterated function of the code exposed anywhere** (§5.3.1). ≈9.3 × 10⁶ years for any of 25 at 10²⁰ hashes/s. |
| Use a blob filename, or `codeLeaf`, as a fast pre-filter | No filename derives from a code, and `codeLeaf` derives from the PBKDF2 output. |
| Brute-force contents from a published leaf, or a one-bit attribute | Attributes carry independent 32-byte derived salts. |
| Learn contents from a proof | Sibling hashes only. Proof *lengths* reveal attribute position and bundle index, both public. |
| Learn a bundle's structure from proof length | Identical padded attribute sets; blob entries byte-identical in size. **Tier B deliberately reverses this at close.** |
| Use my own bundle to learn another's | Cryptographically nothing transfers. **Compositionally it can** — §5.5.3, §8.10. |
| Diff published artifacts | The commitment is published once with no per-bundle state; the blob file is hash-committed; only the anchor receipt is revised, and it carries no per-bundle data. |
| Correlate CDN fetches with buyers | One file for the whole run. IP, time and run identity remain observable. |
| Substitute a card after publishing | Requires a second preimage. **Physical substitution is a different matter** — §8.5, §8.6. |
| Change the ladder, guarantee, composition, policy, rarity table or blob after sales | All inside `headerDigest`. `v` and `anchors` are outside and are treated as untrusted (§5.1). |
| Mint fresh codes or a fresh blob after learning buyers | `codes_commit` and `blob_hash` are anchored, and membership is now verifiable (§5.3.1). |
| Choose a digest after observing sales | Header inclusion must precede the first ledger entry's inclusion, both externally timestamped. |
| **Steer a specific buyer to a specific bundle** | The buyer chooses (§5.6). Lying about availability is refuted by the ledger, which makes the available set derivable. |
| Bring only some bundles to an event | The set present is committed in the `pause` entry and checkable against the ledger's available set. |
| Rewrite the ledger after seeing a random seed | There is no seed. The randomised allocation is deleted. |
| **Buy the chases ourselves** | **Not prevented.** A committed policy statement only — §5.6.6, §8.7. |
| Hide an amendment | Only as strong as the log identity, monitoring and consistency checking, which §12.4 records as unspecified. |
| Lock, inspect, abandon, re-lock | **Not detectable by a log** (§5.7.3), and moot under buyer-choice since there is no draw to re-roll. |
| Replay one opening under several bundle labels at close | Every index required exactly once, with index-bound proofs (§5.5.2). |
| Read the manifest from the internal network | Bearer token on internal routes — an operational control only (§8.11). |

---

## 7.1 Defect history, revision 1

| # | Defect | Resolution |
| --- | --- | --- |
| 1 | Attribute sets varied in size between bundles | Fixed `max_lines` padding |
| 2 | Verification required an authenticated endpoint on a private service | Static encrypted blobs |
| 3 | The commitment carried a mutable `shipped` flag | Publish once, no mutable public state |
| 4 | Contents committed, allocation not | Sealed permutation — **itself later broken** |
| 5 | `is_chase` defined by the seller | Ladder published before any sale |
| 6 | Amendments could launder a substitution | Root chain surfaced |
| 7 | Internal API open on the private network | Bearer-token gate |
| 8 | Salt revealed on dispatch | Contents never published before close; the code travels physically |

## 7.2 Defect history, revision 2

| Finding | Resolution |
| --- | --- |
| Sealed permutation does not prove fair allocation | Per-purchase beacon — **itself later broken** |
| Anchored root did not bind ladder, guarantee, composition, allocation | `headerDigest` |
| `blobName(code)` was a one-SHA verifier bypassing PBKDF2 | Single combined file |
| Code transmitted in a query string | URL fragment |
| Tier A proves labels, not chase count | Claim restated (§2.1) |
| Tier B did not establish occupancy | `kind` + `qty` |
| Codes and blobs could be minted after sales | `codesCommit` — **completed only in revision 4** |
| §6 reported success after non-slab substitution | Two distinct results |
| Pending anchor did not prove pre-sale ordering | Required immediate external anchor |
| PBKDF2 arithmetic; physical uniformity; non-atomic lock; amendments; ~25 under-spec items | All accepted |

## 7.3 Defect history, revision 3

| Finding | Resolution |
| --- | --- |
| Optional stopping — stop selling once only chases remain | Committed sales policy — **shown inadequate in revision 4** |
| Lock-grind-relock; undiscoverable amendments | Transparency log — **claim withdrawn in revision 4** |
| Tier B proved only the chase slot | Widened to every claim-referenced attribute |
| Blob availability | Buyer exports a self-contained opening |
| Verifier obligations unstated; CORS; cert-site check | All accepted |
| Rarity table version pinned nothing checkable | Table hash-committed and published |

## 7.4 Defect history, revision 4 — disposition of the two revision-3 reviews

Two independent reviews, by different agents. Both reimplemented `BKR1` and matched every published value.

| Finding | Disposition | Where |
| --- | --- | --- |
| **Self-purchase defeats the sales policy — "sold" includes "sold to the seller"** | **Accepted, critical.** Both found it. Revision 3 called withholding "detectable"; withdrawal is, purchase is not | §2.1, §5.6.6, §8.7 |
| **`occurredAt` was seller-authored and the ledger only periodically anchored**, so the beacon input stayed mutable after the seed existed | **Accepted, critical** | Allocation deleted, §5.6 |
| **Bitcoin header timestamps are miner-set, non-monotonic, post-datable by two hours**, so the "future" block may already exist | **Accepted, critical** | Allocation deleted |
| **In-person "buyer picks" gave no defence against a confederate**, and relied on physical uniformity §8.6 disclaims | **Accepted.** Buyer-choice is retained, but its claim is now scoped to *we cannot steer you*, never *no collusion is possible* | §5.6.6, §8.17 |
| **`codeLeaf` recreated the fast-verifier defect**, and its membership proof was unimplementable | **Accepted, high.** Both found it | §5.3.1 |
| **The blob file was not bound to the header** | **Accepted, high** | §5.1 `blobHash` |
| **The header fixture violated the document's own lock rules** — slab-only claims bound to a guarantee about packs, and no language claim | **Accepted, embarrassing.** Both found it. Fixture rebuilt on EX2 | §4.10.2, §5.1 |
| **Guarantee prose not normatively derived from claims** | **Accepted** | §11.2, verifier regenerates and byte-compares |
| **Ledger vector contradicted the ledger prose** | **Accepted.** One reviewer's corrected value was itself wrong — the prose reading gives `cacef573…`, not their `4c9992ff…` | §5.6.5 |
| **Chosen bundle and event set absent from the hash chain** | **Accepted** | §5.6.2 |
| **`ref = SHA-256(order id)` is reversible** — order numbers are short and sequential | **Accepted** | §5.6.2, random token |
| **Close-out had no indexed coverage check**, so one opening could be replayed under many labels | **Accepted, high** | §5.5.2 |
| **Claim 3 needed a multiset check** | **Accepted** | §5.5.2 |
| **Cancellation unspecified and a retry oracle** | **Accepted.** Moot for allocation once the draw is deleted; the schema is now specified | §5.6.2 |
| **Transparency-log enumeration does not work as claimed** | **Accepted, claim withdrawn.** A log cannot reveal unsubmitted candidates | §5.7.3 |
| **Normalisation vector was inert** | **Accepted.** Independently verified: the source held a precomposed `é` and a literal `\t`, and the U+3000 was interior | §4.10.3 |
| **Padded numeric fields contradicted the §4.3 grammars** | **Accepted** | §4.3 |
| **Populated vs padded lines undefined; duplicate leaves and codes permitted; `v` outside the digest; bare dates not instants; timing channel in trial decryption** | **Accepted** | §4.3, §4.4, §4.8, §5.1, §5.3 |
| Reviewer's multi-target figure of ~8 years | **Disputed, and conceded by that reviewer.** *N*/(*K*+1) ≈ 15.5 years at 10²⁰ H/s is right |
| Reviewer's `4c9992ff…` corrected ledger hash | **Disputed.** Independently computed as `cacef573…` under the prose reading. The defect is real; the arithmetic was not |
| Adopt zero-knowledge proofs for the count claim | **Disputed on proportionality.** Both reviewers agree with us. "Unavoidable" stays withdrawn as overstated |
| Adopt Argon2id | **Disputed.** Both reviewers now agree PBKDF2 is right at 100 bits once no fast verifier exists |
| Beacon at sale close, dispatch after `salesCloseAt` | **Disputed on commercial grounds, and now moot.** With randomness deleted, the choice is buyer-selection versus nothing |
| Independent custody, threshold-encrypted mapping, escrowed penalties for self-dealing | **Noted, not adopted.** Real techniques, disproportionate for a 25-unit run. §12.1 rather than dismissal |

---

## 7.5 Defect history, revision 5 — disposition of the final review round

Two independent reviews of revision 4. Both reimplemented `BKR1`; both confirmed the code and blob layer
clean and the arithmetic correct. Their findings split cleanly into implementation defects, which are fixed
here, and claims disagreements, which are settled by owner decision and recorded rather than argued.

**Implementation defects — accepted and fixed**

| Finding | Fix |
| --- | --- |
| **The verifier never evaluated the claims it published.** Commit grade `9`, publish `min_grade gte 10`, open the `9` honestly — every listed check passed | §5.5.2, §6.1: evaluate every claim over opened values |
| **Tier C permitted two chases in one bundle and none in another** — global multiset {1,2,3} passed | §5.5.2: index equality with tier A, one match per bundle, in the chase slot, bijection |
| **"Every index exactly once" rejected every valid tier-B artifact** — one bundle contributes many openings at the same index | §5.5.2: the unit is `(bundle index, attribute name)`, derived as an exact matrix |
| **`bundle.seal_serial` was required by §8.5 and impossible under §4.4/§4.5** | Added to the attribute set |
| **EX2 was not reproducible** — every `identity_key`, pack `game` and all three composition labels were unstated, and it used `max_lines` 2 while §3 declared 3 | §4.10.2 restated field by field, `max_lines` 3, labels stated, all vectors regenerated |
| **Cancel `seq` contradicted the prose** for the third revision running | Cancels carry `seq = 0`; chain regenerated |
| **No parcel-to-choice binding** — staff could hand #12's parcel to whoever chose #7 | §6.1 |
| **Amendment re-encryption risked GCM nonce reuse** | §5.3.3, §10.5: `L` fixed at lock, unaffected entries copied verbatim, fresh nonce for changed |
| **Tier B proved a quantity under a slot *name*, not a product type** | §5.5.1 opens `product_type` for sealed slots |
| **Free-text composition labels injected unproved nouns** into the anchored sentence | §11.2: labels display-only, `[A-Za-z ]{1,32}` |
| **The byte-equality guarantee check was unimplementable** | §11.2 restructured: claims are the boundary and are evaluated; the sentence is generated and committed but not regenerated by verifiers |
| **Bundle salts were not required to be distinct** | §4.6 |
| Post-dispatch cancellation could return a known parcel to sale | §5.6.2: pre-dispatch only |
| Ledger publication timing unstated | §5.6.2: entries are public when written |
| `detail` had no grammar | §5.6.5 |

**Claims — settled by owner decision, not by further design**

| Reviewer position | Decision |
| --- | --- |
| Withdraw claim 4; allocation is unprovable while the seller knows the map | **Claim 4 is kept, scoped to the mechanism**: the buyer selects and we cannot assign. §2 no longer implies anything about equal odds, and §2.1 states the limit plainly. The zero-trust property this product sells is *contents*, and that is proven |
| Bring in independent custody, a verifiable shuffle, or threshold encryption | **Declined.** A third party is the opposite of what this system is for. The trust that remains is ours, is named, and is anchored as policy |
| Per-bundle pricing is an invisible steering lever, and our own policy authorised it | **Accepted in full.** One price for every remaining number at all times; `reprice` is run-wide; per-bundle auctions removed from the policy |
| A buyer with a scale could find chases by weight at an event | **Operational control**: parcels are handled under supervision and instruments are not permitted. §8.6 |
| Pre-sale chronology is not externally proven | **Accepted as a residual** (§8.20). Closing it needs signed third-party order evidence, which is declined above |
| The rarity table is seller-authored | **Accepted as a residual** (§8.19). It is committed and public before any sale; the control is scrutiny |

**Two design questions settled after the reviews**

| Question | Decision |
| --- | --- |
| Blob entry length `L` | **Global constant, 4096 bytes.** Revision 4 derived it per run from the largest record, which disclosed that size and left ~160 bytes of headroom on Edition 1's tightest bundle — an amendment with a longer card name would have been refused with no recovery. A fixed value also makes entry size identical across editions |
| The required immediately-verifiable anchor | **Dropped; wait for the Bitcoin confirmation instead** (§5.7.3). The immediacy requirement was self-inflicted. Waiting removes a signing identity, an entry schema, key rotation, a monitor and consistency-proof checking from the system, and both reviewers had already established a log cannot detect an unsubmitted candidate |

---

## 8. Residual risks

### 8.1 Buyer collusion
If every buyer but one publishes their verification, the remaining bundle follows by elimination for
attributes constrained by a known global multiset. Not preventable.

### 8.2 A compromised verification page
It could show a false result or exfiltrate a code, and a first-party CSP does not restrain first-party code.
Mitigable by a signed, reproducible, content-addressed standalone verifier hosted independently, with
printed instructions for reaching it. **A page cannot usefully attest its own source hash** — the hash must
be published elsewhere.

### 8.3 Backups contain the secrets
Mitigable by envelope encryption under a key held outside the snapshot, per-run, with access separation and
scheduled erasure.

### 8.4 Commitment is not truth
A committed cert for a card never in our possession verifies perfectly. Mitigations are procedural:
validation against the grader's public database at intake, and tier C exposure.

### 8.5 Physical substitution after packing
**The seal serial must be committed as a bundle attribute**, not merely recommended, so the parcel binds to
the record. Serials are random per bundle, never a contiguous block.

### 8.6 Physical uniformity is not enforced
Component count is enforced; weight, thickness and profile are not. This is an operational control on
whoever packs and on event supervision — parcels are handled under staff supervision and measuring
instruments are not permitted at the table.

A reviewer observed that under buyer-choice a physical tell becomes a *buyer-side* advantage rather than a
seller-side one, which is a real change from the beacon design. The operational control is the answer; the
system does not claim to prevent it, and §2 claims nothing about equal odds.

### 8.7 Self-dealing is not prevented
We know the map and can buy any bundle. The committed policy (§5.6.6) makes it a false published statement
rather than an unaddressed possibility, but no artifact distinguishes our purchase from a stranger's.
**The most significant residual in revision 4**, and the reason claim 5 is labelled weak.

### 8.8 Support-channel re-issue
The lost-insert path yields full contents for that bundle. Requires proportionate identity checks, dual
approval, buyer notification and audit logging.

### 8.9 Failure to close, and split-view publication
`close_by` makes a breach visible, not impossible. Split-view serving is mitigated by content-addressing,
the anchor and third-party archiving — none of which we control, which is the point. A specified monitor
with consistency-proof checking would strengthen it.

### 8.10 Fingerprinting from auxiliary data
§5.5.3. Effective anonymity is the candidate class size after A, B, C, one holder's opening and ordering
constraints.

### 8.11 Insider access
We hold the complete map at all times. The bearer token is an operational control, not an auditable
boundary: it says nothing about transport, token scope, insiders, host compromise, the print pipeline or
backups.

### 8.12 Public artifact disappearance
Mitigated by content-addressing, third-party archiving and the buyer's exportable opening — **but only for
buyers who export it**, and the blob file should be mirrored independently before sales.

### 8.13 Rarity ranking of ordinary bundles
Tier B opens `rarity` for every bundle, leaving a permanent public record of which ordinary bundles held the
better rarity. Accepted: the guarantee names a rarity, so proving it means opening it. Published only after
delivery.

### 8.14 Chase-recipient exposure
Close-out publishes which bundles held chases, and the ledger publishes bundle numbers against ordinals.
Anyone who can map an ordinal to a person learns who holds a high-value item — a physical-safety
consideration. Mitigated by the grace period and by random receipt tokens replacing hashed order numbers.

### 8.15 No defence against a false buyer claim
Nothing proves what was physically delivered. Committed seal serials plus an intact tamper-evident seal are
partial evidence; resolution is commercial.

### 8.16 The pack-independence rule is policy, not binding
§5.5.1 requires pack composition to be independent of chase placement so tier B's disclosure carries no
signal. That is not a database invariant, not committed and not publicly checked. A malicious seller could
deliberately encode `is_chase` in pack structure — or in physical profile (§8.6).

### 8.17 Bundle numbers are visible at events
A buyer must be able to identify parcels to choose one, so numbers are visible where bystanders watch.
Combined with tier A at close, an observer who noted who took which number learns who holds a chase. Random
seal serials do not help, because we can always map serial to bundle.

### 8.18 A number never offered leaves no trace
The ledger refutes a false *sold*, but an unsold number that is simply never displayed — an unpublished
variant, "that one's reserved" at a table — produces no entry at all. §5.6.2 commits the policy that every
unsold number is purchasable at all times outside a `pause`; nothing derives it from the chain.

### 8.19 The rarity table is ours to write
We author and publish the source-to-class mapping the rarity claim is evaluated through. A dishonest
mapping would pass an automated evaluator. It is published and committed before any sale, so the control
is public scrutiny rather than a proof.

### 8.20 Pre-sale chronology is proven against the published record, not the world
The header's Bitcoin timestamp confirms before any sale, so the commitment provably predates every
*recorded* sale. It does not exclude an unrecorded private sale before the header existed. Closing that
would need independently signed order evidence binding the header digest — a third party, which is
declined by design.

### 8.21 An unpublished amendment is undiscoverable
Amendment discovery rests on our publishing each header at a stable location and naming it in the dated
post. Nothing forces us to publish one. This was equally true under the transparency-log design, since a
log cannot reveal an entry never submitted to it.

---

## 9. Data model

The host system is an internal, single-process service backed by an embedded SQL database on a private
network. **The governing constraint is that this module must not duplicate the existing stock model**: the
moment two systems disagree about whether a card is committed, the product fails.

### 9.1 Entities

`runs` · `run_slot_specs` · `run_bundles` · `run_reservations` · `run_bundle_slots` · `run_chase_tiers` ·
`run_earmarks` · `run_amendments` · `run_claims` · `run_anchors` · `run_ledger` · `run_audit`

Monetary values exist on exactly **one** column, the run's unit price. No money column exists on any
per-bundle or per-slot table, which is what makes the public projections structurally incapable of carrying
one.

### 9.2 Invariants enforced by the database

1. **A singleton slot holds exactly one item per bundle** — partial unique index on `(bundle_id, slot)`
   restricted to rows flagged singleton. The flag is copied from the slot spec at insert, because a
   constraint that must join another table is not one the database can enforce.
2. **A physical item is in at most one bundle, ever** — partial unique index on the reservation ledger over
   live states.
3. **A certification number appears in at most one bundle, ever** — partial unique index on the slot table.
   Deliberately redundant with (2).
4. **A locked run carries its commitment**; a slot requiring certification carries one; **a bundle number is
   sold at most once** in the ledger.

The per-run equality rule is asserted in the lock transaction: for every bundle and slot spec, summed
quantity equals `qty_per_bundle` and no undeclared slot is present.

### 9.3 Reservation is a ledger, not a status value

Adding a fourth "reserved" value to the existing three-value stock lifecycle was considered and rejected: an
audit of the call sites showed it would be silently ignored in two places that publish items for sale while
working by accident in two others. Reservation is orthogonal to lifecycle.

States: `active` → `committed` → `consumed` / `released` / **`broken`** (it sold elsewhere anyway — never
deleted; the incident record).

**One path is deliberately unguarded**: the routine decrementing stock on a genuine sale. If a reserved item
really sells elsewhere the sale is real, and blocking the decrement would leave the business believing it
owns something a customer paid for. The sale proceeds, the reservation is marked broken, an alert fires, and
the run cannot lock until a human resolves it. Degrade visibly.

---

## 10. Lifecycle and integration

### 10.1 States

```
draft → locked_pending_publish → locked_published → selling → shipped → closed → disclosed
```

- **draft** — items assigned and reserved, freely rearranged.
- **locked_pending_publish** — manifest frozen, all cryptographic material generated, nothing public.
- **locked_published** — blob file, commitment and required anchor all in place. Sales may open.
- **selling** — buyers choose bundles; the ledger grows and is anchored per entry.
- **shipped** — all parcels dispatched.
- **closed** — every bundle number recorded sold, `salesCloseAt` honoured, `close_by` not exceeded.
- **disclosed** — after the grace period, the tiered disclosure is published.

### 10.2 Binding rules

Derived from the slot specification, not slot names. A **singleton** slot binds one stock row at quantity 1
and refuses a row whose quantity exceeds 1 — a partial reservation means the database can no longer answer
"this exact physical object is in bundle 7". A **multi-line** slot binds several rows per §4.4. Where the
spec requires certification, a missing cert is refused.

Individual sealed packs are not modelled as separate stock rows; claim 1 is scoped accordingly (§2.1).

### 10.3 Sales

The run is listed as **one variant per bundle number, one unit each**, so the storefront's own inventory
enforces single sale and displays the true available set (§5.6.3). Orders are read by a polling read-only
query and appended to the ledger with the chosen number. In-person sales append with `kind =
sale_in_person`. Opening an event session writes a `pause` entry committing the set taken and closes the
online channel; closing it writes `resume`.

### 10.4 Lock is two phases, because it cannot be atomic

**Phase 1, one database transaction →** `locked_pending_publish`: re-validate the manifest against the
composition; randomise chase placement with a cryptographic random source; freeze slot descriptors and pad
to `max_lines`; generate salts and codes; build attribute trees, leaves, `runRoot`, `codesCommit`, **the
complete blob file and its hash**, and `headerDigest`; generate the guarantee from the claims; mark
reservations committed; audit.

Building the blob file in phase 1 is what makes phase 2 genuinely idempotent — revision 3 encrypted in phase
2, so a retry with fresh nonces produced different, uncommitted ciphertext.

**Phase 2, idempotent and retryable →** `locked_published`: upload the blob file, publish the commitment,
submit anchors, re-fetch each artifact and verify it reads back correctly, then transition.

### 10.5 Amendments are normative

A locked manifest is never edited in place. An amendment recomputes the tree and publishes a **new header
with its own anchor**. The amendment fields extend the §5.1 formula, appended in this order after
`unsoldPolicy`:

```
|| ns(predecessorHeaderDigest) || ns(amendmentSeq) || ns(reason)
|| ns(affectedBundleNumbers)   || ns(amendedAt)
```

where `affectedBundleNumbers` is a comma-joined ascending list of zero-padded numbers. An original header
omits all five fields. **`codesCommit` is carried unchanged into every amended header**, or inserts already
shipped would stop verifying.

**The amended blob file, normatively.** Revision 4 left this undefined, and both reviewers found the same
hazard in it:

- `L` is the **global constant** of §5.3.3 and never changes. An amendment whose body would exceed it is
  refused.
- Entries for **unaffected bundles are copied byte for byte** — same nonce, same ciphertext, same tag.
- Each **affected** entry is re-encrypted under its unchanged key with a **fresh nonce**. Reusing the old
  nonce on changed plaintext under the same key would leak the XOR of the two plaintexts and the GCM
  authentication key.
- The new file gets its own `blobHash`, which enters the amended `headerDigest`. A buyer's exported
  opening (§6 step 8) remains valid against the header it was taken under; the verification page shows
  both the original and amended chain. The verification page must surface any amendment affecting the bundle being
verified, and an amended bundle cannot render a plain success state.

---

## 11. Guardrail enforcement

| # | Constraint (§2.2) | Mechanism |
| --- | --- | --- |
| 1 | No monetary values customer-facing | **(a)** Public projections are database views with no monetary column. **(b)** A sanitiser deep-walks every outbound payload and **throws** on a money-shaped key or value-claim string — throwing, because a silently stripped field is a defect nobody sees. **(c)** A test seeds known values and asserts those **literal numbers** appear nowhere in any response |
| 2 | Counts, never ratios | The guarantee is generated; the only count renderer emits an integer-to-word form. A test scans for `%`, `/`, "odds", "chance", "probability" |
| 3 | Guarantee true of the manifest | §11.2 |
| 4 | Language disclosed | The lock is refused if the claim set lacks a language claim while any item's language is non-default |

### 11.1 The rarity vocabulary

**Rarity claims are never evaluated by string comparison.** Every source string maps to a **rarity class**
through a committed table, and claims are set membership over classes. Three problems force this:
cross-language aliases ("Art Rare" and "Illustration Rare" are one card); an abbreviation collision, since
`AR` maps from both "Art Rare" and the unrelated "Amazing Rare", so classes derive from the full source
string and never from an abbreviation; and unmapped values, which have no class, satisfy no claim, and fail
the lock closed.

Source strings are lowercased using **ASCII case folding only**, after §4.2 normalisation.

Illustrative entries — the operative table for a run is published with its commitment and hash-committed in
the header:

| source string | class |
| --- | --- |
| `amazing rare` | `AMAZING_RARE` |
| `art rare` | `ART_RARE` |
| `illustration rare` | `ART_RARE` |
| `mega attack rare` | `MEGA_ATTACK_RARE` |
| `mega_attack_rare` | `MEGA_ATTACK_RARE` |
| `special art rare` | `SPECIAL_ART_RARE` |
| `special illustration rare` | `SPECIAL_ART_RARE` |

**Classes carry display names**, because the guarantee renderer needs them and revision 4's table had no
such column — one of the reasons its byte-equality check could not be implemented:

| class | display name |
| --- | --- |
| `AMAZING_RARE` | Amazing Rare |
| `ART_RARE` | Art Rare |
| `MEGA_ATTACK_RARE` | Mega Attack Rare |
| `SPECIAL_ART_RARE` | Special Art Rare |

```
rarityTableCanonical = ns("SOURCES") ns(count)
                       for each source sorted byte-wise:  ns(source) ns(class)
                       ns("CLASSES") ns(count)
                       for each class sorted byte-wise:   ns(class) ns(display)
rarityTableHash      = SHA-256( 0x06 || UTF8(rarityTableCanonical) )
```

For the rows above this is 417 bytes and
`ca971d5d15666d83cfeb4b451dc3bd99d6639e7eeee70c23002c39a7d28d83e0`.

**Honest limit.** We publish the table, so we could in principle map a junk source string to a valuable
class. A reviewer raised this and it is real: an automated evaluator would accept it, and only a human
reading the published table would notice. The table being committed and public is the control — the
mapping is visible to anyone before a single bundle sells — but it is scrutiny, not cryptography. §8.19.

### 11.2 The guarantee is generated from the claims

**The structured claims are the security boundary. The English sentence is a rendering of them.**

Revision 4 required a verifier to regenerate the sentence and compare it byte for byte. Both reviewers
showed that could not be implemented: the described renderer was prose rather than a grammar, the rarity
table had no display names, and the example's ordering did not follow the canonical claim order. A
mandatory check no two implementers can agree on is worse than no check.

Revision 5 splits the roles:

- **The producer generates the sentence from the claims**, so the copy cannot assert more than the claims
  support. This is the §2.2 guardrail-3 mechanism and it is where compliance is enforced.
- **The sentence is committed** in `headerDigest`, so the words a customer reads cannot be swapped after
  publication.
- **The verifier evaluates the claims**, not the English (§5.5.2, §6.1). A false guarantee is caught by a
  claim failing over opened values, which is a decidable test.

**Claim vocabulary is closed.** A verifier must reject an unknown `claim_type`, `operator` or `subject`
rather than ignore it — silence must fail closed, not open.

| claim_type | operator | subject | value | evaluator |
| --- | --- | --- | --- | --- |
| `grader` | `eq` | slot name | grading company code | every populated line of the slot has that `grading_company` |
| `min_grade` | `gte` | slot name | decimal per §4.3 | every populated line's `grade` parses and is ≥ the value |
| `language` | `eq` | `bundle` or slot | language code | every populated line in scope has that `language` |
| `rarity_in` | `in` | slot name | class set | every populated line's `rarity`, mapped through §11.1, is in the set |
| `packs_language` | `eq` | slot name | language code | as `language`, scoped to that slot |
| `slot_count` | `eq` | `bundle` | `slot:qty` list | per slot, summed `qty` over populated lines equals the stated quantity |

**Rendering.** Fragments are emitted in `claimsCanonical` order and assembled into a fixed skeleton:

```
Every bundle contains <slot_count phrase>, where the <chase slot label> is
<grader+min_grade token> <language word> and of <rarity_in phrase>.
```

Integers render as words from a fixed table; language codes render through the rarity table's class
display column and a language display table committed alongside it; slot labels render from
`compositionCanonical`. **Composition labels are display-only and never introduce a noun the claims do not
support** — a reviewer noted that a free-text label such as "booster packs and a guaranteed bonus card"
would otherwise inject an unproved assertion into an anchored sentence. Labels are restricted to
`[A-Za-z ]{1,32}`.

A run whose rarity table lacks a display name for a class in its claim set **fails to lock**.

The first edition's claims and the sentence they generate:

```
grader     slab   eq  PSA
language   bundle eq  JA
min_grade  slab   gte 10
rarity_in  slab   in  ART_RARE, MEGA_ATTACK_RARE, SPECIAL_ART_RARE
slot_count bundle eq  art:1, packs:3, slab:1
```

> Every bundle contains one PSA 10 graded Japanese card of an illustrated chase rarity (Art Rare, Mega
> Attack Rare or Special Art Rare), three sealed Japanese booster packs and one art card.

Note the rarity classes render in canonical byte order — Art, Mega, Special — which revision 4's example
did not, one of the reasons its byte-equality check was unreachable.

A run whose pool includes a class outside the committed set fails to lock, with the offending bundle named.

---

## 12. Open questions

The review programme is closed and the anchoring and blob-length questions are settled (§5.7.3, §5.3.3).
What remains are build-time details, none of them blocking.

1. **Grace period.** 21 days after final dispatch is a guess; it should exceed the slowest realistic
   delivery plus a margin.
2. **Multi-unit purchases.** One entry per bundle, so a buyer wanting three produces three choices and
   three ledger entries. Confirm that is the intended checkout experience.
3. **Ledger anchoring cadence.** Entries are submitted for timestamping as written, batched at most
   hourly. Confirm the batch bound.

---

## 13. Appendix — implementation map

*Internal orientation only. Not part of the review.*

| Section | Implementation site |
| --- | --- |
| §4 encoding, normalisation, attributes | `lib/runs-canonical.mjs` — isomorphic, served to the browser |
| §4.7–4.9 hashing, trees, proofs, selective disclosure | `lib/runs-merkle.mjs` — isomorphic |
| §5.1–5.5 header, commitment, blob file, disclosure | `lib/runs-public.mjs` — the only module permitted to build a customer-facing payload |
| §5.6 sale ledger and availability | `lib/runs-ledger.mjs` |
| §5.7 anchoring | `lib/runs-anchor.mjs` |
| §9 schema | `migrateRuns(db)` in `lib/db.mjs` |
| §9.3 reservation ledger and guards | `lib/runs-reserve.mjs`, plus guards at the publish, listing, pooling, repricing and stock-mutation call sites |
| §10.3 sales | `lib/runs.mjs`, one storefront variant per bundle number |
| §11 claims, renderer, rarity table | `lib/runs-claims.mjs` |
| Internal UI | `runs.html`, `runs-intake.html`, `runs-verify.html` |
| Public verification page | The storefront theme repository, separate from this one |

Test categories follow existing convention: unit tests per module, invariant tests for architectural
properties, schema-pinning tests for configuration, and integration tests against a booted server.
