require("dotenv").config();
const path      = require("path");
const fs        = require("fs");
const express   = require("express");
const cors      = require("cors");
const WebSocket = require("ws");

const {
  clients, initClients, clientSnapshot, clientManagementView,
  addClient, updateClient, removeClient,
  visibleTo, isVisibleTo,
} = require("./clients");
const {
  refreshInstruments, getDashboardInstruments, getInstrumentStatus, setInstruments,
} = require("./instrumentloader");
const { loginClient, logoutClient, getOrders, getTrades, getPositions, connectOrderStream, disconnectOrderStream, getBalance } = require("./xtsApi");
const {
  loginMarketData, connectMarketSocket, subscribeTokens, unsubscribeTokens, tokensOwnedBy,
  onPriceUpdate, getLivePrices, getMarketStatus,
} = require("./Marketsocket");
const { executeOrderMulti } = require("./index");
const auth     = require("./auth");
const settings = require("./settings");
const monitor  = require("./monitor");
const journal  = require("./journal");
const tradebooks = require("./tradebooks");
const strategyStore = require("./strategy/store");
const { createRunner } = require("./strategy/runner");
const { onOrderGuardTrip } = require("./orderGuard");

const app     = express();
const PORT    = parseInt(process.env.PORT    || "5000");
const WS_PORT = parseInt(process.env.WS_PORT || "3002");

// CORS — only known browser origins may call the API.
// CORS_ORIGINS=https://desk.example.com,https://other.example.com
// When unset, localhost and private-LAN addresses are allowed (dev / office
// network), and so is the server's own address — a dashboard opened at
// http://<server-ip>:<port> served by this backend. Set CORS_ORIGINS
// explicitly for any internet-facing deployment.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

const hostnameOf = hostHeader => String(hostHeader || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();

// hostHeader: the Host the request was sent to. A page from this same host
// (any port — the API and dashboard share one) is always allowed.
function isAllowedOrigin(origin, hostHeader) {
  if (!origin) return true; // non-browser clients (curl, server-to-server) and same-origin GETs
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostHeader && host === hostnameOf(hostHeader)) return true;
    return PRIVATE_HOST.test(host);
  } catch { return false; }
}
if (!ALLOWED_ORIGINS.length) {
  console.warn("Warning: CORS_ORIGINS not set — allowing localhost / private-LAN origins only. Set it before exposing this server publicly.");
}

app.use((req, res, next) => {
  if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: `Origin ${req.headers.origin} is not allowed` });
  }
  next();
});
// The 403 check above already ran for this request with its Host, so any origin reaching here is allowed.
app.use(cors({ origin: (origin, cb) => cb(null, true) }));

// Large bodies only for the instrument upload; everything else stays small.
const smallJson = express.json({ limit: "1mb" });
const largeJson = express.json({ limit: "200mb" });
app.use((req, res, next) =>
  (req.method === "POST" && req.path === "/api/instruments" ? largeJson : smallJson)(req, res, next));

// Login gates
// Public:  POST /api/auth/login,  GET /api/auth/verify
//          POST /api/admin/login, GET /api/admin/verify
// /api/admin/*  requires an ADMIN token (Admin console, Ctrl+Shift+Space)
// /api/*        requires a dashboard USER token
app.post("/api/auth/login",  auth.login);
app.get("/api/auth/verify",  auth.verify);
app.post("/api/auth/logout", auth.logout);
app.post("/api/admin/login", auth.adminLogin);
app.get("/api/admin/verify", auth.adminVerify);

// WebSocket — broadcasts bid/ask quotes to logged-in dashboards.
// Runs on the API port at /ws:  ws://<host>:<PORT>/ws?token=<dashboard token>
// (startWS(<number>) still opens a standalone port — used by tests.)
const quoteServers = new Set();
let wss = null; // the main one (for the monitor's socket count)
let broadcasting = false;
let sessionWatch = false;

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const s of quoteServers) {
    s.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch (_) {} }
    });
  }
}

function tokenFromWsRequest(req) {
  try { return new URL(req.url, "http://localhost").searchParams.get("token"); } catch { return null; }
}

function startWS(target = WS_PORT) {
  const attach = typeof target === "object" && target !== null;
  const server = new WebSocket.Server({
    ...(attach ? { server: target, path: "/ws" } : { port: target }),
    verifyClient: (info, done) => {
      if (!isAllowedOrigin(info.origin, info.req.headers.host)) return done(false, 403, "Origin not allowed");
      const user = auth.verifyUserToken(tokenFromWsRequest(info.req));
      if (!user) return done(false, 401, "Unauthorized");
      info.req.user = user;
      done(true);
    },
  });
  quoteServers.add(server);
  if (!wss) wss = server;
  console.log(attach ? "Quote WebSocket on /ws (same port as the API)" : `Quote WebSocket on port ${target}`);

  if (!sessionWatch) {
    sessionWatch = true;
    // An ended session (logout, replaced by a new login, ended by admin) loses its price stream at once.
    auth.onSessionEnded(({ username, sid, reason }) => {
      for (const srv of quoteServers) srv.clients.forEach(ws => { if (ws.user?.sid === sid) ws.close(4401, reason); });
      // ...and the leg tokens that user's dashboard had subscribed.
      const owner = `ui:${username}`;
      const held = tokensOwnedBy(owner);
      if (held.length) unsubscribeTokens(held, owner).catch(() => {});
    });
  }

  server.on("connection", (ws, req) => {
    ws.user = req.user;
    console.log(`Frontend connected (${ws.user.username})`);
    const quotes = getLivePrices();
    if (Object.keys(quotes).length > 0) {
      ws.send(JSON.stringify({ type: "quotes", data: quotes }));
    }
    ws.on("close", ()  => console.log(`Frontend disconnected (${ws.user.username})`));
    ws.on("error", err => console.error("WS client error:", err.message));
  });

  if (!broadcasting) {
    broadcasting = true;
    onPriceUpdate(quotes => broadcast({ type: "quote", data: quotes }));
  }

  // Keep-alive, and drop sockets whose dashboard session has expired.
  const keepAlive = setInterval(() => {
    server.clients.forEach(ws => {
      if (ws.user?.exp && Date.now() > ws.user.exp) return ws.close(4401, "Session expired");
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    });
  }, 30_000);
  server.on("close", () => {
    clearInterval(keepAlive);
    quoteServers.delete(server);
    if (wss === server) wss = null;
  });

  return server;
}

