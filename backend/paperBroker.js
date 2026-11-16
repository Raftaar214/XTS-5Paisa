// paperBroker.js — a simulated broker for PAPER trading.
//
// It speaks the same interface the execution engine uses for the real broker
// (placeOrder / getOrderHistory / getOrders / cancelOrder), so PAPER orders go
// through exactly the same marketable-limit logic as LIVE: price buffer, fill
// timeout, cancel, retry of the unfilled remainder, MANUAL_CHECK rules.
//
// Fill model: an open order fills in full as soon as the LIVE quote crosses
// its limit — a SELL when bid >= limit (at the bid), a BUY when ask <= limit
// (at the ask). Quotes come from the broker's live market-data feed. Market
// depth is not simulated, so there are no partial fills.
//
// Nothing here talks to any broker. Order IDs are PAPER-YYYYMMDD-XXXXXX.

const crypto = require("crypto");
const ist = require("./strategy/ist");

const KEEP_MS = 6 * 3600_000;

const rejection = message =>
  Object.assign(new Error(message), { response: { status: 400, data: { type: "error", description: message } } });

function createPaperBroker({ getQuotes, now = Date.now }) {
  const orders = new Map();

  const newId = () =>
    `PAPER-${ist.parts(now()).date.replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

  const publicView = o => ({
    AppOrderID: o.AppOrderID, ClientID: o.clientId, ExchangeInstrumentID: Number(o.token),
    OrderSide: o.side, OrderQuantity: o.qty, OrderType: "LIMIT", LimitPrice: o.limit,
    OrderStatus: o.OrderStatus, CumulativeQuantity: o.CumulativeQuantity, LeavesQuantity: o.LeavesQuantity,
    OrderAverageTradedPrice: o.OrderAverageTradedPrice, OrderUniqueIdentifier: o.uid,
    LastUpdateDateTime: new Date(o.updatedAt).toISOString(),
  });
  const snap = o => { o.updatedAt = Date.now(); o.history.push(publicView(o)); };

  function evaluate(o) {
    if (o.OrderStatus !== "New") return;
    const q = (getQuotes() || {})[o.token] || {};
    let px = 0;
    if (o.side === "SELL") { const bid = Number(q.bid || 0); if (bid > 0 && bid >= o.limit) px = bid; }
    else                   { const ask = Number(q.ask || 0); if (ask > 0 && ask <= o.limit) px = ask; }
    if (!px) return;
    o.OrderStatus = "Filled";
    o.CumulativeQuantity = o.qty;
    o.LeavesQuantity = 0;
    o.OrderAverageTradedPrice = px;
    snap(o);
  }

  function prune() {
    const cutoff = Date.now() - KEEP_MS;
    for (const [id, o] of orders) if (o.createdAt < cutoff) orders.delete(id);
  }

  const api = {
    async placeOrder(client, p) {
      const qty = Number(p.orderQuantity);
      const limit = Number(p.limitPrice);
      if (!(qty > 0)) throw rejection("Quantity must be above 0");
      if (!(limit > 0)) throw rejection("Limit price must be above 0");
      if (!["BUY", "SELL"].includes(p.orderSide)) throw rejection("Side must be BUY or SELL");
      prune();
      const o = {
        AppOrderID: newId(), clientId: client?.id, token: String(p.exchangeInstrumentID),
        side: p.orderSide, qty, limit, uid: p.orderUniqueIdentifier || "",
        OrderStatus: "New", CumulativeQuantity: 0, LeavesQuantity: qty, OrderAverageTradedPrice: 0,
        history: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      orders.set(o.AppOrderID, o);
      snap(o);
      return { AppOrderID: o.AppOrderID };
    },

    async getOrderHistory(_client, appOrderId) {
      const o = orders.get(String(appOrderId));
      if (!o) return [];
      evaluate(o);
      return o.history.slice();
    },

    async getOrders(client) {
      return [...orders.values()].filter(o => !client || o.clientId === client.id).map(o => { evaluate(o); return publicView(o); });
    },

    // Like the live order-update stream: resolves as soon as the order fills
    // or is cancelled (checked every 20 ms against the live quote), or null.
    async waitForUpdate(_client, appOrderId, ms, since = 0) {
      const o = orders.get(String(appOrderId));
      const end = Date.now() + Math.max(0, ms);
      while (o) {
        evaluate(o);
        if (o.OrderStatus !== "New" && o.updatedAt > since) return publicView(o);
        const left = end - Date.now();
        if (left <= 0) break;
        await new Promise(r => setTimeout(r, Math.min(20, left)));
      }
      return null;
    },

    async cancelOrder(_client, appOrderId) {
      const o = orders.get(String(appOrderId));
      if (!o) throw rejection(`Unknown order ${appOrderId}`);
      evaluate(o); // it may have just filled
      if (o.OrderStatus !== "New") throw rejection(`Order ${appOrderId} is already ${o.OrderStatus}`);
      o.OrderStatus = "Cancelled";
      snap(o);
      return {};
    },
  };

  return { api, orders: () => [...orders.values()].map(publicView) };
}

module.exports = { createPaperBroker };
