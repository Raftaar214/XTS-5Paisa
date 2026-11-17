// Marketsocket.js — live bid / ask / LTP from the XTS market-data feed.
//
// Prices are TICK data pushed by the broker over Socket.IO (1501 touchline /
// 1502 market depth, JSON "Full" mode) — there is no polling. A snapshot is
// taken once, from the subscription response, when a token is first
// subscribed, so a price shows at once.
//
// Session handling: the broker allows ONE market-data session per API key.
// If the session ends ("io server disconnect", logout, "Invalid Token") the
// module logs in again, reconnects and re-subscribes every token by itself.
// If that keeps happening, another login is using the same Market Data key
// (another running copy of this backend, or another app) — it says so and
// backs off instead of fighting it.
//
// Credentials come from the PARENT client (Admin -> Clients), falling back to
// MARKET_APP_KEY / MARKET_SECRET_KEY in .env when no parent exists yet.

const axios = require("axios");
const io    = require("socket.io-client");
const { getSegmentForToken } = require("./instrumentloader");
const { getParent }          = require("./clients");
const { ipv4Agent }          = require("./httpAgent");
axios.defaults.httpsAgent = ipv4Agent;

const BASE_DEFAULT = process.env.XTS_MARKET_URL || process.env.XTS_INTERACTIVE_URL || "https://xtsmum.5paisa.com";
const SUB_PATHS = ["/apimarketdata/instruments/subscription", "/marketdata/instruments/subscription"];
const CHUNK = 50;                      // instruments per subscription request
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TAKEOVER_BACKOFF_MS = Number(process.env.MARKET_TAKEOVER_BACKOFF_MS || 30_000);
const RELOGIN_BASE_MS     = Number(process.env.MARKET_RELOGIN_BASE_MS || 2000);
// After a failed login round, keep trying: 30 s, then every 60 s, forever.
const RETRY_FIRST_MS      = Number(process.env.MARKET_RETRY_MS || 30_000);
const RETRY_MAX_MS        = 2 * RETRY_FIRST_MS;
// Repeated take-overs back off further each time: 30 s, 60 s, 2 min, 5 min.
const TAKEOVER_STEPS      = [1, 2, 4, 10];
// Tokens whose subscribe call failed are tried again on this interval.
const SUB_RETRY_MS        = Number(process.env.MARKET_SUB_RETRY_MS || 30_000);

// State
let marketToken  = null;
let marketUserID = null;
let socket       = null;
let joined       = false;
let MARKET_BASE  = BASE_DEFAULT;
let subPath      = null;               // which subscription URL works (found on first call)

const liveQuotes    = {};              // token -> { bid, ask, ltp, hasData, ts }
const subscribedMap = new Map();       // token -> { xtsSegmentCode }
const owners        = new Map();       // token -> Set(owner)  ("ui:<user>", "positions", "strategy:<id>")

const quoteListeners = new Set();
function notify(update) { quoteListeners.forEach(fn => { try { fn(update); } catch (_) {} }); }

const stats = {
  ticks: 0, ticksLastMinute: 0, lastTickAt: 0,
  otherTicks: 0,                       // ticks for tokens we did not subscribe (another login on the same key)
  recoveries: [],                      // timestamps of re-logins (last 5 min)
  lastError: "", takeoverWarnedAt: 0,
  takeoverLevel: 0,                    // how many take-over back-offs in a row
};
const pendingSubs = new Set();         // tokens whose subscribe call failed — retried
let missingCredentials = false;        // no key/secret: retrying is pointless
let retryTimer = null, retryDelay = RETRY_FIRST_MS;
let subRetryTimer = null;
let heartbeatTimer = null;

const isInvalidToken = d => d?.code === "e-session-0007" || /invalid token/i.test(String(d?.description || ""));

