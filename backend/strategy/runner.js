// strategy/runner.js — runs assigned strategies automatically.
//
// A one-second tick, in IST, for every assignment that is not STOPPED:
//
//   1. New IST day -> reset the day's slots and daily-loss halts.
//   2. Settle positions whose expiry has passed (15:30 IST on expiry day).
//   3. During market hours: per-leg stops, intraday time exit, square-off
//      requests and the per-client daily loss limit (risk-reducing exits run
//      even while trading is halted or the strategy is paused).
//   4. RUNNING only: on an entry day (DTE from the instrument master's
//      expiry dates) each schedule slot fires once — strikes picked by
//      delta / ATM offset / premium, lots × each client's multiplier.
//      Slots that passed while the runner was off are skipped, never fired late.
//
// PAPER mode fills at the live bid/ask and sends nothing to the broker.
// LIVE mode goes through the execution engine (index.js) and order guard.
// State is saved atomically after every change; every fill and decision is
// written to the journal. Statuses: STOPPED · RUNNING · STOPPING · PAUSED.

const ist = require("./ist");
const chainLib = require("./chain");
const greeks = require("./greeks");

const SLOT_GRACE_MS   = 120_000; // a slot this late (e.g. after a restart) is skipped
const WINDOW_STRIKES  = 25;      // strikes each side of ATM kept subscribed
const EXIT_RETRY_MS   = 30_000;
const PRUNE_DAYS      = 7;

const round2 = x => Math.round(x * 100) / 100;
const QUOTE_MAX_AGE_MS = 60_000; // older prices are not traded on
const FILLED = ["FILLED", "PARTIAL"];

