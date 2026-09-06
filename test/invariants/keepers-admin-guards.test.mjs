// test/invariants/keepers-admin-guards.test.mjs — the guards on the Keepers admin surface, asserted
// against SOURCE TEXT.
//
// Same shape and same reasoning as shopify-hooks-isolation.test.mjs: these are properties a runtime
// test cannot prove absent. An integration test can show that mint refuses TODAY, with a blanked
// DIAG_TOKEN and mode 'off'; it cannot show that the refusal is still there after someone deletes a
// line. Source assertions can.
//
// Each of these was a real hole before this change, not a hypothetical:
//   · data/keepers.db was TRACKED — the only tracked .db in the repo, committed by mistake in
//     18de0c5, holding customer XP and points, opened in WAL mode. A branch switch reverted it.
//   · bootServer did not redirect it, so any integration test touching /api/keepers wrote the real one.
//   · mintRedemption reads neither cfg.mode nor project.allowLive and takes `store` as a plain
//     parameter, so nothing below the route stopped a real discount code landing on the live store.
//   · the projection route, registered after the /customers/ prefix branch, would never have run.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';

const keepers = read('lib/keepers.mjs');
const status = read('lib/status.mjs');
const boot = read('test/helpers/boot-server.mjs');
const ignore = read('.gitignore');

describe('the points ledger is not a tracked file', () => {
  it('.gitignore covers data/keepers.db and both WAL sidecars', () => {
    for (const f of ['data/keepers.db', 'data/keepers.db-wal', 'data/keepers.db-shm']) {
      assert.ok(ignore.includes(f), `${f} must be gitignored — a tracked SQLite file in WAL mode can be reverted to a stale snapshot by an ordinary checkout`);
    }
  });

  it('the two server-owned configs are ignored too', () => {
    // Both hold ARMING state — which store, which mode, whether live writes are allowed — and that is
    // per-machine. Committing either pushes one box's arming onto another.
    assert.ok(ignore.includes('data/keepers.config.json'));
    assert.ok(ignore.includes('data/shopify-hooks.config.json'));
  });

  it('bootServer redirects the ledger, before Vite loads the module', () => {
    // KEEPERS_DB_PATH is a module-scope const, so setting it in a test file is too late — the module
    // has already captured it. It has to be here.
    assert.match(boot, /process\.env\.TCG_KEEPERS_DB = path\.join\(dataDir, 'keepers\.db'\)/,
      'bootServer must point TCG_KEEPERS_DB at the temp dir, or every integration test writes real customer XP');
    assert.match(boot, /keepersDb: process\.env\.TCG_KEEPERS_DB/,
      'and expose it, so a test can assert which file it is on');
  });
});

