// download.test.js — CSV export used by the client-card CSV buttons.
// Run:  node --test tests/frontend-download.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { rowsToCsv } from "../frontend/src/download.js";

test("columns can be given as [key, label] pairs", () => {
  const csv = rowsToCsv([{ a: 1, b: "x" }], [["a", "Alpha"], ["b", "Beta"]]);
  assert.strictEqual(csv, '"Alpha","Beta"\n"1","x"');
});

test("without columns, every key that appears in any row becomes a column", () => {
  const csv = rowsToCsv([{ AppOrderID: 1, OrderSide: "BUY" }, { AppOrderID: 2, LeavesQuantity: 0 }]);
  assert.strictEqual(csv, '"AppOrderID","OrderSide","LeavesQuantity"\n"1","BUY",""\n"2","","0"');
});

test("quotes, nulls and nested values are written safely", () => {
  const csv = rowsToCsv([{ a: 'say "hi"', b: null, c: { x: 1 } }]);
  assert.strictEqual(csv, '"a","b","c"\n"say ""hi""","","{""x"":1}"');
});

test("an empty list still yields the header row", () => {
  assert.strictEqual(rowsToCsv([], [["a", "A"]]), '"A"');
});