// LOGIN
async function loginMarketData() {
  const parent = getParent();
  const APP_KEY    = (parent?.marketKey    || process.env.MARKET_APP_KEY    || process.env.CLI1_INTERACTIVE_KEY    || "").trim();
  const SECRET_KEY = (parent?.marketSecret || process.env.MARKET_SECRET_KEY || process.env.CLI1_INTERACTIVE_SECRET || "").trim();
  MARKET_BASE = parent?.rootUrl || BASE_DEFAULT;

  if (!APP_KEY || !SECRET_KEY) {
    missingCredentials = true;
    console.warn("Warning: Missing Market Data API Key/Secret — add a Parent client in the Admin console (or MARKET_APP_KEY / MARKET_SECRET_KEY in .env).");
    return null;
  }
  missingCredentials = false;

  const url     = `${MARKET_BASE}/apimarketdata/auth/login`;
  const primary = (process.env.MARKET_SOURCE || parent?.source || process.env.XTS_SOURCE || "WEBAPI").toUpperCase();
  const other   = primary === "CTCL" ? "WEBAPI" : "CTCL";

  for (const source of [primary, other]) {
    try {
      const { data } = await axios.post(url, { appKey: APP_KEY, secretKey: SECRET_KEY, source }, { timeout: 10000 });
      if (data.type === "success") {
        marketToken  = data.result.token;
        marketUserID = data.result.userID;
        retryDelay = RETRY_FIRST_MS;
        clearTimeout(retryTimer); retryTimer = null;
        console.log(`Market Data logged in (source=${source}, userID=${marketUserID})`);
        return marketToken;
      }
      stats.lastError = `[${data.code}] ${data.description}`;
      console.warn(`   Market Data login source=${source} rejected: ${stats.lastError}`);
    } catch (err) {
      stats.lastError = err.response?.data?.description || err.message;
      console.warn(`   Market Data login source=${source} failed: ${stats.lastError}`);
    }
  }
  console.error("Error: Market Data login failed.");
  return null;
}

// SOCKET — tick stream
function closeSocket() {
  joined = false;
  if (!socket) return;
  try { socket.removeAllListeners(); socket.close(); } catch (_) {}
  socket = null;
}

function onTick(raw) {
  const data = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : raw;
  const q = parseQuote(data);
  // Count only our own tokens; the rest belong to another session on this user ID.
  if (q && subscribedMap.has(String(q.token))) stats.ticks++;
  else stats.otherTicks++;
}

function connectMarketSocket() {
  if (!marketToken) { console.warn("Warning: No market token — socket skipped."); return; }
  closeSocket();

  socket = io(MARKET_BASE, {
    path: "/apimarketdata/socket.io",
    transports: ["websocket"],
    reconnection: true,           // network blips: socket.io retries by itself
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
    query: { token: marketToken, userID: marketUserID, publishFormat: "JSON", broadcastMode: "Full" },
  });

  let joinFallback = null;
  socket.on("connect", () => {
    console.log("Market Data socket connected");
    // Subscribe once the broker confirms the join; fall back after 2 s.
    clearTimeout(joinFallback);
    joinFallback = setTimeout(() => { if (!joined) { joined = true; resubscribeAll(); } }, 2000);
  });
  socket.on("joined", () => {
    clearTimeout(joinFallback);
    if (!joined) { joined = true; resubscribeAll(); }
  });
  socket.on("disconnect", reason => {
    joined = false;
    console.warn(`Market Data socket disconnected: ${reason}`);
    // The broker closed it (session ended / taken over): socket.io will not
    // retry this case, so log in again. Other reasons reconnect by themselves.
    if (reason === "io server disconnect") recover("the broker closed the market-data session");
  });
  socket.on("logout", () => recover("the broker logged the market-data session out"));
  socket.on("connect_error", e => { stats.lastError = e.message; });

  ["1501-json-full", "1501-json-partial", "1502-json-full", "1502-json-partial"].forEach(ev => socket.on(ev, onTick));

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      stats.ticksLastMinute = stats.ticks;
      const other = stats.otherTicks;
      stats.ticks = 0;
      stats.otherTicks = 0;
      console.log(`Market data: ${stats.ticksLastMinute} tick(s)/min | ${subscribedMap.size} token(s) | socket ${socket?.connected ? (joined ? "live" : "joining") : "down"}` +
        (other ? ` | ${other} other tick(s) ignored (another login on this key)` : ""));
    }, 60_000);
    heartbeatTimer.unref?.();
  }
}

// One re-login at a time; repeated take-overs are reported and slowed down.
let recovering = null;
// isRetry: a scheduled retry after failed logins — not a take-over, so it
// is not counted towards the "another login on this key" warning.
function recover(reason, { isRetry = false } = {}) {
  if (recovering) return recovering;
  recovering = (async () => {
    const now = Date.now();
    stats.recoveries = stats.recoveries.filter(t => now - t < 5 * 60_000);
    if (!isRetry) stats.recoveries.push(now);
    if (!isRetry && stats.recoveries.length >= 3) {
      const wait = TAKEOVER_BACKOFF_MS * TAKEOVER_STEPS[Math.min(stats.takeoverLevel, TAKEOVER_STEPS.length - 1)];
      stats.takeoverLevel++;
      if (now - stats.takeoverWarnedAt > 5 * 60_000) {
        stats.takeoverWarnedAt = now;
        console.error("Warning: The market-data session keeps being taken over. Another login is using the SAME Market Data API key " +
          "(another running copy of this backend, or another app/script). Only one can stay connected — stop the other one.");
      }
      console.warn(`Market data: waiting ${Math.round(wait / 1000)} s before logging in again (take-over ${stats.takeoverLevel})`);
      await sleep(wait);
    } else if (!isRetry && stats.recoveries.length < 2) {
      stats.takeoverLevel = 0;                  // calm again: start the back-off from the beginning
    }
    console.warn(`Market data: ${reason} — logging in again`);
    closeSocket();
    marketToken = null;
    for (let i = 0; i < 6 && !marketToken; i++) {
      if (await loginMarketData()) break;
      if (missingCredentials) break;
      await sleep(Math.min(30_000, RELOGIN_BASE_MS * 2 ** i));
    }
    if (marketToken) connectMarketSocket();   // "joined" -> resubscribeAll()
    else scheduleRetry("market-data login keeps failing");
  })().finally(() => { recovering = null; });
  return recovering;
}

