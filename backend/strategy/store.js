// strategy/store.js — strategy library, user assignments and run state.
//
//   data/strategies.json              uploaded strategy files (raw + name)
//   data/assignments.json             which dashboard user runs which strategy
//   data/strategy-runs/<id>.json      live state of one assignment (status,
//                                     open positions, slots done today…)
//
// Every write is atomic (temp file + rename), so a crash never leaves a
// half-written file behind.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { writeJsonAtomic, readJson, ensureDir } = require("../fsutil");
const { parseStrategyFile } = require("./parser");

const DATA_DIR = process.env.XTS_DATA_DIR || path.join(__dirname, "..", "data");
const STRATEGIES_FILE  = path.join(DATA_DIR, "strategies.json");
const ASSIGNMENTS_FILE = path.join(DATA_DIR, "assignments.json");
const RUNS_DIR         = path.join(DATA_DIR, "strategy-runs");

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const newId = prefix => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;

// ── Strategies ───────────────────────────────────────────────
let strategies = [];

function loadStrategies() {
  const raw = readJson(STRATEGIES_FILE, []);
  strategies = (Array.isArray(raw) ? raw : []).map(s => {
    const parsed = parseStrategyFile(s.raw);
    return { ...s, spec: parsed.spec, warnings: parsed.warnings, errors: parsed.errors };
  });
}

function saveStrategies() {
  writeJsonAtomic(STRATEGIES_FILE, strategies.map(({ id, name, fileName, uploadedAt, uploadedBy, raw }) =>
    ({ id, name, fileName, uploadedAt, uploadedBy, raw })));
}

function listStrategies() { return strategies; }
function getStrategy(id) { return strategies.find(s => s.id === id) || null; }

function addStrategy({ fileName, raw, by }) {
  const parsed = parseStrategyFile(raw);
  if (!parsed.ok) throw fail(400, `${fileName || "File"}: ${parsed.errors.join("; ")}`, { errors: parsed.errors });
  const s = {
    id: newId("stg"),
    name: parsed.spec.name,
    fileName: String(fileName || "").slice(0, 120),
    uploadedAt: new Date().toISOString(),
    uploadedBy: by || "",
    raw,
    spec: parsed.spec,
    warnings: parsed.warnings,
    errors: [],
  };
  strategies.push(s);
  saveStrategies();
  return s;
}

function removeStrategy(id) {
  const s = getStrategy(id);
  if (!s) throw fail(404, "Strategy not found");
  const used = assignments.filter(a => a.strategyId === id);
  if (used.length) throw fail(409, `Strategy is assigned to ${used.map(a => a.username).join(", ")} — remove those assignments first`);
  strategies = strategies.filter(x => x.id !== id);
  saveStrategies();
  return s;
}

// ── Assignments ──────────────────────────────────────────────
let assignments = [];

function loadAssignments() {
  const raw = readJson(ASSIGNMENTS_FILE, []);
  assignments = Array.isArray(raw) ? raw : [];
}
function saveAssignments() { writeJsonAtomic(ASSIGNMENTS_FILE, assignments); }

function listAssignments() { return assignments; }
function getAssignment(id) { return assignments.find(a => a.id === id) || null; }

// `validate(assignment, strategy)` lets the server check usernames/clients.
function normalizeAssignment(input, existing = {}) {
  const a = { ...existing };
  if (input.strategyId !== undefined) a.strategyId = String(input.strategyId);
  if (input.username   !== undefined) a.username   = String(input.username).trim();
  if (input.clientIds  !== undefined) a.clientIds  = Array.isArray(input.clientIds) ? input.clientIds.map(String) : [];
  if (input.capital    !== undefined) a.capital    = input.capital === null || input.capital === "" ? null : Number(input.capital);
  if (input.mode       !== undefined) a.mode       = String(input.mode).toUpperCase();
  if (input.enabled    !== undefined) a.enabled    = Boolean(input.enabled);
  if (input.note       !== undefined) a.note       = String(input.note).slice(0, 200);
  // Capital allocated to this strategy per client (₹). Lots for a client =
  // strategy lots × allocation ÷ the assignment's capital. Unset → the
  // client's normal sizing.
  if (input.allocations !== undefined) {
    const out = {};
    for (const [id, v] of Object.entries(input.allocations || {})) {
      if (v === null || v === "") continue;
      const n = Number(v);
      if (!(n >= 0)) throw fail(400, `Allocation for ${id} must be an amount in ₹`);
      out[String(id)] = n;
    }
    a.allocations = out;
  }
  a.clientIds = a.clientIds || [];
  a.mode = a.mode || "PAPER";
  if (a.enabled === undefined) a.enabled = true;
  return a;
}

