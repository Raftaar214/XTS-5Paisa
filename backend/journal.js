// journal.js — the durable trade book and activity log.
//
// Every fill (manual or strategy, LIVE or PAPER) and every strategy event
// is appended to a per-day JSON-lines file and flushed to disk before the
// call returns, so a crash, restart or lost connection never loses history:
//
//   data/journal/trades-YYYY-MM-DD.jsonl
//   data/journal/events-YYYY-MM-DD.jsonl
//
// Days are IST days. Files are append-only; a half-written last line from a
// crash is skipped when reading.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ist = require("./strategy/ist");
const { appendLineDurable } = require("./fsutil");

const DATA_DIR = process.env.XTS_DATA_DIR || path.join(__dirname, "data");
const DIR = path.join(DATA_DIR, "journal");
const KINDS = ["trades", "events"];

const TRADE_COLUMNS = [
  "date", "time", "source", "mode", "user", "strategy", "assignmentId", "symbol",
  "client", "clientName", "tradingSymbol", "token", "side", "qty", "price",
  "reason", "status", "orderId", "orderIds", "pnl", "requestedQty", "limitPrice", "bid", "ask", "ltp",
  "attempts", "executionTime", "queueMs", "ackMs", "fillMs", "totalMs", "multiplier", "error", "id",
];
const EVENT_COLUMNS = ["date", "time", "source", "level", "user", "strategy", "assignmentId", "client", "message", "clientTime", "id"];

const listeners = new Set();

function fileFor(kind, date) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown journal "${kind}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must be YYYY-MM-DD");
  return path.join(DIR, `${kind}-${date}.jsonl`);
}

function append(kind, record, nowMs = Date.now()) {
  const p = ist.parts(nowMs);
  const rec = {
    id: crypto.randomUUID(),
    ts: new Date(nowMs).toISOString(),
    date: p.date,
    time: `${p.hhmm}:${String(p.seconds).padStart(2, "0")}`,
    ...record,
  };
  appendLineDurable(fileFor(kind, p.date), JSON.stringify(rec));
  listeners.forEach(fn => { try { fn(kind, rec); } catch (_) {} });
  return rec;
}

const appendTrade = (record, nowMs) => append("trades", record, nowMs);
const appendEvent = (record, nowMs) => append("events", record, nowMs);

function read(kind, date, filter) {
  const file = fileFor(kind, date);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (!filter || filter(rec)) out.push(rec);
    } catch {
      // half-written line from a crash — skip it
    }
  }
  return out;
}

function listDates(kind) {
  if (!fs.existsSync(DIR)) return [];
  const re = new RegExp(`^${kind}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
  return fs.readdirSync(DIR).map(n => re.exec(n)?.[1]).filter(Boolean).sort().reverse();
}

function csvCell(v) {
  if (v === null || v === undefined) return '""';
  return `"${String(v).replace(/"/g, '""')}"`;
}

function toCsv(rows, columns) {
  const lines = [columns.map(csvCell).join(",")];
  for (const r of rows) lines.push(columns.map(c => csvCell(r[c])).join(","));
  return lines.join("\n");
}

function onAppend(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = {
  appendTrade, appendEvent, read, listDates, toCsv, onAppend,
  TRADE_COLUMNS, EVENT_COLUMNS, KINDS,
};
