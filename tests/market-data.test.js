// test-market-data.js — quote parsing. No network: nothing here logs in
// or subscribes; it only feeds sample packets into parseQuote().
//
// Run:  node --test tests/market-data.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Keep clients.js away from the real data/clients.json.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xts-md-test-"));
fs.writeFileSync(path.join(dataDir, "clients.json"), JSON.stringify([
  { id: "TEST-P", name: "Test parent", role: "PARENT", multiplier: 1, rootUrl: "https://example.invalid",
    source: "WEBAPI", assignedTo: "", interactiveKey: "k", interactiveSecret: "s", marketKey: "", marketSecret: "", enabled: false },
]));
process.env.XTS_DATA_DIR = dataDir;

const { parseQuote, getLivePrices } = require(BACKEND + "/Marketsocket");

test("parseQuote reads bid/ask/ltp from an XTS JSON quote", () => {
  const result = parseQuote({
    ExchangeInstrumentID: 12345,
    BidInfo: { Price: 101.25 },
    AskInfo: { Price: 101.5 },
    LastTradedPrice: 101.4,
  });
  assert.deepStrictEqual(result, { token: "12345", bid: 101.25, ask: 101.5, ltp: 101.4 });
});

test("parseQuote reads the Touchline shape", () => {
  const result = parseQuote({
    ExchangeInstrumentID: 222,
    Touchline: { BidInfo: { Price: 10 }, AskInfo: { Price: 10.5 }, LastTradedPrice: 10.2 },
  });
  assert.deepStrictEqual(result, { token: "222", bid: 10, ask: 10.5, ltp: 10.2 });
});

test("quotes for tokens nobody subscribed to are not published", () => {
  parseQuote({ ExchangeInstrumentID: 99999, BidInfo: { Price: 5 }, AskInfo: { Price: 6 }, LastTradedPrice: 5.5 });
  assert.strictEqual(getLivePrices()["99999"], undefined);
});
