/**
 * index.js — Marketable Limit Order (MLO) Execution Engine
 * Node.js port of execution.py (MarketableLimitEngine class)
 *
 * Exact Python -> JS mapping:
 *   MarketableLimitEngine.execute()  -> executeOneLeg()
 *   _marketable_limit_price()        -> marketableLimitPrice()
 *   _query_status()                  -> queryOrderStatus()
 *   XTSSession.place_order()         -> placeOrder()    [xtsApi.js]
 *   XTSSession.cancel_order()        -> cancelOrder()   [xtsApi.js]
 *   XTSSession.get_order_history()   -> getOrderHistory() [xtsApi.js]
 *   time.sleep()                     -> await sleep()
 *   threading.Thread                 -> Promise.all()
 *
 * Flow per leg per client:
 *   attempt 1..maxRetries+1:
 *     1. Fresh bid/ask/ltp from live feed
 *     2. Marketable LIMIT price = ask*(1+buf%) BUY | bid*(1-buf%) SELL
 *     3. Risk limits (max qty / max order value) checked BEFORE placing
 *     4. Place LIMIT order -> get AppOrderID
 *     5. Poll order history every pollInterval until filled / dead / fillTimeout
 *     6. Timeout -> cancel, wait for the broker to confirm, then book the
 *        order's FINAL fill (fills that land while the cancel is in flight
 *        are counted) and retry only what is genuinely still unfilled
 *     7. Broker rejection (HTTP response) -> retry; placement error with NO
 *        response (timeout / network) -> stop, MANUAL_CHECK (the order may
 *        exist at the broker, so a retry could double the position)
 *   Exhausted -> PARTIAL (some filled) or FAILED (0 filled)
 *
 * Parent / Child multiplier:
 *   Every client (parent or child) fans out from the SAME leg spec.
 *   The parent always trades at 1x. Each child scales its own order
 *   quantity by its configured `multiplier` (set in the Admin console,
 *   e.g. a child with 2x the parent's capital gets 2x the quantity).
 */

const { v4: uuidv4 }                               = require("uuid");
const { segmentToXTS }                             = require("./instrumentloader");

// The broker the engine talks to is a parameter: the real XTS API for LIVE,
// the simulated paper broker for PAPER. Live modules are loaded only when
// first needed, so PAPER and tests have no side effects.
let liveApi = null;
function getLiveApi() {
  if (!liveApi) {
    const x = require("./xtsApi");
    liveApi = {
      placeOrder: x.placeOrder, cancelOrder: x.cancelOrder, getOrders: x.getOrders, getOrderHistory: x.getOrderHistory,
      // pushed order updates from the XTS Interactive socket (falls back to polling when absent)
      waitForUpdate: (_client, id, ms, since) => require("./orderStream").waitForOrderUpdate(id, ms, since),
    };
  }
  return liveApi;
}
const liveQuotes = () => require("./Marketsocket").getLivePrices();

// Strategy presets  (mirrors OrderConfig._DEFAULTS in Python)
const STRATEGY_PRESETS = {
  BFY:    { bufferPct: 0.50, fillTimeout: 4, maxRetries: 1 },
  LINEAR: { bufferPct: 0.50, fillTimeout: 4, maxRetries: 1 },
  SQOFF:  { bufferPct: 0.50, fillTimeout: 3, maxRetries: 0 },
  MANUAL: { bufferPct: 0.50, fillTimeout: 4, maxRetries: 1 },
};

const DEFAULT_CFG = {
  ...STRATEGY_PRESETS.BFY,
  pollInterval:  0.5,  // seconds between order-status polls
  cancelTimeout: 5,    // seconds to wait for the broker to confirm a cancel
  retryDelay:    2,    // seconds to pause between attempts
  limits: {},          // { maxQtyPerOrder, maxOrderValue } — 0/absent = no limit
};

// Tick size per XTS segment  (mirrors TICK_SIZE in Python)
const TICK_SIZE = {
  NSEFO: 0.05, BSEFO: 0.05,
  NSECM: 0.05, BSECM: 0.05,
  MCXFO: 0.05,
};
const DEFAULT_TICK = 0.05;

const FILLED_STATES = ["FILLED", "TRADED", "COMPLETE", "COMPLETED"];
const DEAD_STATES   = ["CANCELLED", "CANCELED", "EXPIRED", "REJECTED"];

// Helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Round to nearest tick (mirrors _round_to_tick in Python).
 * BUY  -> CEIL  so we never undershoot the ask.
 * SELL -> FLOOR so we never overshoot the bid.
 */
function roundToTick(price, direction = "CEIL", tick = 0.05) {
  if (!price || price <= 0) return tick;
  const f = 1 / tick;
  const v = direction === "CEIL"
    ? Math.ceil(price * f - 1e-9) / f
    : Math.floor(price * f + 1e-9) / f;
  return Math.round(v * 1e4) / 1e4; // no float noise like 101.55000000000001
}

/**
 * Marketable limit price  (mirrors _marketable_limit_price in Python).
 * BUY  -> ask*(1+buf%)  rounded CEIL  -> hits best ask instantly
 * SELL -> bid*(1-buf%)  rounded FLOOR -> hits best bid instantly
 * Falls back to ltp when bid/ask is zero.
 */
function marketableLimitPrice(side, bid, ask, ltp, bufferPct, tick) {
  const buf = bufferPct / 100;

  if (side === "BUY") {
    const base = ask > 0 ? ask : ltp;
    if (base <= 0) {
      throw new Error("Execution Aborted: Ask and LTP are zero (No valid market price).");
    }
    return roundToTick(base * (1 + buf), "CEIL", tick);
  }

  const base = bid > 0 ? bid : ltp;
  if (base <= 0) {
    throw new Error("Execution Aborted: Bid and LTP are zero (No valid market price).");
  }
  return roundToTick(base * (1 - buf), "FLOOR", tick);
}

// Order history is a list of state records for one order. XTS returns it
// oldest-first, but cumulative fill can only grow, so if the first record
// has a higher fill than the last the list must be newest-first.
function latestHistoryEntry(history) {
  const first = history[0];
  const last  = history[history.length - 1];
  const fq = Number(first.CumulativeQuantity || 0);
  const lq = Number(last.CumulativeQuantity || 0);
  const latest = fq > lq ? first : last;
  // Never report less filled than any record shows.
  const maxFilled = Math.max(...history.map(h => Number(h.CumulativeQuantity || 0)));
  return { ...latest, CumulativeQuantity: maxFilled };
}

function toStatus(order) {
  return {
    status: String(order.OrderStatus || "").toUpperCase(),
    filledQty: Number(order.CumulativeQuantity || 0),
    remainingQty: Number(order.LeavesQuantity || 0),
    avgPrice: Number(order.OrderAverageTradedPrice || 0),
    rejectReason: order.CancelRejectReason || "",
    order,
  };
}

// A pushed update is usable on its own only if it carries status and fill.
function pushedStatus(d) {
  if (!d || d.OrderStatus === undefined || d.CumulativeQuantity === undefined) return null;
  return toStatus(d);
}

// Query single order status  (mirrors _query_status in Python)
// Uses the per-order history endpoint (one small response for this order)
// instead of downloading the whole order book on every poll. Falls back to
// the order book only if history returns nothing for this AppOrderID.
async function queryOrderStatus(api, client, appOrderId) {
  try {
    let order = null;

    const history = await api.getOrderHistory(client, appOrderId);
    if (history && history.length) {
      order = latestHistoryEntry(history);
    } else {
      const orders = await api.getOrders(client);
      order = (orders || []).find(o => String(o.AppOrderID) === String(appOrderId)) || null;
    }

    if (!order) {
      console.log(`[OrderStatus] AppOrderID ${appOrderId} not found`);
      return null;
    }

    return toStatus(order);
  } catch (err) {
    console.error("[queryOrderStatus]", err.response?.data || err.message);
    return null;
  }
}

