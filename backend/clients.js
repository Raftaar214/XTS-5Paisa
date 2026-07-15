// clients.js
//
// Holds the live roster of XTS/5paisa clients this dashboard trades through:
//   - exactly ONE "PARENT" client   (Interactive API + Market Data API — both mandatory)
//   - any number of "CHILD" clients (Interactive API only, order size scaled by `multiplier`)
//
// The roster is persisted to data/clients.json so it survives restarts and
// can be edited live from the "User Management" panel in the dashboard.
// On the very first run (no data/clients.json yet) it bootstraps itself from
// the CLI1_*, CLI2_*... and MARKET_* variables in .env, so the existing
// setup keeps working with zero manual migration.

require("dotenv").config();
const fs   = require("fs");
const path = require("path");

const DATA_DIR  = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "clients.json");
const DEFAULT_ROOT_URL = process.env.XTS_INTERACTIVE_URL || "https://xtsmum.5paisa.com";

const clients = []; // shared array reference — always mutated in place, never reassigned

// ─────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function persist() {
  ensureDataDir();
  const serializable = clients.map(c => ({
    id:                c.id,
    name:              c.name,
    role:              c.role,
    multiplier:        c.multiplier,
    rootUrl:           c.rootUrl,
    source:            c.source,
    assignedTo:        c.assignedTo || "",
    interactiveKey:    c.interactiveKey,
    interactiveSecret: c.interactiveSecret,
    marketKey:         c.marketKey    || "",
    marketSecret:      c.marketSecret || "",
    enabled:           c.enabled,
  }));
  fs.writeFileSync(DATA_FILE, JSON.stringify(serializable, null, 2));
}

function persistQuiet() {
  try { persist(); } catch (e) { console.error("⚠️  Could not write data/clients.json:", e.message); }
}

function replaceAll(list) {
  clients.length = 0;
  list.forEach(c => clients.push(c));
}

function runtimeShape(c) {
  return { ...c, isLogged: false, isConnected: false, token: null, userID: null };
}

// ─────────────────────────────────────────────────────────────
// First-run bootstrap from legacy .env (CLI1_*, CLI2_*, ... MARKET_*)
// First client found becomes the PARENT (matches the existing .env you had:
// CLI1 = ABHISHEK KHANDAL, plus MARKET_APP_KEY/MARKET_SECRET_KEY).
// ─────────────────────────────────────────────────────────────
function bootstrapFromEnv() {
  const list = [];
  for (let i = 1; i <= 10; i++) {
    const id = process.env[`CLI${i}_ID`];
    if (!id) continue;
    const isFirst = list.length === 0;
    list.push({
      id,
      name:              process.env[`CLI${i}_NAME`] || `Client ${i}`,
      role:              isFirst ? "PARENT" : "CHILD",
      multiplier:        1,
      rootUrl:           DEFAULT_ROOT_URL,
      source:            process.env[`CLI${i}_SOURCE`] || process.env.XTS_SOURCE || "WEBAPI",
      assignedTo:        "",
      interactiveKey:    process.env[`CLI${i}_INTERACTIVE_KEY`]    || "",
      interactiveSecret: process.env[`CLI${i}_INTERACTIVE_SECRET`] || "",
      marketKey:         isFirst ? (process.env.MARKET_APP_KEY    || "") : "",
      marketSecret:      isFirst ? (process.env.MARKET_SECRET_KEY || "") : "",
      enabled: true,
    });
  }
  if (!list.length) {
    list.push({
      id: "CLI-001", name: "Client 1", role: "PARENT", multiplier: 1,
      rootUrl: DEFAULT_ROOT_URL, source: process.env.XTS_SOURCE || "WEBAPI",
      assignedTo: "",
      interactiveKey: "", interactiveSecret: "",
      marketKey: process.env.MARKET_APP_KEY || "", marketSecret: process.env.MARKET_SECRET_KEY || "",
      enabled: true,
    });
  }
  return list;
}

