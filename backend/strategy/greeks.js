// strategy/greeks.js — Black-76 (options on a forward) price, delta and
// implied volatility. Index options are priced off the forward recovered
// from put-call parity, so no separate index quote is needed.

const ist = require("./ist");

// Standard normal CDF (Hart / West, accurate to ~1e-15).
function normCdf(x) {
  const z = Math.abs(x);
  let c;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-02 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-02 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = e * n / d;
    } else {
      let f = z + 0.65;
      f = z + 4 / f; f = z + 3 / f; f = z + 2 / f; f = z + 1 / f;
      c = e / f / 2.506628274631;
    }
  }
  return x <= 0 ? c : 1 - c;
}

function d1d2(F, K, T, sigma) {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * v * v) / v;
  return [d1, d1 - v];
}

function price(F, K, T, sigma, r, type) {
  const df = Math.exp(-r * T);
  if (!(T > 0) || !(sigma > 0)) {
    return df * Math.max(0, type === "CE" ? F - K : K - F);
  }
  const [d1, d2] = d1d2(F, K, T, sigma);
  return type === "CE"
    ? df * (F * normCdf(d1) - K * normCdf(d2))
    : df * (K * normCdf(-d2) - F * normCdf(-d1));
}

// Signed delta (CE positive, PE negative).
function delta(F, K, T, sigma, r, type) {
  const df = Math.exp(-r * T);
  if (!(T > 0) || !(sigma > 0)) {
    if (type === "CE") return F > K ? df : 0;
    return F < K ? -df : 0;
  }
  const [d1] = d1d2(F, K, T, sigma);
  return type === "CE" ? df * normCdf(d1) : -df * normCdf(-d1);
}

// Bisection — robust for the very short expiries of 0/1 DTE options.
function impliedVol(premium, F, K, T, r, type) {
  if (!(premium > 0) || !(T > 0) || !(F > 0) || !(K > 0)) return null;
  const intrinsic = price(F, K, T, 0, r, type);
  if (premium <= intrinsic + 1e-9) return null;
  let lo = 1e-4, hi = 5;
  if (price(F, K, T, hi, r, type) < premium) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (price(F, K, T, mid, r, type) > premium) hi = mid; else lo = mid;
    if (hi - lo < 1e-7) break;
  }
  return (lo + hi) / 2;
}

const MS_PER_YEAR = 365 * 24 * 3600 * 1000;

// Time from `nowMs` to 15:30 IST on the expiry date, in years (≥ 1 minute).
function yearsToExpiry(nowMs, expiryDate) {
  const closeMs = ist.timeOn(expiryDate, "15:30");
  return Math.max(60_000, closeMs - nowMs) / MS_PER_YEAR;
}

module.exports = { normCdf, price, delta, impliedVol, yearsToExpiry };
