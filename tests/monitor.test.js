// test-monitor.js — latency statistics for the admin Monitor. Pure functions.
//
// Run:  node --test tests/monitor.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const { latencyStats, latencySummary } = require(BACKEND + "/monitor");

test("latency stats: count, average, median, 95th percentile and max, ignoring blanks", () => {
  const rows = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(v => ({ totalMs: v }));
  rows.push({ totalMs: null }, { totalMs: "" }, { totalMs: "abc" }, {});
  assert.deepStrictEqual(latencyStats(rows, "totalMs"), { count: 10, avg: 55, p50: 50, p95: 100, max: 100 });
  assert.deepStrictEqual(latencyStats([], "totalMs"), { count: 0, avg: null, p50: null, p95: null, max: null });
});

test("the summary splits by metric, client and mode", () => {
  const rows = [
    { client: "P1", mode: "LIVE",  queueMs: 2, ackMs: 40, fillMs: 300, totalMs: 342 },
    { client: "P1", mode: "LIVE",  queueMs: 4, ackMs: 60, fillMs: 500, totalMs: 564 },
    { client: "C1", mode: "PAPER", queueMs: 1, ackMs: 0,  fillMs: 5,   totalMs: 6 },
  ];
  const s = latencySummary(rows);
  assert.strictEqual(s.overall.totalMs.count, 3);
  assert.strictEqual(s.overall.ackMs.max, 60);
  assert.deepStrictEqual(s.byClient.map(c => [c.client, c.totalMs.count]), [["C1", 1], ["P1", 2]]);
  assert.strictEqual(s.byClient.find(c => c.client === "P1").fillMs.avg, 400);
  assert.deepStrictEqual(s.byMode.map(m => m.mode), ["LIVE", "PAPER"]);
});
