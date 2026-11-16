// instrumentloader.js
//
// Instrument master (symbols ↔ exchange tokens). Downloaded straight from
// Upstox when the backend starts and whenever someone presses "Refresh
// Instruments" — no hand-downloaded file is needed:
//
//   INSTRUMENT_URL  (default) https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz
//
// The last good download is kept in data/instruments-cache.json.gz and is
// used only if Upstox can't be reached when the backend starts. A failed
// refresh while running never replaces the data already loaded.

require("dotenv").config();
const fs    = require("fs");
const zlib  = require("zlib");
const path  = require("path");
const axios = require("axios");
const { ipv4Agent } = require("./httpAgent");

const INSTRUMENT_URL = process.env.INSTRUMENT_URL ||
  "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";
const DATA_DIR   = process.env.XTS_DATA_DIR || path.join(__dirname, "data");
const CACHE_FILE = path.join(DATA_DIR, "instruments-cache.json.gz");
const DOWNLOAD_TIMEOUT_MS = 120_000;

// ============================================================
// Segment mappings
// ============================================================

// Instrument-file segment string → XTS string segment
const SEG_TO_XTS = {
  // NSE
  NSE:      "NSECM",
  NSE_CM:   "NSECM",
  NSE_EQ:   "NSECM",
  NSE_INDEX: "NSECM",

  // BSE
  BSE:      "BSECM",
  BSE_CM:   "BSECM",
  BSE_EQ:   "BSECM",
  BSE_INDEX: "BSECM",

  // F&O
  NSE_FO:   "NSEFO",
  BSE_FO:   "BSEFO",

  // Currency
  NSE_CD:   "NSECD",
  NCD_FO:   "NSECD",

  // BSE Currency
  BCD_FO:   "BSECD",

  // Commodity
  MCX:       "MCXFO",
  MCX_FO:    "MCXFO",
  NCDEX:     "NCDEX",
};

// XTS string segment → integer code used in market-data subscription
const XTS_SEG_CODE = {
  NSECM:   1,
  NSEFO:   2,
  NSECD:   3,

  BSECM:  11,
  BSEFO:  12,
  BSECD:  13,

  NCDEX:  21,

  MCXFO:  51,
};

// Segments the dashboard can offer (the admin narrows them down). Only these
// are sent to the browser, with only the fields it uses.
// tick_size is kept as in the master: in PAISE (5 = ₹0.05, 100 = ₹1).
// NSE_COM is left out: it has no XTS segment code.
const DASHBOARD_SEGMENTS = new Set(["NSE_FO", "BSE_FO", "MCX_FO", "MCX", "NSE_EQ", "BSE_EQ", "NCD_FO", "BCD_FO"]);
// Tradable equity series (bonds, G-secs, T-bills and other debt are left out).
const EQUITY_SERIES = {
  NSE_EQ: new Set(["EQ", "BE", "BZ", "SM", "ST"]),
  BSE_EQ: new Set(["A", "B", "T", "X", "XT", "M", "MT", "Z", "ZP", "P", "MS", "R", "TS"]),
};
const DASHBOARD_FIELDS = [
  "segment", "exchange_token", "asset_symbol", "instrument_type",
  "expiry", "strike_price", "lot_size", "trading_symbol", "tick_size", "name",
];

// ============================================================
// In-memory store
// ============================================================
let rawInstruments       = [];
let dashboardInstruments = [];
let tokenSegmentMap      = {};   // { "exchange_token": { xtsSegment, xtsSegmentCode } }

const status = {
  source: null,        // "upstox" | "cache" | "upload" | null
  url: INSTRUMENT_URL,
  fetchedAt: null,     // when the loaded data was downloaded
  refreshing: false,
  lastError: null,     // last refresh failure, cleared by the next success
  lastAttemptAt: null,
};

let inFlight = null;   // shared promise while a refresh is running

function normalizeInstrumentPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.instruments)) return payload.instruments;
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.items)) return payload.items;

  return [];
}

function setInstruments(payload, source = "upload") {
  const list = normalizeInstrumentPayload(payload);
  if (!list.length) throw new Error("Instrument data contained no instruments");

  const map = {};
  const dash = [];
  const segmentCount = {};
  const skippedSegments = {};
  let missingToken = 0;

  list.forEach(item => {
    const token = item.exchange_token?.toString();
    if (!token) { missingToken++; return; }

    let seg = (item.segment || "").trim().toUpperCase();
    segmentCount[seg] = (segmentCount[seg] || 0) + 1;

    const equityOk = !EQUITY_SERIES[seg] || EQUITY_SERIES[seg].has(String(item.instrument_type || "").toUpperCase());
    if (DASHBOARD_SEGMENTS.has(seg) && equityOk) {
      const slim = {};
      DASHBOARD_FIELDS.forEach(f => { if (item[f] !== undefined) slim[f] = item[f]; });
      dash.push(slim);
    }

    if (seg === "MCX_FO") seg = "MCX";
    const xtsSegment = SEG_TO_XTS[seg];
    if (!xtsSegment) {
      skippedSegments[seg] = (skippedSegments[seg] || 0) + 1;
      return;
    }
    map[token] = { xtsSegment, xtsSegmentCode: XTS_SEG_CODE[xtsSegment] };
  });

  rawInstruments       = list;
  dashboardInstruments = dash;
  tokenSegmentMap      = map;
  status.source        = source;

  console.log(`📂 Instruments (${source}): ${list.length.toLocaleString()} total | ` +
    `${dash.length.toLocaleString()} F&O for dashboard | ${Object.keys(map).length.toLocaleString()} mapped tokens` +
    (missingToken ? ` | ${missingToken} without token` : ""));
  if (Object.keys(skippedSegments).length) {
    console.log("   Unmapped segments:", JSON.stringify(skippedSegments));
  }

  return list.length;
}