// Never give up: while there is no session (and there are credentials), try
// again after 30 s, then every 60 s, until the broker answers.
function scheduleRetry(reason) {
  if (missingCredentials || retryTimer || marketToken) return;
  const wait = retryDelay;
  retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
  console.warn(`Warning: Market data: no session — trying again in ${Math.round(wait / 1000)} s`);
  retryTimer = setTimeout(() => { retryTimer = null; recover(reason, { isRetry: true }); }, wait);
  retryTimer.unref?.();
}

// Start-up / restart entry point: log in and connect, or keep retrying.
async function startMarketData() {
  clearTimeout(retryTimer); retryTimer = null;
  retryDelay = RETRY_FIRST_MS;
  closeSocket();                 // a restart starts from a clean session
  marketToken = null;
  const token = await loginMarketData();
  if (token) { connectMarketSocket(); return true; }
  scheduleRetry("market-data login failed at start");
  return false;
}

// SUBSCRIPTION (REST) — POST subscribe / PUT unsubscribe
function instrumentsFor(tokens) {
  return tokens.map(t => ({
    exchangeSegment: Number(subscribedMap.get(t)?.xtsSegmentCode || getSegmentForToken(t).xtsSegmentCode),
    exchangeInstrumentID: Number(t),
  }));
}

// Sends one chunk; returns the snapshot list (if any). Throws on failure;
// err.invalidToken marks an ended session.
async function sendChunk(method, instruments) {
  const paths = subPath ? [subPath] : SUB_PATHS;
  let lastErr;
  for (const p of paths) {
    try {
      const res = await axios({
        method, url: `${MARKET_BASE}${p}`, timeout: 10000,
        data: { instruments, xtsMessageCode: 1501 },
        headers: { Authorization: marketToken, "Content-Type": "application/json" },
      });
      subPath = p;
      return res.data?.result?.listQuotes || [];
    } catch (err) {
      const d = err.response?.data;
      if (d?.code === "e-session-0002") { subPath = p; return d?.result?.listQuotes || []; } // already subscribed
      if (isInvalidToken(d)) throw Object.assign(new Error("Invalid Token"), { invalidToken: true });
      lastErr = Object.assign(new Error(d?.description || err.message), { status: err.response?.status });
      if (err.response?.status === 404 && !subPath) continue;
      throw lastErr;
    }
  }
  throw lastErr;
}

function parseSnapshots(list) {
  if (!Array.isArray(list)) return;
  list.forEach(q => { try { parseQuote(typeof q === "string" ? JSON.parse(q) : q); } catch (_) {} });
}

async function sendSubscription(method, tokens) {
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    parseSnapshots(await sendChunk(method, instrumentsFor(chunk)));
  }
}

async function resubscribeAll() {
  const tokens = [...subscribedMap.keys()];
  pendingSubs.clear();
  if (!tokens.length || !marketToken) return;
  try {
    await sendSubscription("post", tokens);
    console.log(`Subscribed ${tokens.length} token(s) on the market-data session`);
  } catch (err) {
    if (err.invalidToken) return recover("the market-data token was rejected");
    stats.lastError = err.message;
    tokens.forEach(t => pendingSubs.add(t));
    startSubRetry();
    console.warn(`Warning: Re-subscribe failed: ${err.message} — trying again in ${Math.round(SUB_RETRY_MS / 1000)} s`);
  }
}