function load() {
  ensureDataDir();
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (Array.isArray(raw) && raw.length) {
        replaceAll(raw.map(runtimeShape));
        console.log(`✅ Loaded ${clients.length} client(s) from data/clients.json`);
        return;
      }
    } catch (err) {
      console.error("❌ Failed to read data/clients.json — falling back to .env bootstrap:", err.message);
    }
  }
  replaceAll(bootstrapFromEnv().map(runtimeShape));
  persistQuiet();
  console.log(`✅ Bootstrapped ${clients.length} client(s) from .env → data/clients.json`);
}

load();

async function initClients() {
  console.log(`✅ ${clients.length} client(s) configured: ${clients.map(c => `${c.id}(${c.role}${c.role === "CHILD" ? ` ${c.multiplier}x` : ""})`).join(", ")}`);
}

// ─────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────
function getParent() { return clients.find(c => c.role === "PARENT") || null; }
function hasParent()  { return !!getParent(); }

// Snapshot sent to the main dashboard (GET /api/clients) — SAME shape as
// before this feature existed, so the existing dashboard UI is untouched.
function clientSnapshot(c) {
  return {
    id:          c.id,
    name:        c.name,
    enabled:     c.enabled,
    isLogged:    c.isLogged,
    isConnected: c.isConnected,
  };
}

function mask(v) {
  if (!v) return "";
  if (v.length <= 4) return "••••";
  return v.slice(0, 2) + "••••" + v.slice(-2);
}

// Fuller snapshot for the User Management panel — secrets are always
// masked; real values are never sent back down once saved.
function clientManagementView(c) {
  return {
    id: c.id, name: c.name, role: c.role, multiplier: c.multiplier,
    rootUrl: c.rootUrl, source: c.source, assignedTo: c.assignedTo || "",
    enabled: c.enabled, isLogged: c.isLogged, isConnected: c.isConnected,
    interactiveKeyMasked:    mask(c.interactiveKey),
    interactiveSecretMasked: mask(c.interactiveSecret),
    marketKeyMasked:         mask(c.marketKey),
    marketSecretMasked:      mask(c.marketSecret),
    hasInteractiveCreds: !!(c.interactiveKey && c.interactiveSecret),
    hasMarketCreds:      !!(c.marketKey && c.marketSecret),
  };
}

// Clients a given dashboard login is allowed to see/operate on: their own
// assigned clients, plus any client nobody has assigned yet (unassigned =
// shared/visible to everyone — this is also what keeps every client you
// already had before this feature existed visible to both logins).
function visibleTo(username) {
  return clients.filter(c => !c.assignedTo || c.assignedTo === username);
}
function isVisibleTo(client, username) {
  return !client.assignedTo || client.assignedTo === username;
}

// ─────────────────────────────────────────────────────────────
// CRUD (used by the User Management panel)
// ─────────────────────────────────────────────────────────────
function fail(status, message) { return Object.assign(new Error(message), { status }); }

