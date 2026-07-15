/**
 * index.js — Marketable Limit Order (MLO) Execution Engine
 * =========================================================
 * Node.js port of execution.py (MarketableLimitEngine class)
 *
 * Exact Python → JS mapping:
 *   MarketableLimitEngine.execute()  → executeOneLeg()
 *   _marketable_limit_price()        → marketableLimitPrice()
 *   _query_status()                  → queryOrderStatus()
 *   XTSSession.place_order()         → placeOrder()    [xtsApi.js]
 *   XTSSession.cancel_order()        → cancelOrder()   [xtsApi.js]
 *   XTSSession.get_order_history()   → getOrderHistory() [xtsApi.js]
 *   time.sleep()                     → await sleep()
 *   threading.Thread                 → Promise.all()
 *
 * Flow per leg per client:
 *   attempt 1..max_retries+1:
 *     1. Fresh bid/ask/ltp from live feed
 *     2. Marketable LIMIT price = ask*(1+buf%) BUY | bid*(1-buf%) SELL
 *     3. Place LIMIT order → get AppOrderID
 *     4. Poll every 0.5s until FILLED or fill_timeout (3s)
 *     5. FILLED → return immediately
 *     6. Timeout + partial → cancel remaining, retry remaining qty only
 *     7. Rejected/error → log and retry
 *   Exhausted → PARTIAL (some filled) or FAILED (0 filled)
 *
 * Parent / Child multiplier:
 *   Every client (parent or child) fans out from the SAME leg spec.
 *   The parent always trades at 1x. Each child scales its own order
 *   quantity by its configured `multiplier` (set via User Management,
 *   e.g. a child with 2x the parent's capital gets 2x the quantity).
 */

const { v4: uuidv4 }                               = require("uuid");
const { placeOrder, cancelOrder, getOrders } = require("./xtsApi");
const { segmentToXTS }                             = require("./instrumentloader");
const { getLivePrices }                            = require("./Marketsocket");

// ─────────────────────────────────────────────────────────────
// Strategy presets  (mirrors OrderConfig._DEFAULTS in Python)
// ─────────────────────────────────────────────────────────────
const STRATEGY_PRESETS = {
  BFY:    { bufferPct: 0.50, fillTimeout: 4, maxRetries: 1 },
  LINEAR: { bufferPct: 0.50, fillTimeout: 4, maxRetries: 1 },
  SQOFF:  { bufferPct: 0.50, fillTimeout: 3, maxRetries: 0 },
  MANUAL: { bufferPct: 0.50, fillTimeout: 4, maxRetries: 1 },
};

const DEFAULT_CFG = {
  ...STRATEGY_PRESETS.BFY,
  pollInterval: 0.5,   // seconds between order-status polls
};


// Tick size per XTS segment  (mirrors TICK_SIZE in Python)
const TICK_SIZE = {
  NSEFO: 0.05, BSEFO: 0.05,
  NSECM: 0.05, BSECM: 0.05,
  MCXFO: 0.05,
};
const DEFAULT_TICK = 0.05;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Round to nearest tick (mirrors _round_to_tick in Python).
 * BUY  → CEIL  so we never undershoot the ask.
 * SELL → FLOOR so we never overshoot the bid.
 */
function roundToTick(price, direction = "CEIL", tick = 0.05) {
  if (!price || price <= 0) return tick;
  const f = 1 / tick;
  return direction === "CEIL"
    ? Math.ceil(price * f) / f
    : Math.floor(price * f) / f;
}

/**
 * Marketable limit price  (mirrors _marketable_limit_price in Python).
 * BUY  → ask*(1+buf%)  rounded CEIL  → hits best ask instantly
 * SELL → bid*(1-buf%)  rounded FLOOR → hits best bid instantly
 * Falls back to ltp when bid/ask is zero.
 */
function marketableLimitPrice(side, bid, ask, ltp, bufferPct, tick) {

    const buf = bufferPct / 100;

    if (side === "BUY") {

        const base = ask > 0 ? ask : ltp;

        if (base <= 0) {
            throw new Error(
                "Execution Aborted: Ask and LTP are zero (No valid market price)."
            );
        }

        return roundToTick(
            base * (1 + buf),
            "CEIL",
            tick
        );

    } else {

        const base = bid > 0 ? bid : ltp;

        if (base <= 0) {
            throw new Error(
                "Execution Aborted: Bid and LTP are zero (No valid market price)."
            );
        }

        return roundToTick(
            base * (1 - buf),
            "FLOOR",
            tick
        );

    }

}

