// strategy/chain.js — option chains from the instrument master, the forward
// from put-call parity, and strike selection by delta / ATM offset / premium.

const ist = require("./ist");
const greeks = require("./greeks");

const segOf = item => {
  const s = String(item.segment || "").toUpperCase();
  return s === "MCX" ? "MCX_FO" : s;
};
const isOption = item => item.instrument_type === "CE" || item.instrument_type === "PE";

// Sorted IST expiry dates (>= fromDate) of this underlying's options.
function listExpiries(instruments, underlying, segment, fromDate) {
  const set = new Set();
  for (const it of instruments) {
    if (it.asset_symbol !== underlying || segOf(it) !== segment || !isOption(it)) continue;
    const d = ist.dateOf(it.expiry);
    if (d && d >= fromDate) set.add(d);
  }
  return [...set].sort();
}

function pickExpiry(expiries, which) {
  if (!expiries.length) return null;
  if (which === "next_week") return expiries[1] || null;
  if (which === "monthly") {
    const month = expiries[0].slice(0, 7);
    const inMonth = expiries.filter(d => d.slice(0, 7) === month);
    return inMonth[inMonth.length - 1];
  }
  return expiries[0]; // current_week
}

function buildChain(instruments, underlying, segment, expiry, today) {
  const byStrike = {};
  let lotSize = null;
  let future = null;
  for (const it of instruments) {
    if (it.asset_symbol !== underlying || segOf(it) !== segment) continue;
    const d = ist.dateOf(it.expiry);
    if (it.instrument_type === "FUT" || it.instrument_type === "FO") {
      if (d && d >= today && (!future || d < future.expiry)) {
        future = { token: String(it.exchange_token), expiry: d, segment };
      }
      continue;
    }
    if (!isOption(it) || d !== expiry) continue;
    const k = Number(it.strike_price);
    if (!(k > 0)) continue;
    byStrike[k] = byStrike[k] || {};
    byStrike[k][it.instrument_type] = {
      token: String(it.exchange_token),
      strike: k,
      type: it.instrument_type,
      lotSize: Number(it.lot_size || 1),
      tickSize: Number(it.tick_size) > 0 ? Number(it.tick_size) / 100 : null, // master is in paise
      tradingSymbol: it.trading_symbol || `${underlying} ${k} ${it.instrument_type}`,
    };
    lotSize = lotSize || Number(it.lot_size || 1);
  }
  const strikes = Object.keys(byStrike).map(Number).sort((a, b) => a - b);
  // Most common gap between strikes (some chains add wider far strikes).
  const gaps = {};
  for (let i = 1; i < strikes.length; i++) {
    const g = +(strikes[i] - strikes[i - 1]).toFixed(2);
    gaps[g] = (gaps[g] || 0) + 1;
  }
  const step = Number(Object.entries(gaps).sort((a, b) => b[1] - a[1])[0]?.[0] || 0);
  return { underlying, segment, expiry, strikes, byStrike, lotSize, step, future };
}

function mid(q) {
  if (!q) return 0;
  const bid = Number(q.bid || 0), ask = Number(q.ask || 0), ltp = Number(q.ltp || 0);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return ltp > 0 ? ltp : 0;
}

function nearestStrike(chain, x) {
  let best = null;
  for (const k of chain.strikes) if (best === null || Math.abs(k - x) < Math.abs(best - x)) best = k;
  return best;
}

// Option tokens for strikes within ±n steps of `center` (both CE and PE).
function windowTokens(chain, center, n) {
  const i0 = chain.strikes.indexOf(nearestStrike(chain, center));
  const out = [];
  for (let i = Math.max(0, i0 - n); i <= Math.min(chain.strikes.length - 1, i0 + n); i++) {
    const row = chain.byStrike[chain.strikes[i]];
    if (row.CE) out.push(row.CE.token);
    if (row.PE) out.push(row.PE.token);
  }
  return out;
}

// Forward from put-call parity at the strike nearest the spot guess:
// F = K + (C - P)·e^{rT}. Falls back to the guess if quotes are missing.
function forward(chain, quotes, spotGuess, T, r) {
  const atm = nearestStrike(chain, spotGuess);
  const row = chain.byStrike[atm] || {};
  const c = mid(quotes[row.CE?.token]);
  const p = mid(quotes[row.PE?.token]);
  if (c > 0 && p > 0) {
    const F = atm + (c - p) * Math.exp(r * T);
    return { F, atm: nearestStrike(chain, F) };
  }
  return { F: spotGuess, atm };
}

