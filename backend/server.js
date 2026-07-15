require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const WebSocket = require("ws");
const path      = require("path");

const {
  clients, initClients, clientSnapshot, clientManagementView,
  hasParent, addClient, updateClient, removeClient,
  visibleTo, isVisibleTo,
} = require("./clients");
const { loadInstruments, getInstruments }      = require("./instrumentloader");
const { loginClient, logoutClient, getOrders, getTrades, getPositions } = require("./xtsApi");
const { loginMarketData, connectMarketSocket, subscribeTokens, unsubscribeTokens, onPriceUpdate, getLivePrices } = require("./Marketsocket");
const { executeOrderMulti } = require("./index");
const auth = require("./auth");

const app     = express();
const PORT    = parseInt(process.env.PORT    || "5000");
const WS_PORT = parseInt(process.env.WS_PORT || "3002");

app.use(cors());
app.use(express.json({ limit: "100mb" }));

// ─────────────────────────────────────────────────────────────
// Dashboard login gate
// Public:  POST /api/auth/login , GET /api/auth/verify
// Everything else under /api requires a valid Bearer token —
// the frontend attaches this automatically once you're logged in.
// ─────────────────────────────────────────────────────────────
app.post("/api/auth/login", auth.login);
app.get("/api/auth/verify", auth.verify);
app.use("/api", auth.requireAuth);

// ─────────────────────────────────────────────────────────────
// WebSocket — broadcasts bid/ask quotes to frontend
// ─────────────────────────────────────────────────────────────
let wss;

function broadcast(obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch (_) {} }
  });
}

function startWS() {
  wss = new WebSocket.Server({ port: WS_PORT });
  console.log(`📡 WS server on port ${WS_PORT}`);

  wss.on("connection", ws => {
    console.log("🟢 Frontend connected");
    // Push all current quotes immediately on connect
    const quotes = getLivePrices();
    if (Object.keys(quotes).length > 0) {
      ws.send(JSON.stringify({ type: "quotes", data: quotes }));
    }
    ws.on("close",  ()  => console.log("🔴 Frontend disconnected"));
    ws.on("error",  err => console.error("WS client error:", err.message));
  });

  // Forward every bid/ask update to all connected frontends
  onPriceUpdate(quotes => {
    console.log("➡ Sending to frontend:", quotes);

    broadcast({
        type: "quote",
        data: quotes
    });
});

  setInterval(() => {
    wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.ping(); });
  }, 30_000);
}

// ─────────────────────────────────────────────────────────────
// Market data bootstrap — credentials come from the PARENT client.
// Re-run automatically whenever a Parent is added/edited via
// User Management, so Bid/Ask starts flowing without a restart.
// ─────────────────────────────────────────────────────────────
async function bootMarketData() {
  console.log("\n─── Market Data ─────────────────────────────────");
  try {
    const mdToken = await loginMarketData();
    if (mdToken) {
      connectMarketSocket();
    } else {
      console.warn("⚠️  Bid/Ask will show '—' — add a Parent client with Market Data API Key/Secret via User Management.\n");
    }
  } catch (err) {
    console.warn("⚠️  Market data login error:", err.message);
  }
  console.log("─────────────────────────────────────────────────\n");
}