// ─────────────────────────────────────────────────────────────
// Query single order status  (mirrors _query_status in Python)
// ─────────────────────────────────────────────────────────────
async function queryOrderStatus(client, appOrderId) {
  try {
    const orders = await getOrders(client);

    if (!orders || !orders.length) return null;

    const order = orders.find(
      o => String(o.AppOrderID) === String(appOrderId)
    );

    if (!order) {
      console.log(`[OrderBook] AppOrderID ${appOrderId} not found`);
      return null;
    }

    return {
      status: String(order.OrderStatus || "").toUpperCase(),
      filledQty: Number(order.CumulativeQuantity || 0),
      remainingQty: Number(order.LeavesQuantity || 0),
      avgPrice: Number(order.OrderAverageTradedPrice || 0),
      rejectReason: order.CancelRejectReason || "",
      order,
    };
  } catch (err) {
    console.error("[queryOrderStatus]", err.response?.data || err.message);
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
// executeOneLeg  —  single-leg MLO engine
// Exact port of MarketableLimitEngine.execute() from Python
// ─────────────────────────────────────────────────────────────
async function executeOneLeg(client, leg, cfg) {
  const token   = leg.exchange_token?.toString();
  const lots = parseInt(leg.lots || leg.quantity || 1);
const lotSize = parseInt(leg.lot_size || 1);

  // Child accounts scale every order by their configured Multiplier ×
  // (e.g. a child funded at 2x the parent's capital gets 2x the qty).
  // Parent is always 1x. Falls back to 1x if unset/invalid.
  const mult = Number(client.multiplier) > 0 ? Number(client.multiplier) : 1;

let qty;

if (leg.segment === "MCX") {
    // MCX orders should use lots directly
    qty = lots * mult;
} else {
    // NSE/BSE F&O use lot size
    qty = lots * lotSize * mult;
}
  const side    = (leg.side || "Buy").toUpperCase() === "BUY" ? "BUY" : "SELL";
  const seg     = leg.segment || "NSE_FO";
  const xts     = segmentToXTS(seg);
  const tick    = TICK_SIZE[xts] || DEFAULT_TICK;
  const label   = `${leg.symbol} ${leg.type} ${leg.strike || "FUT"}`;
  const startTime = Date.now();

  // Result object — updated throughout the loop
  const result = {
    client: client.id,
    clientName: client.name,

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

    error: ""
};

  if (!token || token === "Unknown Key") {
    result.status = "FAILED";
    result.error  = `${label}: invalid token`;
    result.executionTime = Date.now() - startTime;
    return result;
  }
  if (qty <= 0) {
    result.status = "FAILED";
    result.error  = `${label}: invalid quantity (lots=${lots} lotSize=${lotSize} mult=${mult})`;
    result.executionTime = Date.now() - startTime;
    return result;
  }

  let remaining     = qty;
  let totalFilled   = 0;
  let lastFillPrice = 0;
  let lastOrderId   = null;

  // ── Main retry loop (mirrors `while attempt <= cfg.max_retries` in Python) ──
  for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {

    // Step 1 — live feed (fresh bid/ask on every attempt, like Python `self._feed()`)
    const liveQuotes = getLivePrices();
    const q   = liveQuotes[token] || {};
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

    lmt = marketableLimitPrice(
        side,
        bid,
        ask,
        ltp,
        cfg.bufferPct,
        tick
    );

} catch (e) {

    result.status = "FAILED";
    result.error = e.message;
    result.executionTime = Date.now() - startTime;

    return result;

}
    const fillRef = side === "BUY" ? ask : bid;

    console.log(
      `[MLO] ${client.id} | ${label} | attempt ${attempt}/${cfg.maxRetries+1} | ` +
      `${side} qty=${remaining} | bid=${bid} ask=${ask} ltp=${ltp} | ` +
      `limit=${lmt} buf=${cfg.bufferPct}%`
    );

    const attemptLog = { attempt, side, qty: remaining, bid, ask, ltp, limitPrice: lmt };
    result.bid = bid;
result.ask = ask;
result.ltp = ltp;

    // Step 3 — place LIMIT order
    let appOrderId;

try {

    const orderUID = `MLO_${Date.now()}_${uuidv4().slice(0, 6)}`;

    const res = await placeOrder(client, {
        exchangeSegment: xts,
        exchangeInstrumentID: Number(token),

        productType: "NRML",
        orderType: "LIMIT",
        orderSide: side,

        timeInForce: "DAY",
        disclosedQuantity: 0,
        orderQuantity: remaining,

        limitPrice: lmt,
        stopPrice: 0,

        orderUniqueIdentifier: orderUID,
    });

    appOrderId = res?.AppOrderID || res?.OrderID || String(res);

    lastOrderId = appOrderId;

    attemptLog.orderId = appOrderId;

    result.orderId = appOrderId;
    result.orderUniqueIdentifier = orderUID;

    console.log(
        `[MLO] ${client.id} | Placed AppOrderID=${appOrderId} UID=${orderUID} lmt=${lmt}`
    );

} catch (err) {

    const msg = err.response?.data?.description || err.message;

    console.error(
        `[MLO] ${client.id} | Attempt ${attempt} REJECTED: ${msg}`
    );

    attemptLog.error = msg;
    attemptLog.status = "REJECTED";

    result.attempts.push(attemptLog);

    if (attempt > cfg.maxRetries) break;

    await sleep(cfg.pollInterval * 1000);

    continue;
}

    // Step 4 — poll for fill (mirrors `while time.monotonic() < deadline` in Python)
    const deadline  = Date.now() + cfg.fillTimeout * 1000;
    let filledHere  = 0;
    let avgPrice    = fillRef;
    let orderStatus = "OPEN";

    while (Date.now() < deadline) {
      await sleep(cfg.pollInterval * 1000);

      const st = await queryOrderStatus(client, appOrderId);
      if (!st) continue;

      filledHere  = st.filledQty;
      if (st.avgPrice > 0) avgPrice = st.avgPrice;
      orderStatus = st.status;

      console.log(
        `[MLO] ${client.id} | status=${orderStatus} ` +
        `filled=${filledHere}/${remaining} avg=${avgPrice.toFixed(2)}`
      );

      // Step 5a — FULLY FILLED (mirrors `if raw_status in ('FILLED'...):`)
      if (["FILLED","TRADED","COMPLETE","COMPLETED"].includes(orderStatus)) {
        totalFilled   += filledHere;
        lastFillPrice  = avgPrice;
        attemptLog.filledQty  = filledHere;
        attemptLog.avgPrice   = avgPrice;
        attemptLog.status     = "FILLED";
        result.attempts.push(attemptLog);

        console.log(
          `[MLO] ${client.id} | ✅ FILLED ${label} ` +
          `total=${totalFilled} avg=${lastFillPrice.toFixed(2)} AppOrderID=${appOrderId}`
        );

        result.filledQty    = totalFilled;
        result.remainingQty = qty - totalFilled;
        result.avgPrice     = lastFillPrice;
        result.orderId      = appOrderId;
        result.status       = "FILLED";
        result.success      = true;
        result.executionTime = Date.now() - startTime;
        return result;
      }

      // Cancelled / Rejected externally — stop polling
      // Order rejected → stop immediately (don't retry)
if (orderStatus === "REJECTED") {
  console.warn(
    `[MLO] ${client.id} | Order REJECTED AppOrderID=${appOrderId}`
  );

  attemptLog.status = "REJECTED";
  attemptLog.filledQty = filledHere;
  attemptLog.avgPrice = avgPrice;

  result.attempts.push(attemptLog);

  result.filledQty = totalFilled;
  result.remainingQty = remaining;
  result.avgPrice = lastFillPrice;
  result.orderId = appOrderId;
  result.status = "FAILED";
  result.success = false;
  result.error = "Order Rejected";
  result.executionTime = Date.now() - startTime;
  return result;
}

// Cancelled/Expired → allow retry
if (["CANCELLED", "EXPIRED"].includes(orderStatus)) {
  console.warn(
    `[MLO] ${client.id} | Order ${orderStatus} AppOrderID=${appOrderId}`
  );
  break;
}
    }

    // Step 5b — Timeout: account for partial fill, cancel remaining, retry
    // (mirrors `Step 5 — timeout: cancel + retry` in Python)
    totalFilled += filledHere;
    if (filledHere > 0) lastFillPrice = avgPrice;

    const stillOpen = remaining - filledHere;
    attemptLog.filledQty = filledHere;
    attemptLog.avgPrice  = avgPrice;
    attemptLog.remaining = stillOpen;

    if (stillOpen > 0 && !["CANCELLED","REJECTED","EXPIRED"].includes(orderStatus)) {
      // Cancel the unfilled part (mirrors `self._sess.cancel_order(oid)` in Python)
      console.log(
        `[MLO] ${client.id} | Timeout ${cfg.fillTimeout}s | ` +
        `filled=${filledHere} remaining=${stillOpen} — cancelling AppOrderID=${appOrderId}`
      );
      try {
    await cancelOrder(client, appOrderId);

    console.log(
        `[MLO] ${client.id} | Waiting for cancel confirmation AppOrderID=${appOrderId}`
    );

    let cancelConfirmed = false;

    // Wait up to 5 seconds for broker to confirm cancellation
    for (let i = 0; i < 10; i++) {
        await sleep(500);

        const st = await queryOrderStatus(client, appOrderId);

        if (!st) continue;

        console.log(
  `[CancelCheck] status=${st.status} filled=${st.filledQty} brokerRemaining=${st.remainingQty} retryRemaining=${stillOpen}`
);

        // Filled while cancel request was travelling
        if (["FILLED", "TRADED", "COMPLETE", "COMPLETED"].includes(st.status)) {

            totalFilled = Math.max(totalFilled, st.filledQty);

            result.filledQty = totalFilled;
            result.remainingQty = 0;
            result.avgPrice = st.avgPrice;
            result.orderId = appOrderId;
            result.status = "FILLED";
            result.success = true;
            result.executionTime = Date.now() - startTime;

            return result;
        }

        if (["CANCELLED", "EXPIRED"].includes(st.status)) {
            cancelConfirmed = true;
            remaining = stillOpen;
            break;
        }
    }

    if (!cancelConfirmed) {

    result.status = "MANUAL_CHECK";
    result.success = false;

    result.error =
        "Broker did not confirm cancellation. Verify order manually.";

    result.filledQty = totalFilled;
    result.remainingQty = stillOpen;
    result.avgPrice = lastFillPrice;
    result.orderId = appOrderId;
    result.executionTime = Date.now() - startTime;

    console.error(
        `[CRITICAL] ${client.id} | Broker did not confirm cancellation for AppOrderID=${appOrderId}`
    );

    return result;
}

    console.log(
        `[MLO] ${client.id} | Cancel confirmed. Remaining=${remaining}`
    );

    attemptLog.cancelled = true;

} catch (cerr) {

    console.warn(
        `[MLO] ${client.id} | Cancel failed: ${cerr.message}`
    );

    attemptLog.cancelError = cerr.message;

    // STOP HERE — don't retry if cancel failed
    result.status = "FAILED";
    result.error = `Cancel failed: ${cerr.message}`;
    result.filledQty = totalFilled;
    result.remainingQty = stillOpen;
    result.avgPrice = lastFillPrice;
    result.orderId = appOrderId;
    result.executionTime = Date.now() - startTime;

    return result;

}

} else if (stillOpen === 0 && filledHere > 0) {

    attemptLog.status = "FILLED";
    result.attempts.push(attemptLog);

    result.filledQty = totalFilled;
    result.remainingQty = 0;
    result.avgPrice = lastFillPrice;
    result.orderId = appOrderId;
    result.status = "FILLED";
    result.success = true;
    result.executionTime = Date.now() - startTime;

    return result;

} else {

    remaining = stillOpen;

}

    attemptLog.status = filledHere > 0 ? "PARTIAL" : "PENDING";
    result.attempts.push(attemptLog);

    if (attempt > cfg.maxRetries) break;

    console.log(
      `[MLO] ${client.id} | ${label} | ` +
      `Retrying attempt ${attempt+1} with remaining qty=${remaining} …`
    );
    await sleep(2000); // brief pause between retries (mirrors `time.sleep(0.3)`)
  }

  // ── Exhausted all retries  (mirrors `final_status = 'PARTIAL' if ...` in Python)
  result.filledQty    = totalFilled;
  result.remainingQty = qty - totalFilled;
  result.avgPrice     = lastFillPrice;
  result.orderId      = lastOrderId;
  result.status       = totalFilled > 0 ? "PARTIAL" : "FAILED";
  result.success      = false;
  result.error        = result.status === "PARTIAL"
    ? `Partial: ${totalFilled}/${qty} filled after ${cfg.maxRetries+1} attempt(s)`
    : `Failed: 0/${qty} filled after ${cfg.maxRetries+1} attempt(s)`;

  console.log(
    `[MLO] ${client.id} | ${label} | Done | ` +
    `filled=${totalFilled}/${qty} status=${result.status}`
  );
  result.executionTime = Date.now() - startTime;
  return result;
}

// ─────────────────────────────────────────────────────────────
// executeOrderMulti  —  all legs × all clients, fully concurrent
// Mirrors LiveExecutor using threading.Thread for each leg in Python
// Fans out to EVERY active client — parent AND children — each one
// scaled by its own multiplier inside executeOneLeg() above.
// ─────────────────────────────────────────────────────────────
async function executeOrderMulti(legs, activeClients, cfg = DEFAULT_CFG) {
  const allResults = [];

  await Promise.all(
    activeClients.map(async client => {
      // All legs for this client fire concurrently (like Python threads)
      const legResults = await Promise.all(
        legs.map((leg, i) => executeOneLeg(client, { ...leg, legIndex: i + 1 }, cfg))
      );
      allResults.push(...legResults);
    })
  );

  return allResults;
}

module.exports = { executeOrderMulti, STRATEGY_PRESETS, DEFAULT_CFG };
