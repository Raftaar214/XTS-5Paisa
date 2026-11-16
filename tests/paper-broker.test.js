// test-paper-broker.js — PAPER orders run through the REAL execution engine
// against a simulated broker that fills only when the live bid/ask crosses
// the limit price. Same buffer, timeout, cancel and retry logic as LIVE.
// No network, no real broker: the engine is given the paper API explicitly.
//
// Run:  node --test tests/paper-broker.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");

const { createPaperBroker } = require(BACKEND + "/paperBroker");
const { executeOrderMulti } = require(BACKEND + "/index");

const CFG = { bufferPct: 0.5, fillTimeout: 0.3, maxRetries: 1, pollInterval: 0.05, cancelTimeout: 0.5, retryDelay: 0.01 };
const CLIENT = { id: "P1", name: "Paper client", multiplier: 1 };
const leg = side => ({ segment: "NSE_FO", symbol: "NIFTY", type: "CE", strike: "24200", exchange_token: "777", lots: 1, lot_size: 75, side });

function setup(quote) {
  const quotes = { "777": quote };
  const paper = createPaperBroker({ getQuotes: () => quotes, now: () => Date.UTC(2026, 10, 13, 4, 0) });
  const run = (side, cfg = {}) =>
    executeOrderMulti([leg(side)], [CLIENT], { ...CFG, ...cfg, getQuotes: () => quotes }, paper.api);
  return { quotes, paper, run };
}

test("a marketable SELL fills at the live bid with a PAPER order ID", async () => {
  const { run } = setup({ bid: 40, ask: 40.2, ltp: 40.1 });
  const [r] = await run("Sell");
  assert.strictEqual(r.status, "FILLED");
  assert.strictEqual(r.filledQty, 75);
  assert.strictEqual(r.avgPrice, 40);
  assert.match(r.orderId, /^PAPER-20261113-[0-9A-F]{6}$/);
  assert.strictEqual(r.attempts.length, 1);
});

test("a marketable BUY fills at the live ask", async () => {
  const { run } = setup({ bid: 40, ask: 40.2, ltp: 40.1 });
  const [r] = await run("Buy");
  assert.strictEqual(r.status, "FILLED");
  assert.strictEqual(r.avgPrice, 40.2);
});

test("when the market runs away, the order times out, is cancelled, and is retried at a fresh price", async () => {
  const { quotes, paper, run } = setup({ bid: 40, ask: 40.2, ltp: 40.1 });
  // the bid collapses right after the first order goes in, then recovers before the retry
  const origPlace = paper.api.placeOrder;
  let n = 0;
  paper.api.placeOrder = async (...a) => {
    n++;
    const res = await origPlace(...a);
    if (n === 1) quotes["777"] = { bid: 30, ask: 30.2, ltp: 30.1 };
    return res;
  };
  const [r] = await run("Sell");
  assert.strictEqual(r.status, "FILLED", JSON.stringify(r));
  assert.strictEqual(r.attempts.length, 2);
  assert.strictEqual(r.attempts[0].status, "UNFILLED");
  assert.ok(r.attempts[0].cancelled, "first order was cancelled");
  assert.ok(r.attempts[1].limitPrice < r.attempts[0].limitPrice, "retry priced off the new bid");
  assert.strictEqual(r.avgPrice, 30);
  const first = paper.orders().find(o => o.AppOrderID === r.attempts[0].orderId);
  assert.strictEqual(first.OrderStatus, "Cancelled");
});

test("an order that never becomes marketable ends FAILED after the retries — never a manual check", async () => {
  const { run } = setup({ bid: 0, ask: 0, ltp: 40 }); // no bid to sell into
  const [r] = await run("Sell");
  assert.strictEqual(r.status, "FAILED");
  assert.strictEqual(r.filledQty, 0);
  assert.strictEqual(r.attempts.length, 2);
  assert.ok(r.attempts.every(a => a.cancelled));
});