// Market data bootstrap — credentials come from the PARENT client.
// Re-run whenever the Parent is added/edited in the Admin console.
async function bootMarketData() {
  console.log("\nMarket Data");
  try {
    const mdToken = await loginMarketData();
    if (mdToken) {
      connectMarketSocket();
    } else {
      console.warn("Bid/Ask will show '—' — add a Parent client with Market Data API Key/Secret in the Admin console.\n");
    }
  } catch (err) {
    console.warn("Market data login error:", err.message);
  }
  console.log("");
}

// Broker session helpers (shared by dashboard and admin routes)
function brokerError(err) {
  const body = err.response?.data;
  return body?.description || body?.error || err.message || "Login failed";
}

async function brokerLogin(c) {
  const r = await loginClient(c);
  c.token = r.token; c.userID = r.userID; c.isLogged = true;
  console.log(`${c.id} logged in — userID: ${c.userID}`);
  // Pushed order updates for instant fill detection (receive-only socket).
  if (typeof connectOrderStream === "function") {
    try { connectOrderStream(c); } catch (err) { console.warn(`Order stream ${c.id}: ${err.message}`); }
  }
}

async function brokerLogout(c) {
  if (typeof disconnectOrderStream === "function") {
    try { disconnectOrderStream(c); } catch (_) {}
  }
  if (c.isLogged) await logoutClient(c);
  c.isLogged = false; c.isConnected = false; c.token = null; c.userID = null;
}

function findClient(id) { return clients.find(x => x.id === id); }

// Automated strategies
const MARKET_STALE_MS = 120_000;

function engineConfig() {
  const s = settings.getSettings();
  return { ...s.engine, products: s.products, sizingRounding: s.sizing?.rounding, limits: { maxQtyPerOrder: s.limits.maxQtyPerOrder, maxOrderValue: s.limits.maxOrderValue } };
}

// Lots per client for one lot of a leg (Admin -> Execution & Limits -> Sizing):
//   multiplier — the client's Multiplier × (parent 1x)
//   capital    — client capital / base capital (0 when the client has no capital set)
function sizingFactor(c) {
  const z = settings.getSettings().sizing || {};
  if (z.mode === "capital") return c.capital > 0 && z.baseCapital > 0 ? c.capital / z.baseCapital : 0;
  return Number(c.multiplier) > 0 ? Number(c.multiplier) : 1;
}

// Clients a strategy assignment trades: the user's clients, optionally narrowed by the admin.
function clientsForAssignment(a) {
  return visibleTo(a.username).filter(c => !a.clientIds?.length || a.clientIds.includes(c.id));
}

// PAPER orders: same engine, simulated broker filling against the live feed.
const { createPaperBroker } = require("./paperBroker");
const paperBroker = createPaperBroker({ getQuotes: getLivePrices });

const runner = createRunner({
  store: strategyStore,
  journal,
  getInstruments: getDashboardInstruments,
  getQuotes: getLivePrices,
  subscribe: (tokens, segments, owner) => subscribeTokens(tokens, segments, owner),
  unsubscribe: (tokens, owner) => unsubscribeTokens(tokens, owner),
  clientsFor: clientsForAssignment,
  executeLegs: async (legs, cls, label) => {
    const results = await executeOrderMulti(legs, cls, { ...engineConfig(), startedAt: Date.now() });
    monitor.recordExecution(`strategy: ${label}`, results);
    return results;
  },
  executePaperLegs: async (legs, cls, label) => {
    const results = await executeOrderMulti(legs, cls, { ...engineConfig(), startedAt: Date.now(), getQuotes: getLivePrices }, paperBroker.api);
    monitor.recordExecution(`paper: ${label}`, results);
    return results;
  },
  getSettings: settings.getSettings,
  clientFactor: sizingFactor,
  marketHealthy: () => {
    const m = getMarketStatus();
    return m.loggedIn && m.socketConnected && m.lastTickAgeMs != null && m.lastTickAgeMs < MARKET_STALE_MS;
  },
});

// The order breaker pauses any strategy using the client that tripped it.
onOrderGuardTrip((clientId, msg) => {
  runner.pauseForClient(clientId, msg);
  monitor.recordAudit("system", "Order rate breaker tripped", msg);
});

// The runner ticks every 250 ms, and also as soon as a price changes (at
// most every 50 ms) so a stop is acted on the moment the quote crosses it.
// Ticks never overlap; a request during a tick runs right after it.
const RUNNER_TICK_MS = 250;
function startRunnerLoop() {
  let ticking = false, again = false, lastTick = 0;
  const run = async () => {
    if (ticking) { again = true; return; }
    ticking = true;
    lastTick = Date.now();
    try { await runner.tick(); }
    catch (err) { console.error("Strategy runner tick failed:", err.message); }
    finally {
      ticking = false;
      if (again) { again = false; setImmediate(run); }
    }
  };
  setInterval(run, RUNNER_TICK_MS);
  onPriceUpdate(() => { if (Date.now() - lastTick >= 50) run(); });
}

function strategySummary(s) {
  const spec = s.spec;
  if (!spec) return null;
  return {
    symbols: spec.symbols.map(x => x.underlying),
    entryDte: spec.entryDte,
    expiry: spec.expiryWhich,
    stop: spec.stop.mode === "per_leg" ? `${spec.stop.multiplier}x per leg` : "none",
    dailyLossPct: spec.dailyLossPct,
    exit: spec.exit.intradayAt ? `square off ${spec.exit.intradayAt}` : "hold to expiry",
    groups: spec.groups.map(g => ({
      id: g.id,
      window: g.slots.length ? `${g.slots[0]}-${g.slots[g.slots.length - 1]}` : "",
      entries: g.slots.length,
      legs: g.legs.map(l => `${l.action} ${l.lots}L ${l.type} ${l.strike.rule === "delta" ? `delta ${l.strike.delta}` : l.strike.rule === "premium" ? `₹${l.strike.premium}` : `ATM${l.strike.n >= 0 ? "+" : ""}${l.strike.n}`}`),
    })),
  };
}

