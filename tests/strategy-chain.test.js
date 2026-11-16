// test-strategy-chain.js — option chain, Black-76 greeks and strike selection.
// Pure functions with synthetic quotes: no network, no broker.
//
// Run:  node --test tests/strategy-chain.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");

const greeks = require(BACKEND + "/strategy/greeks");
const chainLib = require(BACKEND + "/strategy/chain");
const ist = require(BACKEND + "/strategy/ist");

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} ${a} vs ${b}`);

test("Black-76 price and delta match textbook values", () => {
  const c = greeks.price(100, 100, 1, 0.2, 0, "CE");
  close(c, 7.9656, 1e-3, "call price");
  close(greeks.delta(100, 100, 1, 0.2, 0, "CE"), 0.5398, 1e-3, "call delta");
  close(greeks.delta(100, 100, 1, 0.2, 0, "PE"), -0.4602, 1e-3, "put delta");
});

test("implied volatility round-trips through the price", () => {
  const p = greeks.price(24000, 24300, 0.0008, 0.13, 0.06, "CE");
  close(greeks.impliedVol(p, 24000, 24300, 0.0008, 0.06, "CE"), 0.13, 1e-4, "iv");
  assert.strictEqual(greeks.impliedVol(0, 24000, 24300, 0.0008, 0.06, "CE"), null);
});

// synthetic NIFTY chain
const EXPIRY = "2026-11-17";
const NOW = ist.timeOn(EXPIRY, "09:20");
const F = 24012, SIGMA = 0.35, R = 0.06;
const T = greeks.yearsToExpiry(NOW, EXPIRY);

function makeInstruments() {
  const list = [];
  let tok = 50000;
  for (let k = 23000; k <= 25000; k += 50) {
    for (const type of ["CE", "PE"]) {
      list.push({ segment: "NSE_FO", asset_symbol: "NIFTY", instrument_type: type, strike_price: k,
        expiry: ist.timeOn(EXPIRY, "23:59"), lot_size: 75, exchange_token: String(tok++), trading_symbol: `NIFTY ${k} ${type}` });
    }
  }
  // next week, which must not be picked for current_week
  list.push({ segment: "NSE_FO", asset_symbol: "NIFTY", instrument_type: "CE", strike_price: 24000,
    expiry: ist.timeOn("2026-11-24", "23:59"), lot_size: 75, exchange_token: "70000" });
  list.push({ segment: "NSE_FO", asset_symbol: "NIFTY", instrument_type: "FUT",
    expiry: ist.timeOn("2026-11-24", "23:59"), lot_size: 75, exchange_token: "80000" });
  // SENSEX must not leak into a NIFTY chain
  list.push({ segment: "BSE_FO", asset_symbol: "SENSEX", instrument_type: "CE", strike_price: 80000,
    expiry: ist.timeOn(EXPIRY, "23:59"), lot_size: 20, exchange_token: "90000" });
  return list;
}

function makeQuotes(chain, sigma = SIGMA) {
  const q = {};
  for (const k of chain.strikes) {
    for (const type of ["CE", "PE"]) {
      const inst = chain.byStrike[k][type];
      const p = Math.max(0.05, greeks.price(F, k, T, sigma, R, type));
      q[inst.token] = { bid: +(p - 0.05).toFixed(2), ask: +(p + 0.05).toFixed(2), ltp: +p.toFixed(2), hasData: true };
    }
  }
  q["80000"] = { bid: F, ask: F + 1, ltp: F, hasData: true };
  return q;
}

test("expiries are listed per underlying and current_week is the nearest", () => {
  const ins = makeInstruments();
  const exps = chainLib.listExpiries(ins, "NIFTY", "NSE_FO", "2026-11-17");
  assert.deepStrictEqual(exps, ["2026-11-17", "2026-11-24"]);
  assert.strictEqual(chainLib.pickExpiry(exps, "current_week"), "2026-11-17");
  assert.strictEqual(chainLib.pickExpiry(exps, "next_week"), "2026-11-24");
  assert.strictEqual(chainLib.listExpiries(ins, "NIFTY", "NSE_FO", "2026-11-18")[0], "2026-11-24");
});

test("a chain holds only that underlying and expiry, plus the nearest future", () => {
  const chain = chainLib.buildChain(makeInstruments(), "NIFTY", "NSE_FO", EXPIRY, EXPIRY);
  assert.strictEqual(chain.strikes.length, 41);
  assert.strictEqual(chain.lotSize, 75);
  assert.strictEqual(chain.step, 50);
  assert.strictEqual(chain.future.token, "80000");
  assert.ok(!chain.strikes.includes(80000));
});

test("the forward is recovered from put-call parity at the money", () => {
  const chain = chainLib.buildChain(makeInstruments(), "NIFTY", "NSE_FO", EXPIRY, EXPIRY);
  const { F: fwd, atm } = chainLib.forward(chain, makeQuotes(chain), F, T, R);
  assert.strictEqual(atm, 24000);
  close(fwd, F, 2, "forward");
});

test("delta 20 nearest_ge picks the furthest strike whose delta is still >= 20", () => {
  const chain = chainLib.buildChain(makeInstruments(), "NIFTY", "NSE_FO", EXPIRY, EXPIRY);
  const quotes = makeQuotes(chain);
  const ctx = { F, T, r: R };
  for (const type of ["CE", "PE"]) {
    const pick = chainLib.selectStrike(chain, quotes, ctx, type, { rule: "delta", delta: 20, match: "nearest_ge", minPremium: 0, tolerance: 5 });
    assert.ok(pick.ok, pick.reason);
    assert.ok(pick.delta >= 20 && pick.delta <= 25, `${type} delta ${pick.delta}`);
    // the next strike further out must be below 20
    const further = type === "CE" ? pick.strike + 50 : pick.strike - 50;
    const dFurther = Math.abs(greeks.delta(F, further, T, SIGMA, R, type)) * 100;
    assert.ok(dFurther < 20, `next strike ${further} has delta ${dFurther}`);
    assert.strictEqual(pick.token, chain.byStrike[pick.strike][type].token);
  }
});

test("atm_offset and premium rules", () => {
  const chain = chainLib.buildChain(makeInstruments(), "NIFTY", "NSE_FO", EXPIRY, EXPIRY);
  const quotes = makeQuotes(chain);
  const ctx = { F, T, r: R, atm: 24000 };
  assert.strictEqual(chainLib.selectStrike(chain, quotes, ctx, "CE", { rule: "atm_offset", n: 2 }).strike, 24100);
  assert.strictEqual(chainLib.selectStrike(chain, quotes, ctx, "PE", { rule: "atm_offset", n: 2 }).strike, 23900);
  const p = chainLib.selectStrike(chain, quotes, ctx, "CE", { rule: "premium", premium: 20, match: "nearest_ge", minPremium: 0 });
  assert.ok(p.ok && p.premium >= 20, JSON.stringify(p));
});

test("no quotes means no pick", () => {
  const chain = chainLib.buildChain(makeInstruments(), "NIFTY", "NSE_FO", EXPIRY, EXPIRY);
  const none = chainLib.selectStrike(chain, {}, { F, T, r: R }, "CE", { rule: "delta", delta: 20, match: "nearest_ge", minPremium: 0 });
  assert.strictEqual(none.ok, false);
});

test("a delta no strike can reach takes the nearest strike, marked as a fallback", () => {
  const chain = chainLib.buildChain(makeInstruments(), "NIFTY", "NSE_FO", EXPIRY, EXPIRY);
  const quotes = makeQuotes(chain);
  const far = chainLib.selectStrike(chain, quotes, { F, T, r: R }, "CE", { rule: "delta", delta: 0.001, match: "nearest_le", minPremium: 0, tolerance: 0.0001 });
  assert.ok(far.ok, far.reason);
  assert.strictEqual(far.fallback, true);
  // the lowest-delta CE in the chain is the nearest to 0.001
  const lowest = chainLib.selectStrike(chain, quotes, { F, T, r: R }, "CE", { rule: "delta", delta: 0, match: "nearest", minPremium: 0 });
  assert.strictEqual(far.strike, lowest.strike);
  assert.match(far.note, /nearest strike/);
});

test("an in-tolerance pick is not marked as a fallback", () => {
  const chain = chainLib.buildChain(makeInstruments(), "NIFTY", "NSE_FO", EXPIRY, EXPIRY);
  const pick = chainLib.selectStrike(chain, makeQuotes(chain), { F, T, r: R }, "CE", { rule: "delta", delta: 20, match: "nearest_ge", minPremium: 0, tolerance: 5 });
  assert.ok(pick.ok);
  assert.ok(!pick.fallback);
});

test("strikes needing quotes: a window around the money", () => {
  const chain = chainLib.buildChain(makeInstruments(), "NIFTY", "NSE_FO", EXPIRY, EXPIRY);
  const tokens = chainLib.windowTokens(chain, 24000, 5);
  assert.strictEqual(tokens.length, 11 * 2);
});

test("when the strike gap jumps past the tolerance, the strike with the nearest delta is taken", () => {
  const chain = chainLib.buildChain(makeInstruments(), "NIFTY", "NSE_FO", EXPIRY, EXPIRY);
  const quotes = makeQuotes(chain, 0.14);
  const ctx = { F, T, r: R };
  // at 14% vol the deltas go 55 -> 34 -> 16: nothing within 20 ± 5 that is >= 20
  const pick = chainLib.selectStrike(chain, quotes, ctx, "CE",
    { rule: "delta", delta: 20, match: "nearest_ge", minPremium: 0, tolerance: 5 });
  assert.ok(pick.ok, pick.reason);
  assert.strictEqual(pick.fallback, true);
  assert.ok(pick.delta < 20, `took delta ${pick.delta}`);
  // no other CE has a delta closer to 20
  const strikes = chain.strikes.filter(k => chain.byStrike[k].CE);
  for (const k of strikes) {
    const iv = greeks.impliedVol(chainLib.mid(quotes[chain.byStrike[k].CE.token]), F, k, T, R, "CE");
    if (iv == null) continue;
    const d = Math.abs(greeks.delta(F, k, T, iv, R, "CE")) * 100;
    assert.ok(Math.abs(d - 20) >= Math.abs(pick.delta - 20) - 1e-9, `strike ${k} delta ${d} is nearer than ${pick.delta}`);
  }
  assert.match(pick.note, /took the nearest strike/);
});
