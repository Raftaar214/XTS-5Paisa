// test-strategy-runner.js — the automated strategy runner, end to end, with a
// fake clock, synthetic option chain, fake quotes and a FAKE broker. Nothing
// here can reach 5paisa: LIVE-mode tests use an in-memory executeLegs.
//
// Run:  node --test tests/strategy-runner.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xts-runner-test-"));
process.env.XTS_DATA_DIR = dataDir;

const ist = require(BACKEND + "/strategy/ist");
const greeks = require(BACKEND + "/strategy/greeks");
const journal = require(BACKEND + "/journal");

let store = require(BACKEND + "/strategy/store");
let { createRunner } = require(BACKEND + "/strategy/runner");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "0dte-v2_v38.strategy.json"), "utf8"));

// market fixture: NIFTY expires Tue 2026-11-17 and Tue 2026-11-24
const EXPIRY = "2026-11-17";
const F = 24012, SIGMA = 0.35, R = 0.06;
const instruments = [];
let tok = 50000;
for (const exp of [EXPIRY, "2026-11-24"]) {
  for (let k = 23000; k <= 25000; k += 50) {
    for (const type of ["CE", "PE"]) {
      instruments.push({ segment: "NSE_FO", asset_symbol: "NIFTY", instrument_type: type, strike_price: k,
        expiry: ist.timeOn(exp, "23:59"), lot_size: 75, exchange_token: String(tok++), trading_symbol: `NIFTY ${exp} ${k} ${type}` });
    }
  }
}
instruments.push({ segment: "NSE_FO", asset_symbol: "NIFTY", instrument_type: "FUT", expiry: ist.timeOn("2026-11-24", "23:59"), lot_size: 75, exchange_token: "99999" });

let NOW = 0;
const at = (date, hhmm, sec = 0) => { NOW = ist.timeOn(date, hhmm) + sec * 1000; };

let quotes = {};
function priceQuotes(date) {
  quotes = { "99999": { bid: F, ask: F + 1, ltp: F, hasData: true } };
  const T = greeks.yearsToExpiry(ist.timeOn(date, "09:20"), EXPIRY);
  for (const it of instruments) {
    if (it.instrument_type === "FUT") continue;
    const p = Math.max(0.05, greeks.price(F, it.strike_price, T, SIGMA, R, it.instrument_type));
    quotes[it.exchange_token] = { bid: +(p - 0.1).toFixed(2), ask: +(p + 0.1).toFixed(2), ltp: +p.toFixed(2), hasData: true };
  }
}

const clients = {
  P1: { id: "P1", name: "Parent", role: "PARENT", multiplier: 1, enabled: true, isLogged: true, isConnected: true },
  C1: { id: "C1", name: "Child", role: "CHILD", multiplier: 2, enabled: true, isLogged: true, isConnected: true },
  C2: { id: "C2", name: "Rahul child", role: "CHILD", multiplier: 1, enabled: true, isLogged: true, isConnected: true },
};
const userClients = { nikhil: ["P1", "C1"], rahul: ["C2", "P1"] };

// PAPER goes through the real execution engine against the simulated paper
// broker (fills when the live quote crosses the limit), with fast timings.
const { createPaperBroker } = require(BACKEND + "/paperBroker");
const { executeOrderMulti } = require(BACKEND + "/index");
const PAPER_CFG = { bufferPct: 0.5, fillTimeout: 0.3, maxRetries: 1, pollInterval: 0.02, cancelTimeout: 0.3, retryDelay: 0.01 };
const paper = createPaperBroker({ getQuotes: () => quotes, now: () => NOW });

let settings, liveCalls, liveResult, subs;
function deps() {
  return {
    store, journal,
    now: () => NOW,
    getInstruments: () => instruments,
    getQuotes: () => quotes,
    subscribe: async (tokens, segments, owner) => { subs.push({ tokens, owner }); },
    unsubscribe: async () => {},
    clientsFor: a => (a.clientIds.length ? a.clientIds : userClients[a.username]).map(id => clients[id]),
    executeLegs: async (legs, cls) => {
      liveCalls.push({ legs, clients: cls.map(c => ({ id: c.id, multiplier: c.multiplier })) });
      return liveResult(legs, cls);
    },
    executePaperLegs: (legs, cls) => executeOrderMulti(legs, cls, { ...PAPER_CFG, getQuotes: () => quotes }, paper.api),
    getSettings: () => settings,
    marketHealthy: () => true,
  };
}