// executeOneLeg  —  single-leg MLO engine
// Port of MarketableLimitEngine.execute() from Python, with fill
// accounting that books each order's final fill exactly once.
async function executeOneLeg(client, leg, cfg, api) {
  const pollMs          = Number(cfg.pollInterval  ?? 0.5) * 1000;
  const cancelTimeoutMs = Number(cfg.cancelTimeout ?? 5)   * 1000;
  const retryDelayMs    = Number(cfg.retryDelay    ?? 2)   * 1000;
  const limits          = cfg.limits || {};

  const token   = leg.exchange_token?.toString();
  const lots    = parseInt(leg.lots || leg.quantity || 1);
  const lotSize = parseInt(leg.lot_size || 1);

  // Child accounts scale every order by their configured Multiplier ×
  // (e.g. a child funded at 2x the parent's capital gets 2x the qty).
  // Parent is always 1x. Falls back to 1x if unset/invalid.
  // Sizing factor for this client (Multiplier ×, or capital / base capital —
  // worked out by the caller). Unset means 1x; 0 means "too small".
  const mult = client.multiplier === undefined || client.multiplier === null || client.multiplier === ""
    ? 1 : Math.max(0, Number(client.multiplier) || 0);
  // Orders are whole lots: floor (default — never more than the ratio allows) or round.
  const rawLots = lots * mult;
  const effectiveLots = cfg.sizingRounding === "round" ? Math.round(rawLots) : Math.floor(rawLots + 1e-9);

  // MCX orders use lots directly; NSE/BSE F&O use lots × lot size.
  const qty = leg.segment === "MCX" ? effectiveLots : effectiveLots * lotSize;

  const side  = (leg.side || "Buy").toUpperCase() === "BUY" ? "BUY" : "SELL";
  const seg   = leg.segment || "NSE_FO";
  const xts   = segmentToXTS(seg);
  // The instrument's own tick (leg.tick_size, in rupees) — MCX contracts tick in ₹1,
  // currency in ₹0.0025 — falling back to the segment default.
  const legTick = Number(leg.tick_size);
  const tick  = legTick > 0 && legTick < 10000 ? legTick : (TICK_SIZE[xts] || DEFAULT_TICK);
  const segKey = seg === "MCX" ? "MCX_FO" : seg;
  const productType = cfg.products?.[segKey] || cfg.products?.default || "NRML";
  const label = `${leg.symbol} ${leg.type} ${leg.strike && leg.strike !== "N/A" ? leg.strike : "FUT"}`;
  const startTime = Date.now();
  // Latency, all in ms: queue = execute request -> first order sent; ack =
  // order sent -> broker accepted; fill = accepted -> fill seen; total =
  // execute request -> final fill (or end). cfg.startedAt = request arrival.
  const t0 = Number(cfg.startedAt) > 0 ? Number(cfg.startedAt) : startTime;
  let firstPlaceAt = null, firstAckMs = null, fillAckAt = null, lastFillAt = null;
  const quotesNow = () => (cfg.getQuotes ? cfg.getQuotes() : liveQuotes()) || {};

  // Next status of an order: wake on a pushed update if the broker offers
  // them (instant), otherwise after waitMs; fall back to a status poll.
  let pushedSince = 0;
  const nextStatus = async (id, waitMs) => {
    const ms = Math.max(0, waitMs);
    if (api.waitForUpdate) {
      const pushed = await api.waitForUpdate(client, id, ms, pushedSince);
      if (pushed) {
        pushedSince = Date.now();
        const st = pushedStatus(pushed);
        if (st) return st;
      }
    } else {
      await sleep(ms);
    }
    return queryOrderStatus(api, client, id);
  };

  const result = {
    client: client.id,
    clientName: client.name,
    label,

    // Instrument
    exchange: seg,
    symbol: leg.symbol || "",
    expiry: leg.expiry || "",
    strike: leg.strike || "",
    type: leg.type || "",
    token,

    // Order
    side,
    lots,
    lotSize,
    multiplier: mult,
    effectiveLots,

    requestedQty: qty,
    filledQty: 0,
    remainingQty: qty,
    avgPrice: 0,

    // Live quote
    bid: 0,
    ask: 0,
    ltp: 0,

    // Execution
    buffer: cfg.bufferPct,
    fillTimeout: cfg.fillTimeout,
    executionTime: 0,

    orderId: null,
    orderUniqueIdentifier: "",
    attempts: [],

    status: "PENDING",
    success: false,
    error: "",
  };

  let totalFilled = 0;   // across all attempts
  let filledValue = 0;   // sum fill × price, for a true average price
  let remaining   = qty;
  let lastOrderId = null;

  const finish = (status, error = "") => {
    result.filledQty     = totalFilled;
    result.remainingQty  = Math.max(0, qty - totalFilled);
    result.avgPrice      = totalFilled > 0 ? Math.round((filledValue / totalFilled) * 100) / 100 : 0;
    result.orderId       = lastOrderId;
    result.status        = status;
    result.success       = status === "FILLED";
    result.error         = error;
    result.executionTime = Date.now() - startTime;
    result.latency = {
      queueMs: firstPlaceAt !== null ? firstPlaceAt - t0 : null,
      ackMs:   firstAckMs,
      fillMs:  lastFillAt && fillAckAt ? lastFillAt - fillAckAt : null,
      totalMs: (lastFillAt || Date.now()) - t0,
    };
    return result;
  };

  // Book the FINAL fill of one dead/filled order — called exactly once per order.
  const book = (filled, price, seenAt, ackTime, log) => {
    if (filled > 0 && seenAt) {
      lastFillAt = seenAt;
      fillAckAt = ackTime;
      if (log && ackTime) log.fillMs = seenAt - ackTime;
    }
    totalFilled += filled;
    filledValue += filled * (price || 0);
    remaining = qty - totalFilled;
  };

  if (!token || token === "Unknown Key") return finish("FAILED", `${label}: invalid token`);
  if (effectiveLots < 1) {
    return finish("FAILED", `${label}: ${lots} lot(s) × ${Math.round(mult * 1000) / 1000} = ${Math.round(rawLots * 1000) / 1000} rounds to 0 lots — client too small for this order (check its capital / multiplier)`);
  }
  if (!(qty > 0)) return finish("FAILED", `${label}: invalid quantity (lots=${lots} lotSize=${lotSize} mult=${mult})`);

  if (Number(limits.maxQtyPerOrder) > 0 && qty > Number(limits.maxQtyPerOrder)) {
    return finish("FAILED", `Risk limit: quantity ${qty} exceeds the max ${limits.maxQtyPerOrder} per order`);
  }

  for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {

    // Step 1 — live feed (fresh bid/ask on every attempt)
    const q   = quotesNow()[token] || {};
    const bid = parseFloat(q.bid || leg.bid || 0);
    const ask = parseFloat(q.ask || leg.ask || 0);
    const ltp = parseFloat(q.ltp || leg.ltp || 0);

    if (!bid && !ask && !ltp) {
      const msg = `No live feed for ${label} token=${token} — aborting`;
      console.warn(`[MLO] ${client.id} | ${msg}`);
      result.attempts.push({ attempt, error: msg, status: "FAILED" });
      break;
    }

    // Step 2 — marketable limit price
    let lmt;
    try {
      lmt = marketableLimitPrice(side, bid, ask, ltp, cfg.bufferPct, tick);
    } catch (e) {
      return finish(totalFilled > 0 ? "PARTIAL" : "FAILED", e.message);
    }

    // Step 3 — order value limit, checked before anything is sent
    const orderValue = lmt * remaining;
    if (Number(limits.maxOrderValue) > 0 && orderValue > Number(limits.maxOrderValue)) {
      return finish(
        totalFilled > 0 ? "PARTIAL" : "FAILED",
        `Risk limit: order value ₹${orderValue.toFixed(2)} exceeds the max ₹${limits.maxOrderValue} per order`
      );
    }

    const fillRef = side === "BUY" ? ask : bid;

    console.log(
      `[MLO] ${client.id} | ${label} | attempt ${attempt}/${cfg.maxRetries + 1} | ` +
      `${side} qty=${remaining} | bid=${bid} ask=${ask} ltp=${ltp} | limit=${lmt} buf=${cfg.bufferPct}%`
    );

    const attemptLog = { attempt, side, qty: remaining, bid, ask, ltp, limitPrice: lmt };
    result.bid = bid; result.ask = ask; result.ltp = ltp;

    // Step 4 — place LIMIT order
    let appOrderId;
    let ackAt = null;
    const orderUID = `MLO_${Date.now()}_${uuidv4().slice(0, 6)}`;
    const placeAt = Date.now();
    if (firstPlaceAt === null) firstPlaceAt = placeAt;
    pushedSince = placeAt - 1;
    try {
      const res = await api.placeOrder(client, {
        exchangeSegment: xts,
        exchangeInstrumentID: Number(token),
        productType,
        orderType: "LIMIT",
        orderSide: side,
        timeInForce: "DAY",
        disclosedQuantity: 0,
        orderQuantity: remaining,
        limitPrice: lmt,
        stopPrice: 0,
        orderUniqueIdentifier: orderUID,
      });
      appOrderId = res?.AppOrderID ?? res?.OrderID ?? null;
      ackAt = Date.now();
      attemptLog.ackMs = ackAt - placeAt;
      if (firstAckMs === null) firstAckMs = attemptLog.ackMs;
    } catch (err) {
      const msg = err.response?.data?.description || err.message;
      attemptLog.error = msg;

      if (!err.response) {
        // Timeout / network failure: the broker may have accepted the order.
        // Retrying could double the position, so stop and ask for a manual check.
        attemptLog.status = "UNKNOWN";
        result.attempts.push(attemptLog);
        result.orderUniqueIdentifier = orderUID;
        console.error(`[MLO] ${client.id} | Attempt ${attempt} placement outcome UNKNOWN: ${msg}`);
        return finish(
          "MANUAL_CHECK",
          `Order placement outcome unknown (${msg}). Check the order book for UID ${orderUID} — no automatic retry was sent.`
        );
      }

      console.error(`[MLO] ${client.id} | Attempt ${attempt} REJECTED: ${msg}`);
      attemptLog.status = "REJECTED";
      result.attempts.push(attemptLog);
      if (attempt > cfg.maxRetries) break;
      await sleep(pollMs);
      continue;
    }

    result.orderUniqueIdentifier = orderUID;
    if (!appOrderId) {
      attemptLog.status = "UNKNOWN";
      result.attempts.push(attemptLog);
      return finish("MANUAL_CHECK", `Broker accepted the order but returned no AppOrderID. Check the order book for UID ${orderUID}.`);
    }

    lastOrderId = appOrderId;
    attemptLog.orderId = appOrderId;
    result.orderId = appOrderId;
    console.log(`[MLO] ${client.id} | Placed AppOrderID=${appOrderId} UID=${orderUID} lmt=${lmt}`);

    // Step 5 — poll for fill
    let filledHere   = 0;          // cumulative fill of THIS order (monotonic)
    let fillSeenAt   = null;       // when the latest fill was first seen
    let avgHere      = fillRef;
    let orderStatus  = "OPEN";
    let rejectReason = "";

    const observe = st => {
      if (st.filledQty > filledHere) { filledHere = st.filledQty; fillSeenAt = Date.now(); }
      if (st.avgPrice > 0) avgHere = st.avgPrice;
      orderStatus = st.status;
      if (st.rejectReason) rejectReason = st.rejectReason;
    };
    const orderDone = () =>
      FILLED_STATES.includes(orderStatus) || DEAD_STATES.includes(orderStatus) || filledHere >= remaining;

    const deadline = Date.now() + cfg.fillTimeout * 1000;
    while (Date.now() < deadline) {
      const st = await nextStatus(appOrderId, Math.min(pollMs, deadline - Date.now()));
      if (!st) continue;
      const before = `${orderStatus}|${filledHere}`;
      observe(st);
      if (before !== `${orderStatus}|${filledHere}`) {
        console.log(`[MLO] ${client.id} | status=${orderStatus} filled=${filledHere}/${remaining} avg=${Number(avgHere).toFixed(2)}`);
      }
      if (orderDone()) break;
    }

    // Broker rejected the order itself — stop, don't retry.
    if (orderStatus === "REJECTED") {
      book(filledHere, avgHere, fillSeenAt, ackAt, attemptLog);
      Object.assign(attemptLog, { status: "REJECTED", filledQty: filledHere, avgPrice: avgHere });
      result.attempts.push(attemptLog);
      console.warn(`[MLO] ${client.id} | Order REJECTED AppOrderID=${appOrderId}`);
      return finish(totalFilled > 0 ? "PARTIAL" : "FAILED", `Order Rejected${rejectReason ? `: ${rejectReason}` : ""}`);
    }

    // Step 6 — still working after the timeout -> cancel, then wait for the
    // broker to confirm, picking up any fills that land meanwhile.
    if (!orderDone()) {
      console.log(
        `[MLO] ${client.id} | Timeout ${cfg.fillTimeout}s | filled=${filledHere}/${remaining} — cancelling AppOrderID=${appOrderId}`
      );

      try {
        await api.cancelOrder(client, appOrderId);
      } catch (cerr) {
        // The cancel was refused — often because the order just filled.
        // Look once more; if it is not clearly finished, a human must check.
        console.warn(`[MLO] ${client.id} | Cancel failed: ${cerr.message}`);
        attemptLog.cancelError = cerr.message;
        const st = await queryOrderStatus(api, client, appOrderId);
        if (st) observe(st);
        if (FILLED_STATES.includes(orderStatus) || filledHere >= remaining) {
          book(filledHere, avgHere, fillSeenAt, ackAt, attemptLog);
          Object.assign(attemptLog, { status: "FILLED", filledQty: filledHere, avgPrice: avgHere });
          result.attempts.push(attemptLog);
          return finish(remaining <= 0 ? "FILLED" : "PARTIAL");
        }
        book(filledHere, avgHere, fillSeenAt, ackAt, attemptLog);
        Object.assign(attemptLog, { status: "UNKNOWN", filledQty: filledHere, avgPrice: avgHere });
        result.attempts.push(attemptLog);
        return finish("MANUAL_CHECK", `Cancel failed (${cerr.message}); the order may still be live. Verify AppOrderID ${appOrderId} manually.`);
      }

      let confirmed = false;
      const cancelDeadline = Date.now() + cancelTimeoutMs;
      while (Date.now() < cancelDeadline) {
        const st = await nextStatus(appOrderId, Math.min(pollMs, cancelDeadline - Date.now()));
        if (!st) continue;
        observe(st);
        console.log(`[CancelCheck] status=${st.status} filled=${filledHere} brokerRemaining=${st.remainingQty}`);
        if (FILLED_STATES.includes(orderStatus) || DEAD_STATES.includes(orderStatus)) {
          confirmed = true;
          break;
        }
      }

      if (!confirmed) {
        book(filledHere, avgHere, fillSeenAt, ackAt, attemptLog);
        Object.assign(attemptLog, { status: "UNKNOWN", filledQty: filledHere, avgPrice: avgHere });
        result.attempts.push(attemptLog);
        console.error(`[CRITICAL] ${client.id} | Broker did not confirm cancellation for AppOrderID=${appOrderId}`);
        return finish("MANUAL_CHECK", "Broker did not confirm cancellation. Verify order manually.");
      }

      attemptLog.cancelled = !FILLED_STATES.includes(orderStatus);
    }

    // The order is finished (filled, cancelled or expired): book its final fill once.
    book(filledHere, avgHere, fillSeenAt, ackAt, attemptLog);
    Object.assign(attemptLog, { filledQty: filledHere, avgPrice: avgHere, remaining: Math.max(0, remaining) });

    if (remaining <= 0) {
      attemptLog.status = "FILLED";
      result.attempts.push(attemptLog);
      console.log(`[MLO] ${client.id} | FILLED ${label} total=${totalFilled} AppOrderID=${appOrderId}`);
      return finish("FILLED");
    }

    attemptLog.status = filledHere > 0 ? "PARTIAL" : "UNFILLED";
    result.attempts.push(attemptLog);

    if (attempt > cfg.maxRetries) break;

    console.log(`[MLO] ${client.id} | ${label} | Retrying attempt ${attempt + 1} with remaining qty=${remaining} …`);
    await sleep(retryDelayMs);
  }

  // Exhausted all retries
  const status = totalFilled > 0 ? "PARTIAL" : "FAILED";
  console.log(`[MLO] ${client.id} | ${label} | Done | filled=${totalFilled}/${qty} status=${status}`);
  return finish(
    status,
    status === "PARTIAL"
      ? `Partial: ${totalFilled}/${qty} filled after ${result.attempts.length} attempt(s)`
      : `Failed: 0/${qty} filled after ${result.attempts.length} attempt(s)`
  );
}

// executeOrderMulti  —  all legs × all clients, fully concurrent
// Fans out to EVERY active client — parent AND children — each one
// scaled by its own multiplier inside executeOneLeg() above.
async function executeOrderMulti(legs, activeClients, cfg = DEFAULT_CFG, api = getLiveApi()) {
  const merged = { ...DEFAULT_CFG, ...cfg, limits: { ...(cfg.limits || {}) } };
  const allResults = [];

  await Promise.all(
    activeClients.map(async client => {
      const legResults = await Promise.all(
        legs.map((leg, i) => executeOneLeg(client, { ...leg, legIndex: i + 1 }, merged, api))
      );
      allResults.push(...legResults);
    })
  );

  return allResults;
}

module.exports = { executeOrderMulti, STRATEGY_PRESETS, DEFAULT_CFG };
