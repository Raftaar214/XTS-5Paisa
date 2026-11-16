// settings.js
//
// Live execution controls edited from the Admin console:
//   - tradingHalted : global kill switch — when true, /api/order refuses
//                     every execution before anything reaches the broker
//   - engine        : marketable-limit engine parameters (index.js)
//   - limits        : pre-trade risk limits (0 = no limit)
//
// Persisted to data/settings.json so they survive restarts. A brand-new
// install starts with trading HALTED: an admin must switch it on
// deliberately before the first live order can go out.

require("dotenv").config();
const fs   = require("fs");
const path = require("path");

const DATA_DIR  = process.env.XTS_DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "settings.json");

// [min, max] for every numeric field — anything outside is rejected.
const ENGINE_RANGES = {
  bufferPct:     [0, 5],
  fillTimeout:   [1, 60],
  maxRetries:    [0, 5],
  pollInterval:  [0.2, 5],
  cancelTimeout: [1, 30],
  retryDelay:    [0, 30],
  orderGapMs:    [50, 2000],
};
const LIMIT_RANGES = {
  maxLegs:            [1, 8],
  maxLotsPerLeg:      [0, 100000],
  maxQtyPerOrder:     [0, 10000000],
  maxOrderValue:      [0, 1e12],
  maxActiveClients:   [0, 1000],
  maxOrdersPerMinute: [0, 600],
};

// Instrument-master segments a dashboard may trade (Admin → Execution & Limits).
const ALL_SEGMENTS = ["NSE_FO", "BSE_FO", "MCX_FO", "NSE_EQ", "BSE_EQ", "NCD_FO", "BCD_FO"]; // NSE_COM: no XTS segment
const PRODUCT_TYPES = ["NRML", "MIS", "CNC"];

const DEFAULTS = {
  // PAPER: every order (manual and strategies) is simulated on the live feed.
  // LIVE:  manual orders go to the broker; strategies follow their own mode.
  tradingMode: "PAPER",
  tradingHalted: true,
  haltReason: "New install — enable trading from the Admin console when ready.",
  engine: {
    bufferPct: 0.5,
    fillTimeout: 4,
    maxRetries: 1,
    pollInterval: 0.5,
    cancelTimeout: 5,
    retryDelay: 2,
    orderGapMs: 110,   // ≈ 9 orders/s per client — under the broker limit of 10/s
  },
  allowedSegments: ["NSE_FO", "BSE_FO", "MCX_FO"],
  products: { NSE_EQ: "CNC", BSE_EQ: "CNC", default: "NRML" },
  // How many lots each client trades for one lot of a leg:
  //   multiplier — the client's Multiplier × (parent 1x)
  //   capital    — client capital ÷ baseCapital (e.g. ₹2 Cr ÷ ₹1 Cr = 2 lots)
  // Fractions are rounded (floor = never more than the ratio allows).
  sizing: { mode: "multiplier", baseCapital: 10000000, rounding: "floor" },
  limits: {
    maxLegs: 8,
    maxLotsPerLeg: 0,
    maxQtyPerOrder: 0,
    maxOrderValue: 0,
    maxActiveClients: 0,
    maxOrdersPerMinute: 60,
  },
};

let settings = clone(DEFAULTS);

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      settings = {
        tradingMode:   raw.tradingMode === "LIVE" ? "LIVE" : "PAPER",
        tradingHalted: raw.tradingHalted !== undefined ? Boolean(raw.tradingHalted) : DEFAULTS.tradingHalted,
        allowedSegments: Array.isArray(raw.allowedSegments) ? raw.allowedSegments.filter(x => ALL_SEGMENTS.includes(x)) : [...DEFAULTS.allowedSegments],
        products: { ...DEFAULTS.products, ...(raw.products || {}) },
        sizing: { ...DEFAULTS.sizing, ...(raw.sizing || {}) },
        haltReason:    String(raw.haltReason || ""),
        engine: { ...DEFAULTS.engine, ...(raw.engine || {}) },
        limits: { ...DEFAULTS.limits, ...(raw.limits || {}) },
      };
      return;
    }
  } catch (err) {
    console.error("⚠️  Could not read data/settings.json — using safe defaults (trading halted):", err.message);
    settings = clone(DEFAULTS);
    return;
  }
  settings = clone(DEFAULTS);
  persist();
}

function persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("⚠️  Could not write data/settings.json:", err.message);
  }
}

function fail(message) { return Object.assign(new Error(message), { status: 400 }); }

function validateGroup(input, ranges, label) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!(key in ranges)) throw fail(`Unknown ${label} setting "${key}"`);
    const n = Number(value);
    const [min, max] = ranges[key];
    if (!Number.isFinite(n) || n < min || n > max) {
      throw fail(`${label}.${key} must be a number between ${min} and ${max}`);
    }
    out[key] = ["maxRetries", "maxLegs", "maxActiveClients", "maxOrdersPerMinute", "orderGapMs"].includes(key) ? Math.round(n) : n;
  }
  return out;
}

function getSettings() { return clone(settings); }

// Partial update: { tradingHalted?, haltReason?, engine?: {...}, limits?: {...} }
function updateSettings(patch = {}) {
  const engine = validateGroup(patch.engine, ENGINE_RANGES, "engine");
  const limits = validateGroup(patch.limits, LIMIT_RANGES, "limits");

  const next = clone(settings);
  if (patch.tradingMode !== undefined) {
    if (!["PAPER", "LIVE"].includes(patch.tradingMode)) throw fail("tradingMode must be PAPER or LIVE");
    next.tradingMode = patch.tradingMode;
  }
  if (patch.allowedSegments !== undefined) {
    if (!Array.isArray(patch.allowedSegments) || patch.allowedSegments.some(x => !ALL_SEGMENTS.includes(x))) {
      throw fail(`allowedSegments must be a list from: ${ALL_SEGMENTS.join(", ")}`);
    }
    next.allowedSegments = [...new Set(patch.allowedSegments)];
  }
  if (patch.products !== undefined) {
    for (const [seg, p] of Object.entries(patch.products || {})) {
      if (seg !== "default" && !ALL_SEGMENTS.includes(seg)) throw fail(`Unknown segment "${seg}"`);
      if (!PRODUCT_TYPES.includes(p)) throw fail(`Product type must be one of ${PRODUCT_TYPES.join(", ")}`);
    }
    next.products = { ...next.products, ...patch.products };
  }
  if (patch.sizing !== undefined) {
    const z = { ...next.sizing, ...(patch.sizing || {}) };
    if (!["multiplier", "capital"].includes(z.mode)) throw fail("sizing.mode must be multiplier or capital");
    if (!["floor", "round"].includes(z.rounding)) throw fail("sizing.rounding must be floor or round");
    z.baseCapital = Number(z.baseCapital);
    if (!(z.baseCapital >= 10000 && z.baseCapital <= 1e12)) throw fail("sizing.baseCapital must be between ₹10,000 and ₹1,00,000 Cr");
    next.sizing = z;
  }
  if (patch.tradingHalted !== undefined) {
    next.tradingHalted = Boolean(patch.tradingHalted);
    next.haltReason = next.tradingHalted ? String(patch.haltReason || "Halted by admin").slice(0, 200) : "";
  }
  Object.assign(next.engine, engine);
  Object.assign(next.limits, limits);

  settings = next;
  persist();
  return getSettings();
}

load();

module.exports = { getSettings, updateSettings, DEFAULTS, ENGINE_RANGES, LIMIT_RANGES, ALL_SEGMENTS, PRODUCT_TYPES };
