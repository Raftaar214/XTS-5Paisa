// test-execution-engine.js
//
// Exercises the marketable-limit execution engine (index.js) against a FAKE
// broker. xtsApi.js and Marketsocket.js are replaced in the require cache
// before index.js loads, so nothing in this file can reach 5paisa — no
// login, no market data, and no real order is ever placed.
//
// Run:  node --test tests/execution-engine.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const Module = require("module");

function mockModule(relPath, exports) {
  const file = require.resolve(path.join(BACKEND, relPath));
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}

// ── Fake broker ──────────────────────────────────────────────
// Each "plan" describes one order the engine will place, in order:
//   placeError  : throw this from placeOrder instead of accepting
//   beforeCancel: [[status, cumulativeFilled], ...] returned on successive polls
//   afterCancel : same, once the engine has asked to cancel this order
let broker;

function makeBroker(plans) {
  const b = { placed: [], cancels: [], orderBookCalls: 0, historyCalls: 0 };
  b.placeOrder = async (_client, payload) => {
    const plan = plans[b.placed.length];
    if (!plan) throw new Error(`TEST: unexpected order #${b.placed.length + 1} (qty ${payload.orderQuantity})`);
    b.placed.push({ qty: payload.orderQuantity, limitPrice: payload.limitPrice, productType: payload.productType });
    if (plan.placeError) throw plan.placeError;
    const order = { id: 9000 + b.placed.length, qty: payload.orderQuantity, plan, step: 0, cancelled: false, seen: [] };
    (b.orders = b.orders || []).push(order);
    return { AppOrderID: order.id };
  };
  b.cancelOrder = async (_client, appOrderId) => {
    const o = b.orders.find(x => String(x.id) === String(appOrderId));
    b.cancels.push(appOrderId);
    o.cancelled = true;
    o.step = 0;
    return {};
  };
  b.getOrderHistory = async (_client, appOrderId) => {
    b.historyCalls++;
    const o = (b.orders || []).find(x => String(x.id) === String(appOrderId));
    if (!o) return [];
    const seq = o.cancelled ? o.plan.afterCancel : o.plan.beforeCancel;
    const [status, filled] = seq[Math.min(o.step, seq.length - 1)];
    o.step++;
    o.seen.push({
      AppOrderID: o.id, OrderStatus: status, CumulativeQuantity: filled,
      LeavesQuantity: o.qty - filled, OrderAverageTradedPrice: filled ? 101 : 0,
    });
    return [...o.seen]; // chronological, latest last
  };
  b.getOrders = async () => { b.orderBookCalls++; return []; };
  return b;
}

mockModule("./xtsApi.js", {
  placeOrder:      (...a) => broker.placeOrder(...a),
  cancelOrder:     (...a) => broker.cancelOrder(...a),
  getOrderHistory: (...a) => broker.getOrderHistory(...a),
  getOrders:       (...a) => broker.getOrders(...a),
  loginClient:  async () => { throw new Error("TEST: no broker login allowed"); },
  logoutClient: async () => {},
  getTrades:    async () => [],
  getPositions: async () => [],
});
mockModule("./Marketsocket.js", {
  getLivePrices: () => ({ "123": { bid: 100, ask: 101, ltp: 100.5, hasData: true } }),
});

const { executeOrderMulti } = require(BACKEND + "/index");

const CFG = {
  bufferPct: 0.5, fillTimeout: 0.3, maxRetries: 1, pollInterval: 0.05,
  cancelTimeout: 1, retryDelay: 0.01,
};
const CLIENT = { id: "T1", name: "Test client", multiplier: 1 };
const LEG = { segment: "NSE_FO", symbol: "NIFTY", type: "CE", strike: "25000", exchange_token: "123", lots: 1, lot_size: 10, side: "Buy" };

async function runOne(plans, cfg = CFG, leg = LEG) {
  broker = makeBroker(plans);
  const [r] = await executeOrderMulti([leg], [CLIENT], cfg);
  return r;
}

beforeEach(() => { broker = null; });

test("fills that arrive while a cancel is in flight are not re-ordered", async () => {
  const r = await runOne([
    { beforeCancel: [["PartiallyFilled", 4]], afterCancel: [["Cancelled", 7]] },
    { beforeCancel: [["Filled", 3]],          afterCancel: [["Filled", 3]] },
  ]);
  assert.strictEqual(broker.placed[1]?.qty, 3, "retry must only ask for the 3 lots still unfilled");
  assert.strictEqual(r.filledQty, 10);
  assert.strictEqual(r.status, "FILLED");
});