function strategyRaw(edit) {
  const raw = JSON.parse(JSON.stringify(fixture));
  const s = raw.strategy;
  s.extra_symbols = [];
  s.structures = [];
  s.schedule = [{ start: "09:20", end: "09:40", every_min: 10 }];
  s.legs.list = s.legs.list.map(l => ({ ...l, lots: 1 }));
  if (edit) edit(s);
  return raw;
}

let runner;
function setup({ mode = "PAPER", username = "nikhil", capital = 1_000_000, edit } = {}) {
  const stg = store.addStrategy({ fileName: "t.json", raw: strategyRaw(edit), by: "admin" });
  const a = store.addAssignment({ strategyId: stg.id, username, capital, mode });
  return a;
}

beforeEach(() => {
  // tradingMode LIVE here so each assignment's own mode decides (global PAPER is tested separately)
  settings = { tradingMode: "LIVE", tradingHalted: false, engine: { bufferPct: 0.5, fillTimeout: 4, maxRetries: 1 }, limits: { maxLotsPerLeg: 0 } };
  liveCalls = [];
  subs = [];
  liveResult = (legs, cls) => cls.flatMap(c => legs.map(l => ({
    client: c.id, token: String(l.exchange_token), status: "FILLED",
    filledQty: l.lots * l.lot_size * (c.multiplier || 1), avgPrice: 40, orderId: "A1",
  })));
  runner = createRunner(deps());
  priceQuotes(EXPIRY);
});

const open = run => run.positions.filter(p => p.status === "OPEN");

test("started the day before expiry: armed, no orders, then fires on expiry day", async () => {
  const a = setup();
  at("2026-11-16", "09:00");
  runner.start(a.id, "nikhil");
  at("2026-11-16", "09:20", 1);
  await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 0);
  const st = runner.status(a.id);
  assert.strictEqual(st.status, "RUNNING");
  assert.strictEqual(st.nextEntryDate, EXPIRY);
  assert.match(st.phase, /2026-11-17/);

  at(EXPIRY, "09:20", 1);
  await runner.tick();
  const pos = open(store.loadRun(a.id));
  // 2 legs × 2 clients (P1 1x, C1 2x)
  assert.strictEqual(pos.length, 4);
  assert.deepStrictEqual(pos.map(p => p.qty).sort((x, y) => x - y), [75, 75, 150, 150]);
  for (const p of pos) {
    assert.strictEqual(p.side, "SELL");
    assert.strictEqual(p.mode, "PAPER");
    assert.strictEqual(p.entryPrice, quotes[p.token].bid);       // paper sells at the bid
    assert.strictEqual(p.stopPrice, +(p.entryPrice * 2).toFixed(2)); // per_leg stop 2x
  }
  const trades = journal.read("trades", EXPIRY, r => r.assignmentId === a.id);
  assert.strictEqual(trades.length, 4);
  assert.ok(trades.every(t => t.source === "STRATEGY" && t.mode === "PAPER" && /ENTRY/.test(t.reason)));
  runner.squareOff(a.id, "nikhil"); await runner.tick();
});

test("every PAPER fill gets its own paper order ID, on the position and in the trade book", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  const pos = open(store.loadRun(a.id));
  const ids = pos.map(p => p.orderId);
  assert.ok(ids.every(id => /^PAPER-20261117-[0-9A-F]{6}$/.test(id)), ids.join(", "));
  assert.strictEqual(new Set(ids).size, ids.length, "paper order IDs are unique");

  runner.squareOff(a.id, "nikhil"); await runner.tick();
  const closed = store.loadRun(a.id).positions.filter(p => ids.includes(p.orderId));
  assert.ok(closed.every(p => /^PAPER-/.test(p.exitOrderId) && p.exitOrderId !== p.orderId));

  const trades = journal.read("trades", EXPIRY, r => r.assignmentId === a.id);
  const entryIds = trades.filter(t => /ENTRY/.test(t.reason)).map(t => t.orderId).sort();
  assert.deepStrictEqual(entryIds, [...ids].sort());
  assert.ok(trades.filter(t => t.reason === "SQUARE_OFF").every(t => /^PAPER-/.test(t.orderId)));
});

