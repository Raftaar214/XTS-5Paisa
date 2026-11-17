// test-market-session.js — market-data session handling with a FAKE socket
// and FAKE HTTP: tick stream, re-login when the broker ends the session,
// re-subscription, unsubscribe. Nothing here touches the network.
//
// Run:  node --test tests/market-session.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");
const EventEmitter = require("events");

// The module logs to the console; silence it here (one of its lines confuses
// the node --test output protocol, and nothing below asserts on logs).

process.env.XTS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "xts-mdsession-"));
process.env.MARKET_TAKEOVER_BACKOFF_MS = "10";
process.env.MARKET_RELOGIN_BASE_MS = "5";
process.env.MARKET_RETRY_MS = "20";
process.env.MARKET_SUB_RETRY_MS = "20";

function mockModule(request, exports, from = BACKEND) {
  const file = require.resolve(request, { paths: [from] });
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports;
  require.cache[file] = m;
}

// fake broker
const broker = { logins: 0, token: null, calls: [], invalid: false, loginFails: 0, subFails: 0 };
const sockets = [];
function fakeIo(url, opts) {
  const s = new EventEmitter();
  s.connected = false;
  s.opts = opts;
  s.close = () => { s.connected = false; };
  sockets.push(s);
  setImmediate(() => { s.connected = true; s.emit("connect"); s.emit("joined", "{}"); });
  return s;
}
const fakeAxios = async cfg => {
  broker.calls.push({ method: cfg.method, tokens: cfg.data.instruments.map(i => String(i.exchangeInstrumentID)), auth: cfg.headers.Authorization });
  if (cfg.method === "post" && broker.subFails > 0) {
    broker.subFails--;
    throw Object.assign(new Error("500"), { response: { status: 500, data: { type: "error", description: "Server busy" } } });
  }
  if (broker.invalid || cfg.headers.Authorization !== broker.token) {
    throw Object.assign(new Error("400"), { response: { status: 400, data: { type: "error", code: "e-session-0007", description: "Invalid Token" } } });
  }
  return { data: { result: { listQuotes: cfg.method === "post" ? cfg.data.instruments.map(i => JSON.stringify({
    ExchangeInstrumentID: i.exchangeInstrumentID, Touchline: { BidInfo: { Price: 10 }, AskInfo: { Price: 11 }, LastTradedPrice: 10.5 } })) : [] } } };
};
fakeAxios.post = async () => {
  if (broker.loginFails > 0) { broker.loginFails--; throw Object.assign(new Error("network down"), { code: "ECONNRESET" }); }
  broker.logins++;
  broker.invalid = false;
  broker.token = `T${broker.logins}`;
  return { data: { type: "success", result: { token: broker.token, userID: "U1" } } };
};
fakeAxios.defaults = {};

mockModule("socket.io-client", fakeIo);
mockModule("axios", fakeAxios);
mockModule("./clients.js", { getParent: () => ({ marketKey: "k", marketSecret: "s", rootUrl: "https://example.invalid" }) });

const md = require(BACKEND + "/Marketsocket");
const wait = ms => new Promise(r => setTimeout(r, ms));
const updates = [];
md.onPriceUpdate(u => updates.push(u));

test("tokens asked for before login are subscribed as soon as the session joins", async () => {
  await md.subscribeTokens(["101"], ["NSE_FO"], "ui:a");
  assert.strictEqual(broker.calls.length, 0, "no session yet — nothing sent");
  await md.loginMarketData();
  md.connectMarketSocket();
  await wait(30);
  assert.deepStrictEqual(broker.calls.at(-1), { method: "post", tokens: ["101"], auth: "T1" });
  assert.strictEqual(md.getLivePrices()["101"].ask, 11, "snapshot from the subscription response");
});

test("prices come from pushed ticks — no polling", async () => {
  const before = broker.calls.length;
  sockets.at(-1).emit("1501-json-full", JSON.stringify({ ExchangeInstrumentID: 101, Touchline: { BidInfo: { Price: 12 }, AskInfo: { Price: 12.5 }, LastTradedPrice: 12.2 } }));
  assert.strictEqual(md.getLivePrices()["101"].bid, 12);
  assert.ok(md.getLivePrices()["101"].ts > 0);
  await wait(2500);
  assert.strictEqual(broker.calls.length, before, "no periodic subscription calls");
});

test("when the broker ends the session, it logs in again and re-subscribes everything", async () => {
  await md.subscribeTokens(["102"], ["NSE_FO"], "ui:a");
  broker.invalid = true;                           // someone else took the session
  sockets.at(-1).connected = false;
  sockets.at(-1).emit("disconnect", "io server disconnect");
  await wait(80);
  assert.strictEqual(broker.logins, 2);
  const last = broker.calls.at(-1);
  assert.strictEqual(last.auth, "T2");
  assert.deepStrictEqual(last.tokens.sort(), ["101", "102"]);
  assert.strictEqual(md.getMarketStatus().joined, true);
});

test("an Invalid Token answer to a subscribe also triggers a re-login", async () => {
  broker.invalid = true;
  await md.subscribeTokens(["103"], ["NSE_FO"], "ui:a");
  await wait(80);
  assert.strictEqual(broker.logins, 3);
  assert.ok(broker.calls.at(-1).tokens.includes("103"));
});

