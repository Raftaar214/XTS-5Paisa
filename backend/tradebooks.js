// tradebooks.js — a daily copy of every client's BROKER trade book.
//
//   data/tradebooks/YYYY-MM-DD/<clientId>.json
//
// The broker only returns today's trades, and only while the client is
// logged in, so the backend saves what it sees: every few minutes during
// market hours and whenever someone opens a client's Trades view. Each save
// MERGES into the day's file (new trades are added, earlier ones are never
// dropped), and writes are atomic. Reading the trade book is a GET — it never
// places, modifies or cancels anything.

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic, readJson } = require("./fsutil");

const DATA_DIR = process.env.XTS_DATA_DIR || path.join(__dirname, "data");
const DIR = path.join(DATA_DIR, "tradebooks");

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

function checkDate(date) {
  if (!DATE_RE.test(String(date))) throw new Error("Date must be YYYY-MM-DD");
}
function checkClient(id) {
  const s = String(id);
  if (!CLIENT_RE.test(s) || s.includes("..")) throw new Error(`Invalid client id "${id}"`);
}

function fileFor(date, clientId) {
  checkDate(date);
  checkClient(clientId);
  return path.join(DIR, date, `${clientId}.json`);
}

// Identity of a trade: the exchange trade ID when the broker gives one,
// otherwise the whole record.
function tradeKey(t) {
  const id = t.ExchangeTradeID ?? t.ExchangeTradeId ?? t.TradeID ?? t.tradeId;
  if (id !== undefined && id !== null && id !== "") return `id:${id}`;
  const sorted = Object.keys(t).sort().reduce((o, k) => { o[k] = t[k]; return o; }, {});
  return `raw:${JSON.stringify(sorted)}`;
}

function read(date, clientId) {
  const book = readJson(fileFor(date, clientId), null);
  return book || { clientId: String(clientId), clientName: "", date, updatedAt: null, trades: [] };
}

function saveSnapshot(client, trades, date) {
  const file = fileFor(date, client.id);
  const book = read(date, client.id);
  const keys = new Set(book.trades.map(tradeKey));
  for (const t of Array.isArray(trades) ? trades : []) {
    if (!t || typeof t !== "object") continue;
    const k = tradeKey(t);
    if (keys.has(k)) continue;
    keys.add(k);
    book.trades.push(t);
  }
  book.clientId = String(client.id);
  book.clientName = client.name || book.clientName || "";
  book.date = date;
  book.updatedAt = new Date().toISOString();
  writeJsonAtomic(file, book);
  return { clientId: book.clientId, count: book.trades.length, updatedAt: book.updatedAt };
}

function listDates() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(d => DATE_RE.test(d)).sort().reverse();
}

function listClients(date) {
  checkDate(date);
  const dir = path.join(DIR, date);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => n.endsWith(".json"))
    .map(n => {
      const b = readJson(path.join(dir, n), null);
      return b ? { clientId: b.clientId, clientName: b.clientName, count: b.trades.length, updatedAt: b.updatedAt } : null;
    })
    .filter(Boolean);
}

module.exports = { saveSnapshot, read, listDates, listClients, tradeKey };