test("PAPER entries use the engine's retry logic: a run-away market is cancelled and re-priced", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  // every bid halves the moment the first paper orders are placed -> first attempt cannot fill
  const origPlace = paper.api.placeOrder;
  let placed = 0;
  paper.api.placeOrder = async (...args) => {
    const res = await origPlace(...args);
    if (++placed === 1) for (const k of Object.keys(quotes)) if (k !== "99999") quotes[k] = { ...quotes[k], bid: +(quotes[k].bid / 2).toFixed(2), ask: +(quotes[k].ask / 2).toFixed(2), ltp: +(quotes[k].ltp / 2).toFixed(2) };
    return res;
  };
  try {
    at(EXPIRY, "09:20", 1); await runner.tick();
  } finally {
    paper.api.placeOrder = origPlace;
  }
  const cancelled = paper.orders().filter(o => o.OrderStatus === "Cancelled");
  assert.ok(cancelled.length >= 1, "the unfillable first order was cancelled");
  const pos = open(store.loadRun(a.id));
  assert.strictEqual(pos.length, 4, "every leg still filled on the retry");
  const trades = journal.read("trades", EXPIRY, r => r.assignmentId === a.id && /ENTRY/.test(r.reason));
  assert.ok(trades.every(t => t.totalMs >= 0 && t.ackMs >= 0), "latency recorded on paper fills");
  runner.squareOff(a.id, "nikhil"); await runner.tick();
});

test("each slot fires once, however many ticks land in that minute", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  for (const s of [0, 1, 5, 30, 59]) { at(EXPIRY, "09:20", s); await runner.tick(); }
  assert.strictEqual(open(store.loadRun(a.id)).length, 4);
  at(EXPIRY, "09:30", 2); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 8);
  runner.squareOff(a.id, "nikhil"); await runner.tick();
});

test("starting mid-day skips the slots already past instead of firing them late", async () => {
  const a = setup();
  at(EXPIRY, "09:35"); runner.start(a.id, "nikhil");
  await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 0);
  at(EXPIRY, "09:40", 3); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 4);
  runner.squareOff(a.id, "nikhil"); await runner.tick();
});

test("the start message counts missed slots only on an entry day", async () => {
  const startMsg = (date, id) => journal.read("events", date, r => r.assignmentId === id && /Strategy started/.test(r.message)).pop()?.message;

  // the day before expiry (DTE 1): late start, but nothing was due — no "missed" warning
  const a = setup();
  at("2026-11-16", "14:50"); runner.start(a.id, "nikhil");
  assert.doesNotMatch(startMsg("2026-11-16", a.id), /missed|skipped/);
  runner.stop(a.id, "nikhil");

  // expiry day (DTE 0), started at 09:35: the 09:20 and 09:30 entries really were missed
  const b = setup();
  at(EXPIRY, "09:35"); runner.start(b.id, "nikhil");
  assert.match(startMsg(EXPIRY, b.id), /2 entry slot\(s\) earlier today were missed \(NIFTY/);
  runner.stop(b.id, "nikhil");
});

test("a leg whose premium doubles is bought back (per-leg stop)", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  const ce = open(store.loadRun(a.id)).find(p => p.type === "CE" && p.client === "P1");
  quotes[ce.token] = { bid: ce.stopPrice, ask: ce.stopPrice + 0.2, ltp: ce.stopPrice + 0.1, hasData: true };
  at(EXPIRY, "09:25"); await runner.tick();

  const after = store.loadRun(a.id).positions.filter(p => p.token === ce.token);
  assert.ok(after.every(p => p.status === "CLOSED" && p.exitReason === "STOP"), JSON.stringify(after));
  const exits = journal.read("trades", EXPIRY, r => r.assignmentId === a.id && r.reason === "STOP");
  assert.strictEqual(exits.length, 2); // P1 and C1 both held that strike
  assert.ok(exits.every(t => t.side === "BUY" && t.pnl < 0));
  runner.squareOff(a.id, "nikhil"); await runner.tick();
});

test("the daily loss limit squares off that client and blocks its further entries", async () => {
  // 2% of ₹10,000 = ₹200 for P1 (1x) and ₹400 for C1 (2x)
  const a = setup({ capital: 10_000 });
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  // every option up 3 points: P1 loses 2 legs × 75 × 3 = 450 >= 200; C1 loses 900 >= 400
  for (const p of open(store.loadRun(a.id))) {
    const q = quotes[p.token];
    quotes[p.token] = { ...q, ltp: p.entryPrice + 3, ask: p.entryPrice + 3.1 };
  }
  at(EXPIRY, "09:21"); await runner.tick();
  const run = store.loadRun(a.id);
  assert.strictEqual(open(run).length, 0);
  assert.deepStrictEqual(run.haltedClients.sort(), ["C1", "P1"]);
  at(EXPIRY, "09:30", 1); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 0, "no new entries after the daily limit");
  runner.stop(a.id, "nikhil"); await runner.tick();
});

