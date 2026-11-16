// test-order-stream.js — handling of pushed order updates from the XTS
// Interactive socket. Only the message handling is tested: no socket is
// opened and nothing contacts a broker.
//
// Run:  node --test tests/order-stream.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const stream = require(BACKEND + "/orderStream");

test("a pushed order update (JSON string) is delivered to whoever waits for that order", async () => {
  const since = Date.now();
  const waiting = stream.waitForOrderUpdate("A100", 1000, since);
  setTimeout(() => stream.handleOrderMessage(JSON.stringify({ AppOrderID: "A100", OrderStatus: "Filled", CumulativeQuantity: 75 })), 20);
  const t = Date.now();
  const d = await waiting;
  assert.strictEqual(d.OrderStatus, "Filled");
  assert.ok(Date.now() - t < 200);
});

test("an update that arrived before anyone started waiting is not missed", async () => {
  const since = Date.now() - 1;
  stream.handleOrderMessage({ AppOrderID: 200, OrderStatus: "Filled", CumulativeQuantity: 50 });
  const d = await stream.waitForOrderUpdate(200, 1000, since);
  assert.strictEqual(d.CumulativeQuantity, 50);
});

test("an older update is not mistaken for a new one", async () => {
  stream.handleOrderMessage({ AppOrderID: 300, OrderStatus: "New", CumulativeQuantity: 0 });
  const since = Date.now() + 1;
  const t = Date.now();
  const d = await stream.waitForOrderUpdate(300, 60, since);
  assert.strictEqual(d, null);
  assert.ok(Date.now() - t >= 50, "waited for the timeout");
});

test("malformed messages are ignored", () => {
  assert.doesNotThrow(() => stream.handleOrderMessage("{not json"));
  assert.doesNotThrow(() => stream.handleOrderMessage({ no: "id" }));
  assert.doesNotThrow(() => stream.handleOrderMessage(null));
});
