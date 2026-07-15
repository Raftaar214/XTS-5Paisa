const fs   = require("fs");
const zlib = require("zlib");
const path = require("path");

// ============================================================
// Segment mappings
// ============================================================

// From your JSON segment string → XTS string segment

const SEG_TO_XTS = {
  // NSE
  NSE:      "NSECM",
  NSE_CM:   "NSECM",
  NSE_EQ:   "NSECM",

  // BSE
  BSE:      "BSECM",
  BSE_CM:   "BSECM",
  BSE_EQ:   "BSECM",

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
  NSE_COM:   "MCXFO",   // Only if your instrument file uses NSE_COM for MCX contracts
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

// ============================================================
// In-memory store
// ============================================================
let rawInstruments  = [];      // original array from file
let tokenSegmentMap = {};      // { "exchange_token": { xtsSegment, xtsSegmentCode } }

function normalizeInstrumentPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.instruments)) return payload.instruments;
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.items)) return payload.items;

  return [];
}

function setInstruments(payload) {
  rawInstruments = normalizeInstrumentPayload(payload);
  tokenSegmentMap = {};

  const segmentCount = {};
  const skippedSegments = {};
  const duplicateTokens = {};
  let missingToken = 0;

  rawInstruments.forEach(item => {
    const token = item.exchange_token?.toString();

    if (!token) {
      missingToken++;
      return;
    }

    let seg = (item.segment || "").trim().toUpperCase();

    if (seg === "MCX_FO") seg = "MCX";

    segmentCount[seg] = (segmentCount[seg] || 0) + 1;

    const xtsSegment = SEG_TO_XTS[seg];

    if (!xtsSegment) {
      skippedSegments[seg] = (skippedSegments[seg] || 0) + 1;
      return;
    }

    if (tokenSegmentMap[token]) {
      duplicateTokens[token] = (duplicateTokens[token] || 1) + 1;
    }

    tokenSegmentMap[token] = {
      xtsSegment,
      xtsSegmentCode: XTS_SEG_CODE[xtsSegment],
    };
  });

  console.log("\n========== Instrument Loader ==========");
  console.log("Total Instruments :", rawInstruments.length);
  console.log("Mapped Tokens     :", Object.keys(tokenSegmentMap).length);
  console.log("Missing Tokens    :", missingToken);

  console.log("\nSegments Found:");
  console.table(segmentCount);

  console.log("\nSkipped Segments:");
  console.table(skippedSegments);

  console.log("\nDuplicate Tokens :", Object.keys(duplicateTokens).length);

  if (Object.keys(duplicateTokens).length) {
    console.log("\nFirst 20 Duplicate Tokens:");
    console.log(Object.keys(duplicateTokens).slice(0, 20));
  }

  return rawInstruments.length;
}

// ============================================================
// Load
// ============================================================
async function loadInstruments(filePath) {
  const resolved = path.resolve(filePath);
  console.log(`📂 Loading instruments from: ${resolved}`);

  // ── File not found: try alternatives and list directory ──
  if (!fs.existsSync(resolved)) {
    const dir  = path.dirname(resolved);
    const base = path.basename(resolved);

    // Try common alternative paths automatically
    const alternatives = [
      resolved.replace(/\.gz$/i, ""),                          // completedata.json (no gz)
      resolved.endsWith(".gz") ? resolved : resolved + ".gz",  // add .gz if missing
      path.join(dir, "completedata.json"),
      path.join(dir, "completedata.json"),
      path.join(dir, "instrumentsdata.json"),
      path.join(dir, "instrumentsdata.json"),
    ].filter(p => p !== resolved);

    for (const alt of alternatives) {
      if (fs.existsSync(alt)) {
        console.warn(`⚠️  Original path not found. Using: ${alt}`);
        console.warn(`    Update INSTRUMENT_FILE=${alt} in your .env to silence this.`);
        return loadInstruments(alt);   // recurse with found path
      }
    }

    // Nothing found — list Downloads folder to help
    console.warn(`⚠️  Instrument file not found: ${resolved}`);
    if (fs.existsSync(dir)) {
      const all = fs.readdirSync(dir);
      const candidates = all.filter(f =>
        f.toLowerCase().includes("complete") ||
        f.toLowerCase().includes("instrument") ||
        f.endsWith(".gz") ||
        f.endsWith(".json")
      );
      if (candidates.length) {
        console.warn(`   Possible files in ${dir}:`);
        candidates.forEach(f => console.warn(`   →  ${path.join(dir, f)}`));
        console.warn(`   Set INSTRUMENT_FILE=<full path> in your .env`);
      } else {
        console.warn(`   No .json / .gz files found in: ${dir}`);
        console.warn(`   Download the instrument file from 5paisa and set INSTRUMENT_FILE= in .env`);
      }
    } else {
      console.warn(`   Directory does not exist: ${dir}`);
    }
    rawInstruments  = [];
    tokenSegmentMap = {};
    return;
  }

  try {
    const buffer = fs.readFileSync(resolved);

    let parsed;
    if (resolved.toLowerCase().endsWith(".gz")) {
      const decompressed = zlib.gunzipSync(buffer);
      parsed = JSON.parse(decompressed.toString("utf8"));
    } else {
      parsed = JSON.parse(buffer.toString("utf8"));
    }

    const count = setInstruments(parsed);
    console.log(`✅ Loaded ${rawInstruments.length.toLocaleString()} instruments`);
    console.log(`✅ Token-segment map: ${Object.keys(tokenSegmentMap).length.toLocaleString()} entries`);
  } catch (err) {
    console.error("❌ Failed to load instruments:", err.message);
    rawInstruments  = [];
    tokenSegmentMap = {};
  }
}

// ============================================================
// Getters
// ============================================================
function getInstruments()    { return rawInstruments; }
function getTokenSegmentMap(){ return tokenSegmentMap; }

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
  loadInstruments,
  normalizeInstrumentPayload,
  setInstruments,
  getInstruments,
  getTokenSegmentMap,
  getSegmentForToken,
  segmentToXTS,
  XTS_SEG_CODE,
};