test("positions held to expiry are settled at 15:30", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  at(EXPIRY, "15:30", 5); await runner.tick();
  const run = store.loadRun(a.id);
  assert.strictEqual(open(run).length, 0);
  assert.ok(run.positions.every(p => p.status === "EXPIRED"));
  runner.stop(a.id, "nikhil"); await runner.tick();
  assert.strictEqual(store.loadRun(a.id).status, "STOPPED");
});

test("expiry with no option price settles at intrinsic value from the futures price — never at 0", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  const ce = open(store.loadRun(a.id)).find(p => p.type === "CE");
  // 15:30: the options have no quote any more; the future trades 100 above the CE strike
  for (const p of open(store.loadRun(a.id))) delete quotes[p.token];
  quotes["99999"] = { bid: ce.strike + 100, ask: ce.strike + 100, ltp: ce.strike + 100, hasData: true };
  at(EXPIRY, "15:30", 5); await runner.tick();
  const settled = store.loadRun(a.id).positions.find(p => p.id === ce.id);
  assert.strictEqual(settled.status, "EXPIRED");
  assert.strictEqual(settled.exitPrice, 100, "CE settled at F - K");
  assert.ok(journal.read("events", EXPIRY, e => e.assignmentId === a.id).some(e => /intrinsic value from the futures price/.test(e.message)));
  runner.stop(a.id, "nikhil"); await runner.tick();
  priceQuotes(EXPIRY);
});

test("with no price at all, an expired position stays open (and is reported) instead of settling at 0", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  const run = store.loadRun(a.id);
  for (const p of open(run)) { delete quotes[p.token]; delete p.lastPrice; }
  delete quotes["99999"];
  at(EXPIRY, "15:30", 5); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 4, "nothing settled without a price");
  assert.ok(journal.read("events", EXPIRY, e => e.assignmentId === a.id).some(e => /Waiting to settle/.test(e.message)));
  priceQuotes(EXPIRY);
  at(EXPIRY, "15:31"); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 0, "settled once prices are back");
  runner.stop(a.id, "nikhil"); await runner.tick();
});

test("if one leg of an entry fails, the filled legs are closed at once (no one-sided position)", async () => {
  const a = setup({ mode: "LIVE" });
  let first = true;
  liveResult = (legs, cls) => cls.flatMap(c => legs.map((l, i) => {
    const ok = !(first && l.side === "Sell" && i === 1);           // the 2nd leg of the first entry is rejected
    return ok
      ? { client: c.id, token: String(l.exchange_token), status: "FILLED", filledQty: l.lots * l.lot_size * (c.multiplier || 1), requestedQty: l.lots * l.lot_size * (c.multiplier || 1), avgPrice: 40, orderId: "A1" }
      : { client: c.id, token: String(l.exchange_token), status: "FAILED", filledQty: 0, requestedQty: l.lots * l.lot_size, error: "RMS: margin shortfall" };
  }));
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  first = false;
  const run = store.loadRun(a.id);
  assert.strictEqual(open(run).length, 0, "nothing left open");
  assert.ok(run.positions.length > 0 && run.positions.every(p => p.exitReason === "UNWIND"));
  assert.ok(liveCalls.some(c => c.legs.every(l => l.side === "Buy")), "the filled short legs were bought back");
  assert.ok(journal.read("events", EXPIRY, e => e.assignmentId === a.id).some(e => /entry incomplete/.test(e.message)));
  runner.stop(a.id, "nikhil"); await runner.tick();
});

test("an entry is skipped when any leg's price is old (feed stalled for that contract)", async () => {
  runner = createRunner({ ...deps(), isFresh: () => false });
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 0);
  assert.ok(journal.read("events", EXPIRY, e => e.assignmentId === a.id).some(e => /is old — whole entry skipped/.test(e.message)));
  runner.stop(a.id, "nikhil"); await runner.tick();
});