function createRunner(deps) {
  const {
    store, journal, now = Date.now,
    getInstruments, getQuotes, subscribe, unsubscribe,
    clientsFor, executeLegs, executePaperLegs, getSettings, marketHealthy = () => true,
    // Was this token's quote sent by the broker within maxAgeMs? (Marketsocket.isFresh)
    isFresh = () => true,
    // Client sizing outside any strategy allocation (server: multiplier or capital / base).
    clientFactor = c => (Number(c.multiplier) > 0 ? Number(c.multiplier) : 1),
  } = deps;

  const entering  = new Set();          // assignment ids with an entry in flight
  const exiting   = new Set();          // position ids with an exit in flight
  const subscribed = new Map();         // assignment id -> Set(token)
  const lastPrewarm = new Map();        // assignment id -> ms
  const noted     = new Map();          // de-duplication of repeated warnings
  let expiryCache = { ref: null, map: new Map() };
  let chainCache  = { ref: null, map: new Map() };

  // helpers
  const owner = a => `strategy:${a.id}`;

  // PAPER and LIVE share the execution engine; only the broker differs.
  const executorFor = mode => (mode === "LIVE" ? executeLegs : executePaperLegs);
  // Global PAPER (Admin -> Execution & Limits) makes every assignment paper.
  const modeOf = a => ((getSettings() || {}).tradingMode === "LIVE" && a.mode === "LIVE" ? "LIVE" : "PAPER");
  const latencyFields = l => (l ? { queueMs: l.queueMs, ackMs: l.ackMs, fillMs: l.fillMs, totalMs: l.totalMs } : {});

  function event(a, s, level, message, extra = {}) {
    journal.appendEvent({ level, user: a.username, strategy: s?.name, assignmentId: a.id, message, ...extra }, now());
  }
  function eventOnce(key, ms, a, s, level, message) {
    const t = noted.get(key);
    if (t && now() - t < ms) return;
    noted.set(key, now());
    event(a, s, level, message);
  }

  function instruments() { return getInstruments() || []; }
  const holidays = () => (getSettings() || {}).holidays || [];

  // Mark price of an option for stops and P&L: the last traded price, unless
  // it is outside the live bid/ask (an old trade on an illiquid strike) —
  // then the mid. Old quotes (not sent for 60 s) give no mark.
  function markOf(quotes, token) {
    const q = quotes[token];
    if (!q || !isFresh(token, QUOTE_MAX_AGE_MS)) return 0;
    const ltp = Number(q.ltp || 0), bid = Number(q.bid || 0), ask = Number(q.ask || 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
    if (ltp > 0 && (!mid || (ltp >= bid && ltp <= ask))) return ltp;
    return mid || ltp;
  }

  function expiriesFor(sym, fromDate) {
    const ins = instruments();
    if (expiryCache.ref !== ins) expiryCache = { ref: ins, map: new Map() };
    const key = `${sym.underlying}|${sym.segment}|${fromDate}`;
    if (!expiryCache.map.has(key)) expiryCache.map.set(key, chainLib.listExpiries(ins, sym.underlying, sym.segment, fromDate));
    return expiryCache.map.get(key);
  }

  function chainFor(sym, expiry, today) {
    const ins = instruments();
    if (chainCache.ref !== ins) chainCache = { ref: ins, map: new Map() };
    const key = `${sym.underlying}|${sym.segment}|${expiry}|${today}`;
    if (!chainCache.map.has(key)) chainCache.map.set(key, chainLib.buildChain(ins, sym.underlying, sym.segment, expiry, today));
    return chainCache.map.get(key);
  }

  function planFor(spec, sym, date) {
    const expiry = chainLib.pickExpiry(expiriesFor(sym, date), spec.expiryWhich);
    if (!expiry) return { sym, expiry: null, dte: null, entryDay: false };
    const dte = ist.tradingDaysBetween(date, expiry, holidays());
    return { sym, expiry, dte, entryDay: ist.isTradingDay(date, holidays()) && spec.entryDte.includes(dte) };
  }

  const isOpen = p => p.status === "OPEN";
  const hasOpen = run => run.positions.some(isOpen);

  function rollDay(run, today) {
    if (run.day === today) return false;
    run.day = today;
    run.slotsDone = [];
    run.haltedClients = [];
    const cutoff = ist.addDays(today, -PRUNE_DAYS);
    run.positions = run.positions.filter(p => isOpen(p) || p.status === "CHECK" || (p.exitDate || p.entryDate) >= cutoff);
    return true;
  }

  async function ensureSubscribed(a, tokens, segment) {
    const have = subscribed.get(a.id) || new Set();
    const fresh = [...new Set(tokens.map(String))].filter(t => !have.has(t));
    if (!fresh.length) return;
    fresh.forEach(t => have.add(t));
    subscribed.set(a.id, have);
    await subscribe(fresh, fresh.map(() => segment), owner(a));
  }

  async function releaseSubscriptions(a) {
    const have = subscribed.get(a.id);
    subscribed.delete(a.id);
    if (have && have.size) await unsubscribe([...have], owner(a));
  }

  function pause(a, s, run, reason) {
    if (run.status === "PAUSED") return;
    run.pausedFrom = run.status;
    run.status = "PAUSED";
    run.pausedReason = reason;
    store.saveRun(run);
    event(a, s, "error", `Paused: ${reason}`);
  }

  function pnlOf(p, price) {
    return round2((p.side === "SELL" ? p.entryPrice - price : price - p.entryPrice) * p.qty);
  }

  function recordTrade(a, s, p, side, qty, price, reason, extra = {}) {
    journal.appendTrade({
      source: "STRATEGY", mode: p.mode, user: a.username, strategy: s?.name, assignmentId: a.id,
      symbol: p.symbol, client: p.client, clientName: p.clientName, tradingSymbol: p.tradingSymbol,
      token: p.token, side, qty, price, reason, status: "FILLED", ...extra,
    }, now());
  }

  // Every attempt's order ID is kept (orderIds), so a broker check after a
  // restart can tell our own fills from unknown ones.
  const orderIdsOf = attempts => (attempts || []).map(x => x && x.orderId).filter(Boolean).join(" ");

  function closePosition(a, s, run, p, price, reason, orderId, latency, attempts) {
    const t = now();
    p.status     = reason === "EXPIRY" ? "EXPIRED" : "CLOSED";
    p.exitPrice  = round2(price);
    p.exitTime   = new Date(t).toISOString();
    p.exitDate   = ist.parts(t).date;
    p.exitReason = reason;
    p.exitOrderId = orderId || "";
    p.pnl        = pnlOf(p, price);
    recordTrade(a, s, p, p.side === "SELL" ? "BUY" : "SELL", p.qty, p.exitPrice, reason, {
      pnl: p.pnl, orderId: orderId || "", orderIds: orderIdsOf(attempts), status: reason === "EXPIRY" ? "SETTLED" : "FILLED",
      ...latencyFields(latency),
    });
  }

  // settlement
  // Settlement price of an expired option, best source first:
  //   1. its own last traded price (live quote);
  //   2. intrinsic value from the underlying futures price (CE: F-K, PE: K-F);
  //   3. the last good price seen on expiry day;
  //   4. nothing -> keep it open and try again (never settle at 0 by default).
  function settlementPrice(pos, quotes, p) {
    const live = Number(quotes[pos.token]?.ltp || 0);
    if (live > 0) return { price: live, how: "last traded price" };
    const chain = chainFor({ underlying: pos.symbol, segment: pos.segment }, pos.expiry, pos.expiry);
    const fq = chain.future ? quotes[chain.future.token] : null;
    const F = chainLib.mid(fq) || Number(fq?.ltp || 0);
    if (F > 0) {
      const k = Number(pos.strike);
      const intrinsic = Math.max(0, pos.type === "CE" ? F - k : k - F);
      return { price: round2(intrinsic), how: pos.expiry === p.date ? "intrinsic value from the futures price" : "approximate intrinsic value (settled late)" };
    }
    if (pos.lastPrice > 0 && pos.lastPriceDate === pos.expiry) return { price: pos.lastPrice, how: "last price seen on expiry day" };
    if (chain.future) ensureSubscribed({ id: `settle:${pos.symbol}` }, [chain.future.token], pos.segment).catch(() => {});
    return null;
  }

  function settleExpired(a, s, run, p) {
    let changed = false;
    const quotes = getQuotes() || {};
    for (const pos of run.positions) {
      if (!isOpen(pos) || exiting.has(pos.id)) continue;
      const due = pos.expiry < p.date || (pos.expiry === p.date && p.minutes >= ist.MARKET_CLOSE);
      if (!due) continue;
      const sp = settlementPrice(pos, quotes, p);
      if (!sp) {
        eventOnce(`settle:${pos.id}`, 10 * 60_000, a, s, "warn",
          `Cannot settle ${pos.client} ${pos.tradingSymbol} yet — no price for the option or its future; trying again`);
        continue;
      }
      closePosition(a, s, run, pos, sp.price, "EXPIRY");
      event(a, s, "info", `Expiry: ${pos.client} ${pos.tradingSymbol} settled at ${sp.price} (${sp.how})`);
      changed = true;
    }
    return changed;
  }

  // exits
  async function exitPositions(a, s, run, list) {
    if (!list.length) return;
    list.forEach(([p]) => exiting.add(p.id));
    try {
      const byClient = new Map();   // "mode|client" -> items
      list.forEach(item => {
        const key = `${item[0].mode === "LIVE" ? "LIVE" : "PAPER"}|${item[0].client}`;
        if (!byClient.has(key)) byClient.set(key, []);
        byClient.get(key).push(item);
      });
      const clientMap = new Map((clientsFor(a) || []).filter(Boolean).map(c => [c.id, c]));

      for (const [key, items] of byClient) {
        const [mode, clientId] = key.split("|");
        const client = clientMap.get(clientId) || (mode === "PAPER" ? { id: clientId, name: items[0][0].clientName } : null);
        if (mode === "LIVE" && (!client || !client.isLogged)) {
          items.forEach(([p]) => { p.exitRetryAt = now() + EXIT_RETRY_MS; });
          eventOnce(`exit-login:${a.id}:${clientId}`, 60_000, a, s, "error",
            `Cannot exit ${items.length} position(s) for ${clientId}: client is not logged in — log it in now`);
          continue;
        }
        // Exact quantity: lots=1 × lot_size=qty, and multiplier 1 so it is not applied twice.
        const legs = items.map(([p]) => ({
          segment: p.segment, symbol: p.symbol, type: p.type, strike: String(p.strike), expiry: p.expiry,
          exchange_token: p.token, lots: 1, lot_size: p.qty, side: p.side === "SELL" ? "Buy" : "Sell",
        }));
        let results = [];
        try {
          results = await executorFor(mode)(legs, [{ ...client, multiplier: 1 }], `${s?.name} exit`);
        } catch (err) {
          items.forEach(([p]) => { p.exitRetryAt = now() + EXIT_RETRY_MS; });
          event(a, s, "error", `Exit failed for ${clientId}: ${err.message} — will retry`);
          continue;
        }
        for (const [p, reason] of items) {
          const r = results.find(x => String(x.token) === String(p.token)) || {};
          const filled = Number(r.filledQty || 0);
          if (r.status === "FILLED" || filled >= p.qty) {
            closePosition(a, s, run, p, Number(r.avgPrice || 0), reason, r.orderId, r.latency, r.attempts);
          } else if (r.status === "MANUAL_CHECK") {
            p.status = "CHECK";
            p.checkReason = r.error || "exit outcome unknown";
            pause(a, s, run, `Exit order needs a manual check (${clientId} ${p.tradingSymbol}): ${p.checkReason}`);
          } else if (filled > 0) {
            // partial exit: book what filled, keep the rest open and retry
            const rest = { ...p };
            p.qty = filled;
            closePosition(a, s, run, p, Number(r.avgPrice || 0), reason, r.orderId, r.latency, r.attempts);
            run.positions.push({ ...rest, id: store.newId("pos"), qty: rest.qty - filled, exitRetryAt: now() + EXIT_RETRY_MS });
            event(a, s, "warn", `Partial exit ${filled}/${rest.qty} for ${clientId} ${p.tradingSymbol} — retrying the rest`);
          } else {
            p.exitRetryAt = now() + EXIT_RETRY_MS;
            event(a, s, "error", `Exit not filled for ${clientId} ${p.tradingSymbol} (${r.status || "no result"}${r.error ? `: ${r.error}` : ""}) — retrying in 30s`);
          }
        }
      }
    } finally {
      list.forEach(([p]) => exiting.delete(p.id));
      store.saveRun(run);
    }
  }

  // monitoring (stops, time exit, square-off, daily loss)
  function monitor(a, s, run, p) {
    const spec = s.spec;
    const quotes = getQuotes() || {};
    const t = now();
    const ready = run.positions.filter(x => isOpen(x) && !exiting.has(x.id) && !(x.exitRetryAt > t));
    const reasons = new Map();
    const want = (pos, reason) => { if (!reasons.has(pos.id)) reasons.set(pos.id, [pos, reason]); };

    if (run.squareOffRequested) ready.forEach(x => want(x, "SQUARE_OFF"));

    if (spec.exit.intradayAt && p.minutes >= ist.toMinutes(spec.exit.intradayAt)) {
      ready.filter(x => x.entryDate === p.date).forEach(x => want(x, "TIME_EXIT"));
    }

    // Remember each open position's last good mark, for P&L when the feed is quiet.
    for (const pos of run.positions) {
      if (!isOpen(pos)) continue;
      const m = markOf(quotes, pos.token);
      if (m > 0) { pos.lastPrice = round2(m); pos.lastPriceDate = p.date; }
    }

    for (const pos of ready) {
      if (!(pos.stopPrice > 0)) continue;
      const mark = markOf(quotes, pos.token);
      if (!(mark > 0)) continue;
      if (pos.side === "SELL" ? mark >= pos.stopPrice : mark <= pos.stopPrice) want(pos, "STOP");
    }

    // Daily loss per client: capital × client multiplier × pct.
    if (spec.dailyLossPct && a.capital > 0) {
      const byClient = new Map();
      for (const pos of run.positions) {
        if (pos.entryDate !== p.date && pos.exitDate !== p.date && !isOpen(pos)) continue;
        if (!byClient.has(pos.client)) byClient.set(pos.client, { pnl: 0, mult: pos.multiplier || 1 });
        const agg = byClient.get(pos.client);
        if (isOpen(pos)) {
          // live mark, else the last good one — never count a leg as 0 loss for lack of a price
          const px = markOf(quotes, pos.token) || Number(pos.lastPrice || 0);
          agg.pnl += px > 0 ? pnlOf(pos, px) : 0;
        } else if (pos.exitDate === p.date) {
          agg.pnl += Number(pos.pnl || 0);
        }
      }
      for (const [clientId, agg] of byClient) {
        if (run.haltedClients.includes(clientId)) continue;
        const limit = a.capital * agg.mult * spec.dailyLossPct / 100;
        if (agg.pnl <= -limit) {
          run.haltedClients.push(clientId);
          store.saveRun(run);
          event(a, s, "error", `Daily loss limit hit for ${clientId}: ₹${round2(agg.pnl)} <= -₹${round2(limit)} (${spec.dailyLossPct}% of ₹${round2(a.capital * agg.mult)}) — squaring off, no more entries today`);
          run.positions.filter(x => x.client === clientId && isOpen(x) && !exiting.has(x.id)).forEach(x => want(x, "DAILY_LOSS"));
        }
      }
    }

    return reasons.size ? [exitPositions(a, s, run, [...reasons.values()])] : [];
  }

  // entries
  function dueSlots(a, s, run, t, p) {
    const due = [];
    let missed = 0;
    for (const sym of s.spec.symbols) {
      const plan = planFor(s.spec, sym, p.date);
      if (!plan.entryDay) continue;
      for (const g of s.spec.groups) {
        for (const slot of g.slots) {
          const key = `${sym.underlying}|${g.id}|${slot}`;
          if (run.slotsDone.includes(key)) continue;
          const slotMs = ist.timeOn(p.date, slot);
          if (slotMs > t) continue;
          run.slotsDone.push(key); // marked BEFORE trading: a crash can never fire it twice
          if (t - slotMs > SLOT_GRACE_MS) { missed++; continue; }
          due.push({ plan, group: g, slot });
        }
      }
    }
    if (missed) event(a, s, "warn", `Skipped ${missed} entry slot(s) that passed while the strategy was not running`);
    return { due, changed: due.length > 0 || missed > 0 };
  }

  async function prewarm(a, s, p) {
    const t = now();
    if (t - (lastPrewarm.get(a.id) || 0) < 60_000) return;
    lastPrewarm.set(a.id, t);
    const quotes = getQuotes() || {};
    for (const sym of s.spec.symbols) {
      const plan = planFor(s.spec, sym, p.date);
      if (!plan.entryDay) continue;
      const chain = chainFor(sym, plan.expiry, p.date);
      if (chain.future) await ensureSubscribed(a, [chain.future.token], sym.segment);
      const spot = chainLib.mid(quotes[chain.future?.token]);
      if (spot > 0) await ensureSubscribed(a, chainLib.windowTokens(chain, spot, WINDOW_STRIKES), sym.segment);
    }
  }

  async function enterSlot(a, s, run, { plan, group, slot }) {
    const spec = s.spec;
    const sym = plan.sym;
    const label = `${sym.underlying} ${group.id === "main" ? "" : `${group.id} `}${slot}`;
    const settings = getSettings();
    const mode = modeOf(a);
    if (Array.isArray(settings.allowedSegments) && !settings.allowedSegments.includes(sym.segment)) {
      event(a, s, "warn", `${label}: segment ${sym.segment} is not allowed for trading by the admin — skipped`);
      return;
    }

    if (mode === "LIVE" && settings.tradingHalted) { event(a, s, "warn", `Trading is halted by admin — ${label} entry skipped`); return; }
    // PAPER too: an entry on old prices would not match what LIVE could have done.
    if (!marketHealthy()) { event(a, s, "warn", `Market data is not live — ${label} entry skipped`); return; }

    const chain = chainFor(sym, plan.expiry, run.day);
    if (!chain.strikes.length) { event(a, s, "error", `No ${sym.underlying} options for expiry ${plan.expiry} — ${label} skipped`); return; }

    if (chain.future) await ensureSubscribed(a, [chain.future.token], sym.segment);
    let quotes = getQuotes() || {};
    const spot = chainLib.mid(quotes[chain.future?.token]);
    if (!(spot > 0)) { event(a, s, "error", `No ${sym.underlying} futures quote to locate ATM — ${label} skipped`); return; }
    await ensureSubscribed(a, chainLib.windowTokens(chain, spot, WINDOW_STRIKES), sym.segment);
    quotes = getQuotes() || {};

    const T = greeks.yearsToExpiry(now(), plan.expiry);
    const r = (spec.riskFreePct || 0) / 100;
    const { F, atm } = chainLib.forward(chain, quotes, spot, T, r);

    const picks = [];
    for (const leg of group.legs) {
      const pick = chainLib.selectStrike(chain, quotes, { F, T, r, atm }, leg.type, leg.strike);
      if (!pick.ok) { event(a, s, "warn", `${label}: ${pick.reason} — whole entry skipped`); return; }
      picks.push({ leg, pick, lots: leg.lots * sym.lotsPerEntry });
    }

    // Every leg must be priced off a fresh quote (sent within the last 60 s).
    const stale = picks.find(({ pick }) => !isFresh(pick.token, QUOTE_MAX_AGE_MS));
    if (stale) { event(a, s, "warn", `${label}: price for ${stale.pick.tradingSymbol} is old — whole entry skipped`); return; }

    const maxLots = Number(settings.limits?.maxLotsPerLeg || 0);
    const tooBig = picks.find(x => maxLots > 0 && x.lots > maxLots);
    if (tooBig) { event(a, s, "warn", `${label}: ${tooBig.lots} lots exceeds the admin limit of ${maxLots} per leg — skipped`); return; }

    let cls = (clientsFor(a) || []).filter(Boolean).filter(c => c.enabled && !run.haltedClients.includes(c.id));
    if (mode === "LIVE") {
      const off = cls.filter(c => !(c.isLogged && c.isConnected));
      if (off.length) event(a, s, "warn", `${label}: skipped ${off.map(c => c.id).join(", ")} — not logged in and connected`);
      cls = cls.filter(c => c.isLogged && c.isConnected);
    }
    if (!cls.length) { event(a, s, "warn", `${label}: no eligible clients — skipped`); return; }

    // Lots per client: the strategy allocation for that client (₹ / strategy capital),
    // else the client's normal sizing. 0 -> this client sits this strategy out.
    const factorOf = c => {
      const alloc = a.allocations?.[c.id];
      if (alloc !== undefined && alloc !== null && a.capital > 0) return alloc / a.capital;
      return clientFactor(c);
    };
    const sized = cls.map(c => ({ ...c, multiplier: factorOf(c) }));
    const sittingOut = sized.filter(c => !(c.multiplier > 0));
    if (sittingOut.length) event(a, s, "info", `${label}: ${sittingOut.map(c => c.id).join(", ")} not trading this strategy (no capital allocated)`);
    cls = sized.filter(c => c.multiplier > 0);
    if (!cls.length) { event(a, s, "warn", `${label}: no client has capital allocated — skipped`); return; }

    const t = now();
    const entryDate = ist.parts(t).date;
    const opened = new Map(); // client id -> positions opened by this slot
    const addPosition = (client, { leg, pick }, qty, price, orderId, latency, attempts) => {
      const side = leg.action;
      const stopPrice = spec.stop.mode === "per_leg"
        ? round2(side === "SELL" ? price * spec.stop.multiplier : price / spec.stop.multiplier)
        : null;
      const pos = {
        id: store.newId("pos"),
        client: client.id, clientName: client.name, multiplier: Number(client.multiplier) > 0 ? Number(client.multiplier) : 1,
        symbol: sym.underlying, segment: sym.segment, expiry: plan.expiry,
        token: pick.token, tradingSymbol: pick.tradingSymbol, type: leg.type, strike: pick.strike,
        side, qty, lotSize: pick.lotSize, entryPrice: round2(price), stopPrice,
        entryTime: new Date(t).toISOString(), entryDate, group: group.id, slot,
        delta: pick.delta != null ? round2(pick.delta) : null,
        mode, orderId: orderId || "", status: "OPEN",
      };
      run.positions.push(pos);
      if (!opened.has(client.id)) opened.set(client.id, []);
      opened.get(client.id).push(pos);
      pos.orderIds = orderIdsOf(attempts);
      recordTrade(a, s, pos, side, qty, pos.entryPrice, `ENTRY ${group.id} ${slot}`, { orderId: pos.orderId, orderIds: pos.orderIds, ...latencyFields(latency) });
    };

    {
      const legs = picks.map(({ leg, pick, lots }) => ({
        segment: sym.segment, symbol: sym.underlying, type: leg.type, strike: String(pick.strike),
        expiry: plan.expiry, exchange_token: pick.token, lots, lot_size: pick.lotSize, tick_size: pick.tickSize,
        side: leg.action === "SELL" ? "Sell" : "Buy",
      }));
      let results = [];
      try {
        results = await executorFor(mode)(legs, cls, `${s.name} ${label}`);
      } catch (err) {
        event(a, s, "error", `${label}: execution error ${err.message}`);
        pause(a, s, run, `Execution error at ${label}: ${err.message}`);
        return;
      }
      const checks = [];
      for (const c of cls) {
        for (const x of picks) {
          const res = results.find(rr => rr.client === c.id && String(rr.token) === String(x.pick.token));
          if (!res) continue;
          const filled = Number(res.filledQty || 0);
          if (filled > 0 && (FILLED.includes(res.status) || res.status === "MANUAL_CHECK")) {
            addPosition(c, x, filled, Number(res.avgPrice || 0), res.orderId, res.latency, res.attempts);
          }
          if (res.status === "MANUAL_CHECK") checks.push(`${c.id} ${x.pick.tradingSymbol}: ${res.error || "unknown"}`);
          else if (res.status !== "FILLED") event(a, s, "error", `${label}: ${c.id} ${x.pick.tradingSymbol} ${res.status} ${filled}/${res.requestedQty ?? "?"} — ${res.error || ""}`);
        }
      }
      if (checks.length) pause(a, s, run, `Order needs a manual check — ${checks.join("; ")}`);

      // All or nothing per client: if any leg did not fill completely, close
      // the legs that did, so no unhedged (one-sided) position is left open.
      // A leg needing a manual check is left alone (its outcome is unknown).
      const unwind = [];
      for (const c of cls) {
        const mine = picks.map(x => results.find(rr => rr.client === c.id && String(rr.token) === String(x.pick.token)) || { status: "FAILED", filledQty: 0 });
        if (mine.some(r => r.status === "MANUAL_CHECK")) continue;
        const complete = mine.every(r => r.status === "FILLED");
        const posList = opened.get(c.id) || [];
        if (complete || !posList.length) continue;
        event(a, s, "warn", `${label}: ${c.id} entry incomplete (${mine.map(r => `${r.status} ${r.filledQty || 0}/${r.requestedQty ?? "?"}`).join(", ")}) — closing the filled legs so nothing is left unhedged`);
        posList.forEach(pos => unwind.push([pos, "UNWIND"]));
      }
      if (unwind.length) await exitPositions(a, s, run, unwind);
    }

    event(a, s, "info", `Entered ${label} (${mode}) for ${cls.map(c => c.id).join(", ")}: ` +
      picks.map(({ leg, pick, lots }) => `${leg.action} ${lots}L ${pick.tradingSymbol}${pick.delta != null ? ` delta ${round2(pick.delta)}` : ""} @${round2(pick.premium)}`).join(" | "));
  }

  async function enter(a, s, run, due) {
    try {
      for (const d of due) {
        if (run.status !== "RUNNING") break;
        try { await enterSlot(a, s, run, d); }
        catch (err) { event(a, s, "error", `Entry ${d.plan.sym.underlying} ${d.slot} failed: ${err.message}`); }
        store.saveRun(run);
      }
    } finally {
      store.saveRun(run);
    }
  }

  // the tick
  async function tick() {
    const t = now();
    const p = ist.parts(t);
    const work = [];
    const marketOpen = ist.isTradingDay(p.date, holidays()) && p.minutes >= ist.MARKET_OPEN && p.minutes < ist.MARKET_CLOSE;

    for (const a of store.listAssignments()) {
      const run = store.loadRun(a.id);
      if (run.status === "STOPPED") continue;
      const s = store.getStrategy(a.strategyId);
      if (!s?.spec) continue;
      try {
        let changed = rollDay(run, p.date);
        changed = settleExpired(a, s, run, p) || changed;

        if (marketOpen) {
          work.push(...monitor(a, s, run, p));
          if (run.status === "RUNNING" && a.enabled && !entering.has(a.id)) {
            work.push(prewarm(a, s, p).catch(() => {}));
            const { due, changed: slotChange } = dueSlots(a, s, run, t, p);
            if (slotChange) { changed = true; store.saveRun(run); }
            if (due.length) {
              entering.add(a.id);
              work.push(enter(a, s, run, due).finally(() => entering.delete(a.id)));
            }
          }
        }
        if (changed) store.saveRun(run);
      } catch (err) {
        eventOnce(`tick:${a.id}`, 60_000, a, s, "error", `Runner error: ${err.message}`);
      }
    }

    await Promise.all(work);

    // Finish stops once nothing is open or in flight.
    for (const a of store.listAssignments()) {
      const run = store.loadRun(a.id);
      if (run.status !== "STOPPING") continue;
      if (hasOpen(run) || entering.has(a.id) || run.positions.some(x => exiting.has(x.id))) continue;
      run.status = "STOPPED";
      run.squareOffRequested = false;
      run.stoppedAt = new Date(now()).toISOString();
      store.saveRun(run);
      event(a, store.getStrategy(a.strategyId), "info", "Strategy stopped");
      await releaseSubscriptions(a);
    }
  }

  // commands
  function load(id) {
    const a = store.getAssignment(id);
    if (!a) throw Object.assign(new Error("Assignment not found"), { status: 404 });
    const s = store.getStrategy(a.strategyId);
    return { a, s, run: store.loadRun(id) };
  }

  function start(id, by) {
    const { a, s, run } = load(id);
    if (!a.enabled) throw Object.assign(new Error("This assignment is disabled by the admin"), { status: 409 });
    if (!s?.spec) throw Object.assign(new Error("Strategy file is invalid — re-upload it"), { status: 409 });
    if (run.status === "RUNNING") return run;
    if (run.status === "PAUSED") throw Object.assign(new Error(`Paused: ${run.pausedReason} — review it, then press Resume`), { status: 409 });

    const t = now();
    const p = ist.parts(t);
    rollDay(run, p.date);
    // Slots before the start minute are skipped — never fired late. Only
    // slots that would really have traded (today is that symbol's entry day)
    // are reported as missed entries.
    const startMinute = ist.timeOn(p.date, p.hhmm);
    let skipped = 0;
    const skippedSyms = new Set();
    for (const sym of s.spec.symbols) {
      const entryDay = planFor(s.spec, sym, p.date).entryDay;
      for (const g of s.spec.groups) {
        for (const slot of g.slots) {
          const key = `${sym.underlying}|${g.id}|${slot}`;
          if (ist.timeOn(p.date, slot) < startMinute && !run.slotsDone.includes(key)) {
            run.slotsDone.push(key);
            if (entryDay) { skipped++; skippedSyms.add(sym.underlying); }
          }
        }
      }
    }
    run.status = "RUNNING";
    run.squareOffRequested = false;
    run.pausedReason = "";
    run.startedAt = new Date(t).toISOString();
    run.startedBy = by;
    store.saveRun(run);
    lastPrewarm.delete(a.id);
    event(a, s, "info", `Strategy started by ${by} (${modeOf(a)}${modeOf(a) !== a.mode ? " — global PAPER mode" : ""})${skipped ? ` — ${skipped} entry slot(s) earlier today were missed (${[...skippedSyms].join(", ")} entry day; started late)` : ""}`);
    return run;
  }

  function stop(id, by) {
    const { a, s, run } = load(id);
    if (run.status === "STOPPED") return run;
    run.status = "STOPPING";
    run.pausedReason = "";
    store.saveRun(run);
    event(a, s, "info", `Stop requested by ${by} — no new entries; open positions stay protected by their stops`);
    return run;
  }

  function squareOff(id, by) {
    const { a, s, run } = load(id);
    run.squareOffRequested = true;
    if (run.status !== "STOPPED") run.status = "STOPPING";
    run.pausedReason = "";
    store.saveRun(run);
    event(a, s, "warn", `Square off requested by ${by} — closing all open positions`);
    return run;
  }

  function resume(id, by) {
    const { a, s, run } = load(id);
    if (run.status !== "PAUSED") return run;
    run.status = run.pausedFrom === "STOPPING" ? "STOPPING" : "RUNNING";
    run.pausedReason = "";
    run.pausedFrom = null;
    store.saveRun(run);
    event(a, s, "info", `Resumed by ${by}`);
    return run;
  }

  function pauseForClient(clientId, reason) {
    for (const a of store.listAssignments()) {
      const run = store.loadRun(a.id);
      if (run.status !== "RUNNING" && run.status !== "STOPPING") continue;
      const uses = (clientsFor(a) || []).some(c => c && c.id === clientId);
      if (uses) pause(a, store.getStrategy(a.strategyId), run, reason);
    }
  }

  // After a restart: re-subscribe open positions so stops keep working.
  async function init() {
    for (const a of store.listAssignments()) {
      const run = store.loadRun(a.id);
      if (run.status === "STOPPED") continue;
      const s = store.getStrategy(a.strategyId);
      const openPos = run.positions.filter(p => isOpen(p) || p.status === "CHECK");
      const bySeg = new Map();
      openPos.forEach(p => {
        if (!bySeg.has(p.segment)) bySeg.set(p.segment, []);
        bySeg.get(p.segment).push(p.token);
        // the future too: it prices expiry settlement when the option has no quote
        const fut = chainFor({ underlying: p.symbol, segment: p.segment }, p.expiry, p.expiry).future;
        if (fut) bySeg.get(p.segment).push(fut.token);
      });
      for (const [seg, tokens] of bySeg) await ensureSubscribed(a, tokens, seg);
      event(a, s, "info", `Backend restarted — resuming (${run.status}, ${openPos.length} open position(s))`);
    }
  }

  // status for the UI
  function nextEntry(s, run, t) {
    const today = ist.parts(t).date;
    for (let i = 0, d = today; i < 30; i++, d = ist.addDays(d, 1)) {
      if (!ist.isTradingDay(d, holidays())) continue;
      const slots = [];
      for (const sym of s.spec.symbols) {
        if (!planFor(s.spec, sym, d).entryDay) continue;
        for (const g of s.spec.groups) for (const slot of g.slots) {
          if (d === today && (ist.timeOn(d, slot) <= t || run.slotsDone.includes(`${sym.underlying}|${g.id}|${slot}`))) continue;
          slots.push(slot);
        }
      }
      if (slots.length) return { date: d, slot: slots.sort()[0] };
    }
    return null;
  }

  function status(id) {
    const { a, s, run } = load(id);
    const t = now();
    const p = ist.parts(t);
    const quotes = getQuotes() || {};
    const symbols = s?.spec ? s.spec.symbols.map(sym => {
      const plan = planFor(s.spec, sym, p.date);
      return { underlying: sym.underlying, expiry: plan.expiry, dte: plan.dte, entryDay: plan.entryDay };
    }) : [];
    const next = s?.spec ? nextEntry(s, run, t) : null;

    const positions = run.positions.filter(x => isOpen(x) || x.status === "CHECK" || x.entryDate === p.date || x.exitDate === p.date)
      .map(x => {
        const ltp = Number(quotes[x.token]?.ltp || 0);
        return { ...x, ltp: ltp || null, unrealized: isOpen(x) && ltp > 0 ? pnlOf(x, ltp) : null };
      });
    const realized   = round2(positions.filter(x => x.exitDate === p.date).reduce((sum, x) => sum + Number(x.pnl || 0), 0));
    const unrealized = round2(positions.reduce((sum, x) => sum + Number(x.unrealized || 0), 0));
    const openCount  = positions.filter(isOpen).length;
    const checks     = positions.filter(x => x.status === "CHECK").length;

    let phase;
    if (run.status === "STOPPED") phase = "Stopped";
    else if (run.status === "PAUSED") phase = `Paused — ${run.pausedReason}`;
    else if (run.status === "STOPPING") phase = run.squareOffRequested
      ? `Squaring off ${openCount} position(s)…` : `Stopping — watching ${openCount} open position(s)`;
    else if (!next) phase = "Running — no entry day found in the next 30 days (check instruments)";
    else if (next.date === p.date) phase = `Running — next entry ${next.slot} today`;
    else phase = `Armed — next entry day ${next.date} at ${next.slot}`;

    return {
      assignmentId: a.id, strategyId: a.strategyId, strategyName: s?.name, username: a.username,
      mode: modeOf(a), assignedMode: a.mode, enabled: a.enabled, capital: a.capital,
      allocations: a.allocations || {}, clientIds: a.clientIds || [],
      status: run.status, phase, pausedReason: run.pausedReason,
      nextEntryDate: next?.date || null, nextEntrySlot: next?.slot || null,
      symbols, haltedClients: run.haltedClients,
      startedAt: run.startedAt, startedBy: run.startedBy,
      openPositions: openCount, needsCheck: checks,
      pnlToday: { realized, unrealized, total: round2(realized + unrealized) },
      positions,
    };
  }

  return { tick, start, stop, squareOff, resume, pauseForClient, init, status };
}

module.exports = { createRunner };
