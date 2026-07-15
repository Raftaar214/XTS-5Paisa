// xtsApi.js
const axios = require("axios");
// Import the agent directly as a single object
const strictAgent = require('./httpAgent');

// Assign the agent to axios
axios.defaults.httpsAgent = strictAgent;
axios.defaults.timeout = 10000;
// Single shared agent (see httpAgent.js) — keeps every request on the
// same connection so the outbound IP stays consistent with login.

const BASE = process.env.XTS_INTERACTIVE_URL || "https://xtsmum.5paisa.com";

// Per-client Root URL override, settable from User Management. Falls back
// to the global XTS_INTERACTIVE_URL above when a client doesn't specify one
// (which is the normal case — every client on the same broker shares it).
function baseFor(client) { return (client && client.rootUrl) || BASE; }

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function hdr(token) {
  return { authorization: token, "Content-Type": "application/json" };
}

function ok(res) {
  return res.data?.type === "success" || res.data?.result !== undefined;
}

function logErr(label, err) {
  if (err.response) {
    console.error(`❌ ${label}: HTTP ${err.response.status}`);
    console.error(`   Body:`, JSON.stringify(err.response.data));
  } else {
    console.error(`❌ ${label}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// SESSION
// ─────────────────────────────────────────────────────────────
async function loginClient(client) {
  // Try whatever source is configured FIRST — your account is confirmed
  // to work with WEBAPI. Only fall back to the other value if that fails,
  // so a misconfigured .env doesn't silently force the wrong source.
  const configured = (client.source || process.env.XTS_SOURCE || "WEBAPI").toUpperCase();
  const sources = [configured];

  let lastErr;
  for (const source of sources) {
    console.log(`🔐 ${client.id} → source=${source}  key=${client.interactiveKey?.slice(0,6)}…`);
    try {
      const res = await axios.post(`${baseFor(client)}/interactive/user/session`, {
        appKey:    client.interactiveKey,
        secretKey: client.interactiveSecret,
        source,
      }, {
        timeout: 10000,
        validateStatus: () => true,
      });
      const d = res.data;
      if (d.type === "success") {
        const r      = d.result;
        const userID = r.clientCodes?.[0] || r.userID || client.id;
        console.log(`✅ ${client.id} logged in  source=${source}  userID=${userID}`);
        return { token: r.token, userID };
      }
      console.warn(`   source=${source} rejected: [${d.code}] ${d.description}`);
      lastErr = new Error(d.description || d.message || "Login failed");
    } catch (err) {
      const body = err.response?.data;
      const status = err.response?.status;
      let message = body?.description || body?.error || body?.message || err.message || "Login failed";
      if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" || err.message?.includes("timeout")) {
        message = "5paisa login timed out — network or firewall issue";
      } else if (!status) {
        message = "5paisa login failed — host unreachable";
      }
      console.warn(`   source=${source} HTTP ${status || "network"}: ${message}`);
      if (body) console.warn(`   Body:`, JSON.stringify(body));
      lastErr = new Error(message);
      lastErr.response = err.response;
      lastErr.cause = err;
    }
  }

  console.error(`❌ ${client.id} login failed with all sources.`);
  throw lastErr || new Error("Login failed");
}

async function logoutClient(client) {
  try {
    await axios.delete(`${baseFor(client)}/interactive/user/session`, {
      headers: hdr(client.token),
    });
  } catch (e) {
    console.warn(`Logout warn (${client.id}):`, e.response?.data?.description || e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────────
async function placeOrder(client, payload) {
  try {
    console.log("========== ORDER PAYLOAD ==========");
    console.log(JSON.stringify(payload, null, 2));

    const res = await axios.post(
      `${baseFor(client)}/interactive/orders`,
      payload,
      {
        headers: hdr(client.token),
      }
    );

    const d = res.data;

    if (!ok(res)) {
      console.log("Response:", JSON.stringify(d, null, 2));
      throw new Error(d.description || d.message || "Order failed");
    }

    return d.result;

  } catch (err) {

    console.log("========== ORDER ERROR ==========");

    if (err.response) {
      console.log("Status :", err.response.status);
      console.log("Body :", JSON.stringify(err.response.data, null, 2));
    } else {
      console.log(err.message);
    }

    throw err;
  }
}

async function getOrders(client) {
  try {
    const res = await axios.get(`${baseFor(client)}/interactive/orders`, {
      headers: hdr(client.token),
      params: { clientID: client.userID },
    });

    if (!ok(res)) return [];

    const r = res.data.result;

    if (Array.isArray(r)) return r;

    if (Array.isArray(r?.orders)) return r.orders;

    if (Array.isArray(r?.OrderBook)) return r.OrderBook;

    if (Array.isArray(r?.orderBook)) return r.orderBook;

    if (Array.isArray(r?.listQuotesFull)) return r.listQuotesFull;

    return [];
  } catch (e) {
    logErr(`getOrders (${client.id})`, e);
    return [];
  }
}

async function getTrades(client) {
  try {
    const res = await axios.get(`${baseFor(client)}/interactive/orders/trades`, {
      headers: hdr(client.token),
      params:  { clientID: client.userID },
    });
    if (!ok(res)) return [];
    const r = res.data.result;
    if (Array.isArray(r))                 return r;
    if (Array.isArray(r?.listQuotesFull)) return r.listQuotesFull;
    return [];
  } catch (e) {
    logErr(`getTrades (${client.id})`, e);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// POSITIONS
// ─────────────────────────────────────────────────────────────
async function getPositions(client) {
  try {
    const res = await axios.get(`${baseFor(client)}/interactive/portfolio/positions`, {
      headers: hdr(client.token),
      params:  { clientID: client.userID, dayOrNet: "NetWise" },
    });
    if (!ok(res)) return [];
    const r = res.data.result;
    if (Array.isArray(r))               return r;
    if (Array.isArray(r?.positionList)) return r.positionList;
    if (Array.isArray(r?.netwise))      return r.netwise;
    if (Array.isArray(r?.Netwise))      return r.Netwise;
    return [];
  } catch (e) {
    logErr(`getPositions (${client.id})`, e);

    // Retry without clientID — some 5paisa versions reject it
    if (e.response?.status === 400) {
      console.warn(`   Retrying getPositions without clientID…`);
      try {
        const res2 = await axios.get(`${baseFor(client)}/interactive/portfolio/positions`, {
          headers: hdr(client.token),
          params:  { dayOrNet: "NetWise" },
        });
        const r2 = res2.data?.result;
        if (Array.isArray(r2))               return r2;
        if (Array.isArray(r2?.positionList)) return r2.positionList;
        if (Array.isArray(r2?.netwise))      return r2.netwise;
        return [];
      } catch (e2) {
        logErr(`getPositions retry (${client.id})`, e2);
        return [];
      }
    }
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// CANCEL ORDER
// Mirrors XTSSession.cancel_order() in execution.py
// Called by MLO engine when fill_timeout is reached and qty
// is still open — cancel the remaining unfilled portion before
// retrying with a fresh price for that remaining qty only.
// ─────────────────────────────────────────────────────────────
async function cancelOrder(client, appOrderId) {
  const uid = `CAN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const res = await axios.delete(`${baseFor(client)}/interactive/orders`, {
      headers: hdr(client.token),

      // Try query parameters instead of request body
      params: {
        appOrderID: Number(appOrderId),
        orderUniqueIdentifier: uid,
        clientID: client.userID,
      },

      validateStatus: () => true,
    });

    console.log("========== CANCEL RESPONSE ==========");
    console.log("Status:", res.status);
    console.log("Data:", JSON.stringify(res.data, null, 2));

    if (res.data?.type !== "success") {
      throw new Error(res.data?.description || "Cancel failed");
    }

    console.log(`[Cancel] OK AppOrderID=${appOrderId}`);
    return res.data.result;

  } catch (err) {
    console.error("[Cancel Error]");
    console.error(err.response?.data || err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// GET ORDER HISTORY
// Mirrors XTSSession.get_order_history() in execution.py
// Returns array of order state records; last entry = latest.
// MLO poll loop calls this every 0.5s to check fill status.
//
// XTS endpoint: GET /interactive/orders/history?appOrderID=X
// Response: { type:"success", result: [ { OrderStatus, CumulativeQuantity,
//             OrderAverageTradedPrice, ... }, ... ] }
// ─────────────────────────────────────────────────────────────
async function getOrderHistory(client, appOrderId) {
  try {
    const res = await axios.get(
      `${baseFor(client)}/interactive/orders/history`,
      {
        headers: hdr(client.token),
        params: {
          appOrderID: appOrderId,
          clientID: client.userID,
        },
      }
    );

    console.log("========== ORDER HISTORY ==========");
    console.log("AppOrderID:", appOrderId);
    console.log(JSON.stringify(res.data, null, 2));

    const d = res.data;

    if (!ok(res)) {
      console.warn(
        `[OrderHistory] ${appOrderId}: ${
          d.description || d.message || "no data"
        }`
      );
      return [];
    }

    const r = d.result;

    if (Array.isArray(r)) return r;
    if (Array.isArray(r?.orderHistory)) return r.orderHistory;
    if (Array.isArray(r?.OrderHistory)) return r.OrderHistory;
    if (typeof r === "object" && r !== null) return [r];

    return [];
  } catch (err) {
    console.warn(
      `[OrderHistory] ${appOrderId}:`,
      err.response?.data?.description || err.message
    );
    return [];
  }
}

module.exports = { loginClient, logoutClient, placeOrder, cancelOrder, getOrderHistory, getOrders, getTrades, getPositions };