// ─────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────
async function start() {
  const instrFile = process.env.INSTRUMENT_FILE ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", "Downloads", "completedata.json");

  await loadInstruments(instrFile);
  await initClients();
  await bootMarketData();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 REST server on port ${PORT}`);
    startWS();
  });
}

start().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
app.get("/",                (_, res) => res.send("XTS Trading Backend ✅"));
app.get("/api/instruments", (_, res) => res.json(getInstruments()));
app.post("/api/instruments", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || (typeof payload !== "object" && !Array.isArray(payload))) {
      return res.status(400).json({ error: "Expected a JSON array or object payload" });
    }

    const count = require("./instrumentloader").setInstruments(payload);
    res.json({ success: true, count });
  } catch (err) {
    console.error("❌ Failed to load uploaded instruments:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// Dashboard usernames for the "Assigned To" dropdown in User Management
// (usernames only — never passwords).
app.get("/api/auth/users", (_, res) => res.json(auth.listUsernames()));

// Only clients assigned to the logged-in dashboard user (or left
// unassigned, which stays visible to everyone) show up on the main
// dashboard — this is what makes "nikhil" and "admin" see different books.
app.get("/api/clients",     (req, res) => res.json(visibleTo(req.user.username).map(clientSnapshot)));

// ── User Management (parent/child roster) ──────────────────────
// Full detail view for the management panel (secrets always masked)
app.get("/api/clients/full", (_, res) => {
  res.json(clients.map(clientManagementView));
});

// Add a new client. role="PARENT" requires Interactive API + Market
// Data API + Root URL; only one parent is ever allowed. role="CHILD"
// requires Interactive API only, plus a Multiplier ×.
app.post("/api/clients", (req, res) => {
  try {
    const c = addClient(req.body || {});
    console.log(`✅ Added ${c.role} client ${c.id} (${c.name})`);
    if (c.role === "PARENT") bootMarketData(); // start streaming quotes right away
    res.json({ success: true, client: clientManagementView(c) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.put("/api/clients/:id", (req, res) => {
  try {
    const c = updateClient(req.params.id, req.body || {});
    console.log(`✅ Updated client ${c.id}`);
    if (c.role === "PARENT" && req.body && (req.body.marketKey || req.body.marketSecret || req.body.rootUrl)) {
      bootMarketData(); // credentials/URL may have changed — re-login market feed
    }
    res.json({ success: true, client: clientManagementView(c) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/clients/:id", async (req, res) => {
  const c = clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  try {
    if (c.isLogged) await logoutClient(c);
    removeClient(req.params.id);
    console.log(`🗑️  Removed client ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Login / Logout individual
app.post("/api/clients/:id/login", async (req, res) => {
  const c = clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!isVisibleTo(c, req.user.username)) return res.status(403).json({ error: "This client is assigned to another user" });
  try {
    const r = await loginClient(c);
    c.token = r.token; c.userID = r.userID; c.isLogged = true;
    console.log(`✅ ${c.id} logged in — userID: ${c.userID}`);
    res.json({ success: true, status: "logged_in" });
  } catch (err) {
    const body = err.response?.data;
    const message = body?.description || body?.error || err.message || "Login failed";
    console.error(`❌ ${c.id} login HTTP ${err.response?.status || "?"}:`);
    if (body) console.error(`   5paisa says:`, JSON.stringify(body));
    else      console.error(`   Error:`, err.message);
    res.status(500).json({ error: message, status: "login_failed" });
  }
});

app.post("/api/clients/:id/logout", async (req, res) => {
  const c = clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!isVisibleTo(c, req.user.username)) return res.status(403).json({ error: "This client is assigned to another user" });
  if (c.isLogged) await logoutClient(c);
  c.isLogged = false; c.isConnected = false; c.token = null; c.userID = null;
  res.json({ success: true });
});

// Login / Logout ALL — scoped to the logged-in dashboard user's own clients
app.post("/api/clients/login-all", async (req, res) => {
  const mine = visibleTo(req.user.username);
  const results = await Promise.allSettled(mine.map(async c => {
    if (c.isLogged) return { id: c.id, status: "already_logged" };
    try {
      const r = await loginClient(c);
      c.token = r.token; c.userID = r.userID; c.isLogged = true;
      console.log(`✅ ${c.id} logged in`);
      return { id: c.id, status: "logged_in" };
    } catch (err) {
      const body = err.response?.data;
      const message = body?.description || body?.error || err.message || "Login failed";
      console.error(`❌ ${c.id}:`, body ? JSON.stringify(body) : err.message);
      return { id: c.id, status: "error", error: message };
    }
  }));
  res.json(results.map(r => r.value || { error: r.reason?.message }));
});

