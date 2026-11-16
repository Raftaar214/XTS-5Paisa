// test-server.js — REST + WebSocket integration test with a FAKE broker.
//
// Safety: xtsApi.js and Marketsocket.js are swapped for fakes before
// server.js loads, the client roster lives in a temp folder, and the fake
// placeOrder() throws and is counted — the final test asserts it was never
// called. Nothing here can reach 5paisa or place a live order.
//
// Run:  node --test tests/server.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const WebSocket = require(require.resolve("ws", { paths: [BACKEND] }));

// ── isolated environment (set before anything loads dotenv) ──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xts-server-test-"));
fs.writeFileSync(path.join(dataDir, "clients.json"), JSON.stringify([
  { id: "P1", name: "Parent", role: "PARENT", multiplier: 1, rootUrl: "https://example.invalid", source: "WEBAPI",
    assignedTo: "", interactiveKey: "parent-int-key-123", interactiveSecret: "parent-int-secret-456",
    marketKey: "parent-md-key-789", marketSecret: "parent-md-secret-000", enabled: true },
  { id: "C1", name: "Alice child", role: "CHILD", multiplier: 2, rootUrl: "https://example.invalid", source: "WEBAPI",
    assignedTo: "alice", interactiveKey: "alice-key-111", interactiveSecret: "alice-secret-222",
    marketKey: "", marketSecret: "", enabled: true },
  { id: "C2", name: "Bob child", role: "CHILD", multiplier: 1, rootUrl: "https://example.invalid", source: "WEBAPI",
    assignedTo: "bob", interactiveKey: "bob-key-333", interactiveSecret: "bob-secret-444",
    marketKey: "", marketSecret: "", enabled: true },
]));
Object.assign(process.env, {
  XTS_DATA_DIR: dataDir,
  AUTH_SECRET: "test-secret-not-real",
  APP_USERNAME: "", APP_PASSWORD: "",
  APP_USER1_NAME: "alice", APP_USER1_PASSWORD: "alice-pw",
  APP_USER2_NAME: "bob",   APP_USER2_PASSWORD: "bob-pw",
  ADMIN_USERNAME: "root",  ADMIN_PASSWORD: "root-pw",
  CORS_ORIGINS: "",
  FRONTEND_DIST: (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "xts-dist-test-"));
    fs.writeFileSync(path.join(d, "index.html"), "<!doctype html><title>XTS dashboard</title>");
    fs.mkdirSync(path.join(d, "assets"));
    fs.writeFileSync(path.join(d, "assets", "app.js"), "console.log('app')");
    return d;
  })(),
});

function mockModule(relPath, exports) {
  const file = require.resolve(path.join(BACKEND, relPath));
  const m = new Module(file);
  m.filename = file; m.loaded = true; m.exports = exports;
  require.cache[file] = m;
}

let placeOrderCalls = 0;
let balanceCalls = 0;
// What the fake broker's balance endpoint returns (read-only).
const BALANCE = {
  C1: { BalanceList: [{ limitHeader: "ALL|ALL|ALL", limitObject: {
    RMSSubLimits: { cashAvailable: "300000", collateral: "0", marginUtilized: "120000", netMarginAvailable: "180000", MTM: "0" } } }] },
};
// What the fake broker's trade book returns for C1 (read-only).
const BROKER_TRADES = [
  { ExchangeTradeID: "X1", AppOrderID: 501, TradingSymbol: "NIFTY 24200 CE", OrderSide: "SELL", LastTradedQuantity: 150, LastTradedPrice: 40.5 },
  { ExchangeTradeID: "X2", AppOrderID: 502, TradingSymbol: "NIFTY 23800 PE", OrderSide: "SELL", LastTradedQuantity: 150, LastTradedPrice: 38.1 },
];
mockModule("./xtsApi.js", {
  loginClient:  async c => ({ token: `fake-${c.id}`, userID: c.id }),
  logoutClient: async () => {},
  placeOrder:   async () => { placeOrderCalls++; throw new Error("TEST: live order blocked"); },
  cancelOrder:  async () => { throw new Error("TEST: no cancel"); },
  getOrderHistory: async () => [],
  getOrders:    async () => [],
  getTrades:    async c => (c.id === "C1" ? BROKER_TRADES : []),
  getBalance:   async c => { balanceCalls++; return BALANCE[c.id] || { BalanceList: [] }; },
  getPositions: async () => [],
});
let priceCb = null;
const owned = new Map(); // owner → Set(token), like the real Marketsocket
mockModule("./Marketsocket.js", {
  loginMarketData: async () => null,
  connectMarketSocket: () => {},
  subscribeTokens: async (tokens, _segs, owner) => { if (!owned.has(owner)) owned.set(owner, new Set()); tokens.forEach(t => owned.get(owner).add(String(t))); },
  unsubscribeTokens: async (tokens, owner) => { tokens.forEach(t => owned.get(owner)?.delete(String(t))); },
  tokensOwnedBy: owner => [...(owned.get(owner) || [])],
  onPriceUpdate: cb => { priceCb = cb; },
  getLivePrices: () => ({ "123": { bid: 100, ask: 101, ltp: 100.5, hasData: true } }),
  getMarketStatus: () => ({ loggedIn: false, socketConnected: false, subscribedTokens: 0 }),
  parseQuote: () => null,
});

const { app, startWS } = require(BACKEND + "/server");

