// test-strategy-parser.js — strategy file parsing and IST calendar helpers.
// Pure functions only: no network, no broker.
//
// Run:  node --test tests/strategy-parser.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

const { parseStrategyFile } = require(BACKEND + "/strategy/parser");
const ist = require(BACKEND + "/strategy/ist");

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

// IST helpers
test("IST parts are computed independently of the server's time zone", () => {
  // 2026-11-17 03:50 UTC = 09:20 IST
  const p = ist.parts(Date.UTC(2026, 10, 17, 3, 50, 0));
  assert.strictEqual(p.date, "2026-11-17");
  assert.strictEqual(p.hhmm, "09:20");
  assert.strictEqual(p.minutes, 9 * 60 + 20);
  assert.strictEqual(p.weekday, 2); // Tuesday
});

test("an epoch expiry converts to its IST calendar date", () => {
  // Upstox stores expiry as epoch ms at the end of the IST day
  const ms = Date.UTC(2026, 10, 17, 18, 29, 59); // 23:59:59 IST on 17 Nov
  assert.strictEqual(ist.dateOf(ms), "2026-11-17");
  assert.strictEqual(ist.dateOf("2026-11-17"), "2026-11-17");
});

test("DTE counts trading days and skips weekends", () => {
  assert.strictEqual(ist.tradingDaysBetween("2026-11-17", "2026-11-17"), 0); // expiry day
  assert.strictEqual(ist.tradingDaysBetween("2026-11-16", "2026-11-17"), 1); // Mon -> Tue
  assert.strictEqual(ist.tradingDaysBetween("2026-11-13", "2026-11-17"), 2); // Fri -> Tue
});

test("IST HH:MM on a date converts to the right instant", () => {
  assert.strictEqual(ist.timeOn("2026-11-17", "09:20"), Date.UTC(2026, 10, 17, 3, 50, 0));
});

// Parser
test("v38: NIFTY + SENSEX, two leg groups every 10 minutes on expiry day", () => {
  const { ok, spec, errors } = parseStrategyFile(fixture("0dte-v2_v38.strategy.json"));
  assert.ok(ok, errors.join("; "));
  assert.strictEqual(spec.name, "0dte v2");
  assert.deepStrictEqual(spec.symbols.map(s => s.underlying), ["NIFTY", "SENSEX"]);
  assert.deepStrictEqual(spec.symbols.map(s => s.segment), ["NSE_FO", "BSE_FO"]);
  assert.deepStrictEqual(spec.entryDte, [0]);
  assert.strictEqual(spec.expiryWhich, "current_week");
  assert.deepStrictEqual(spec.stop, { mode: "per_leg", multiplier: 2 });
  assert.strictEqual(spec.dailyLossPct, 2);
  assert.strictEqual(spec.exit.hold, "to_expiry");

  assert.strictEqual(spec.groups.length, 2);
  const [base, extra] = spec.groups;
  assert.strictEqual(base.slots[0], "09:20");
  assert.strictEqual(base.slots[base.slots.length - 1], "14:20");
  assert.strictEqual(base.slots.length, 31);
  assert.deepStrictEqual(base.legs.map(l => [l.action, l.type, l.lots, l.strike.rule, l.strike.delta]),
    [["SELL", "CE", 3, "delta", 20], ["SELL", "PE", 3, "delta", 20]]);
  assert.deepStrictEqual(extra.legs.map(l => [l.lots, l.strike.delta]), [[7, 10], [7, 10]]);
});

test("v32: three groups with their own time windows", () => {
  const { ok, spec, errors } = parseStrategyFile(fixture("0dte-v2_v32.strategy.json"));
  assert.ok(ok, errors.join("; "));
  assert.strictEqual(spec.dailyLossPct, 1);
  assert.deepStrictEqual(spec.groups.map(g => [g.slots[0], g.slots[g.slots.length - 1], g.slots.length]),
    [["09:20", "10:20", 13], ["10:30", "11:20", 11], ["11:30", "14:20", 35]]);
});

test("unsupported features are rejected, not silently ignored", () => {
  const raw = fixture("0dte-v2_v38.strategy.json");
  raw.strategy.target = { k: 50, mode: "pct" };
  raw.strategy.orb = { minutes: 15 };
  const { ok, errors } = parseStrategyFile(raw);
  assert.strictEqual(ok, false);
  assert.ok(errors.some(e => /target/.test(e)));
  assert.ok(errors.some(e => /orb/.test(e)));
});

test("files that are not bt-strategy-config are rejected", () => {
  assert.strictEqual(parseStrategyFile({ hello: 1 }).ok, false);
  assert.strictEqual(parseStrategyFile(null).ok, false);
});

test("an unknown data source is rejected", () => {
  const raw = fixture("0dte-v2_v38.strategy.json");
  raw.strategy.extra_symbols[0].data_source = "mystery_feed";
  const { ok, errors } = parseStrategyFile(raw);
  assert.strictEqual(ok, false);
  assert.ok(errors.some(e => /mystery_feed/.test(e)));
});

test("schedule times outside market hours are rejected", () => {
  const raw = fixture("0dte-v2_v38.strategy.json");
  raw.strategy.schedule = [{ start: "08:00", end: "09:00", every_min: 10 }];
  assert.strictEqual(parseStrategyFile(raw).ok, false);
});