function addClient(input = {}) {
  const role = String(input.role || "CHILD").toUpperCase();
  const id   = String(input.id || "").trim();
  const name = String(input.name || "").trim();

  if (!id)   throw fail(400, "Client ID is required");
  if (!name) throw fail(400, "Client Name is required");
  if (clients.some(c => c.id === id)) throw fail(409, `Client ID "${id}" already exists`);
  if (role !== "PARENT" && role !== "CHILD") throw fail(400, "Role must be Parent or Child");

  const rootUrl = String(input.rootUrl || "").trim() || getParent()?.rootUrl || DEFAULT_ROOT_URL;
  const interactiveKey    = String(input.interactiveKey    || "").trim();
  const interactiveSecret = String(input.interactiveSecret || "").trim();
  const source = String(input.source || process.env.XTS_SOURCE || "WEBAPI").toUpperCase();

  if (role === "PARENT") {
    if (hasParent()) throw fail(409, "A parent client already exists. Only one parent is allowed — add this as a Child instead.");
    const marketKey    = String(input.marketKey    || "").trim();
    const marketSecret = String(input.marketSecret || "").trim();
    if (!interactiveKey || !interactiveSecret) throw fail(400, "Parent requires Interactive API Key and Secret");
    if (!marketKey || !marketSecret)           throw fail(400, "Parent requires Market Data API Key and Secret");
    if (!rootUrl)                              throw fail(400, "Parent requires a Root URL");

    const client = runtimeShape({
      id, name, role, multiplier: 1, rootUrl, source,
      assignedTo: String(input.assignedTo || "").trim(),
      interactiveKey, interactiveSecret, marketKey, marketSecret,
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : true,
    });
    clients.push(client);
    persist();
    return client;
  }

  // CHILD
  if (!interactiveKey || !interactiveSecret) throw fail(400, "Child requires Interactive API Key and Secret");
  const multiplier = Number(input.multiplier);
  const client = runtimeShape({
    id, name, role: "CHILD",
    multiplier: multiplier > 0 ? multiplier : 1,
    rootUrl, source,
    assignedTo: String(input.assignedTo || "").trim(),
    interactiveKey, interactiveSecret, marketKey: "", marketSecret: "",
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : true,
  });
  clients.push(client);
  persist();
  return client;
}

function updateClient(id, input = {}) {
  const c = clients.find(x => x.id === id);
  if (!c) throw fail(404, "Client not found");

  if (input.role) {
    const newRole = String(input.role).toUpperCase();
    if (newRole === "PARENT" && c.role !== "PARENT" && hasParent()) {
      throw fail(409, "A parent client already exists.");
    }
    if (newRole !== "PARENT" && newRole !== "CHILD") throw fail(400, "Role must be Parent or Child");
    c.role = newRole;
  }

  if (input.name    !== undefined) c.name    = String(input.name).trim() || c.name;
  if (input.rootUrl !== undefined) c.rootUrl = String(input.rootUrl).trim() || c.rootUrl;
  if (input.source  !== undefined) c.source  = String(input.source).toUpperCase();
  if (input.enabled !== undefined) c.enabled = Boolean(input.enabled);
  if (input.assignedTo !== undefined) c.assignedTo = String(input.assignedTo).trim();

  if (c.role === "CHILD") {
    if (input.multiplier !== undefined) {
      const m = Number(input.multiplier);
      c.multiplier = m > 0 ? m : 1;
    }
    c.marketKey = ""; c.marketSecret = ""; // children never carry market data creds
  } else {
    c.multiplier = 1;
  }

  // Secrets: only overwrite when a non-empty value is actually supplied —
  // a blank field in the edit form means "keep the existing value".
  if (input.interactiveKey)    c.interactiveKey    = String(input.interactiveKey).trim();
  if (input.interactiveSecret) c.interactiveSecret = String(input.interactiveSecret).trim();
  if (c.role === "PARENT") {
    if (input.marketKey)    c.marketKey    = String(input.marketKey).trim();
    if (input.marketSecret) c.marketSecret = String(input.marketSecret).trim();
  }

  if (!c.interactiveKey || !c.interactiveSecret) throw fail(400, "Interactive API Key and Secret are required");
  if (c.role === "PARENT" && (!c.marketKey || !c.marketSecret || !c.rootUrl)) {
    throw fail(400, "Parent requires Root URL, Market Data API Key and Secret");
  }

  persist();
  return c;
}

function removeClient(id) {
  const idx = clients.findIndex(x => x.id === id);
  if (idx === -1) throw fail(404, "Client not found");
  const [removed] = clients.splice(idx, 1);
  persist();
  return removed;
}

module.exports = {
  clients, initClients, clientSnapshot, clientManagementView,
  getParent, hasParent, addClient, updateClient, removeClient,
  visibleTo, isVisibleTo,
};