// Tokens whose subscribe call failed (not a session problem) are sent again
// on a timer until the broker accepts them.
function startSubRetry() {
  if (subRetryTimer) return;
  subRetryTimer = setInterval(async () => {
    const tokens = [...pendingSubs].filter(t => subscribedMap.has(t));
    pendingSubs.clear();
    if (!tokens.length) { clearInterval(subRetryTimer); subRetryTimer = null; return; }
    if (!marketToken || !joined) { tokens.forEach(t => pendingSubs.add(t)); return; } // the re-join subscribes them
    try {
      await sendSubscription("post", tokens);
      console.log(`Subscribed ${tokens.length} token(s) that had failed before`);
    } catch (err) {
      tokens.forEach(t => pendingSubs.add(t));
      if (err.invalidToken) recover("the market-data token was rejected");
      else stats.lastError = err.message;
    }
  }, SUB_RETRY_MS);
  subRetryTimer.unref?.();
}

async function subscribeTokens(tokens, segmentsArray, owner = "ui") {
  if (!tokens?.length) return;

  // Segment per token, keyed by token (not by position after filtering).
  const segFor = new Map();
  tokens.forEach((t, i) => { const k = String(t); if (!segFor.has(k)) segFor.set(k, segmentsArray?.[i]); });

  const fresh = [];
  for (const [t, seg] of segFor) {
    if (!owners.has(t)) owners.set(t, new Set());
    owners.get(t).add(owner);
    if (!subscribedMap.has(t)) {
      subscribedMap.set(t, { xtsSegmentCode: seg ? xtsSegCode(seg) : getSegmentForToken(t).xtsSegmentCode });
      fresh.push(t);
    }
  }
  // Without a session yet, the tokens are kept and subscribed on (re)join.
  if (!fresh.length || !marketToken || !joined) return;

  try {
    await sendSubscription("post", fresh);
  } catch (err) {
    if (err.invalidToken) { recover("the market-data token was rejected"); return; }
    stats.lastError = err.message;
    fresh.forEach(t => pendingSubs.add(t));
    startSubRetry();
    console.warn(`Warning: Subscribe ${fresh.join(",")} failed: ${err.message} — trying again in ${Math.round(SUB_RETRY_MS / 1000)} s`);
  }
}

// Every token one owner (a dashboard user, a strategy) currently holds.
function tokensOwnedBy(owner) {
  return [...owners].filter(([, set]) => set.has(owner)).map(([t]) => t);
}

async function unsubscribeTokens(tokens, owner = "ui") {
  if (!tokens?.length) return;

  // Release only tokens that no other owner still needs.
  const release = tokens.map(String).filter(t => {
    const set = owners.get(t);
    if (set) {
      set.delete(owner);
      if (set.size) return false;
      owners.delete(t);
    }
    return subscribedMap.has(t);
  });
  if (!release.length) return;

  // Local first: the token stops showing prices immediately, whatever the broker says.
  for (const t of release) {
    subscribedMap.delete(t);
    pendingSubs.delete(t);
    delete liveQuotes[t];
    notify({ [t]: { removed: true } });
  }

  if (!marketToken || !joined) return; // a new session will simply not include them
  try {
    // instrumentsFor() falls back to the instrument master for the segment.
    await sendSubscription("put", release);
  } catch (err) {
    if (!err.invalidToken) console.warn(`Warning: Unsubscribe ${release.join(",")} failed at the broker: ${err.message}`);
  }
}

// PARSE BID / ASK / LTP
function parseQuote(raw) {
  try {
    if (raw && typeof raw === "object") {
      const token = String(raw.ExchangeInstrumentID || "");
      if (!token) return null;

      const tl  = raw.Touchline || raw.TouchLine || {};
      const ask = Number(raw.AskInfo?.Price ?? raw.AskInfo?.AskPrice ?? tl.AskInfo?.Price ?? tl.BestAskPrice ?? 0);
      const bid = Number(raw.BidInfo?.Price ?? raw.BidInfo?.BidPrice ?? tl.BidInfo?.Price ?? tl.BestBidPrice ?? 0);
      const ltp = Number(raw.LastTradedPrice ?? raw.LTP ?? tl.LastTradedPrice ?? tl.LTP ?? 0);
      const bidQty = sizeOf(raw.BidInfo?.Size ?? tl.BidInfo?.Size ?? raw.Bids?.[0]?.Size);
      const askQty = sizeOf(raw.AskInfo?.Size ?? tl.AskInfo?.Size ?? raw.Asks?.[0]?.Size);

      _emit(token, bid, ask, ltp, { bidQty, askQty });
      return { token, bid, ask, ltp };
    }

    if (typeof raw !== "string" || raw.startsWith("{")) return null;

    // Partial (CSV-like) format: t:2_45350,ltp:731,ai:0|0|734.25,bi:0|0|730.15,…
    const obj = {};
    raw.split(",").forEach(item => {
      const idx = item.indexOf(":");
      if (idx === -1) return;
      obj[item.substring(0, idx).trim()] = item.substring(idx + 1).trim();
    });
    const token = obj.t?.split("_")[1];
    if (!token) return null;

    const p0  = v => { if (!v) return 0; const p = v.split("|"); return Number(p[2]) || 0; };
    const q0  = v => { if (!v) return undefined; const p = v.split("|"); return p.length >= 3 ? sizeOf(p[1]) : undefined; };
    const ask = p0(obj.ai);
    const bid = p0(obj.bi);
    const ltp = Number(obj.ltp) || 0;

    _emit(token, bid, ask, ltp, { bidQty: q0(obj.bi), askQty: q0(obj.ai) });
    return { token, bid, ask, ltp };
  } catch (err) {
    console.error("parseQuote error:", err.message);
    return null;
  }
}