test("an order that completes during cancel on a retry counts every attempt's fills", async () => {
  const r = await runOne([
    { beforeCancel: [["PartiallyFilled", 4]], afterCancel: [["Cancelled", 4]] },
    { beforeCancel: [["PartiallyFilled", 2]], afterCancel: [["Filled", 6]] },
  ]);
  assert.strictEqual(r.filledQty, 10);
  assert.strictEqual(r.remainingQty, 0);
  assert.strictEqual(r.status, "FILLED");
});

test("a placement error with no broker response is never retried", async () => {
  const timeout = Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" });
  const r = await runOne([
    { placeError: timeout },
    { beforeCancel: [["Filled", 10]], afterCancel: [["Filled", 10]] },
  ]);
  assert.strictEqual(broker.placed.length, 1, "a second order could double the position");
  assert.strictEqual(r.status, "MANUAL_CHECK");
});

test("a broker rejection (HTTP response) may still be retried", async () => {
  const rejected = Object.assign(new Error("RMS reject"), { response: { status: 400, data: { description: "RMS reject" } } });
  const r = await runOne([
    { placeError: rejected },
    { beforeCancel: [["Filled", 10]], afterCancel: [["Filled", 10]] },
  ]);
  assert.strictEqual(broker.placed.length, 2);
  assert.strictEqual(r.status, "FILLED");
});

test("order status is polled through order history, not the full order book", async () => {
  await runOne([{ beforeCancel: [["New", 0], ["Filled", 10]], afterCancel: [["Filled", 10]] }]);
  assert.ok(broker.historyCalls > 0);
  assert.strictEqual(broker.orderBookCalls, 0);
});

test("maxQtyPerOrder blocks the order before it reaches the broker", async () => {
  const r = await runOne([], { ...CFG, limits: { maxQtyPerOrder: 5 } });
  assert.strictEqual(broker.placed.length, 0);
  assert.strictEqual(r.status, "FAILED");
  assert.match(r.error, /limit/i);
});

test("maxOrderValue blocks the order before it reaches the broker", async () => {
  // 10 qty × ~101.55 limit ≈ 1015 > 1000
  const r = await runOne([], { ...CFG, limits: { maxOrderValue: 1000 } });
  assert.strictEqual(broker.placed.length, 0);
  assert.strictEqual(r.status, "FAILED");
  assert.match(r.error, /limit/i);
});

test("latency from execute to fill is measured on every leg and attempt", async () => {
  // broker takes ~30 ms to acknowledge; the order fills on the 3rd status poll
  const slowPlace = broker => {
    const orig = broker.placeOrder;
    broker.placeOrder = async (...a) => { await new Promise(r => setTimeout(r, 30)); return orig(...a); };
  };
  broker = makeBroker([{ beforeCancel: [["New", 0], ["New", 0], ["Filled", 10]], afterCancel: [["Filled", 10]] }]);
  slowPlace(broker);
  const startedAt = Date.now() - 20; // execute request arrived 20 ms before the engine started
  const [r] = await executeOrderMulti([LEG], [CLIENT], { ...CFG, fillTimeout: 1, startedAt });
  assert.strictEqual(r.status, "FILLED");
  const L = r.latency;
  assert.ok(L.queueMs >= 20, `queue ${L.queueMs}`);
  assert.ok(L.ackMs >= 25, `ack ${L.ackMs}`);
  assert.ok(L.fillMs >= 100, `fill ${L.fillMs}`);       // 3 polls × 50 ms
  assert.ok(L.totalMs >= L.queueMs + L.ackMs + L.fillMs - 5, JSON.stringify(L));
  assert.ok(r.attempts[0].ackMs >= 25 && r.attempts[0].fillMs >= 100);
});