test("a stop uses the live bid/ask mid when the last trade is outside it (old print)", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  const pos = open(store.loadRun(a.id)).find(p => p.side === "SELL");
  const e = pos.entryPrice;
  // an odd trade printed at 3x, but the book is still around the entry price: no stop
  quotes[pos.token] = { bid: e - 0.1, ask: e + 0.1, ltp: e * 3, hasData: true };
  at(EXPIRY, "09:21"); await runner.tick();
  assert.ok(open(store.loadRun(a.id)).some(p => p.id === pos.id), "not stopped on an old print");
  // the book itself moves above the stop: stopped
  quotes[pos.token] = { bid: e * 2.1, ask: e * 2.2, ltp: e * 2.15, hasData: true };
  at(EXPIRY, "09:22"); await runner.tick();
  assert.strictEqual(store.loadRun(a.id).positions.find(p => p.id === pos.id).exitReason, "STOP");
  runner.squareOff(a.id, "nikhil"); await runner.tick();
  priceQuotes(EXPIRY);
});

test("exchange holidays: no trading that day, and they do not count as trading days", async () => {
  assert.strictEqual(ist.tradingDaysBetween("2026-11-13", "2026-11-17"), 2);
  assert.strictEqual(ist.tradingDaysBetween("2026-11-13", "2026-11-17", ["2026-11-16"]), 1);
  assert.strictEqual(ist.isTradingDay("2026-11-16", ["2026-11-16"]), false);
  settings.holidays = [EXPIRY];
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 0, "market closed on a holiday");
  settings.holidays = [];
  runner.stop(a.id, "nikhil"); await runner.tick();
});

test("server off at 15:30: a morning price is never used — the position waits for the close", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  at(EXPIRY, "09:25"); await runner.tick();                       // last mark seen at 09:25 (no entry time)
  // the server is off until the next morning
  at("2026-11-18", "10:00"); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 4, "nothing settled on the 09:25 price");
  assert.ok(journal.read("events", "2026-11-18", e => e.assignmentId === a.id).some(e => /Waiting to settle/.test(e.message)));
  const groups = runner.expirySettlement();
  assert.ok(groups.some(g => g.symbol === "NIFTY" && g.expiry === EXPIRY && g.waiting === 4));

  // the admin enters the NIFTY close of the expiry day: settled at intrinsic value
  const ce = open(store.loadRun(a.id)).find(p => p.type === "CE");
  const r = runner.applyExpiryClose("NIFTY", EXPIRY, ce.strike + 30);
  assert.strictEqual(r.settled, 4);
  const settled = store.loadRun(a.id).positions.find(p => p.id === ce.id);
  assert.strictEqual(settled.exitPrice, 30);
  assert.strictEqual(settled.settleFinal, true);
  runner.stop(a.id, "nikhil"); await runner.tick();
  priceQuotes(EXPIRY);
});

test("server off at 15:30 but a mark was seen at 15:25: that settles the position", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  at(EXPIRY, "15:25"); await runner.tick();
  at("2026-11-18", "10:00"); await runner.tick();
  const run = store.loadRun(a.id);
  assert.strictEqual(open(run).length, 0);
  assert.ok(run.positions.every(p => p.status === "EXPIRED" && p.settleFinal));
  assert.ok(journal.read("events", "2026-11-18", e => e.assignmentId === a.id).some(e => /last price seen at 15:25/.test(e.message)));
  runner.stop(a.id, "nikhil"); await runner.tick();
});

test("a provisional settlement (old morning price) is corrected when the close is entered", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  const run = store.loadRun(a.id);
  // as it happened on 17-11: settled late at a morning price, with no close-time source
  for (const p of open(run)) {
    p.status = "EXPIRED"; p.exitReason = "EXPIRY"; p.exitDate = "2026-11-19"; p.exitPrice = 7.65;
    p.pnl = Math.round((p.side === "SELL" ? p.entryPrice - 7.65 : 7.65 - p.entryPrice) * p.qty * 100) / 100;
  }
  store.saveRun(run);
  assert.ok(runner.expirySettlement().some(g => g.expiry === EXPIRY && g.provisional === 4));

  const ce = run.positions.find(p => p.type === "CE");
  at("2026-11-19", "23:50");
  const r = runner.applyExpiryClose("NIFTY", EXPIRY, ce.strike - 100);   // CE expired worthless
  assert.strictEqual(r.corrected, 4);
  const fixed = store.loadRun(a.id).positions.find(p => p.id === ce.id);
  assert.strictEqual(fixed.exitPrice, 0);
  assert.strictEqual(fixed.pnl, Math.round(fixed.entryPrice * fixed.qty * 100) / 100, "full premium kept");
  const corrections = journal.read("trades", "2026-11-19", t => t.assignmentId === a.id && t.status === "CORRECTION");
  assert.strictEqual(corrections.length, 4, "each correction is its own trade-book row");
  assert.ok(!runner.expirySettlement().some(g => g.expiry === EXPIRY), "nothing left to settle");
  runner.stop(a.id, "nikhil"); await runner.tick();
});

