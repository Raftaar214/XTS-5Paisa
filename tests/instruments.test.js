// test-instruments.js — instrument master download/refresh logic.
// The Upstox download is replaced by an injected fake `fetcher`, and the
// cache lives in a temp folder, so this test makes no network calls.
//
// Run:  node --test tests/instruments.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xts-instr-test-"));
process.env.XTS_DATA_DIR = dataDir;

const loader = require(BACKEND + "/instrumentloader");

const SAMPLE = [
  { segment: "NSE_FO", exchange_token: "35001", asset_symbol: "NIFTY", instrument_type: "CE",
    expiry: 1893456000000, strike_price: 25000, lot_size: 75, trading_symbol: "NIFTY 25000 CE", name: "NIFTY", isin: "x" },
  { segment: "MCX_FO", exchange_token: "440001", asset_symbol: "CRUDEOILM", instrument_type: "FUT",
    expiry: 1893456000000, lot_size: 10, trading_symbol: "CRUDEOILM FUT" },
  { segment: "NSE_EQ", exchange_token: "2885", trading_symbol: "RELIANCE", instrument_type: "EQ", tick_size: 10, lot_size: 1 },
];
const gz = obj => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
const failing = async () => { throw new Error("network down"); };

test("with no download and no cache, refresh fails and reports the error", async () => {
  await assert.rejects(loader.refreshInstruments({ fetcher: failing }), /network down/);
  const st = loader.getInstrumentStatus();
  assert.strictEqual(st.count, 0);
  assert.match(st.lastError, /network down/);
});

test("a gzipped download is parsed and every segment is mapped", async () => {
  const st = await loader.refreshInstruments({ fetcher: async () => gz(SAMPLE) });
  assert.strictEqual(st.count, 3);
  assert.strictEqual(st.source, "upstox");
  assert.ok(st.fetchedAt);
  assert.strictEqual(loader.getSegmentForToken("2885").xtsSegment, "NSECM");
  assert.strictEqual(loader.getSegmentForToken("440001").xtsSegment, "MCXFO");
});

test("the dashboard list holds tradable contracts with the fields it needs", () => {
  const list = loader.getDashboardInstruments();
  assert.deepStrictEqual(list.map(i => i.exchange_token).sort(), ["2885", "35001", "440001"]);
  assert.strictEqual(list[0].isin, undefined);
  assert.strictEqual(list.find(i => i.exchange_token === "35001").lot_size, 75);
});

test("equity bonds / G-secs are left out; every segment keeps its tick size", async () => {
  await loader.refreshInstruments({ fetcher: async () => gz([...SAMPLE,
    { segment: "NSE_EQ", exchange_token: "9001", trading_symbol: "GOI2030", instrument_type: "GS", tick_size: 1 },
    { segment: "BSE_EQ", exchange_token: "9002", trading_symbol: "SOMEBOND", instrument_type: "F", tick_size: 1 },
    { segment: "BSE_EQ", exchange_token: "500325", trading_symbol: "RELIANCE", instrument_type: "A", tick_size: 5, lot_size: 1 },
    { segment: "NCD_FO", exchange_token: "7022", asset_symbol: "USDINR", instrument_type: "FUT", tick_size: 0.25, lot_size: 1, expiry: 1893456000000 },
  ]) });
  const list = loader.getDashboardInstruments();
  const toks = list.map(i => i.exchange_token);
  assert.ok(!toks.includes("9001") && !toks.includes("9002"), "bond series excluded");
  assert.ok(toks.includes("500325") && toks.includes("7022"));
  assert.strictEqual(list.find(i => i.exchange_token === "7022").tick_size, 0.25);
  await loader.refreshInstruments({ fetcher: async () => gz(SAMPLE) });
});

test("when a refresh fails while running, the loaded data stays in use", async () => {
  const st = await loader.refreshInstruments({ fetcher: failing });
  assert.strictEqual(st.source, "upstox");
  assert.strictEqual(st.count, 3);
  assert.match(st.lastError, /network down/);
});

test("after a restart with Upstox unreachable, the last good download is used", async () => {
  delete require.cache[require.resolve(BACKEND + "/instrumentloader")];
  const fresh = require(BACKEND + "/instrumentloader");
  const st = await fresh.refreshInstruments({ fetcher: failing });
  assert.strictEqual(st.source, "cache");
  assert.strictEqual(st.count, 3);
  assert.match(st.lastError, /network down/);
  assert.strictEqual(fresh.getSegmentForToken("2885").xtsSegment, "NSECM");
});

test("a plain (non-gzipped) JSON download also works", async () => {
  const st = await loader.refreshInstruments({ fetcher: async () => Buffer.from(JSON.stringify(SAMPLE.slice(0, 1))) });
  assert.strictEqual(st.count, 1);
  assert.strictEqual(st.lastError, null);
});

test("an empty or malformed download never replaces good data", async () => {
  await loader.refreshInstruments({ fetcher: async () => gz(SAMPLE) });
  await loader.refreshInstruments({ fetcher: async () => gz([]) }).catch(() => {});
  assert.strictEqual(loader.getInstrumentStatus().count, 3);
  await loader.refreshInstruments({ fetcher: async () => Buffer.from("<html>oops</html>") }).catch(() => {});
  assert.strictEqual(loader.getInstrumentStatus().count, 3);
});

test("overlapping refreshes share one download", async () => {
  let calls = 0;
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 50)); return gz(SAMPLE); };
  await Promise.all([
    loader.refreshInstruments({ fetcher: slow }),
    loader.refreshInstruments({ fetcher: slow }),
  ]);
  assert.strictEqual(calls, 1);
});