function checkAssignment(a, validate) {
  const s = getStrategy(a.strategyId);
  if (!s) throw fail(400, "Unknown strategy");
  if (!a.username) throw fail(400, "Choose the dashboard user who runs this strategy");
  if (!["PAPER", "LIVE"].includes(a.mode)) throw fail(400, "Mode must be PAPER or LIVE");
  if (a.capital !== null && a.capital !== undefined && !(a.capital > 0)) throw fail(400, "Capital must be above 0");
  if (s.spec?.dailyLossPct && !(a.capital > 0)) {
    throw fail(400, `This strategy has a ${s.spec.dailyLossPct}% daily loss limit — enter the capital (₹, at 1x) it is measured against`);
  }
  if (Object.keys(a.allocations || {}).length && !(a.capital > 0)) {
    throw fail(400, "Set the strategy capital (₹ at 1x) to use per-client allocations");
  }
  if (validate) validate(a, s);
}

function addAssignment(input, validate) {
  const a = normalizeAssignment(input, { id: newId("asg"), createdAt: new Date().toISOString() });
  checkAssignment(a, validate);
  a.updatedAt = a.createdAt;
  assignments.push(a);
  saveAssignments();
  return a;
}

function updateAssignment(id, input, validate) {
  const current = getAssignment(id);
  if (!current) throw fail(404, "Assignment not found");
  const next = normalizeAssignment(input, current);
  checkAssignment(next, validate);
  next.updatedAt = new Date().toISOString();
  Object.assign(current, next);
  saveAssignments();
  return current;
}

function removeAssignment(id) {
  const a = getAssignment(id);
  if (!a) throw fail(404, "Assignment not found");
  const run = loadRun(id);
  if (run && run.status !== "STOPPED") throw fail(409, "Stop this strategy (and close its positions) before removing it");
  if (run && run.positions.some(p => p.status === "OPEN" || p.status === "CHECK")) {
    throw fail(409, "This assignment still has open positions");
  }
  assignments = assignments.filter(x => x.id !== id);
  saveAssignments();
  try { fs.unlinkSync(path.join(RUNS_DIR, `${id}.json`)); } catch (_) {}
  runs.delete(id);
  return a;
}

// ── Run state ────────────────────────────────────────────────
const runs = new Map();

function emptyRun(id) {
  return {
    assignmentId: id,
    status: "STOPPED",      // STOPPED | RUNNING | STOPPING | PAUSED
    pausedReason: "",
    pausedFrom: null,
    startedAt: null, startedBy: null, stoppedAt: null,
    day: null,              // IST day the per-day fields belong to
    slotsDone: [],          // "SYMBOL|group|HH:MM" handled today
    haltedClients: [],      // clients that hit the daily loss limit today
    positions: [],
    updatedAt: null,
  };
}

function loadRun(id) {
  if (runs.has(id)) return runs.get(id);
  const r = readJson(path.join(RUNS_DIR, `${id}.json`), null);
  const run = r ? { ...emptyRun(id), ...r } : emptyRun(id);
  runs.set(id, run);
  return run;
}

function saveRun(run) {
  run.updatedAt = new Date().toISOString();
  ensureDir(RUNS_DIR);
  writeJsonAtomic(path.join(RUNS_DIR, `${run.assignmentId}.json`), run);
}

loadStrategies();
loadAssignments();

module.exports = {
  listStrategies, getStrategy, addStrategy, removeStrategy,
  listAssignments, getAssignment, addAssignment, updateAssignment, removeAssignment,
  loadRun, saveRun, newId,
};