let server, base, wss, wsPort;
before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  wss = startWS(0);
  await new Promise(r => wss.once("listening", r));
  wsPort = wss.address().port;
});
after(() => { server?.close(); wss?.close(); });

async function call(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}
// One active login per user: tests log each user in once and reuse the token
// (re-logging in when a test has ended that session).
const userTokens = {};
async function userToken(name, pw) {
  const cached = userTokens[name];
  if (cached && (await call("GET", "/api/auth/verify", { token: cached })).status === 200) return cached;
  let r = await call("POST", "/api/auth/login", { body: { username: name, password: pw } });
  if (r.status === 409) {
    await call("POST", "/api/auth/login", { body: { username: name, password: pw, force: true } });
    r = await call("POST", "/api/auth/login", { body: { username: name, password: pw } });
  }
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  userTokens[name] = r.data.token;
  return r.data.token;
}
async function adminToken() {
  const r = await call("POST", "/api/admin/login", { body: { username: "root", password: "root-pw" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
}

const LEG = { segment: "NSE_FO", symbol: "NIFTY", type: "CE", strike: "25000", exchange_token: "123", lots: "1", lot_size: 10, side: "Buy" };

test("dashboard users only see their own and unassigned clients", async () => {
  const t = await userToken("alice", "alice-pw");
  const r = await call("GET", "/api/clients", { token: t });
  assert.deepStrictEqual(r.data.map(c => c.id).sort(), ["C1", "P1"]);
});

test("dashboard users can no longer read, add, edit or delete clients", async () => {
  const t = await userToken("alice", "alice-pw");
  assert.notStrictEqual((await call("GET", "/api/clients/full", { token: t })).status, 200);
  assert.notStrictEqual((await call("POST", "/api/clients", { token: t, body: { id: "X", name: "X", role: "CHILD", interactiveKey: "a", interactiveSecret: "b" } })).status, 200);
  assert.notStrictEqual((await call("DELETE", "/api/clients/C2", { token: t })).status, 200);
  assert.strictEqual((await call("GET", "/api/admin/clients", { token: t })).status, 401);
});

test("admin login rejects a wrong password", async () => {
  const r = await call("POST", "/api/admin/login", { body: { username: "root", password: "nope" } });
  assert.strictEqual(r.status, 401);
});

test("admin sees every client with secrets masked", async () => {
  const t = await adminToken();
  const r = await call("GET", "/api/admin/clients", { token: t });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.map(c => c.id).sort(), ["C1", "C2", "P1"]);
  const raw = JSON.stringify(r.data);
  for (const secret of ["parent-int-secret-456", "parent-md-secret-000", "bob-secret-444", "alice-key-111"]) {
    assert.ok(!raw.includes(secret), `leaked ${secret}`);
  }
});

test("an admin token does not open dashboard routes", async () => {
  const t = await adminToken();
  assert.strictEqual((await call("GET", "/api/clients", { token: t })).status, 401);
});

test("admin can add, edit and delete a client", async () => {
  const t = await adminToken();
  let r = await call("POST", "/api/admin/clients", { token: t, body: { id: "C3", name: "New child", role: "CHILD", multiplier: 3, interactiveKey: "k3-abcdef", interactiveSecret: "s3-abcdef", assignedTo: "bob" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  r = await call("PUT", "/api/admin/clients/C3", { token: t, body: { multiplier: 4 } });
  assert.strictEqual(r.data.client.multiplier, 4);
  r = await call("DELETE", "/api/admin/clients/C3", { token: t });
  assert.strictEqual(r.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "clients.json"), "utf8"));
  assert.ok(!saved.some(c => c.id === "C3"));
});

test("a fresh install starts with trading halted, and execution is refused", async () => {
  const t = await userToken("alice", "alice-pw");
  await call("POST", "/api/clients/C1/login",   { token: t });
  await call("POST", "/api/clients/C1/connect", { token: t });
  const cfg = await call("GET", "/api/execution/config", { token: t });
  assert.strictEqual(cfg.data.tradingHalted, true);
  const r = await call("POST", "/api/order", { token: t, body: { legs: [LEG] } });
  assert.strictEqual(r.status, 423);
});

test("admin settings are validated", async () => {
  const t = await adminToken();
  const r = await call("PUT", "/api/admin/settings", { token: t, body: { engine: { bufferPct: 50 } } });
  assert.strictEqual(r.status, 400);
});

test("risk limits reject executions before any order is placed", async () => {
  const admin = await adminToken();
  let r = await call("PUT", "/api/admin/settings", { token: admin, body: {
    tradingHalted: false, limits: { maxLegs: 1, maxLotsPerLeg: 2, maxQtyPerOrder: 5 },
  } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));

  const t = await userToken("alice", "alice-pw");
  r = await call("POST", "/api/order", { token: t, body: { legs: [LEG, LEG] } });
  assert.strictEqual(r.status, 400, "too many legs");
  r = await call("POST", "/api/order", { token: t, body: { legs: [{ ...LEG, lots: "5" }] } });
  assert.strictEqual(r.status, 400, "too many lots");

  // 1 lot × 10 × 2x multiplier = 20 > maxQtyPerOrder 5 → engine refuses per client
  r = await call("POST", "/api/order", { token: t, body: { legs: [LEG] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.every(x => x.status === "FAILED" && /Risk limit/.test(x.error)), JSON.stringify(r.data));

  // re-halt so nothing later in this file can trade
  await call("PUT", "/api/admin/settings", { token: admin, body: { tradingHalted: true } });
});

test("in PAPER mode (the default) a manual Execute fills through the paper broker — no broker order", async () => {
  const admin = await adminToken();
  let r = await call("GET", "/api/admin/settings", { token: admin });
  assert.strictEqual(r.data.tradingMode, "PAPER", "PAPER is the default");
  await call("PUT", "/api/admin/settings", { token: admin, body: { tradingHalted: false, limits: { maxQtyPerOrder: 0, maxLegs: 8, maxLotsPerLeg: 0 } } });
  const t = await userToken("alice", "alice-pw");
  const cfg = await call("GET", "/api/execution/config", { token: t });
  assert.strictEqual(cfg.data.tradingMode, "PAPER");
  r = await call("POST", "/api/order", { token: t, body: { legs: [LEG] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.length >= 1);
  assert.ok(r.data.every(x => x.status === "FILLED" && /^PAPER-/.test(x.orderId)), JSON.stringify(r.data));
  assert.strictEqual(placeOrderCalls, 0);
  const trades = (await call("GET", "/api/journal/trades", { token: t })).data.rows.filter(x => x.source === "MANUAL");
  assert.ok(trades.length >= 1 && trades.every(x => x.mode === "PAPER"));
  await call("PUT", "/api/admin/settings", { token: admin, body: { tradingHalted: true } });
});

test("the trading mode only accepts PAPER or LIVE", async () => {
  const admin = await adminToken();
  const r = await call("PUT", "/api/admin/settings", { token: admin, body: { tradingMode: "SIM" } });
  assert.strictEqual(r.status, 400);
});

test("admin monitor reports executions, audit trail and market status", async () => {
  const t = await adminToken();
  const r = await call("GET", "/api/admin/monitor", { token: t });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.executions.length >= 1);
  assert.ok(r.data.audit.some(a => /settings/i.test(a.action)));
  assert.ok("market" in r.data && "uptimeMs" in r.data);
});

test("CORS: unknown origins are refused, local origins allowed", async () => {
  const evil = await call("GET", "/api/auth/verify", { headers: { Origin: "http://evil.example" } });
  assert.strictEqual(evil.status, 403);
  const ok = await call("GET", "/api/auth/verify", { headers: { Origin: "http://localhost:5173" } });
  assert.strictEqual(ok.headers.get("access-control-allow-origin"), "http://localhost:5173");
});

test("quote WebSocket refuses connections without a dashboard token", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const outcome = await new Promise(resolve => {
    ws.on("open", () => resolve("open"));
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("error", () => resolve("error"));
  });
  ws.terminate();
  assert.strictEqual(outcome, 401);
});

test("quote WebSocket accepts a dashboard token and streams quotes", async () => {
  const t = await userToken("alice", "alice-pw");
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/?token=${encodeURIComponent(t)}`);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  const got = new Promise(resolve => ws.on("message", m => {
    const msg = JSON.parse(m.toString());
    if (msg.type === "quote") resolve(msg);
  }));
  priceCb({ "123": { bid: 1, ask: 2, ltp: 1.5, hasData: true } });
  const msg = await got;
  assert.strictEqual(msg.data["123"].ask, 2);
  ws.close();
});

// ── automated strategies ──
const v38 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "0dte-v2_v38.strategy.json"), "utf8"));
let strategyId, assignmentId;

test("admin uploads a strategy file; an invalid one is refused with reasons", async () => {
  const t = await adminToken();
  let r = await call("POST", "/api/admin/strategies", { token: t, body: { fileName: "0dte-v2_v38.strategy.json", content: v38 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  strategyId = r.data.id;
  assert.deepStrictEqual(r.data.summary.symbols, ["NIFTY", "SENSEX"]);

  const bad = JSON.parse(JSON.stringify(v38));
  bad.strategy.target = { k: 1, mode: "pct" };
  r = await call("POST", "/api/admin/strategies", { token: t, body: { fileName: "bad.json", content: bad } });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /target/);
  r = await call("POST", "/api/admin/strategies", { token: t, body: { fileName: "x.json", content: "{not json" } });
  assert.strictEqual(r.status, 400);
});

test("assignments are validated: real user, their clients, capital for the loss limit", async () => {
  const t = await adminToken();
  let r = await call("POST", "/api/admin/assignments", { token: t, body: { strategyId, username: "nobody", capital: 100000 } });
  assert.strictEqual(r.status, 400);
  r = await call("POST", "/api/admin/assignments", { token: t, body: { strategyId, username: "alice", capital: 100000, clientIds: ["C2"] } });
  assert.strictEqual(r.status, 400, "C2 belongs to bob");
  r = await call("POST", "/api/admin/assignments", { token: t, body: { strategyId, username: "alice" } });
  assert.strictEqual(r.status, 400, "v38 has a 2% daily loss limit, so capital is required");
  r = await call("POST", "/api/admin/assignments", { token: t, body: { strategyId, username: "alice", capital: 100000 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.mode, "PAPER", "new assignments default to PAPER");
  assignmentId = r.data.assignmentId;
});

test("a user sees and controls only their own strategies", async () => {
  const alice = await userToken("alice", "alice-pw");
  const bob = await userToken("bob", "bob-pw");
  let r = await call("GET", "/api/strategies", { token: alice });
  assert.deepStrictEqual(r.data.map(x => x.assignmentId), [assignmentId]);
  assert.strictEqual((await call("GET", "/api/strategies", { token: bob })).data.length, 0);
  assert.strictEqual((await call("POST", `/api/strategies/${assignmentId}/start`, { token: bob })).status, 404);

  r = await call("POST", `/api/strategies/${assignmentId}/start`, { token: alice });
  assert.strictEqual(r.data.status, "RUNNING");
  r = await call("PUT", `/api/admin/assignments/${assignmentId}`, { token: await adminToken(), body: { mode: "LIVE" } });
  assert.strictEqual(r.status, 409, "mode cannot change while running");
  r = await call("POST", `/api/strategies/${assignmentId}/stop`, { token: alice });
  assert.ok(["STOPPING", "STOPPED"].includes(r.data.status));
});

test("a strategy in use cannot be deleted", async () => {
  const r = await call("DELETE", `/api/admin/strategies/${strategyId}`, { token: await adminToken() });
  assert.strictEqual(r.status, 409);
});

test("the activity log is per user, with a CSV download; admin sees everyone", async () => {
  const alice = await userToken("alice", "alice-pw");
  const bob = await userToken("bob", "bob-pw");
  let r = await call("GET", "/api/journal/events", { token: alice });
  assert.ok(r.data.rows.some(e => /Strategy started/.test(e.message)));
  assert.strictEqual((await call("GET", "/api/journal/events", { token: bob })).data.rows.filter(e => e.user === "alice").length, 0);

  const csv = await fetch(`${base}/api/journal/events?format=csv`, { headers: { Authorization: `Bearer ${alice}` } });
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.headers.get("content-disposition"), /alice-events-/);
  assert.match((await csv.text()).split("\n")[0], /"date","time","source","level"/);

  r = await call("GET", "/api/admin/journal/events", { token: await adminToken() });
  assert.ok(r.data.rows.some(e => e.user === "alice"));
});

test("a client card can list that client's strategy positions (own strategies only)", async () => {
  // Seed a run with positions as the runner would after an entry.
  const strategyStore = require(BACKEND + "/strategy/store");
  const run = strategyStore.loadRun(assignmentId);
  const today = require(BACKEND + "/strategy/ist").parts(Date.now()).date;
  run.positions.push(
    { id: "pos_t1", client: "C1", clientName: "Alice child", symbol: "NIFTY", segment: "NSE_FO", expiry: today, token: "123",
      tradingSymbol: "NIFTY 24200 CE", type: "CE", strike: 24200, side: "SELL", qty: 150, entryPrice: 40, stopPrice: 80,
      entryDate: today, entryTime: new Date().toISOString(), slot: "09:20", group: "main", mode: "PAPER", status: "OPEN", multiplier: 2 },
    { id: "pos_t2", client: "P1", clientName: "Parent", symbol: "NIFTY", segment: "NSE_FO", expiry: today, token: "123",
      tradingSymbol: "NIFTY 24200 CE", type: "CE", strike: 24200, side: "SELL", qty: 75, entryPrice: 40, stopPrice: 80,
      entryDate: today, entryTime: new Date().toISOString(), slot: "09:20", group: "main", mode: "PAPER", status: "OPEN", multiplier: 1 },
  );
  strategyStore.saveRun(run);

  const alice = await userToken("alice", "alice-pw");
  let r = await call("GET", "/api/clients/C1/strategy-positions", { token: alice });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.map(p => p.id), ["pos_t1"]);
  assert.strictEqual(r.data[0].strategyName, "0dte v2");
  assert.strictEqual(r.data[0].ltp, 100.5);              // live quote from the feed
  assert.strictEqual(r.data[0].unrealized, -9075);       // (40 − 100.5) × 150

  const bob = await userToken("bob", "bob-pw");
  r = await call("GET", "/api/clients/C1/strategy-positions", { token: bob });
  assert.deepStrictEqual(r.data, [], "bob cannot see alice's client");
  r = await call("GET", "/api/clients/P1/strategy-positions", { token: bob });
  assert.deepStrictEqual(r.data, [], "a shared client shows only bob's own strategies");

  run.positions = run.positions.filter(p => !p.id.startsWith("pos_t"));
  strategyStore.saveRun(run);
});

test("a client card can list that client's strategy orders by order ID (own strategies only)", async () => {
  const journal = require(BACKEND + "/journal");
  const base = { source: "STRATEGY", mode: "PAPER", strategy: "0dte v2", assignmentId, symbol: "NIFTY",
    tradingSymbol: "NIFTY 24200 CE", token: "123", side: "SELL", qty: 150, price: 40, reason: "ENTRY main 09:20", status: "FILLED" };
  journal.appendTrade({ ...base, user: "alice", client: "C1", orderId: "PAPER-20261113-AAAAAA" });
  journal.appendTrade({ ...base, user: "alice", client: "P1", orderId: "PAPER-20261113-BBBBBB" });
  journal.appendTrade({ ...base, user: "bob",   client: "P1", orderId: "PAPER-20261113-CCCCCC" });
  journal.appendTrade({ ...base, user: "alice", client: "C1", source: "MANUAL", orderId: "123456" });

  const alice = await userToken("alice", "alice-pw");
  let r = await call("GET", "/api/clients/C1/strategy-orders", { token: alice });
  assert.deepStrictEqual(r.data.map(t => t.orderId), ["PAPER-20261113-AAAAAA"]);
  r = await call("GET", "/api/clients/P1/strategy-orders", { token: alice });
  assert.deepStrictEqual(r.data.map(t => t.orderId), ["PAPER-20261113-BBBBBB"]);

  const bob = await userToken("bob", "bob-pw");
  assert.deepStrictEqual((await call("GET", "/api/clients/C1/strategy-orders", { token: bob })).data, []);
});

test("LIVE strategy trades are left out of the Algo views (they belong to the broker views)", async () => {
  const strategyStore = require(BACKEND + "/strategy/store");
  const journal = require(BACKEND + "/journal");
  const today = require(BACKEND + "/strategy/ist").parts(Date.now()).date;
  const run = strategyStore.loadRun(assignmentId);
  run.positions.push({ id: "pos_live1", client: "C1", clientName: "Alice child", symbol: "NIFTY", segment: "NSE_FO",
    expiry: today, token: "123", tradingSymbol: "NIFTY 24200 CE", type: "CE", strike: 24200, side: "SELL", qty: 150,
    entryPrice: 40, stopPrice: 80, entryDate: today, entryTime: new Date().toISOString(), slot: "09:30", group: "main",
    mode: "LIVE", orderId: "1100223344", status: "OPEN", multiplier: 2 });
  strategyStore.saveRun(run);
  journal.appendTrade({ source: "STRATEGY", mode: "LIVE", user: "alice", strategy: "0dte v2", assignmentId, client: "C1",
    tradingSymbol: "NIFTY 24200 CE", token: "123", side: "SELL", qty: 150, price: 40, reason: "ENTRY main 09:30",
    status: "FILLED", orderId: "1100223344" });

  const alice = await userToken("alice", "alice-pw");
  const pos = (await call("GET", "/api/clients/C1/strategy-positions", { token: alice })).data;
  assert.ok(!pos.some(p => p.mode === "LIVE"), JSON.stringify(pos));
  const orders = (await call("GET", "/api/clients/C1/strategy-orders", { token: alice })).data;
  assert.ok(!orders.some(o => o.mode === "LIVE"), JSON.stringify(orders));
  // the strategy panel still lists the LIVE position
  const panel = (await call("GET", "/api/strategies", { token: alice })).data;
  assert.ok(panel[0].positions.some(p => p.id === "pos_live1"));

  run.positions = run.positions.filter(p => p.id !== "pos_live1");
  strategyStore.saveRun(run);
});

// ── daily trade books (admin) ──
test("opening a client's Trades view saves a copy of the broker trade book for the day", async () => {
  const alice = await userToken("alice", "alice-pw");
  const r = await call("GET", "/api/clients/C1/trades", { token: alice });
  assert.strictEqual(r.data.length, 2);
  const admin = await adminToken();
  const list = (await call("GET", "/api/admin/tradebooks", { token: admin })).data;
  const c1 = list.clients.find(c => c.clientId === "C1");
  assert.strictEqual(c1.brokerTrades, 2);
  assert.ok(list.clients.some(c => c.clientId === "C2"), "every client is listed, even with no trades");
});

test("admin reads one client's broker and app trade books, as JSON or CSV", async () => {
  const admin = await adminToken();
  let r = await call("GET", "/api/admin/tradebooks/C1?source=broker", { token: admin });
  assert.deepStrictEqual(r.data.rows.map(t => t.ExchangeTradeID), ["X1", "X2"]);
  r = await call("GET", "/api/admin/tradebooks/C1?source=app", { token: admin });
  assert.ok(r.data.rows.every(t => t.client === "C1"));
  assert.ok(r.data.rows.length >= 1, "journal trades for C1 from earlier tests");

  const csv = await fetch(`${base}/api/admin/tradebooks/C1?source=broker&format=csv`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const text = await csv.text();
  assert.match(text.split("\n")[0], /"ExchangeTradeID"/);
  assert.strictEqual(text.trim().split("\n").length, 3);
});

test("all clients' trade books download as one CSV with a client column", async () => {
  const admin = await adminToken();
  const res = await fetch(`${base}/api/admin/tradebooks/all?source=broker&format=csv`, { headers: { Authorization: `Bearer ${admin}` } });
  const lines = (await res.text()).trim().split("\n");
  assert.match(lines[0], /^"clientId","clientName"/);
  assert.strictEqual(lines.length, 3);
});

test("admin can take a trade book snapshot of every logged-in client now", async () => {
  const admin = await adminToken();
  const r = await call("POST", "/api/admin/tradebooks/snapshot", { token: admin });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.saved.some(s => s.clientId === "C1" && s.count === 2), JSON.stringify(r.data));
});

// ── client margins (admin) ──
test("admin sees each client's utilized and available margin, cached briefly", async () => {
  const admin = await adminToken();
  const before = balanceCalls;
  let r = await call("GET", "/api/admin/margins", { token: admin });
  assert.strictEqual(r.status, 200);
  const c1 = r.data.find(m => m.clientId === "C1");
  assert.deepStrictEqual([c1.loggedIn, c1.utilized, c1.available, c1.total, c1.usedPct], [true, 120000, 180000, 300000, 40]);
  const c2 = r.data.find(m => m.clientId === "C2");
  assert.strictEqual(c2.loggedIn, false, "not logged in → no broker call, shown as unavailable");
  const afterFirst = balanceCalls;
  assert.ok(afterFirst > before);

  r = await call("GET", "/api/admin/margins", { token: admin });
  assert.strictEqual(balanceCalls, afterFirst, "second read within 30 s is served from cache");
  r = await call("GET", "/api/admin/margins?refresh=1", { token: admin });
  assert.ok(balanceCalls > afterFirst, "refresh=1 asks the broker again");

  const alice = await userToken("alice", "alice-pw");
  assert.strictEqual((await call("GET", "/api/admin/margins", { token: alice })).status, 401);
});

test("trade book routes are admin-only", async () => {
  const alice = await userToken("alice", "alice-pw");
  assert.strictEqual((await call("GET", "/api/admin/tradebooks", { token: alice })).status, 401);
});

// ── one port: dashboard + API + quote WebSocket ──
const http = require("http");
function rawGet(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: pathname, headers }, res => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the backend serves the built dashboard, including deep links", async () => {
  let r = await rawGet("/");
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /XTS dashboard/);
  r = await rawGet("/assets/app.js");
  assert.match(r.body, /console\.log/);
  r = await rawGet("/some/page");
  assert.match(r.body, /XTS dashboard/, "unknown non-API paths fall back to the app");
  r = await rawGet("/api/nope");
  assert.strictEqual(r.status, 401, "API paths are never swallowed by the app fallback");
  r = await rawGet("/");
  assert.match(String(r.headers["cache-control"]), /no-cache/, "index.html is never cached, so updates show on reload");
  r = await rawGet("/assets/app.js");
  assert.match(String(r.headers["cache-control"]), /immutable/, "hashed assets are cached");
});

test("a page opened via the server's own IP may call the API; other sites may not", async () => {
  let r = await rawGet("/api/auth/verify", { Host: "19.167.80.19:5000", Origin: "http://19.167.80.19:5000" });
  assert.notStrictEqual(r.status, 403);
  r = await rawGet("/api/auth/verify", { Host: "19.167.80.19:5000", Origin: "http://evil.example" });
  assert.strictEqual(r.status, 403);
});

test("the quote WebSocket also runs on the API port at /ws", async () => {
  const sameServer = startWS(server);
  const t = await userToken("alice", "alice-pw");
  const port = server.address().port;
  const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const badOutcome = await new Promise(resolve => {
    bad.on("open", () => resolve("open"));
    bad.on("unexpected-response", (_q, res) => resolve(res.statusCode));
    bad.on("error", () => resolve("error"));
  });
  bad.terminate();
  assert.strictEqual(badOutcome, 401);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(t)}`);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  const got = new Promise(resolve => ws.on("message", m => {
    const msg = JSON.parse(m.toString());
    if (msg.type === "quote") resolve(msg);
  }));
  priceCb({ "123": { bid: 3, ask: 4, ltp: 3.5, hasData: true } });
  assert.strictEqual((await got).data["123"].ask, 4);
  ws.close();
  sameServer.close();
});

// ── one active login per user ──
test("a second login for a user who is already logged in is warned, not let in", async () => {
  await userToken("bob", "bob-pw");
  const r = await call("POST", "/api/auth/login", { body: { username: "bob", password: "bob-pw" } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, "ALREADY_LOGGED_IN");
  assert.ok(r.data.activeSession.since);
  assert.ok(!r.data.token, "no token until the other session is ended");
});

test("confirming ends the other session, then a fresh login is required", async () => {
  const old = await userToken("bob", "bob-pw");
  let r = await call("POST", "/api/auth/login", { body: { username: "bob", password: "bob-pw", force: true } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.loggedOutOther, true);
  assert.ok(!r.data.token, "the confirmation itself does not log in");

  r = await call("GET", "/api/clients", { token: old });
  assert.strictEqual(r.status, 401, "the other session is logged out");
  assert.strictEqual(r.data.code, "SESSION_REPLACED");

  r = await call("POST", "/api/auth/login", { body: { username: "bob", password: "bob-pw" } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.token);
  userTokens.bob = r.data.token;
});

test("a wrong password never ends anyone's session", async () => {
  const r = await call("POST", "/api/auth/login", { body: { username: "bob", password: "nope", force: true } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await call("GET", "/api/clients", { token: userTokens.bob })).status, 200);
});

test("logging out frees the user to log in again without a warning", async () => {
  const t = await userToken("bob", "bob-pw");
  assert.strictEqual((await call("POST", "/api/auth/logout", { token: t })).status, 200);
  assert.strictEqual((await call("GET", "/api/clients", { token: t })).status, 401);
  const r = await call("POST", "/api/auth/login", { body: { username: "bob", password: "bob-pw" } });
  assert.strictEqual(r.status, 200);
  userTokens.bob = r.data.token;
});

test("admin sees active sessions and can end one", async () => {
  const admin = await adminToken();
  let r = await call("GET", "/api/admin/sessions", { token: admin });
  assert.ok(r.data.some(x => x.username === "bob"));
  r = await call("DELETE", "/api/admin/sessions/bob", { token: admin });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call("GET", "/api/clients", { token: userTokens.bob })).status, 401);
});

// ── segments the admin allows ──
test("only admin-allowed segments are listed and tradable", async () => {
  const admin = await adminToken();
  const loader = require(BACKEND + "/instrumentloader");
  loader.setInstruments([
    { segment: "NSE_FO", exchange_token: "123", asset_symbol: "NIFTY", instrument_type: "CE", strike_price: 25000, lot_size: 10, expiry: Date.now() + 864e5, tick_size: 5 },
    { segment: "NSE_EQ", exchange_token: "2885", trading_symbol: "RELIANCE", instrument_type: "EQ", lot_size: 1, tick_size: 10 },
  ], "upload");
  let r = await call("PUT", "/api/admin/settings", { token: admin, body: { allowedSegments: ["NSE_FO"], tradingHalted: false } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const t = await userToken("alice", "alice-pw");
  r = await call("GET", "/api/instruments", { token: t });
  assert.deepStrictEqual(r.data.map(i => i.segment), ["NSE_FO"]);
  r = await call("POST", "/api/order", { token: t, body: { legs: [{ ...LEG, segment: "NSE_EQ", exchange_token: "2885" }] } });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /NSE_EQ/);

  r = await call("PUT", "/api/admin/settings", { token: admin, body: { allowedSegments: ["NSE_FO", "NSE_EQ"] } });
  r = await call("GET", "/api/instruments", { token: t });
  assert.deepStrictEqual(r.data.map(i => i.segment).sort(), ["NSE_EQ", "NSE_FO"]);
  r = await call("PUT", "/api/admin/settings", { token: admin, body: { allowedSegments: ["NSE_COM"] } });
  assert.strictEqual(r.status, 400, "a segment without an XTS mapping is refused");
  await call("PUT", "/api/admin/settings", { token: admin, body: { tradingHalted: true } });
});

// ── sizing by client capital ──
test("with capital sizing, each client trades lots in proportion to its capital", async () => {
  const admin = await adminToken();
  let r = await call("PUT", "/api/admin/clients/C1", { token: admin, body: { capital: 20000000 } });  // ₹2 Cr
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.client.capital, 20000000);
  r = await call("PUT", "/api/admin/settings", { token: admin, body: {
    tradingHalted: false, allowedSegments: ["NSE_FO"], sizing: { mode: "capital", baseCapital: 10000000, rounding: "floor" },
  } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const t = await userToken("alice", "alice-pw");
  r = await call("POST", "/api/order", { token: t, body: { legs: [LEG] } });   // 1 lot of 10, PAPER
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const c1 = r.data.find(x => x.client === "C1");
  assert.strictEqual(c1.requestedQty, 20, "₹2 Cr ÷ ₹1 Cr = 2 lots");
  const p1 = r.data.find(x => x.client === "P1");
  assert.strictEqual(p1.status, "FAILED", "P1 has no capital set → 0 lots, skipped");
  assert.match(p1.error, /0 lots/);
  await call("PUT", "/api/admin/settings", { token: admin, body: { tradingHalted: true, sizing: { mode: "multiplier" } } });
});

test("sizing settings are validated", async () => {
  const admin = await adminToken();
  assert.strictEqual((await call("PUT", "/api/admin/settings", { token: admin, body: { sizing: { mode: "lots" } } })).status, 400);
  assert.strictEqual((await call("PUT", "/api/admin/settings", { token: admin, body: { sizing: { baseCapital: 5 } } })).status, 400);
});

test("a strategy assignment can allocate capital per client", async () => {
  const admin = await adminToken();
  const r = await call("PUT", `/api/admin/assignments/${assignmentId}`, { token: admin, body: { allocations: { C1: 300000, P1: 0 } } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.allocations, { C1: 300000, P1: 0 });
  const bad = await call("PUT", `/api/admin/assignments/${assignmentId}`, { token: admin, body: { allocations: { C2: 100000 } } });
  assert.strictEqual(bad.status, 400, "C2 is not one of alice's clients");
});

// ── dashboard activity log, saved on the server ──
test("dashboard log lines are saved to the user's activity journal and come back in the CSV", async () => {
  const t = await userToken("alice", "alice-pw");
  const ts = Date.now();
  let r = await call("POST", "/api/activity", { token: t, body: { entries: [
    { ts, message: "Legs: 2 → 4" },
    { ts: ts + 1, message: "❌ P1 | NIFTY CE 25000 | FAILED — RMS reject" },
  ] } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.saved, 2);
  const rows = (await call("GET", "/api/journal/events", { token: t })).data.rows.filter(e => e.source === "UI");
  assert.ok(rows.some(e => e.message === "Legs: 2 → 4" && e.user === "alice" && e.level === "info"));
  assert.ok(rows.some(e => /FAILED/.test(e.message) && e.level === "error"));
  const csv = await fetch(`${base}/api/journal/events?format=csv`, { headers: { Authorization: `Bearer ${t}` } });
  assert.match(await csv.text(), /Legs: 2 → 4/);
});

test("activity uploads are bounded", async () => {
  const t = await userToken("alice", "alice-pw");
  const many = Array.from({ length: 501 }, (_, i) => ({ ts: Date.now(), message: `m${i}` }));
  assert.strictEqual((await call("POST", "/api/activity", { token: t, body: { entries: many } })).status, 400);
  const r = await call("POST", "/api/activity", { token: t, body: { entries: [{ ts: Date.now(), message: "x".repeat(5000) }] } });
  assert.strictEqual(r.status, 200);
  const last = (await call("GET", "/api/journal/events", { token: t })).data.rows.filter(e => e.source === "UI").at(-1);
  assert.ok(last.message.length <= 1000);
});

test("a manual execution logs every client's result on the server, filled ones too", async () => {
  const admin = await adminToken();
  await call("PUT", "/api/admin/settings", { token: admin, body: { tradingHalted: false, allowedSegments: ["NSE_FO"] } });
  const t = await userToken("alice", "alice-pw");
  const r = await call("POST", "/api/order", { token: t, body: { legs: [LEG] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const ev = (await call("GET", "/api/journal/events", { token: t })).data.rows.filter(e => e.source === "EXECUTION");
  assert.ok(ev.some(e => /EXECUTE/.test(e.message)), "the request itself is logged");
  assert.ok(ev.some(e => /FILLED/.test(e.message) && /PAPER-/.test(e.message)), "filled results are logged with order IDs");
  await call("PUT", "/api/admin/settings", { token: admin, body: { tradingHalted: true } });
});

// ── leg subscriptions ──
test("'unsubscribe all' releases every token this user's dashboard holds, and no one else's", async () => {
  const t = await userToken("alice", "alice-pw");
  await call("POST", "/api/subscribe", { token: t, body: { tokens: ["111", "222"], segments: ["NSE_FO", "NSE_FO"] } });
  owned.set("strategy:x", new Set(["111"]));
  const r = await call("POST", "/api/unsubscribe", { token: t, body: { all: true } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.count, 2);
  assert.deepStrictEqual([...owned.get("ui:alice")], []);
  assert.deepStrictEqual([...owned.get("strategy:x")], ["111"], "a strategy's token is untouched");
});

test("logging out releases that user's leg tokens", async () => {
  const t = await userToken("alice", "alice-pw");
  await call("POST", "/api/subscribe", { token: t, body: { tokens: ["333"], segments: ["NSE_FO"] } });
  await call("POST", "/api/auth/logout", { token: t });
  assert.deepStrictEqual([...owned.get("ui:alice")], []);
});

// ── Users tab: logins and passwords ──
test("admin lists dashboard users with login state, never passwords", async () => {
  const admin = await adminToken();
  await userToken("alice", "alice-pw");
  const r = await call("GET", "/api/admin/accounts", { token: admin });
  assert.strictEqual(r.status, 200);
  const alice = r.data.users.find(u => u.username === "alice");
  assert.ok(alice.session && alice.session.since, "alice shows as logged in");
  assert.strictEqual(alice.passwordSetBy, ".env");
  assert.ok(!JSON.stringify(r.data).includes("alice-pw"), "no password in the response");
  assert.strictEqual((await call("GET", "/api/admin/accounts", { token: await userToken("alice", "alice-pw") })).status, 401, "admin only");
});

test("admin resets a user's password: the user is logged out, only the new password works", async () => {
  const admin = await adminToken();
  const old = await userToken("alice", "alice-pw");
  let r = await call("PUT", "/api/admin/accounts/alice/password", { token: admin, body: { password: "short" } });
  assert.strictEqual(r.status, 400, "too short");
  r = await call("PUT", "/api/admin/accounts/nobody/password", { token: admin, body: { password: "long-enough-pw" } });
  assert.strictEqual(r.status, 404);

  r = await call("PUT", "/api/admin/accounts/alice/password", { token: admin, body: { password: "alice-new-pw-1" } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.loggedOut, true);
  r = await call("GET", "/api/clients", { token: old });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.code, "PASSWORD_RESET");

  assert.strictEqual((await call("POST", "/api/auth/login", { body: { username: "alice", password: "alice-pw" } })).status, 401, "old password refused");
  r = await call("POST", "/api/auth/login", { body: { username: "alice", password: "alice-new-pw-1" } });
  assert.strictEqual(r.status, 200);
  userTokens.alice = r.data.token;

  const saved = fs.readFileSync(path.join(dataDir, "passwords.json"), "utf8");
  assert.ok(!saved.includes("alice-new-pw-1"), "stored hashed, not in plain text");
  const acc = (await call("GET", "/api/admin/accounts", { token: admin })).data.users.find(u => u.username === "alice");
  assert.strictEqual(acc.passwordSetBy, "admin console");
});

test("admin changes its own password: other admin sessions end, the old password stops working", async () => {
  const other = await adminToken();
  const me = await adminToken();
  let r = await call("POST", "/api/admin/password", { token: me, body: { currentPassword: "wrong", newPassword: "root-new-pw-1" } });
  assert.strictEqual(r.status, 400, "a wrong current password is refused (400, so the console stays signed in)");

  // tokens are time-stamped in ms; make sure the change is strictly later
  await new Promise(res => setTimeout(res, 5));
  r = await call("POST", "/api/admin/password", { token: me, body: { currentPassword: "root-pw", newPassword: "root-new-pw-1" } });
  assert.strictEqual(r.status, 200);
  const fresh = r.data.token;
  assert.ok(fresh);
  assert.strictEqual((await call("GET", "/api/admin/verify", { token: fresh })).status, 200, "the console that changed it stays in");
  assert.strictEqual((await call("GET", "/api/admin/settings", { token: other })).status, 401, "older admin tokens are signed out");
  assert.strictEqual((await call("POST", "/api/admin/login", { body: { username: "root", password: "root-pw" } })).status, 401);
  assert.strictEqual((await call("POST", "/api/admin/login", { body: { username: "root", password: "root-new-pw-1" } })).status, 200);

  // the newly issued token can change it again
  await new Promise(res => setTimeout(res, 5));
  r = await call("POST", "/api/admin/password", { token: fresh, body: { currentPassword: "root-new-pw-1", newPassword: "root-pw-restored" } });
  assert.strictEqual(r.status, 200);
});

test("no order ever reached the (fake) broker", () => {
  assert.strictEqual(placeOrderCalls, 0);
});
