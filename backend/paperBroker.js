// paperBroker.js — a simulated broker for PAPER trading.
//
// It speaks the same interface the execution engine uses for the real broker
// (placeOrder / getOrderHistory / getOrders / cancelOrder), so PAPER orders go
// through exactly the same marketable-limit logic as LIVE: price buffer, fill
// timeout, cancel, retry of the unfilled remainder, MANUAL_CHECK rules.
//
// Fill model: an open order fills as soon as the LIVE quote crosses its
// limit — a SELL when bid >= limit (at the bid), a BUY when ask <= limit (at
// the ask) — but only up to the size shown at that best price (bidQty /
// askQty from the feed). The rest waits for the next quote update, so a big
// order fills in parts, times out and is cancelled / retried like LIVE.
// A quote the broker has not sent for maxQuoteAgeMs (60 s) never fills
// anything: PAPER does not trade on old prices.
//
// Nothing here talks to any broker. Order IDs are PAPER-YYYYMMDD-XXXXXX.

const crypto = require("crypto");
const ist = require("./strategy/ist");

const KEEP_MS = 6 * 3600_000;

const rejection = message =>
  Object.assign(new Error(message), { response: { status: 400, data: { type: "error", description: message } } });

function createPaperBroker({ getQuotes, now = Date.now, maxQuoteAgeMs = 60_000 }) {
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

  const isOpen = o => o.OrderStatus === "New" || o.OrderStatus === "PartiallyFilled";

  function evaluate(o) {
    if (!isOpen(o)) return;
    const q = (getQuotes() || {})[o.token] || {};
    const seen = Number(q.seen || q.ts || 0);
    if (seen && now() - seen > maxQuoteAgeMs) return;          // old price: no fill
    if (seen && o.lastQuoteSeen === seen) return;              // this quote's size was already taken
    let px = 0, size = null;
    if (o.side === "SELL") { const bid = Number(q.bid || 0); if (bid > 0 && bid >= o.limit) { px = bid; size = q.bidQty; } }
    else                   { const ask = Number(q.ask || 0); if (ask > 0 && ask <= o.limit) { px = ask; size = q.askQty; } }
    if (!px) return;
    const left = o.qty - o.CumulativeQuantity;
    const avail = Number(size) > 0 ? Number(size) : left;      // size unknown: assume enough
    const fill = Math.min(left, avail);
    o.lastQuoteSeen = seen || null;
    o.OrderAverageTradedPrice = (o.OrderAverageTradedPrice * o.CumulativeQuantity + px * fill) / (o.CumulativeQuantity + fill);
    o.CumulativeQuantity += fill;
    o.LeavesQuantity = o.qty - o.CumulativeQuantity;
    o.OrderStatus = o.LeavesQuantity > 0 ? "PartiallyFilled" : "Filled";
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
      if (!isOpen(o)) throw rejection(`Order ${appOrderId} is already ${o.OrderStatus}`);
      o.OrderStatus = "Cancelled";                 // keeps any part already filled
      o.LeavesQuantity = 0;
      snap(o);
      return {};
    },
  };

  return { api, orders: () => [...orders.values()].map(publicView) };
}

module.exports = { createPaperBroker };