test("a pushed order update is used at once — no waiting for the next poll", async () => {
  // Polling is set to a slow 1 s; the broker pushes "Filled" 40 ms after accepting.
  broker = makeBroker([{ beforeCancel: [["New", 0]], afterCancel: [["New", 0]] }]);
  const pushes = new Map(); // appOrderId → { at, data }
  const origPlace = broker.placeOrder;
  broker.placeOrder = async (...a) => {
    const res = await origPlace(...a);
    setTimeout(() => pushes.set(String(res.AppOrderID), { at: Date.now(), data: {
      AppOrderID: res.AppOrderID, OrderStatus: "Filled", CumulativeQuantity: 10, LeavesQuantity: 0, OrderAverageTradedPrice: 101.2,
    } }), 40);
    return res;
  };
  // waitForUpdate(client, id, ms, since): resolves with a pushed update newer than `since`, or null after ms
  broker.waitForUpdate = async (_c, id, ms, since) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const p = pushes.get(String(id));
      if (p && p.at > since) return p.data;
      await new Promise(r => setTimeout(r, 5));
    }
    return null;
  };
  const api = {
    placeOrder: (...a) => broker.placeOrder(...a), cancelOrder: (...a) => broker.cancelOrder(...a),
    getOrders: (...a) => broker.getOrders(...a), getOrderHistory: (...a) => broker.getOrderHistory(...a),
    waitForUpdate: (...a) => broker.waitForUpdate(...a),
  };
  const t = Date.now();
  const [r] = await executeOrderMulti([LEG], [CLIENT], { ...CFG, pollInterval: 1, fillTimeout: 3 }, api);
  assert.strictEqual(r.status, "FILLED");
  assert.strictEqual(r.avgPrice, 101.2);
  assert.ok(Date.now() - t < 400, `took ${Date.now() - t} ms — should not wait for the 1 s poll`);
  assert.ok(r.latency.fillMs < 300, `fill seen after ${r.latency.fillMs} ms`);
});

test("prices use the instrument's own tick size (tick_size is in paise in the master)", async () => {
  // MCX contract with a ₹1 tick: BUY at ask 101 × 1.005 = 101.505 → rounded up to 102
  broker = makeBroker([{ beforeCancel: [["Filled", 10]], afterCancel: [["Filled", 10]] }]);
  await executeOrderMulti([{ ...LEG, segment: "MCX", tick_size: 1 }], [CLIENT], CFG);
  assert.strictEqual(broker.placed[0].limitPrice, 102);
});

test("the product type follows the segment (admin settings)", async () => {
  broker = makeBroker([{ beforeCancel: [["Filled", 10]], afterCancel: [["Filled", 10]] }]);
  await executeOrderMulti([{ ...LEG, segment: "NSE_EQ", lot_size: 1, tick_size: 0.05 }], [CLIENT], { ...CFG, products: { NSE_EQ: "CNC", default: "NRML" } });
  assert.strictEqual(broker.placed[0].productType, "CNC");
  broker = makeBroker([{ beforeCancel: [["Filled", 10]], afterCancel: [["Filled", 10]] }]);
  await executeOrderMulti([LEG], [CLIENT], { ...CFG, products: { NSE_EQ: "CNC", default: "NRML" } });
  assert.strictEqual(broker.placed[0].productType, "NRML");
});

test("a fractional multiplier gives whole lots: rounded down by default, or to nearest", async () => {
  broker = makeBroker([{ beforeCancel: [["Filled", 10]], afterCancel: [["Filled", 10]] }]);
  let [r] = await executeOrderMulti([LEG], [{ ...CLIENT, multiplier: 1.5 }], CFG);
  assert.strictEqual(broker.placed[0].qty, 10, "1 lot × 1.5 → 1 lot (floor)");
  assert.strictEqual(r.effectiveLots, 1);

  broker = makeBroker([{ beforeCancel: [["Filled", 20]], afterCancel: [["Filled", 20]] }]);
  [r] = await executeOrderMulti([LEG], [{ ...CLIENT, multiplier: 1.5 }], { ...CFG, sizingRounding: "round" });
  assert.strictEqual(broker.placed[0].qty, 20, "1 lot × 1.5 → 2 lots (round)");
});

test("a client too small for the order is skipped, never sent a fraction of a lot", async () => {
  broker = makeBroker([]);
  const [r] = await executeOrderMulti([LEG], [{ ...CLIENT, multiplier: 0.4 }], CFG);
  assert.strictEqual(broker.placed.length, 0);
  assert.strictEqual(r.status, "FAILED");
  assert.match(r.error, /0 lots/);
});

test("results carry a human-readable label", async () => {
  const r = await runOne([{ beforeCancel: [["Filled", 10]], afterCancel: [["Filled", 10]] }]);
  assert.strictEqual(r.label, "NIFTY CE 25000");
});