// Accepts gzipped or plain JSON bytes.
function parseInstrumentBuffer(buffer) {
  if (!buffer || !buffer.length) throw new Error("Empty instrument download");
  const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
  const text = (isGzip ? zlib.gunzipSync(buffer) : buffer).toString("utf8");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("Instrument download is not valid JSON"); }
  if (!normalizeInstrumentPayload(parsed).length) throw new Error("Instrument download contained no instruments");
  return parsed;
}

async function downloadFromUpstox() {
  console.log(`🌐 Downloading instruments: ${INSTRUMENT_URL}`);
  const res = await axios.get(INSTRUMENT_URL, {
    responseType: "arraybuffer",
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: 500 * 1024 * 1024,
    httpsAgent: ipv4Agent,
    // Keep the raw gzip bytes; we gunzip ourselves (and cache them as-is).
    decompress: false,
    headers: { "Accept-Encoding": "identity" },
  });
  return Buffer.from(res.data);
}

function writeCache(buffer) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const gzipped = buffer[0] === 0x1f && buffer[1] === 0x8b ? buffer : zlib.gzipSync(buffer);
    fs.writeFileSync(CACHE_FILE, gzipped);
  } catch (err) {
    console.warn("⚠️  Could not save instrument cache:", err.message);
  }
}

function loadFromCache() {
  if (!fs.existsSync(CACHE_FILE)) return false;
  const buffer = fs.readFileSync(CACHE_FILE);
  setInstruments(parseInstrumentBuffer(buffer), "cache");
  status.fetchedAt = fs.statSync(CACHE_FILE).mtime.toISOString();
  return true;
}

async function doRefresh(fetcher) {
  status.refreshing = true;
  status.lastAttemptAt = new Date().toISOString();
  try {
    const buffer = await fetcher();
    const parsed = parseInstrumentBuffer(buffer);   // throws before touching loaded data
    setInstruments(parsed, "upstox");
    status.fetchedAt = new Date().toISOString();
    status.lastError = null;
    writeCache(buffer);
  } catch (err) {
    status.lastError = err.message;
    console.error(`❌ Instrument download failed: ${err.message}`);

    if (rawInstruments.length) {
      console.warn("   Keeping the instruments already loaded.");
    } else {
      let fromCache = false;
      try { fromCache = loadFromCache(); }
      catch (cacheErr) { console.error("   Instrument cache unreadable:", cacheErr.message); }
      if (fromCache) {
        console.warn(`   Using the last good download from ${status.fetchedAt}.`);
      } else {
        throw new Error(`Instrument download failed and no saved copy exists: ${err.message}`);
      }
    }
  } finally {
    status.refreshing = false;
  }
  return getInstrumentStatus();
}

// Download a fresh master from Upstox. Overlapping calls share one download.
// `fetcher` is injectable for tests; production always uses Upstox.
function refreshInstruments({ fetcher = downloadFromUpstox } = {}) {
  if (!inFlight) {
    inFlight = doRefresh(fetcher).finally(() => { inFlight = null; });
  }
  return inFlight;
}

// ============================================================
// Getters
// ============================================================
function getInstruments()          { return rawInstruments; }
function getDashboardInstruments() { return dashboardInstruments; }
function getTokenSegmentMap()      { return tokenSegmentMap; }

function getInstrumentStatus() {
  return {
    ...status,
    count: rawInstruments.length,
    dashboardCount: dashboardInstruments.length,
  };
}

function getSegmentForToken(token) {
  return (
    tokenSegmentMap[token?.toString()] || { xtsSegment: "NSEFO", xtsSegmentCode: 2 }
  );
}

// Helper used in order execution — map segment string → XTS string
function segmentToXTS(seg) {
  if (!seg) return "NSEFO";
  const clean = seg === "MCX_FO" ? "MCX" : seg;
  return SEG_TO_XTS[clean] || "NSEFO";
}

module.exports = {
  refreshInstruments,
  normalizeInstrumentPayload,
  setInstruments,
  getInstruments,
  getDashboardInstruments,
  getInstrumentStatus,
  getTokenSegmentMap,
  getSegmentForToken,
  segmentToXTS,
  XTS_SEG_CODE,
};
