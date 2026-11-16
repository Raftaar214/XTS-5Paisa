// orderGuard.js — keeps broker traffic calm and bounded, per client.
//
//   - Orders (place / cancel) for the same client go out one at a time,
//     at least `minGapMs` apart (default 110 ms ~ 9/s; the broker allows
//     10 orders/s for non-algo apps), so a burst never trips the broker limit.
//   - Order-status polls are spaced at least `pollGapMs` apart.
//   - Circuit breaker: more than `maxOrdersPerMinute` orders for one client
//     inside 60 s is refused BEFORE it reaches the broker. The refusal looks
//     like a broker rejection (HTTP 429), so the execution engine treats it
//     as definite — never as an unknown outcome — and `onTrip` lets the
//     strategy runner pause whatever caused it.
//
// Every broker call in xtsApi.js passes through the shared guard below.

const sleep = ms => new Promise(r => setTimeout(r, ms));

function createOrderGuard({
  minGapMs = 150,
  pollGapMs = 100,
  getMaxPerMinute = () => 0,
  onTrip = () => {},
} = {}) {
  const lanes = new Map();   // `${kind}:${clientId}` -> { nextAt, chain }
  const sent  = new Map();   // clientId -> [timestamps of orders in the last minute]

  function lane(key, gapMs) {
    let l = lanes.get(key);
    if (!l) { l = { nextAt: 0, chain: Promise.resolve() }; lanes.set(key, l); }
    const turn = l.chain.then(async () => {
      const wait = l.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      l.nextAt = Date.now() + gapMs;
    });
    l.chain = turn.catch(() => {});
    return turn;
  }

  function recent(clientId) {
    const cutoff = Date.now() - 60_000;
    const list = (sent.get(clientId) || []).filter(t => t > cutoff);
    sent.set(clientId, list);
    return list;
  }

  // minGapMs may be a number or a function (read live from admin settings).
  const orderGap = () => Math.max(0, Number(typeof minGapMs === "function" ? minGapMs() : minGapMs) || 0);

  async function beforeOrder(clientId) {
    const id = String(clientId || "unknown");
    await lane(`order:${id}`, orderGap());
    const max = Number(getMaxPerMinute()) || 0;
    const list = recent(id);
    if (max > 0 && list.length >= max) {
      const msg = `Order rate limit: ${max} orders per minute reached for client ${id} — refused before sending`;
      try { onTrip(id, msg); } catch (_) {}
      throw Object.assign(new Error(msg), {
        response: { status: 429, data: { description: msg } },
        rateLimited: true,
      });
    }
    list.push(Date.now());
  }

  async function beforePoll(clientId) {
    await lane(`poll:${String(clientId || "unknown")}`, pollGapMs);
  }

  function stats(clientId) {
    return { ordersLastMinute: recent(String(clientId)).length };
  }

  return { beforeOrder, beforePoll, stats };
}

// Shared instance used by xtsApi.js. Limits come from Admin -> Execution & Limits.
let shared = null;
const tripListeners = new Set();
function getSharedGuard() {
  if (!shared) {
    const settings = require("./settings");
    shared = createOrderGuard({
      // Admin -> Execution & Limits -> order spacing (ORDER_MIN_GAP_MS overrides)
      minGapMs:  () => Number(process.env.ORDER_MIN_GAP_MS || settings.getSettings().engine.orderGapMs || 110),
      pollGapMs: Number(process.env.ORDER_POLL_GAP_MS || 100),
      getMaxPerMinute: () => settings.getSettings().limits.maxOrdersPerMinute,
      onTrip: (id, msg) => tripListeners.forEach(fn => { try { fn(id, msg); } catch (_) {} }),
    });
  }
  return shared;
}
function onOrderGuardTrip(fn) { tripListeners.add(fn); return () => tripListeners.delete(fn); }

module.exports = { createOrderGuard, getSharedGuard, onOrderGuardTrip };