// seen = when the broker last sent this token (even unchanged): a price is
// "fresh" by seen, not by ts (ts = last change). bidQty / askQty = size at
// the best price, used by the paper broker for realistic partial fills.
function _emit(token, bid, ask, ltp = 0, sizes = {}) {
  token = String(token);
  if (!subscribedMap.has(token)) return;             // never publish unsubscribed tokens

  const now = Date.now();
  // The feed is alive whenever the broker sends a tick for one of our tokens,
  // changed or not (lastTickAt drives the "market data is live" check).
  stats.lastTickAt = now;
  const prev = liveQuotes[token];
  if (prev && prev.bid === bid && prev.ask === ask && prev.ltp === ltp) { // nothing changed
    prev.seen = now;
    if (sizes.bidQty !== undefined) prev.bidQty = sizes.bidQty;
    if (sizes.askQty !== undefined) prev.askQty = sizes.askQty;
    return;
  }

  liveQuotes[token] = {
    bid, ask, ltp, hasData: true, ts: now, seen: now,
    bidQty: sizes.bidQty ?? prev?.bidQty ?? null, askQty: sizes.askQty ?? prev?.askQty ?? null,
  };
  notify({ [token]: liveQuotes[token] });
}

// Size at the best price, or undefined when the feed does not send it.
const sizeOf = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined; };

// Helpers / status
function xtsSegCode(seg) {
  const m = {
    NSECM: 1, NSEFO: 2, NSECD: 3, BSECM: 11, BSEFO: 12, BSECD: 13, MCXFO: 51, NCDEX: 21,
    NSE: 1, NSE_EQ: 1, NSE_CM: 1, NSE_INDEX: 1,
    BSE: 11, BSE_EQ: 11, BSE_CM: 11, BSE_INDEX: 11,
    NSE_FO: 2, BSE_FO: 12,
    MCX: 51, MCX_FO: 51, NSE_COM: 51,
    NSE_CD: 3, NCD_FO: 3, BCD_FO: 13,
  };
  return m[String(seg || "").toUpperCase()] || 2;
}

function getMarketStatus() {
  const now = Date.now();
  const recent = stats.recoveries.filter(t => now - t < 5 * 60_000).length;
  return {
    loggedIn:          !!marketToken,
    socketConnected:   !!socket?.connected,
    joined,
    subscribedTokens:  subscribedMap.size,
    ticksLastMinute:   stats.ticksLastMinute,
    lastTickAt:        stats.lastTickAt ? new Date(stats.lastTickAt).toISOString() : null,
    lastTickAgeMs:     stats.lastTickAt ? now - stats.lastTickAt : null,
    reloginsLast5Min:  recent,
    takeoverSuspected: recent >= 3,
    takeoverLevel:     stats.takeoverLevel,
    pendingSubscriptions: pendingSubs.size,
    retryingLogin:     !!retryTimer,
    lastError:         stats.lastError,
    rootUrl:           MARKET_BASE,
  };
}

// A token's quote is fresh when the broker sent it within maxAgeMs.
function isFresh(token, maxAgeMs = 60_000, now = Date.now()) {
  const q = liveQuotes[String(token)];
  return !!q && now - (q.seen || q.ts || 0) <= maxAgeMs;
}

function onPriceUpdate(cb) { quoteListeners.add(cb); return () => quoteListeners.delete(cb); }

function getLivePrices() {
  const out = {};
  for (const token of subscribedMap.keys()) if (liveQuotes[token]) out[token] = liveQuotes[token];
  return out;
}

module.exports = {
  loginMarketData, connectMarketSocket, startMarketData, subscribeTokens, unsubscribeTokens, tokensOwnedBy,
  onPriceUpdate, getLivePrices, getMarketStatus, parseQuote, isFresh,
};