function strategyView(s) {
  return {
    id: s.id, name: s.name, fileName: s.fileName, uploadedAt: s.uploadedAt, uploadedBy: s.uploadedBy,
    tags: s.spec?.tags || [], warnings: s.warnings || [], errors: s.errors || [],
    summary: strategySummary(s),
    assignedTo: strategyStore.listAssignments().filter(a => a.strategyId === s.id).map(a => a.username),
  };
}

function validateAssignment(a) {
  if (!auth.listUsernames().includes(a.username)) {
    throw Object.assign(new Error(`"${a.username}" is not a dashboard user`), { status: 400 });
  }
  const mine = visibleTo(a.username).map(c => c.id);
  const bad = [...(a.clientIds || []), ...Object.keys(a.allocations || {})].filter(id => !mine.includes(id));
  if (bad.length) {
    throw Object.assign(new Error(`${bad.join(", ")} not visible to ${a.username} — assign those clients to them first`), { status: 400 });
  }
}

// journal helpers (trade book + activity log)
const todayIst = () => require("./strategy/ist").parts(Date.now()).date;

// daily broker trade book copies
// Read-only: getTrades is a GET of the broker's trade book; nothing is placed.
async function snapshotTradeBook(c) {
  const trades = await getTrades(c);
  if (!Array.isArray(trades)) return null;
  return tradebooks.saveSnapshot(c, trades, todayIst());
}

async function snapshotAllTradeBooks() {
  const saved = [];
  const skipped = [];
  for (const c of clients) {
    if (!c.isLogged) { skipped.push(c.id); continue; }
    try { const r = await snapshotTradeBook(c); if (r) saved.push(r); }
    catch (err) { skipped.push(c.id); console.warn(`Trade book snapshot ${c.id}: ${err.message}`); }
  }
  return { saved, skipped };
}

function startTradeBookLoop() {
  const ist = require("./strategy/ist");
  setInterval(() => {
    const p = ist.parts(Date.now());
    if (ist.isWeekend(p.date) || p.minutes < 9 * 60 || p.minutes > 16 * 60) return;
    snapshotAllTradeBooks().catch(err => console.warn("Trade book snapshot loop:", err.message));
  }, 5 * 60_000);
}

const unionKeys = rows => {
  const keys = [];
  rows.forEach(r => Object.keys(r || {}).forEach(k => { if (!keys.includes(k)) keys.push(k); }));
  return keys;
};

function tradeBookRows(clientId, source, date) {
  if (source === "app") return journal.read("trades", date, r => r.client === clientId);
  return tradebooks.read(date, clientId).trades;
}

function sendRows(req, res, rows, columns, filename) {
  if (req.query.format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(journal.toCsv(rows, columns));
  }
  res.json({ rows });
}

function sendJournal(req, res, filter, prefix) {
  const kind = req.params.kind;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? req.query.date : todayIst();
  const rows = journal.read(kind, date, filter);
  if (req.query.format === "csv") {
    const cols = kind === "trades" ? journal.TRADE_COLUMNS : journal.EVENT_COLUMNS;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${prefix}${kind}-${date}.csv"`);
    return res.send(journal.toCsv(rows, cols));
  }
  res.json({ date, dates: journal.listDates(kind).slice(0, 60), rows });
}

// ADMIN ROUTES  (/api/admin/*)
const admin = express.Router();
admin.use(auth.requireAdmin);

const actor = req => req.admin.username;

admin.get("/users", (_, res) => res.json(auth.listUsernames()));

// Active dashboard sessions (one per user); admin can end one.
admin.get("/sessions", (_, res) => res.json(auth.listSessions()));
admin.delete("/sessions/:username", (req, res) => {
  const ended = auth.endSession(req.params.username, "admin");
  if (ended) monitor.recordAudit(actor(req), "Ended dashboard session", req.params.username);
  res.json({ success: true, ended });
});

// Users tab: who is logged in, and password resets. Passwords are never returned.
admin.get("/accounts", (_, res) => res.json({ users: auth.listAccounts(), minPasswordLength: auth.MIN_PASSWORD }));
admin.put("/accounts/:username/password", (req, res) => {
  const r = auth.resetUserPassword(req.params.username, req.body?.password);
  if (r.error) return res.status(r.status).json({ error: r.error });
  monitor.recordAudit(actor(req), "Reset dashboard password", req.params.username + (r.loggedOut ? " (logged out)" : ""));
  res.json({ success: true, loggedOut: r.loggedOut });
});
admin.post("/password", (req, res) => {
  const r = auth.changeAdminPassword(req.body?.currentPassword, req.body?.newPassword);
  if (r.error) return res.status(r.status).json({ error: r.error });
  monitor.recordAudit(actor(req), "Changed the admin password", "other admin sessions signed out");
  res.json({ success: true, token: r.token, expiresInMs: r.expiresInMs });
});

// Client roster: parent/child, Interactive + Market Data keys
admin.get("/clients", (_, res) => res.json(clients.map(clientManagementView)));