describe('every mutating route is behind the diag gate', () => {
  // Read the middleware body and pair each mutating branch with the diagOk immediately following it.
  const body = keepers.slice(keepers.indexOf("server.middlewares.use('/api/keepers'"));

  const MUTATING = [
    "p === '/grant' || p === '/grant-badge'",
    "p === '/sweep' && req.method === 'POST'",
    "p === '/pass' && req.method === 'POST'",
    "p === '/redemptions' && req.method === 'POST'",
    "p === '/checkin' && req.method === 'POST'",
    "p === '/economy/refresh' && req.method === 'POST'",
  ];

  for (const branch of MUTATING) {
    it(`${branch} calls diagOk before doing anything`, () => {
      const at = body.indexOf(branch);
      assert.ok(at > 0, `branch not found — did it move? ${branch}`);
      const window = body.slice(at, at + 400);
      assert.match(window, /if \(!diagOk\(env, req, url\)\) return send\(403/,
        `${branch} must refuse without a diag token`);
    });
  }

  it('the mint/revoke branch is gated too', () => {
    const at = body.indexOf('const mint = /^');
    assert.ok(at > 0, 'the redemption action branch moved');
    assert.match(body.slice(at, at + 600), /if \(!diagOk\(env, req, url\)\) return send\(403/);
  });
});

describe('minting a real discount code is gated on mode AND on the store', () => {
  // lib/keepers-redeem.mjs takes `store` as a plain parameter and reads neither cfg.mode nor
  // project.allowLive; shopifyGraphQL resolves store==='live' to the production shop. So these two
  // checks are the only thing between this route and a spendable code on binderskeepers.cards, and
  // they must live in the route because the function below it will not do them.
  const at = keepers.indexOf('const mint = /^');
  const branch = keepers.slice(at, at + 3200);

  it('refuses unless mode is apply', () => {
    assert.match(branch, /if \(cfg\.mode !== 'apply'\)/,
      'a mint while the engine is off or observing puts a real reward against a ledger nothing writes to');
  });

  it('refuses a live store without project.allowLive', () => {
    assert.match(branch, /cfg\.store === 'live' && cfg\.project\?\.allowLive !== true/,
      'the live seatbelt must be checked here — keepers-redeem.mjs does not check it');
  });

  it('the live seatbelt covers revoke as well, not just mint', () => {
    // Both reach the same store. The check sits above the mint/revoke split deliberately.
    const seat = branch.indexOf("cfg.store === 'live'");
    const split = branch.indexOf('if (mint) {');
    assert.ok(seat > 0 && split > seat, 'the store check must precede the mint/revoke split so revoke is covered too');
  });

  it('mint is NOT wrapped in a transaction', () => {
    // mintRedemption does its own writes around a network round trip on purpose. Holding a SQLite
    // write transaction open across a Shopify call would block every other writer for its duration.
    const m = /await mintRedemption\(/.exec(branch);
    assert.ok(m, 'mintRedemption call not found');
    // `withTransaction(` with the paren, not the bare word: the comment above the call explains why
    // it is absent, and matching the word would find the explanation and fail on it.
    assert.ok(!branch.slice(0, m.index).includes('withTransaction('),
      'mint must not run inside withTransaction');
  });

  it('the open route translates the unique-index throw into a refusal', () => {
    // uq_kr_open is a partial UNIQUE index, so a second open THROWS from the insert rather than
    // returning { ok:false }. Raw, that surfaces as a 500 reading "UNIQUE constraint failed".
    const openAt = keepers.indexOf("if (p === '/redemptions' && req.method === 'POST')");
    assert.ok(openAt > 0);
    assert.match(keepers.slice(openAt, openAt + 2600), /UNIQUE constraint failed/i,
      'a second open must read as "already open", not as a 500');
  });

  it('the tier comes from the cached economy, never from the request body', () => {
    const openAt = keepers.indexOf("if (p === '/redemptions' && req.method === 'POST')");
    const branchOpen = keepers.slice(openAt, openAt + 2600);
    assert.match(branchOpen, /\(conf\.tiers \|\| \[\]\)\.find\(\(t\) => t\.handle === body\.tier\)/,
      'resolving the tier from the body would let the caller choose the price and the discount');
    assert.ok(!/body\.percentOff|body\.pointsCost/.test(branchOpen));
  });
});

describe('route ordering', () => {
  it('the projection route is registered ABOVE the /customers/ prefix branch', () => {
    // startsWith('/customers/') swallows every deeper path, so the order here is the whole
    // difference between the route working and 404-ing as an unknown customer.
    const proj = keepers.indexOf("p.endsWith('/projection')");
    const prefix = keepers.indexOf("if (p.startsWith('/customers/') && req.method === 'GET') {");
    assert.ok(proj > 0 && prefix > 0, 'both branches must exist');
    assert.ok(proj < prefix, 'the projection route must come first or it is unreachable');
  });
});

describe('the unauthenticated settings PUT cannot arm live', () => {
  // PUT /api/settings/:name checks `editable` and `validate()` and NOTHING else — no diag token, no
  // bearer — and the dev server binds 0.0.0.0 so the LAN can reach it. Without these two refusals any
  // device on the network could arm writes to real customer metafields, while POST /api/keepers/grant
  // — 10 XP in a local SQLite file — still demands DIAG_TOKEN.
  // Newline-agnostic. This repo checks out CRLF on Windows, so a literal '\n' anchor finds nothing,
  // slice(-1) hands back an empty string, and every assertion below then fails for the wrong reason.
  const at = status.search(/^[ \t]*keepers: \{[\r\n]+[ \t]*file: 'keepers\.config\.json'/m);
  const entry = at < 0 ? '' : status.slice(at, at + 2200);

  it('the keepers settings entry exists', () => {
    assert.ok(at > 0, 'SETTINGS.keepers must be registered, or /api/status has no jobs.keepers');
    assert.match(entry, /file: 'keepers\.config\.json'/);
  });

  it("refuses store 'live' through the API", () => {
    assert.match(entry, /if \(c\.store === 'live'\)/);
  });

  it('refuses project.allowLive through the API', () => {
    assert.match(entry, /if \(c\.project\?\.allowLive === true\)/);
  });

  it('still delegates the rest to validateKeepersConfig, rather than restating it', () => {
    assert.match(entry, /const base = validateKeepersConfig\(c\);/);
  });
});

describe('status wiring', () => {
  it('jobs.keepers is guarded, unlike its neighbours', () => {
    // Every other getter in the jobs block reads a module-level object. This one opens a database and
    // runs three queries, so unguarded it would 500 the entire status snapshot on a box that has
    // never run the plugin (AGENTS.md GR7).
    assert.match(status, /function keepersJobState\(\) \{\s*try \{/);
    assert.match(status, /catch \(e\) \{ return \{ error: String\(e\?\.message \|\| e\) \}; \}\s*\}/);
    assert.match(status, /keepers: keepersJobState\(\)/);
  });

  it('the HMAC rejection rate counts rejections in its own denominator', () => {
    // sig_failures and received are DISJOINT: a rejected delivery returns 401 before received++ ever
    // runs. Dividing by `received` alone would understate the rate, and a rejection spike is the only
    // warning that an app-secret rotation has silently killed every webhook.
    assert.match(status, /const seen = Number\(receiver\.received \|\| 0\) \+ rejected;/);
    assert.match(status, /hmac_reject_rate: seen \? .* : null/, 'null while nothing has arrived, never a reassuring 0%');
  });

  it('the self-test is registered as a probe', () => {
    assert.match(status, /keepers: '\/api\/keepers\/self-test'/);
  });
});