test("after a restart the runner resumes: no duplicate entries, stops still watched", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 4);

  // simulate a process restart: fresh modules reading the same data folder
  for (const m of [BACKEND + "/strategy/store", BACKEND + "/strategy/runner"]) delete require.cache[require.resolve(m)];
  store = require(BACKEND + "/strategy/store");
  ({ createRunner } = require(BACKEND + "/strategy/runner"));
  runner = createRunner(deps());
  subs = [];
  await runner.init();
  const resubscribed = new Set(subs.filter(s => s.owner === `strategy:${a.id}`).flatMap(s => s.tokens));
  for (const p of open(store.loadRun(a.id))) assert.ok(resubscribed.has(p.token), `open position ${p.token} re-subscribed`);

  at(EXPIRY, "09:20", 40); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 4, "the 09:20 slot did not fire again");
  assert.strictEqual(runner.status(a.id).status, "RUNNING");
  runner.squareOff(a.id, "nikhil"); await runner.tick();
});

test("LIVE mode sends legs through the execution engine with real quantities", async () => {
  const a = setup({ mode: "LIVE" });
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  assert.strictEqual(liveCalls.length, 1);
  const call = liveCalls[0];
  assert.deepStrictEqual(call.clients.map(c => c.id), ["P1", "C1"]);
  assert.deepStrictEqual(call.legs.map(l => [l.side, l.type, l.lots, l.lot_size, l.segment]),
    [["Sell", "CE", 1, 75, "NSE_FO"], ["Sell", "PE", 1, 75, "NSE_FO"]]);
  const pos = open(store.loadRun(a.id));
  assert.strictEqual(pos.length, 4);
  assert.ok(pos.every(p => p.mode === "LIVE" && p.entryPrice === 40 && p.orderId === "A1"));

  // exit through the engine: exact quantity, multiplier not applied twice
  liveCalls = [];
  runner.squareOff(a.id, "nikhil"); await runner.tick();
  assert.ok(liveCalls.length >= 1);
  for (const c of liveCalls) {
    assert.ok(c.clients.every(x => x.multiplier === 1));
    assert.ok(c.legs.every(l => l.side === "Buy" && l.lots === 1));
  }
  const qtys = liveCalls.flatMap(c => c.legs.map(l => l.lot_size)).sort((x, y) => x - y);
  assert.deepStrictEqual(qtys, [75, 75, 150, 150]);
});

test("without live prices, PAPER entries are skipped too (no fills on old prices)", async () => {
  let healthy = false;
  runner = createRunner({ ...deps(), marketHealthy: () => healthy });
  const a = setup({ mode: "PAPER" });
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 0, "09:20 skipped while prices were not live");
  assert.ok(journal.read("events", EXPIRY, e => e.assignmentId === a.id).some(e => /Market data is not live/.test(e.message)));

  healthy = true;
  at(EXPIRY, "09:30", 1); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 4, "the next slot (4 legs) enters once prices are back");
  runner.squareOff(a.id, "nikhil"); await runner.tick();
});

test("LIVE entries are skipped while trading is halted; PAPER still runs", async () => {
  settings.tradingHalted = true;
  const live = setup({ mode: "LIVE" });
  const paper = setup({ mode: "PAPER", username: "rahul" });
  at(EXPIRY, "09:15"); runner.start(live.id, "nikhil"); runner.start(paper.id, "rahul");
  at(EXPIRY, "09:20", 1); await runner.tick();
  assert.strictEqual(liveCalls.length, 0);
  assert.strictEqual(open(store.loadRun(live.id)).length, 0);
  assert.strictEqual(open(store.loadRun(paper.id)).length, 4);
  assert.ok(journal.read("events", EXPIRY, e => e.assignmentId === live.id).some(e => /halted/i.test(e.message)));
  runner.stop(live.id, "nikhil"); runner.squareOff(paper.id, "rahul"); await runner.tick();
});