app.post("/api/clients/logout-all", async (req, res) => {
  const mine = visibleTo(req.user.username);
  await Promise.allSettled(mine.map(async c => {
    if (c.isLogged) await logoutClient(c);
    c.isLogged = false; c.isConnected = false; c.token = null; c.userID = null;
  }));
  res.json({ success: true });
});

// Connect / Disconnect
app.post("/api/clients/:id/connect", (req, res) => {
  const c = clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!isVisibleTo(c, req.user.username)) return res.status(403).json({ error: "This client is assigned to another user" });
  if (!c.isLogged) return res.status(400).json({ error: "Login first" });
  c.isConnected = true; res.json({ success: true });
});
app.post("/api/clients/:id/disconnect", (req, res) => {
  const c = clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!isVisibleTo(c, req.user.username)) return res.status(403).json({ error: "This client is assigned to another user" });
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

// Toggle enabled
app.post("/api/clients/:id/toggle", (req, res) => {
  const c = clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!isVisibleTo(c, req.user.username)) return res.status(403).json({ error: "This client is assigned to another user" });
  c.enabled = req.body.enabled !== undefined ? Boolean(req.body.enabled) : !c.enabled;
  res.json({ success: true, enabled: c.enabled });
});

// Subscribe / Unsubscribe
app.post("/api/subscribe", async (req, res) => {
  const { tokens, segments } = req.body;
  if (!tokens?.length) return res.json({ status: "no tokens" });
  await subscribeTokens(tokens, segments);
  res.json({ status: "subscribed", count: tokens.length });
});
app.post("/api/unsubscribe", async (req, res) => {
  const { tokens } = req.body;
  if (!tokens?.length) return res.json({ status: "no tokens" });
  await unsubscribeTokens(tokens);
  res.json({ status: "unsubscribed" });
});

// Execute Portfolio — fans out to every enabled + logged-in + connected
// client belonging to the logged-in dashboard user (parent AND children,
// whichever of them are assigned to you, plus any unassigned/shared ones).
// Each child's quantity is scaled by its own Multiplier × inside
// executeOrderMulti / executeOneLeg (index.js).
app.post("/api/order", async (req, res) => {
  const { legs } = req.body;
  if (!legs?.length) return res.status(400).json({ error: "No legs" });
  const active = visibleTo(req.user.username).filter(c => c.enabled && c.isLogged && c.isConnected);
  if (!active.length) return res.status(400).json({ error: "No active clients" });
  console.log(`\n🔥 EXECUTE by ${req.user.username} | ${legs.length} leg(s) | ${active.length} client(s)`);
  try { res.json(await executeOrderMulti(legs, active)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Order Book / Trade Book / Positions
app.get("/api/clients/:id/orders", async (req, res) => {
  const c = clients.find(x => x.id === req.params.id);
  if (!c || !isVisibleTo(c, req.user.username)) return res.json([]);
  res.json(c.isLogged ? await getOrders(c) : []);
});
app.get("/api/clients/:id/trades", async (req, res) => {
  const c = clients.find(x => x.id === req.params.id);
  if (!c || !isVisibleTo(c, req.user.username)) return res.json([]);
  res.json(c.isLogged ? await getTrades(c) : []);
});
app.get("/api/clients/:id/positions", async (req, res) => {
  const c = clients.find(x => x.id === req.params.id);

  if (!c || !isVisibleTo(c, req.user.username) || !c.isLogged) {
    return res.json([]);
  }

  const positions = await getPositions(c);

  // Subscribe live quotes for all open positions
  const tokens = [];
  const segments = [];

  for (const p of positions) {
    if (!p.ExchangeInstrumentId) continue;

    tokens.push(String(p.ExchangeInstrumentId));
    segments.push(p.ExchangeSegment); // NSEFO / MCXFO / BSEFO
  }

  if (tokens.length) {
    console.log("📡 Auto subscribe position tokens:", tokens);
    await subscribeTokens(tokens, segments);
  }

  res.json(positions);
});