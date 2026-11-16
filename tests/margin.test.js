// test-margin.js — reading utilized / available margin out of the XTS
// balance response (GET /interactive/user/balance). Pure parsing, no network.
//
// Run:  node --test tests/margin.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const { parseBalance } = require(BACKEND + "/margin");

// Shape per the XTS Interactive API docs (values arrive as strings).
const SAMPLE = {
  BalanceList: [{
    limitHeader: "ALL|ALL|ALL",
    limitObject: {
      RMSSubLimits: {
        cashAvailable: "500000.00", collateral: "100000", marginUtilized: "215000.50",
        netMarginAvailable: "384999.50", MTM: "-1520.25", UnrealizedMTM: "-1520.25", RealizedMTM: "0",
      },
      marginAvailable: { CashMarginAvailable: "500000" },
      marginUtilized: { SpanMarginPresent: "180000", ExposureMarginPresent: "35000.5" },
      AccountID: "ABC123",
    },
  }],
};

test("utilized and available margin are read from RMSSubLimits", () => {
  const m = parseBalance(SAMPLE);
  assert.strictEqual(m.available, 384999.5);
  assert.strictEqual(m.utilized, 215000.5);
  assert.strictEqual(m.total, 600000);
  assert.strictEqual(m.usedPct, 35.83);
  assert.strictEqual(m.cash, 500000);
  assert.strictEqual(m.collateral, 100000);
  assert.strictEqual(m.mtm, -1520.25);
  assert.strictEqual(m.accountId, "ABC123");
});

test("the ALL|ALL|ALL entry is preferred when several segments are listed", () => {
  const multi = { BalanceList: [
    { limitHeader: "NSE|CM|ALL", limitObject: { RMSSubLimits: { netMarginAvailable: "1", marginUtilized: "1" } } },
    SAMPLE.BalanceList[0],
  ] };
  assert.strictEqual(parseBalance(multi).available, 384999.5);
});

test("an unrecognized response is reported, not guessed", () => {
  assert.throws(() => parseBalance({}), /unrecognized/i);
  assert.throws(() => parseBalance({ BalanceList: [{ limitObject: {} }] }), /unrecognized/i);
  assert.throws(() => parseBalance(null), /unrecognized/i);
});