test("global PAPER mode turns a LIVE assignment into paper — nothing reaches the broker", async () => {
  settings.tradingMode = "PAPER";
  const a = setup({ mode: "LIVE" });
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  assert.strictEqual(liveCalls.length, 0);
  const pos = open(store.loadRun(a.id));
  assert.strictEqual(pos.length, 4);
  assert.ok(pos.every(p => p.mode === "PAPER" && /^PAPER-/.test(p.orderId)));
  runner.squareOff(a.id, "nikhil"); await runner.tick();
  assert.strictEqual(liveCalls.length, 0, "exits were paper too");
});

test("per-client capital allocation sizes each client's lots for this strategy", async () => {
  // base capital ₹10L for the strategy; P1 allocated ₹30L (3 lots), C1 ₹5L (0.5 -> 0 lots, skipped)
  const a = setup({ capital: 1_000_000 });
  store.updateAssignment(a.id, { allocations: { P1: 3_000_000, C1: 500_000 } });
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  const pos = open(store.loadRun(a.id));
  assert.deepStrictEqual([...new Set(pos.map(p => p.client))], ["P1"]);
  assert.ok(pos.every(p => p.qty === 3 * 75 && p.multiplier === 3), JSON.stringify(pos.map(p => [p.client, p.qty, p.multiplier])));
  runner.squareOff(a.id, "nikhil"); await runner.tick();
});

test("LIVE clients that are not logged in and connected are skipped", async () => {
  clients.C1.isConnected = false;
  try {
    const a = setup({ mode: "LIVE" });
    at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
    at(EXPIRY, "09:20", 1); await runner.tick();
    assert.deepStrictEqual(liveCalls[0].clients.map(c => c.id), ["P1"]);
    runner.squareOff(a.id, "nikhil"); await runner.tick();
  } finally {
    clients.C1.isConnected = true;
  }
});

test("an order needing a manual check pauses the strategy", async () => {
  liveResult = (legs, cls) => cls.flatMap(c => legs.map(l => ({
    client: c.id, token: String(l.exchange_token), status: "MANUAL_CHECK", filledQty: 0, avgPrice: 0, error: "timeout",
  })));
  const a = setup({ mode: "LIVE" });
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  const st = runner.status(a.id);
  assert.strictEqual(st.status, "PAUSED");
  assert.match(st.pausedReason, /manual check/i);
  at(EXPIRY, "09:30", 1); await runner.tick();
  assert.strictEqual(liveCalls.length, 1, "no more entries while paused");
  runner.stop(a.id, "nikhil"); await runner.tick();
});

test("the same client under two users' strategies trades for both", async () => {
  const n = setup({ username: "nikhil" });
  const r = setup({ username: "rahul" });
  at(EXPIRY, "09:15"); runner.start(n.id, "nikhil"); runner.start(r.id, "rahul");
  at(EXPIRY, "09:20", 1); await runner.tick();
  assert.ok(open(store.loadRun(n.id)).some(p => p.client === "P1"));
  assert.ok(open(store.loadRun(r.id)).some(p => p.client === "P1"));
  runner.squareOff(n.id, "nikhil"); runner.squareOff(r.id, "rahul"); await runner.tick();
});

test("an order-rate trip pauses every running strategy using that client", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  runner.pauseForClient("C1", "Order rate limit reached");
  assert.strictEqual(runner.status(a.id).status, "PAUSED");
  runner.resume(a.id, "nikhil");
  assert.strictEqual(runner.status(a.id).status, "RUNNING");
  runner.stop(a.id, "nikhil"); await runner.tick();
});

test("stop keeps watching open positions; square off closes them", async () => {
  const a = setup();
  at(EXPIRY, "09:15"); runner.start(a.id, "nikhil");
  at(EXPIRY, "09:20", 1); await runner.tick();
  runner.stop(a.id, "nikhil");
  assert.strictEqual(runner.status(a.id).status, "STOPPING");
  at(EXPIRY, "09:30", 1); await runner.tick();
  assert.strictEqual(open(store.loadRun(a.id)).length, 4, "no new entries after stop");
  runner.squareOff(a.id, "nikhil"); await runner.tick();
  const run = store.loadRun(a.id);
  assert.strictEqual(open(run).length, 0);
  assert.ok(run.positions.every(p => p.exitReason === "SQUARE_OFF"));
  assert.strictEqual(run.status, "STOPPED");
});