test("repeated take-overs are reported as a second login on the same key", async () => {
  assert.strictEqual(md.getMarketStatus().takeoverSuspected, false, "two re-logins: not yet");
  broker.invalid = true;                           // third take-over within 5 minutes
  sockets.at(-1).emit("disconnect", "io server disconnect");
  await wait(120);
  const st = md.getMarketStatus();
  assert.strictEqual(st.takeoverSuspected, true);
  assert.strictEqual(st.reloginsLast5Min, 3);
  assert.strictEqual(st.joined, true, "still recovers after backing off");
});

test("unsubscribe stops a token at once even if the broker call fails", async () => {
  broker.invalid = true;
  updates.length = 0;
  await md.unsubscribeTokens(["103"], "ui:a");
  assert.strictEqual(md.getLivePrices()["103"], undefined);
  assert.ok(updates.some(u => u["103"]?.removed));
  sockets.at(-1).emit("1501-json-full", JSON.stringify({ ExchangeInstrumentID: 103, Touchline: { BidInfo: { Price: 99 }, AskInfo: { Price: 100 }, LastTradedPrice: 99 } }));
  assert.strictEqual(md.getLivePrices()["103"], undefined, "ticks for removed tokens are ignored");
  broker.invalid = false;
});

test("a token still needed by another owner stays subscribed", async () => {
  await md.subscribeTokens(["101"], ["NSE_FO"], "strategy:x");
  await md.unsubscribeTokens(["101"], "ui:a");
  assert.ok(md.getLivePrices()["101"], "strategy still needs it");
});

test("an unchanged tick still marks the price as fresh, and carries the size at the best price", async () => {
  const tick = () => sockets.at(-1).emit("1501-json-full", JSON.stringify({ ExchangeInstrumentID: 101,
    Touchline: { BidInfo: { Price: 12, Size: 300 }, AskInfo: { Price: 12.5, Size: 150 }, LastTradedPrice: 12.2 } }));
  tick();
  const q = md.getLivePrices()["101"];
  assert.strictEqual(q.bidQty, 300);
  assert.strictEqual(q.askQty, 150);
  q.seen = Date.now() - 120_000;                       // pretend nothing came for 2 minutes
  assert.strictEqual(md.isFresh("101", 60_000), false);
  tick();                                              // same price again
  assert.strictEqual(md.isFresh("101", 60_000), true, "seen again, even though nothing changed");
  assert.strictEqual(md.isFresh("999", 60_000), false, "never seen");
});

test("an unchanged tick keeps the feed counted as live (not only price changes)", async () => {
  const tick = () => sockets.at(-1).emit("1501-json-full", JSON.stringify({ ExchangeInstrumentID: 101,
    Touchline: { BidInfo: { Price: 12, Size: 300 }, AskInfo: { Price: 12.5, Size: 150 }, LastTradedPrice: 12.2 } }));
  tick();
  await wait(120);
  assert.ok(md.getMarketStatus().lastTickAgeMs >= 100);
  tick();                                              // exactly the same price as before
  assert.ok(md.getMarketStatus().lastTickAgeMs < 50, "the repeat tick refreshed the live time");
});

test("a subscribe call that fails for a non-session reason is retried until it works", async () => {
  broker.subFails = 2;
  await md.subscribeTokens(["104"], ["NSE_FO"], "ui:a");
  assert.ok(!md.getLivePrices()["104"], "first call failed");
  assert.ok(md.getMarketStatus().pendingSubscriptions >= 1);
  await wait(120);
  assert.strictEqual(md.getLivePrices()["104"]?.ask, 11, "subscribed by the retry");
  assert.strictEqual(md.getMarketStatus().pendingSubscriptions, 0);
});

test("when every login attempt fails, it keeps retrying until the broker is back", async () => {
  broker.loginFails = 9;                               // more than one full round of 6 attempts
  broker.invalid = true;
  const logins = broker.logins;
  sockets.at(-1).emit("disconnect", "io server disconnect");
  await wait(400);
  assert.ok(broker.loginFails === 0, "all failing attempts were used");
  assert.ok(broker.logins > logins, "a later retry logged in");
  await wait(60);
  assert.strictEqual(md.getMarketStatus().joined, true);
  assert.strictEqual(md.getMarketStatus().retryingLogin, false);
});

test("start-up login failure is retried too (no manual restart needed)", async () => {
  broker.loginFails = 2;                               // both login sources fail once
  const logins = broker.logins;
  const ok = await md.startMarketData();
  assert.strictEqual(ok, false);
  assert.strictEqual(md.getMarketStatus().retryingLogin, true);
  await wait(120);
  assert.ok(broker.logins > logins);
  assert.strictEqual(md.getMarketStatus().joined, true);
});

test("repeated take-overs back off longer each time", async () => {
  const level = md.getMarketStatus().takeoverLevel;
  for (let i = 0; i < 2; i++) {
    broker.invalid = true;
    sockets.at(-1).emit("disconnect", "io server disconnect");
    await wait(250);
  }
  assert.ok(md.getMarketStatus().takeoverLevel >= level + 2, "the back-off step went up");
});
