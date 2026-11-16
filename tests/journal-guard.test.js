// test-journal-guard.js — durable trade book / log journal, atomic JSON
// writes, and the per-client order rate guard. No network, no broker.
//
// Run:  node --test tests/journal-guard.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xts-journal-test-"));
process.env.XTS_DATA_DIR = dataDir;

const { writeJsonAtomic, readJson } = require(BACKEND + "/fsutil");
const journal = require(BACKEND + "/journal");
const { createOrderGuard } = require(BACKEND + "/orderGuard");

// ── atomic JSON ──
test("atomic writes replace the file whole and leave no temp files", () => {
  const f = path.join(dataDir, "x.json");
  writeJsonAtomic(f, { a: 1 });
  writeJsonAtomic(f, { a: 2 });
  assert.deepStrictEqual(readJson(f, null), { a: 2 });
  assert.deepStrictEqual(fs.readdirSync(dataDir).filter(n => n.includes(".tmp")), []);
  assert.strictEqual(readJson(path.join(dataDir, "missing.json"), "fallback"), "fallback");
});

// ── journal ──
const T = Date.UTC(2026, 10, 17, 4, 0, 0); // 09:30 IST

test("trades are appended to the IST day's file and read back", () => {
  journal.appendTrade({ user: "nikhil", source: "STRATEGY", client: "C1", side: "SELL", qty: 75, price: 41.5 }, T);
  journal.appendTrade({ user: "rahul", source: "MANUAL", client: "C2", side: "BUY", qty: 50, price: 12 }, T);
  const all = journal.read("trades", "2026-11-17");
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].date, "2026-11-17");
  assert.strictEqual(all[0].time, "09:30:00");
  assert.ok(all[0].id);
  assert.deepStrictEqual(journal.read("trades", "2026-11-17", r => r.user === "nikhil").map(r => r.client), ["C1"]);
});

test("a half-written last line (crash mid-write) does not lose earlier records", () => {
  const file = path.join(dataDir, "journal", "trades-2026-11-17.jsonl");
  fs.appendFileSync(file, '{"user":"x","qty":');
  assert.strictEqual(journal.read("trades", "2026-11-17").length, 2);
  journal.appendTrade({ user: "nikhil", source: "STRATEGY", client: "C1", side: "BUY", qty: 75, price: 80 }, T);
  assert.strictEqual(journal.read("trades", "2026-11-17").length, 3);
});

test("events are journaled and days are listed newest first", () => {
  journal.appendEvent({ level: "info", user: "nikhil", message: "Strategy started" }, T);
  journal.appendEvent({ level: "warn", user: "nikhil", message: "next day" }, T + 86400000);
  assert.strictEqual(journal.read("events", "2026-11-17")[0].message, "Strategy started");
  assert.deepStrictEqual(journal.listDates("events"), ["2026-11-18", "2026-11-17"]);
});

test("CSV export quotes every cell and escapes quotes", () => {
  const csv = journal.toCsv([{ a: 'say "hi"', b: 1 }, { a: null, b: 2 }], ["a", "b"]);
  assert.strictEqual(csv, '"a","b"\n"say ""hi""","1"\n"","2"');
});

// ── order guard ──
test("orders for one client are spaced out; other clients are not blocked", async () => {
  const guard = createOrderGuard({ minGapMs: 40, getMaxPerMinute: () => 0 });
  const t0 = Date.now();
  const stamps = [];
  await Promise.all([1, 2, 3].map(() => guard.beforeOrder("A").then(() => stamps.push(Date.now() - t0))));
  stamps.sort((a, b) => a - b);
  assert.ok(stamps[2] - stamps[0] >= 75, `spacing ${stamps}`);

  const tB = Date.now();
  await guard.beforeOrder("B");
  assert.ok(Date.now() - tB < 30, "client B waited on client A");
});

test("too many orders per minute for a client are refused before reaching the broker", async () => {
  const trips = [];
  const guard = createOrderGuard({ minGapMs: 0, getMaxPerMinute: () => 3, onTrip: (id, msg) => trips.push([id, msg]) });
  await guard.beforeOrder("A"); await guard.beforeOrder("A"); await guard.beforeOrder("A");
  await assert.rejects(guard.beforeOrder("A"), err => {
    assert.strictEqual(err.response?.status, 429); // a definite refusal, not an unknown outcome
    return /per minute/.test(err.message);
  });
  assert.strictEqual(trips.length, 1);
  assert.strictEqual(trips[0][0], "A");
  await guard.beforeOrder("B"); // other clients unaffected
});

test("the order spacing can be changed live (e.g. from the admin settings)", async () => {
  let gap = 80;
  const guard = createOrderGuard({ minGapMs: () => gap, getMaxPerMinute: () => 0 });
  await guard.beforeOrder("A");
  let t = Date.now(); await guard.beforeOrder("A");
  assert.ok(Date.now() - t >= 70, "80 ms gap honoured");
  gap = 0;
  await new Promise(r => setTimeout(r, 90));
  t = Date.now(); await guard.beforeOrder("A"); await guard.beforeOrder("A");
  assert.ok(Date.now() - t < 40, "new 0 ms gap applies immediately");
});

test("status polls are spaced but never counted as orders", async () => {
  const guard = createOrderGuard({ minGapMs: 0, pollGapMs: 20, getMaxPerMinute: () => 1 });
  for (let i = 0; i < 5; i++) await guard.beforePoll("A");
  await guard.beforeOrder("A"); // still allowed: polls are not orders
  assert.deepStrictEqual(guard.stats("A").ordersLastMinute, 1);
});
