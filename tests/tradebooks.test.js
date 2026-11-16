// test-tradebooks.js — daily broker trade book copies per client.
// Pure file storage in a temp folder: no network, no broker.
//
// Run:  node --test tests/tradebooks.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xts-tradebook-test-"));
process.env.XTS_DATA_DIR = dataDir;

const books = require(BACKEND + "/tradebooks");

const t1 = { ExchangeTradeID: "T1", AppOrderID: 11, OrderSide: "SELL", LastTradedQuantity: 75, LastTradedPrice: 40 };
const t2 = { ExchangeTradeID: "T2", AppOrderID: 12, OrderSide: "BUY",  LastTradedQuantity: 75, LastTradedPrice: 80 };
const t3 = { ExchangeTradeID: "T3", AppOrderID: 13, OrderSide: "SELL", LastTradedQuantity: 50, LastTradedPrice: 22 };

test("a snapshot is saved per client per IST day", () => {
  const r = books.saveSnapshot({ id: "C1", name: "Child" }, [t1, t2], "2026-11-13");
  assert.strictEqual(r.count, 2);
  const b = books.read("2026-11-13", "C1");
  assert.strictEqual(b.clientName, "Child");
  assert.deepStrictEqual(b.trades.map(t => t.ExchangeTradeID), ["T1", "T2"]);
  assert.ok(b.updatedAt);
});

test("later snapshots merge in new trades without duplicates, and never drop earlier ones", () => {
  books.saveSnapshot({ id: "C1", name: "Child" }, [t2, t3], "2026-11-13");   // broker list may be partial
  books.saveSnapshot({ id: "C1", name: "Child" }, [], "2026-11-13");          // or empty after a re-login
  assert.deepStrictEqual(books.read("2026-11-13", "C1").trades.map(t => t.ExchangeTradeID), ["T1", "T2", "T3"]);
});

test("trades without a trade ID are de-duplicated by their full content", () => {
  const noId = { AppOrderID: 99, OrderSide: "BUY", OrderQuantity: 10, TradedPrice: 5 };
  books.saveSnapshot({ id: "P1", name: "Parent" }, [noId, { ...noId }], "2026-11-13");
  books.saveSnapshot({ id: "P1", name: "Parent" }, [{ ...noId }], "2026-11-13");
  assert.strictEqual(books.read("2026-11-13", "P1").trades.length, 1);
});

test("days and clients are listed; a missing book reads as empty", () => {
  books.saveSnapshot({ id: "C1", name: "Child" }, [t1], "2026-11-14");
  assert.deepStrictEqual(books.listDates(), ["2026-11-14", "2026-11-13"]);
  assert.deepStrictEqual(books.listClients("2026-11-13").map(c => c.clientId).sort(), ["C1", "P1"]);
  assert.deepStrictEqual(books.read("2026-11-15", "C9").trades, []);
});

test("client IDs cannot escape the storage folder", () => {
  assert.throws(() => books.saveSnapshot({ id: "../evil", name: "x" }, [t1], "2026-11-13"), /client id/i);
  assert.throws(() => books.read("2026-11-13", "../../etc"), /client id/i);
  assert.throws(() => books.read("../x", "C1"), /date/i);
});