// Best candidate exactly as the strategy file defines it (same as the
// backtest): nearest_ge = closest value at or above the target, nearest_le =
// closest at or below, nearest = closest either side; and, when a tolerance is
// set, no further than that from the target. Nothing fits -> null (the entry is
// skipped) — never a strike the file does not allow.
function pickBy(cands, value, target, match, tolerance) {
  const dist = c => Math.abs(value(c) - target);
  let pool = cands;
  if (match === "nearest_ge") pool = cands.filter(c => value(c) >= target - 1e-9);
  if (match === "nearest_le") pool = cands.filter(c => value(c) <= target + 1e-9);
  const best = [...pool].sort((a, b) => dist(a) - dist(b) || value(a) - value(b))[0];
  if (!best) return null;
  if (tolerance != null && dist(best) > tolerance + 1e-9) return null;
  return best;
}

// For the log when nothing fits: the closest strike below and above the target.
function neighbours(cands, value, target) {
  const below = cands.filter(c => value(c) < target).sort((a, b) => value(b) - value(a))[0];
  const above = cands.filter(c => value(c) >= target).sort((a, b) => value(a) - value(b))[0];
  return [above, below].filter(Boolean);
}

// Choose the strike for one leg. Returns { ok, strike, token, delta, premium, … }
// or { ok: false, reason }.
function selectStrike(chain, quotes, ctx, type, spec) {
  if (!chain.strikes.length) return { ok: false, reason: "empty option chain" };

  if (spec.rule === "atm_offset") {
    const atm = ctx.atm ?? nearestStrike(chain, ctx.F);
    const i = chain.strikes.indexOf(atm) + (type === "CE" ? 1 : -1) * Number(spec.n || 0);
    const k = chain.strikes[i];
    const inst = k != null ? chain.byStrike[k][type] : null;
    if (!inst) return { ok: false, reason: `no ${type} ${spec.n} strikes from ATM ${atm}` };
    const premium = mid(quotes[inst.token]);
    if (!(premium > 0)) return { ok: false, reason: `no quote for ${inst.tradingSymbol}` };
    return { ok: true, ...inst, premium };
  }

  const cands = [];
  for (const k of chain.strikes) {
    const inst = chain.byStrike[k][type];
    if (!inst) continue;
    const premium = mid(quotes[inst.token]);
    if (!(premium > 0) || premium < (spec.minPremium || 0)) continue;
    const iv = greeks.impliedVol(premium, ctx.F, k, ctx.T, ctx.r, type);
    const d = iv == null
      ? (type === "CE" ? (k < ctx.F ? 100 : 0) : (k > ctx.F ? 100 : 0))
      : Math.abs(greeks.delta(ctx.F, k, ctx.T, iv, ctx.r, type)) * 100;
    cands.push({ ...inst, premium, iv, delta: d });
  }
  if (!cands.length) return { ok: false, reason: `no ${type} quotes in the chain` };

  const byPremium = spec.rule === "premium";
  const value = byPremium ? c => c.premium : c => c.delta;
  const target = byPremium ? spec.premium : spec.delta;
  const best = pickBy(cands, value, target, spec.match, spec.tolerance);
  if (best) return { ok: true, ...best };

  const side = spec.match === "nearest_ge" ? " or more" : spec.match === "nearest_le" ? " or less" : "";
  const tol = spec.tolerance != null ? ` (tolerance ${spec.tolerance})` : "";
  const what = byPremium ? "premium" : "delta";
  const near = neighbours(cands, value, target)
    .map(c => `${c.strike} ${what} ${byPremium ? c.premium.toFixed(2) : c.delta.toFixed(1)}`).join(", ");
  return { ok: false, reason: `no ${type} with ${what} ${target}${side}${tol} as the strategy file requires${near ? ` — closest: ${near}` : ""}` };
}

module.exports = { listExpiries, pickExpiry, buildChain, windowTokens, forward, selectStrike, mid, nearestStrike };