admin.post("/clients", (req, res) => {
  try {
    const c = addClient(req.body || {});
    monitor.recordAudit(actor(req), "Added client", `${c.role} ${c.id} (${c.name})`);
    if (c.role === "PARENT") bootMarketData();
    res.json({ success: true, client: clientManagementView(c) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

admin.put("/clients/:id", (req, res) => {
  try {
    const c = updateClient(req.params.id, req.body || {});
    const changed = Object.keys(req.body || {}).filter(k => !/key|secret/i.test(k));
    const keysChanged = Object.keys(req.body || {}).filter(k => /key|secret/i.test(k) && req.body[k]);
    monitor.recordAudit(actor(req), "Updated client", `${c.id}: ${[...changed, ...keysChanged.map(k => `${k} (new value)`)].join(", ")}`);
    if (c.role === "PARENT" && req.body && (req.body.marketKey || req.body.marketSecret || req.body.rootUrl)) {
      bootMarketData();
    }
    res.json({ success: true, client: clientManagementView(c) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

admin.delete("/clients/:id", async (req, res) => {
  const c = findClient(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  try {
    await brokerLogout(c);
    removeClient(req.params.id);
    monitor.recordAudit(actor(req), "Deleted client", `${c.id} (${c.name})`);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Session control for ANY client
admin.post("/clients/:id/:action(login|logout|connect|disconnect|toggle)", async (req, res) => {
  const c = findClient(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  const { action } = req.params;
  try {
    if (action === "login")      await brokerLogin(c);
    if (action === "logout")     await brokerLogout(c);
    if (action === "connect") {
      if (!c.isLogged) return res.status(400).json({ error: "Login first" });
      c.isConnected = true;
    }
    if (action === "disconnect") c.isConnected = false;
    if (action === "toggle") {
      c.enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : !c.enabled;
      updateClient(c.id, { enabled: c.enabled }); // persist
    }
    monitor.recordAudit(actor(req), `Client ${action}`, c.id);
    res.json({ success: true, client: clientManagementView(c) });
  } catch (err) {
    monitor.recordAudit(actor(req), `Client ${action} FAILED`, `${c.id}: ${brokerError(err)}`);
    res.status(500).json({ error: brokerError(err) });
  }
});

// Emergency: stop every client from taking part in execution.
admin.post("/clients/disconnect-all", (req, res) => {
  clients.forEach(c => { c.isConnected = false; });
  monitor.recordAudit(actor(req), "Disconnected ALL clients");
  res.json({ success: true });
});
admin.post("/clients/logout-all", async (req, res) => {
  await Promise.allSettled(clients.map(brokerLogout));
  monitor.recordAudit(actor(req), "Logged out ALL clients");
  res.json({ success: true });
});

// Live execution controls: kill switch, engine, risk limits
admin.get("/settings", (_, res) => res.json({
  ...settings.getSettings(),
  ranges: { engine: settings.ENGINE_RANGES, limits: settings.LIMIT_RANGES },
  segments: settings.ALL_SEGMENTS,
  productTypes: settings.PRODUCT_TYPES,
}));

admin.put("/settings", (req, res) => {
  try {
    const before = settings.getSettings();
    const next = settings.updateSettings(req.body || {});
    const diffs = [];
    if (before.tradingMode !== next.tradingMode) diffs.push(`MODE ${before.tradingMode} -> ${next.tradingMode}`);
    if (JSON.stringify(before.allowedSegments) !== JSON.stringify(next.allowedSegments)) diffs.push(`segments -> ${next.allowedSegments.join(",")}`);
    if (JSON.stringify(before.sizing) !== JSON.stringify(next.sizing)) diffs.push(`sizing -> ${JSON.stringify(next.sizing)}`);
    if (before.tradingHalted !== next.tradingHalted) diffs.push(next.tradingHalted ? `HALTED (${next.haltReason})` : "RESUMED trading");
    for (const g of ["engine", "limits"]) {
      for (const k of Object.keys(next[g])) {
        if (before[g][k] !== next[g][k]) diffs.push(`${g}.${k} ${before[g][k]} -> ${next[g][k]}`);
      }
    }
    monitor.recordAudit(actor(req), "Changed settings", diffs.join("; ") || "no change");
    res.json(next);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Production monitor
admin.get("/monitor", (_, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptimeMs: monitor.getUptimeMs(),
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    trading: settings.getSettings(),
    executionsInFlight: [...executionsInFlight],
    market: getMarketStatus(),
    quoteSockets: [...quoteServers].reduce((n, s) => n + s.clients.size, 0),
    instruments: getInstrumentStatus(),
    latency: monitor.latencySummary(journal.read("trades", todayIst())),
    orderStreams: require("./orderStream").status(),
    sessions: auth.listSessions(),
    clients: clients.map(clientManagementView),
    executions: monitor.getExecutions(),
    audit: monitor.getAudit(),
  });
});

admin.post("/market/restart", async (req, res) => {
  monitor.recordAudit(actor(req), "Restarted market data feed");
  await bootMarketData();
  res.json({ success: true, market: getMarketStatus() });
});

admin.post("/instruments/refresh", async (req, res) => {
  try {
    const status = await refreshInstruments();
    monitor.recordAudit(actor(req), "Refreshed instruments", `${status.count} from ${status.source}`);
    res.json(status);
  } catch (err) {
    res.status(502).json({ error: err.message, status: getInstrumentStatus() });
  }
});

// Strategy library (uploaded bt-strategy-config files)
admin.get("/strategies", (_, res) => res.json(strategyStore.listStrategies().map(strategyView)));

admin.post("/strategies", (req, res) => {
  try {
    const { fileName, content } = req.body || {};
    const raw = typeof content === "string" ? JSON.parse(content) : content;
    const s = strategyStore.addStrategy({ fileName, raw, by: actor(req) });
    monitor.recordAudit(actor(req), "Uploaded strategy", `${s.name} (${fileName || "file"})`);
    res.json(strategyView(s));
  } catch (err) {
    const status = err instanceof SyntaxError ? 400 : (err.status || 500);
    res.status(status).json({ error: err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : err.message, errors: err.errors });
  }
});

admin.delete("/strategies/:id", (req, res) => {
  try {
    const s = strategyStore.removeStrategy(req.params.id);
    monitor.recordAudit(actor(req), "Deleted strategy", s.name);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

admin.get("/strategies/:id/raw", (req, res) => {
  const s = strategyStore.getStrategy(req.params.id);
  if (!s) return res.status(404).json({ error: "Strategy not found" });
  res.setHeader("Content-Disposition", `attachment; filename="${(s.fileName || `${s.name}.json`).replace(/"/g, "")}"`);
  res.json(s.raw);
});

// Assignments: which user runs which strategy, on which clients
admin.get("/assignments", (_, res) => res.json(strategyStore.listAssignments().map(a => runner.status(a.id))));

admin.post("/assignments", (req, res) => {
  try {
    const a = strategyStore.addAssignment(req.body || {}, validateAssignment);
    monitor.recordAudit(actor(req), "Assigned strategy", `${strategyStore.getStrategy(a.strategyId)?.name} -> ${a.username} (${a.mode})`);
    res.json(runner.status(a.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

admin.put("/assignments/:id", (req, res) => {
  try {
    const before = strategyStore.getAssignment(req.params.id);
    const prevMode = before?.mode;
    const run = before && strategyStore.loadRun(before.id);
    if (run && run.status !== "STOPPED" && req.body?.mode && req.body.mode !== prevMode) {
      return res.status(409).json({ error: "Stop the strategy before switching PAPER / LIVE" });
    }
    const a = strategyStore.updateAssignment(req.params.id, req.body || {}, validateAssignment);
    monitor.recordAudit(actor(req), "Updated assignment", `${a.id}: ${Object.keys(req.body || {}).join(", ")}${prevMode !== a.mode ? ` (mode ${prevMode} -> ${a.mode})` : ""}`);
    res.json(runner.status(a.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

admin.delete("/assignments/:id", (req, res) => {
  try {
    const a = strategyStore.removeAssignment(req.params.id);
    monitor.recordAudit(actor(req), "Removed assignment", `${a.id} (${a.username})`);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

admin.post("/assignments/:id/:action(start|stop|squareoff|resume)", (req, res) => {
  try {
    const fn = { start: runner.start, stop: runner.stop, squareoff: runner.squareOff, resume: runner.resume }[req.params.action];
    fn(req.params.id, `admin ${actor(req)}`);
    monitor.recordAudit(actor(req), `Strategy ${req.params.action}`, req.params.id);
    res.json(runner.status(req.params.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Client margins: utilized / available (read-only, cached 30 s)
const { parseBalance } = require("./margin");
const MARGIN_CACHE_MS = 30_000;
const marginCache = new Map(); // clientId -> { at, data }

async function marginFor(c, refresh) {
  const base = { clientId: c.id, clientName: c.name, role: c.role, assignedTo: c.assignedTo || "", loggedIn: !!c.isLogged };
  if (!c.isLogged || typeof getBalance !== "function") return base;
  const hit = marginCache.get(c.id);
  if (!refresh && hit && Date.now() - hit.at < MARGIN_CACHE_MS) return { ...base, ...hit.data };
  try {
    const raw = await getBalance(c);
    let data;
    try { data = { ...parseBalance(raw), error: "" }; }
    catch (err) { data = { error: err.message, raw }; }
    data.fetchedAt = new Date().toISOString();
    marginCache.set(c.id, { at: Date.now(), data });
    return { ...base, ...data };
  } catch (err) {
    return { ...base, error: err.response?.data?.description || err.message };
  }
}

admin.get("/margins", async (req, res) => {
  const refresh = req.query.refresh === "1";
  const out = [];
  for (const c of clients) out.push(await marginFor(c, refresh)); // one at a time: gentle on the broker
  res.json(out);
});

// Daily trade books of every client
// source=broker: the saved copy of the broker's own trade book
// source=app:    trades this app placed (journal: manual + strategy, LIVE + PAPER)
const bookDate = req => (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? req.query.date : todayIst());
const bookSource = req => (req.query.source === "app" ? "app" : "broker");

admin.get("/tradebooks", (req, res) => {
  const date = bookDate(req);
  const saved = new Map(tradebooks.listClients(date).map(c => [c.clientId, c]));
  const appTrades = journal.read("trades", date);
  const ids = [...new Set([...clients.map(c => c.id), ...saved.keys()])];
  const dates = [...new Set([todayIst(), ...tradebooks.listDates(), ...journal.listDates("trades")])].sort().reverse();
  res.json({
    date,
    dates: dates.slice(0, 90),
    clients: ids.map(id => {
      const c = findClient(id);
      const s = saved.get(id);
      return {
        clientId: id,
        clientName: c?.name || s?.clientName || "",
        role: c?.role || "",
        isLogged: !!c?.isLogged,
        brokerTrades: s?.count || 0,
        brokerUpdatedAt: s?.updatedAt || null,
        appTrades: appTrades.filter(t => t.client === id).length,
      };
    }),
  });
});

admin.get("/tradebooks/all", (req, res) => {
  const date = bookDate(req);
  const source = bookSource(req);
  const ids = [...new Set([...clients.map(c => c.id), ...tradebooks.listClients(date).map(c => c.clientId)])];
  const rows = [];
  for (const id of ids) {
    const name = findClient(id)?.name || tradebooks.read(date, id).clientName || "";
    for (const t of tradeBookRows(id, source, date)) rows.push({ clientId: id, clientName: name, ...t });
  }
  const cols = source === "app"
    ? ["clientId", "clientName", ...journal.TRADE_COLUMNS.filter(c => c !== "client" && c !== "clientName")]
    : ["clientId", "clientName", ...unionKeys(rows).filter(k => k !== "clientId" && k !== "clientName")];
  sendRows(req, res, rows, cols, `all-clients-${source}-tradebook-${date}.csv`);
});

admin.get("/tradebooks/:clientId", (req, res) => {
  try {
    const date = bookDate(req);
    const source = bookSource(req);
    const rows = tradeBookRows(req.params.clientId, source, date);
    const cols = source === "app" ? journal.TRADE_COLUMNS : unionKeys(rows);
    sendRows(req, res, rows, cols, `${req.params.clientId}-${source}-tradebook-${date}.csv`);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.post("/tradebooks/snapshot", async (req, res) => {
  const result = await snapshotAllTradeBooks();
  monitor.recordAudit(actor(req), "Saved trade books", `${result.saved.length} client(s)`);
  res.json(result);
});

// Journal: every user's trades and events
admin.get("/journal/:kind(trades|events)", (req, res) => {
  const user = req.query.user ? String(req.query.user) : null;
  sendJournal(req, res, user ? r => r.user === user : null, "all-");
});

app.use("/api/admin", admin);

// DASHBOARD ROUTES  (/api/*, dashboard user token)
app.use("/api", auth.requireAuth);

// The built dashboard (frontend/dist), so the whole app runs on one port
const FRONTEND_DIST = process.env.FRONTEND_DIST || path.join(__dirname, "..", "frontend", "dist");
const FRONTEND_INDEX = path.join(FRONTEND_DIST, "index.html");
// index.html is never cached (so an update shows on the next reload); the
// built assets have content hashes in their names and can be cached for long.
app.use(express.static(FRONTEND_DIST, {
  index: "index.html",
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  },
}));
app.get(/^\/(?!api\/|api$|ws$).*/, (req, res, next) => {
  if (!fs.existsSync(FRONTEND_INDEX)) return req.path === "/" ? res.send("XTS Trading Backend (dashboard not built — run start.bat)") : next();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(FRONTEND_INDEX);
});

// Instruments (fetched from Upstox on start; refresh on demand)
// Only the segments the admin allows (Admin -> Execution & Limits).
const segKey = seg => { const x = String(seg || "").toUpperCase(); return x === "MCX" ? "MCX_FO" : x; };
app.get("/api/instruments", (_, res) => {
  const allowed = new Set(settings.getSettings().allowedSegments || []);
  res.json(getDashboardInstruments().filter(i => allowed.has(segKey(i.segment))));
});
app.get("/api/instruments/status", (_, res) => res.json(getInstrumentStatus()));
app.post("/api/instruments/refresh", async (req, res) => {
  try {
    const status = await refreshInstruments();
    console.log(`Instruments refreshed by ${req.user.username}: ${status.count}`);
    res.json(status);
  } catch (err) {
    res.status(502).json({ error: err.message, status: getInstrumentStatus() });
  }
});
app.post("/api/instruments", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Expected a JSON array or object payload" });
    }
    const count = setInstruments(payload, "upload");
    res.json({ success: true, count });
  } catch (err) {
    console.error("Error: Failed to load uploaded instruments:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Live execution settings the dashboard displays (read-only here).
app.get("/api/execution/config", (_, res) => {
  const s = settings.getSettings();
  res.json({ tradingMode: s.tradingMode, tradingHalted: s.tradingHalted, haltReason: s.haltReason, engine: s.engine, limits: s.limits, allowedSegments: s.allowedSegments, sizing: s.sizing });
});

// Only clients assigned to the logged-in dashboard user (or unassigned).
app.get("/api/clients", (req, res) => res.json(visibleTo(req.user.username).map(clientSnapshot)));

const forbidden = res => res.status(403).json({ error: "This client is assigned to another user" });

app.post("/api/clients/:id/login", async (req, res) => {
  const c = findClient(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!isVisibleTo(c, req.user.username)) return forbidden(res);
  try {
    await brokerLogin(c);
    res.json({ success: true, status: "logged_in" });
  } catch (err) {
    const body = err.response?.data;
    console.error(`Error: ${c.id} login HTTP ${err.response?.status || "?"}:`, body ? JSON.stringify(body) : err.message);
    res.status(500).json({ error: brokerError(err), status: "login_failed" });
  }
});

app.post("/api/clients/:id/logout", async (req, res) => {
  const c = findClient(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!isVisibleTo(c, req.user.username)) return forbidden(res);
  await brokerLogout(c);
  res.json({ success: true });
});

app.post("/api/clients/login-all", async (req, res) => {
  const mine = visibleTo(req.user.username);
  const results = await Promise.allSettled(mine.map(async c => {
    if (c.isLogged) return { id: c.id, status: "already_logged" };
    try {
      await brokerLogin(c);
      return { id: c.id, status: "logged_in" };
    } catch (err) {
      console.error(`Error: ${c.id}:`, brokerError(err));
      return { id: c.id, status: "error", error: brokerError(err) };
    }
  }));
  res.json(results.map(r => r.value || { error: r.reason?.message }));
});

app.post("/api/clients/logout-all", async (req, res) => {
  await Promise.allSettled(visibleTo(req.user.username).map(brokerLogout));
  res.json({ success: true });
});

app.post("/api/clients/:id/connect", (req, res) => {
  const c = findClient(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!isVisibleTo(c, req.user.username)) return forbidden(res);
  if (!c.isLogged) return res.status(400).json({ error: "Login first" });
  c.isConnected = true; res.json({ success: true });
});
app.post("/api/clients/:id/disconnect", (req, res) => {
  const c = findClient(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!isVisibleTo(c, req.user.username)) return forbidden(res);
  c.isConnected = false; res.json({ success: true });
});
app.post("/api/clients/connect-all", (req, res) => {
  res.json(visibleTo(req.user.username).map(c => {
    if (!c.isLogged) return { id: c.id, error: "Not logged in" };
    c.isConnected = true; return { id: c.id, success: true };
  }));
});
app.post("/api/clients/disconnect-all", (req, res) => {
  visibleTo(req.user.username).forEach(c => { c.isConnected = false; }); res.json({ success: true });
});

app.post("/api/clients/:id/toggle", (req, res) => {
  const c = findClient(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!isVisibleTo(c, req.user.username)) return forbidden(res);
  c.enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : !c.enabled;
  res.json({ success: true, enabled: c.enabled });
});

// Subscribe / Unsubscribe — owned per user, so one dashboard can't cut off
// another dashboard's (or a running strategy's) quotes.
app.post("/api/subscribe", async (req, res) => {
  const { tokens, segments } = req.body || {};
  if (!Array.isArray(tokens) || !tokens.length) return res.json({ status: "no tokens" });
  if (tokens.length > 200) return res.status(400).json({ error: "Too many tokens in one request (max 200)" });
  await subscribeTokens(tokens, segments, `ui:${req.user.username}`);
  res.json({ status: "subscribed", count: tokens.length });
});
// { "all": true } releases every token this user's dashboard holds — sent when
// the dashboard opens, so tokens left over from an earlier page don't keep streaming.
app.post("/api/unsubscribe", async (req, res) => {
  const owner = `ui:${req.user.username}`;
  const tokens = req.body?.all === true ? tokensOwnedBy(owner) : req.body?.tokens;
  if (!Array.isArray(tokens) || !tokens.length) return res.json({ status: "no tokens", count: 0 });
  await unsubscribeTokens(tokens, owner);
  res.json({ status: "unsubscribed", count: tokens.length });
});

// Automated strategies assigned to the logged-in user
function ownAssignment(req, res) {
  const a = strategyStore.getAssignment(req.params.id);
  if (!a || a.username !== req.user.username) {
    res.status(404).json({ error: "Strategy not assigned to you" });
    return null;
  }
  return a;
}

app.get("/api/strategies", (req, res) => {
  const mine = strategyStore.listAssignments().filter(a => a.username === req.user.username);
  res.json(mine.map(a => {
    const st = runner.status(a.id);
    const s = strategyStore.getStrategy(a.strategyId);
    return { ...st, summary: s ? strategySummary(s) : null };
  }));
});

app.post("/api/strategies/:id/:action(start|stop|squareoff|resume)", (req, res) => {
  const a = ownAssignment(req, res);
  if (!a) return;
  try {
    const fn = { start: runner.start, stop: runner.stop, squareoff: runner.squareOff, resume: runner.resume }[req.params.action];
    fn(a.id, req.user.username);
    res.json(runner.status(a.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Dashboard activity log -> server journal (survives refresh, restart, network loss)
const levelOf = m => (/Error: |error|reject|fail|manual check/i.test(m) ? "error" : /Warning: |partial|warn|disconnect|halted/i.test(m) ? "warn" : "info");
app.post("/api/activity", (req, res) => {
  const entries = req.body?.entries;
  if (!Array.isArray(entries) || entries.length > 500) {
    return res.status(400).json({ error: "entries must be a list of at most 500 lines" });
  }
  let saved = 0;
  for (const e of entries) {
    const message = String(e?.message ?? "").slice(0, 1000);
    if (!message) continue;
    const ts = Number(e?.ts);
    journal.appendEvent({
      source: "UI", level: levelOf(message), user: req.user.username, message,
      clientTime: Number.isFinite(ts) ? new Date(ts).toISOString() : "",
    }, Number.isFinite(ts) && Math.abs(Date.now() - ts) < 86_400_000 ? ts : Date.now());
    saved++;
  }
  res.json({ saved });
});

// Trade book and activity log (own records only); ?format=csv to download
app.get("/api/journal/:kind(trades|events)", (req, res) => {
  sendJournal(req, res, r => r.user === req.user.username, `${req.user.username}-`);
});

// Execute Portfolio — fans out to every enabled + logged-in + connected
// client visible to the logged-in dashboard user. Guarded by the admin
// kill switch and risk limits BEFORE anything is sent to the broker.
const executionsInFlight = new Set(); // dashboard usernames with a running execution

app.post("/api/order", async (req, res) => {
  const receivedAt = Date.now(); // latency is measured from here to each fill
  const s = settings.getSettings();
  const { legs } = req.body || {};

  if (s.tradingHalted) {
    const why = String(s.haltReason || "").trim().replace(/[.\s]+$/, "");
    const note = why && !/^halted( by (the )?admin)?$/i.test(why) ? ` (reason: ${why})` : "";
    return res.status(423).json({ error: `Trading is halted by the admin${note}` });
  }
  if (!Array.isArray(legs) || !legs.length) return res.status(400).json({ error: "No legs" });
  if (legs.length > s.limits.maxLegs) {
    return res.status(400).json({ error: `Risk limit: ${legs.length} legs exceeds the max of ${s.limits.maxLegs}` });
  }
  const allowedSegs = new Set(s.allowedSegments || []);
  for (const [i, leg] of legs.entries()) {
    if (!allowedSegs.has(segKey(leg.segment || "NSE_FO"))) {
      return res.status(400).json({ error: `Leg ${i + 1}: segment ${segKey(leg.segment)} is not allowed for trading (Admin > Execution & Limits)` });
    }
    const lots = Number(leg.lots);
    if (!Number.isInteger(lots) || lots <= 0) {
      return res.status(400).json({ error: `Leg ${i + 1}: lots must be a whole number above 0` });
    }
    if (s.limits.maxLotsPerLeg > 0 && lots > s.limits.maxLotsPerLeg) {
      return res.status(400).json({ error: `Risk limit: leg ${i + 1} has ${lots} lots, max is ${s.limits.maxLotsPerLeg}` });
    }
  }

  // PAPER needs no broker session; LIVE needs each client logged in and connected.
  const paper = s.tradingMode !== "LIVE";
  const active = visibleTo(req.user.username).filter(c => c.enabled && (paper || (c.isLogged && c.isConnected)));
  if (!active.length) return res.status(400).json({ error: "No active clients" });
  if (s.limits.maxActiveClients > 0 && active.length > s.limits.maxActiveClients) {
    return res.status(400).json({ error: `Risk limit: ${active.length} active clients exceeds the max of ${s.limits.maxActiveClients}` });
  }

  // One execution at a time per dashboard user — a double click must not
  // send the whole portfolio twice.
  const who = req.user.username;
  if (executionsInFlight.has(who)) {
    return res.status(409).json({ error: "An execution is already running for your account — wait for it to finish." });
  }
  executionsInFlight.add(who);

  console.log(`\nEXECUTE by ${who} | ${legs.length} leg(s) | ${active.length} client(s)`);
  journal.appendEvent({
    source: "EXECUTION", level: "info", user: who,
    message: `EXECUTE (${paper ? "PAPER" : "LIVE"}) by ${who}: ${legs.length} leg(s) × ${active.length} client(s) — ` +
      legs.map(l => `${l.side} ${l.lots}L ${[l.symbol, l.type, l.strike && l.strike !== "N/A" ? l.strike : "", l.expiry].filter(Boolean).join(" ")}`).join(" | "),
  }, receivedAt);
  try {
    const cfg = {
      ...s.engine,
      startedAt: receivedAt,
      products: s.products,
      sizingRounding: s.sizing?.rounding,
      limits: { maxQtyPerOrder: s.limits.maxQtyPerOrder, maxOrderValue: s.limits.maxOrderValue },
    };
    const sized = active.map(c => ({ ...c, multiplier: sizingFactor(c) }));
    const results = paper
      ? await executeOrderMulti(legs, sized, { ...cfg, getQuotes: getLivePrices }, paperBroker.api)
      : await executeOrderMulti(legs, sized, cfg);
    monitor.recordExecution(who, results);
    // Durable trade book: every fill, and every leg that did not fill.
    for (const r of results) {
      if (Number(r.filledQty) > 0) {
        journal.appendTrade({
          source: "MANUAL", mode: paper ? "PAPER" : "LIVE", user: who, symbol: r.symbol, client: r.client, clientName: r.clientName,
          tradingSymbol: r.label, token: r.token, side: r.side, qty: r.filledQty, price: r.avgPrice,
          reason: "MANUAL", status: r.status, orderId: r.orderId || "", error: r.error || "",
          requestedQty: r.requestedQty, limitPrice: r.attempts?.[0]?.limitPrice ?? "", bid: r.bid, ask: r.ask, ltp: r.ltp,
          attempts: r.attempts?.length || 0, executionTime: r.executionTime, multiplier: r.multiplier,
          queueMs: r.latency?.queueMs, ackMs: r.latency?.ackMs, fillMs: r.latency?.fillMs, totalMs: r.latency?.totalMs,
        });
      }
      // Every client's result, filled ones too, with order ID and latency.
      const L = r.latency || {};
      journal.appendEvent({
        source: "EXECUTION",
        level: r.status === "FILLED" ? "info" : r.status === "MANUAL_CHECK" || r.status === "FAILED" ? "error" : "warn",
        user: who, client: r.client,
        message: `${paper ? "PAPER" : "LIVE"} ${r.side} ${r.label} · ${r.clientName || r.client}: ${r.status} ${r.filledQty}/${r.requestedQty}` +
          (r.avgPrice ? ` @ ${r.avgPrice}` : "") + (r.orderId ? ` · order ${r.orderId}` : "") +
          (L.totalMs != null ? ` · ${L.totalMs} ms (ack ${L.ackMs ?? "—"}, fill ${L.fillMs ?? "—"})` : "") +
          (r.attempts?.length > 1 ? ` · ${r.attempts.length} attempts` : "") + (r.error ? ` — ${r.error}` : ""),
      });
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    executionsInFlight.delete(who);
  }
});

// PAPER strategy (algo) positions held for one client by the logged-in
// user's own strategies. PAPER fills never reach the broker, so this is the
// only place a client card can show them. LIVE strategy trades are left out
// on purpose: they appear in the broker's own order/trade/position books.
app.get("/api/clients/:id/strategy-positions", (req, res) => {
  const c = findClient(req.params.id);
  if (!c || !isVisibleTo(c, req.user.username)) return res.json([]);
  const today = require("./strategy/ist").parts(Date.now()).date;
  const quotes = getLivePrices() || {};
  const out = [];
  for (const a of strategyStore.listAssignments()) {
    if (a.username !== req.user.username) continue;
    const s = strategyStore.getStrategy(a.strategyId);
    for (const p of strategyStore.loadRun(a.id).positions) {
      if (p.client !== c.id || p.mode === "LIVE") continue;
      const live = p.status === "OPEN" || p.status === "CHECK";
      if (!live && p.entryDate !== today && p.exitDate !== today) continue;
      const ltp = Number(quotes[p.token]?.ltp || 0) || null;
      const unrealized = p.status === "OPEN" && ltp
        ? Math.round((p.side === "SELL" ? p.entryPrice - ltp : ltp - p.entryPrice) * p.qty * 100) / 100
        : null;
      out.push({ ...p, assignmentId: a.id, strategyName: s?.name || "", ltp, unrealized });
    }
  }
  out.sort((x, y) => String(y.entryTime).localeCompare(String(x.entryTime)));
  res.json(out);
});

// PAPER strategy orders for one client (the logged-in user's own strategies),
// from the durable trade book, by PAPER order ID. LIVE strategy orders show in
// the broker's order and trade books instead. ?date=YYYY-MM-DD
app.get("/api/clients/:id/strategy-orders", (req, res) => {
  const c = findClient(req.params.id);
  if (!c || !isVisibleTo(c, req.user.username)) return res.json([]);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? req.query.date : todayIst();
  const rows = journal.read("trades", date, r =>
    r.source === "STRATEGY" && r.mode !== "LIVE" && r.user === req.user.username && r.client === c.id);
  res.json(rows.reverse());
});

// Order Book / Trade Book / Positions
app.get("/api/clients/:id/orders", async (req, res) => {
  const c = findClient(req.params.id);
  if (!c || !isVisibleTo(c, req.user.username)) return res.json([]);
  res.json(c.isLogged ? await getOrders(c) : []);
});
app.get("/api/clients/:id/trades", async (req, res) => {
  const c = findClient(req.params.id);
  if (!c || !isVisibleTo(c, req.user.username)) return res.json([]);
  if (!c.isLogged) return res.json([]);
  const trades = await getTrades(c);
  // Keep the day's copy of the broker trade book up to date (read-only).
  if (Array.isArray(trades)) {
    try { tradebooks.saveSnapshot(c, trades, todayIst()); }
    catch (err) { console.warn(`Trade book save ${c.id}: ${err.message}`); }
  }
  res.json(trades);
});
app.get("/api/clients/:id/positions", async (req, res) => {
  const c = findClient(req.params.id);
  if (!c || !isVisibleTo(c, req.user.username) || !c.isLogged) return res.json([]);

  const positions = await getPositions(c);

  // Subscribe live quotes for all open positions
  const tokens = [];
  const segments = [];
  for (const p of positions) {
    if (!p.ExchangeInstrumentId) continue;
    tokens.push(String(p.ExchangeInstrumentId));
    segments.push(p.ExchangeSegment); // NSEFO / MCXFO / BSEFO
  }
  if (tokens.length) await subscribeTokens(tokens, segments, "positions");

  res.json(positions);
});

// Bootstrap — only when run directly (`node server.js`), so tests can
// load the app without listening on real ports or logging in anywhere.
async function start() {
  try {
    await refreshInstruments();
  } catch (err) {
    console.error("Error: Instruments unavailable:", err.message);
  }
  await initClients();
  await bootMarketData();

  // AUTO_LOGIN_ON_START=true: log every enabled client in to the broker and
  // connect it, so running strategies can trade after an unattended restart.
  if (String(process.env.AUTO_LOGIN_ON_START).toLowerCase() === "true") {
    console.log("AUTO_LOGIN_ON_START — logging in enabled clients…");
    for (const c of clients.filter(x => x.enabled)) {
      try { await brokerLogin(c); c.isConnected = true; }
      catch (err) { console.error(`Error: Auto-login ${c.id}: ${brokerError(err)}`); }
    }
  }

  await runner.init();
  startRunnerLoop();
  startTradeBookLoop();

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`REST server on port ${PORT}`);
    startWS(httpServer);
  });
}

if (require.main === module) {
  start().catch(err => { console.error("Error: Fatal:", err); process.exit(1); });
}

module.exports = { app, startWS, start, runner };