test("PAPER orders record latency like LIVE ones", async () => {
  const { run } = setup({ bid: 40, ask: 40.2, ltp: 40.1 });
  const [r] = await run("Sell", { startedAt: Date.now() });
  for (const k of ["queueMs", "ackMs", "fillMs", "totalMs"]) assert.ok(r.latency[k] >= 0, k);
});

test("a marketable paper order is seen as filled at once, not on the next 1 s poll", async () => {
  const { run } = setup({ bid: 40, ask: 40.2, ltp: 40.1 });
  const t = Date.now();
  const [r] = await run("Sell", { pollInterval: 1, fillTimeout: 3, startedAt: t });
  assert.strictEqual(r.status, "FILLED");
  assert.ok(Date.now() - t < 300, `took ${Date.now() - t} ms`);
});

test("PAPER fills only the size shown at the best price; the rest waits like a real book", async () => {
  // 75 to sell, only 25 bid at 40, and no new quote arrives: 25 + 25 (retry) = 50
  const quotes = { "777": { bid: 40, ask: 40.2, ltp: 40.1, bidQty: 25, askQty: 25, seen: Date.now() } };
  const paper = createPaperBroker({ getQuotes: () => quotes });
  const [r] = await executeOrderMulti([leg("Sell")], [CLIENT], { ...CFG, getQuotes: () => quotes }, paper.api);
  assert.strictEqual(r.status, "PARTIAL", JSON.stringify(r.attempts));
  assert.strictEqual(r.filledQty, 50);
  assert.strictEqual(r.avgPrice, 40);
});

test("with fresh quotes arriving, the full size fills across several prints", async () => {
  const quotes = { "777": { bid: 40, ask: 40.2, ltp: 40.1, bidQty: 30, askQty: 30, seen: Date.now() } };
  const ticker = setInterval(() => { quotes["777"] = { ...quotes["777"], seen: Date.now() + Math.random() }; }, 15);
  try {
    const paper = createPaperBroker({ getQuotes: () => quotes });
    const [r] = await executeOrderMulti([leg("Sell")], [CLIENT], { ...CFG, fillTimeout: 1, getQuotes: () => quotes }, paper.api);
    assert.strictEqual(r.status, "FILLED", JSON.stringify(r.attempts));
    assert.strictEqual(r.filledQty, 75);
  } finally { clearInterval(ticker); }
});

test("an old quote (not sent for over 60 s) is never traded on — no order is sent", async () => {
  const quotes = { "777": { bid: 40, ask: 40.2, ltp: 40.1, seen: Date.now() - 120_000 } };
  const paper = createPaperBroker({ getQuotes: () => quotes });
  const [r] = await executeOrderMulti([leg("Sell")], [CLIENT], { ...CFG, getQuotes: () => quotes }, paper.api);
  assert.strictEqual(r.status, "FAILED");
  assert.match(r.error, /s old — no order sent/);
  assert.strictEqual(paper.orders().length, 0);
});

test("the paper broker itself does not fill on an old quote", async () => {
  const quotes = { "777": { bid: 40, ask: 40.2, ltp: 40.1, seen: Date.now() - 120_000 } };
  const paper = createPaperBroker({ getQuotes: () => quotes });
  const { AppOrderID } = await paper.api.placeOrder(CLIENT, { exchangeInstrumentID: 777, orderSide: "SELL", orderQuantity: 75, limitPrice: 39 });
  const [h] = (await paper.api.getOrderHistory(CLIENT, AppOrderID)).slice(-1);
  assert.strictEqual(h.OrderStatus, "New");
});

test("order tags fit the broker's 20-character limit and are unique", () => {
  const { orderTag } = require(BACKEND + "/index");
  const tags = new Set();
  for (let i = 0; i < 500; i++) { const t = orderTag(); assert.ok(t.length <= 20 && /^[A-Z0-9]+$/.test(t), t); tags.add(t); }
  assert.strictEqual(tags.size, 500);
});

test("paper order IDs are unique", async () => {
  const { run } = setup({ bid: 40, ask: 40.2, ltp: 40.1 });
  const ids = new Set();
  for (let i = 0; i < 20; i++) ids.add((await run("Sell"))[0].orderId);
  assert.strictEqual(ids.size, 20);
});
