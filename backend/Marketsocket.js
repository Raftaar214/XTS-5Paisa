const axios = require("axios");
const io    = require("socket.io-client");
const { getSegmentForToken } = require("./instrumentloader");
const { getParent }          = require("./clients");
const { ipv4Agent } = require("./httpAgent");
axios.defaults.httpsAgent = ipv4Agent;

const BASE_DEFAULT = process.env.XTS_MARKET_URL || process.env.XTS_INTERACTIVE_URL || "https://xtsmum.5paisa.com";

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let marketToken   = null;
let marketUserID  = null;
let socket        = null;
let quoteCallback = null;
let refreshTimer  = null;   // periodic snapshot refresh
let MARKET_BASE   = BASE_DEFAULT; // set from the Parent client's Root URL once logged in

const liveQuotes    = {};
const subscribedMap = new Map();   // token → { xtsSegmentCode }
const rawEventCounts = {};

// ─────────────────────────────────────────────────────────────
// LOGIN
// Credentials come from the PARENT client, configured via User
// Management (market data key/secret are mandatory on the parent).
// Falls back to MARKET_APP_KEY / MARKET_SECRET_KEY / CLI1_* in .env
// only when no parent has been configured yet, so a brand-new
// install still boots exactly the way it always did.
// ─────────────────────────────────────────────────────────────
async function loginMarketData() {
  const parent = getParent();
  const APP_KEY    = (parent?.marketKey    || process.env.MARKET_APP_KEY    || process.env.CLI1_INTERACTIVE_KEY    || "").trim();
  const SECRET_KEY = (parent?.marketSecret || process.env.MARKET_SECRET_KEY || process.env.CLI1_INTERACTIVE_SECRET || "").trim();
  MARKET_BASE = parent?.rootUrl || BASE_DEFAULT;

  if (!APP_KEY || !SECRET_KEY) {
    console.warn("⚠️  Missing Market Data API Key/Secret — add a Parent client via User Management (or set MARKET_APP_KEY / MARKET_SECRET_KEY in .env).");
    return null;
  }

  const url     = `${MARKET_BASE}/apimarketdata/auth/login`;
  const primary = (process.env.MARKET_SOURCE || parent?.source || process.env.XTS_SOURCE || "WEBAPI").toUpperCase();
  const other   = primary === "CTCL" ? "WEBAPI" : "CTCL";

  console.log(`🔐 Market Data → ${url}`);
  console.log(`   key=${APP_KEY.slice(0,6)}…   secret=${SECRET_KEY.slice(0,4)}…`);

  for (const source of [primary, other]) {
    console.log(`   Trying source=${source} …`);
    try {
      const { data } = await axios.post(url, { appKey: APP_KEY, secretKey: SECRET_KEY, source });
      if (data.type === "success") {
        marketToken  = data.result.token;
        marketUserID = data.result.userID;
        console.log(`✅ Market Data logged in  source=${source}  userID=${marketUserID}`);
        return marketToken;
      }
      console.warn(`   source=${source} rejected: [${data.code}] ${data.description}`);
    } catch (err) {
      const body = err.response?.data;
      console.warn(`   source=${source} error: HTTP ${err.response?.status || err.message}`);
      if (body) console.warn(`   Response:`, JSON.stringify(body));
    }
  }

  console.error("❌ Market Data login failed.");
  return null;
}

// ─────────────────────────────────────────────────────────────
// SOCKET
// ─────────────────────────────────────────────────────────────
function connectMarketSocket() {
  if (!marketToken) { console.warn("⚠️  No market token — socket skipped."); return; }

  // Clean up any previous connection first — this function can now be
  // called more than once per process (e.g. re-run after the Parent's
  // Market Data credentials are added/edited via User Management).
  stopRefresh();
  if (socket) {
    try { socket.removeAllListeners(); socket.disconnect(); } catch (_) {}
    socket = null;
  }

  socket = io(MARKET_BASE, {
    path:          "/apimarketdata/socket.io",
    transports:    ["websocket"],
    reconnection:  true,
    reconnectionAttempts: 10,
    reconnectionDelay:    5000,
    query: { token: marketToken, userID: marketUserID, publishFormat: "JSON", broadcastMode: "Full" },
  });

  socket.on("connect", () => {
    console.log("✅ Market Data Socket connected");
    if (subscribedMap.size > 0) _bulkSubscribe([...subscribedMap.keys()]);
    startRefresh();
  });

  socket.on("joined",        (d) => console.log("JOINED:", typeof d === "string" ? d.slice(0,80) : JSON.stringify(d).slice(0,80)));
  socket.on("disconnect",    (r) => { console.log("🔴 Market Socket disconnected:", r); stopRefresh(); });
  socket.on("connect_error", (e) => console.error("❌ Market socket error:", e.message));

  ["1501-json-full","1501-json-partial","1502-json-full","1502-json-partial"].forEach(ev => {
    socket.on(ev, raw => {
      rawEventCounts[ev] = (rawEventCounts[ev] || 0) + 1;
      const data = typeof raw === "string"
        ? (() => { try { return JSON.parse(raw); } catch { return raw; } })()
        : raw;
      parseQuote(data);
    });
  });

  setInterval(() => {
    const total = Object.values(rawEventCounts).reduce((a,b) => a+b, 0);
    console.log(`💓 WS: ${total} event(s) | refresh: ${refreshTimer ? "ON" : "OFF"} | ${subscribedMap.size} token(s)`);
    Object.keys(rawEventCounts).forEach(k => rawEventCounts[k] = 0);
  }, 10_000);
}

// ─────────────────────────────────────────────────────────────
// SNAPSHOT REFRESH
// REST quote endpoint 404s on this server. The SUBSCRIBE response
// itself contains listQuotes with current prices — so we call
// subscribe every 2 seconds for all tracked tokens to get fresh
// snapshots. Works even when server returns "already subscribed"
// because the snapshot is in the response body either way.
// ─────────────────────────────────────────────────────────────
function startRefresh() {
  if (refreshTimer) return;
  console.log("🔄 Snapshot refresh started (2s interval)");
  refreshTimer = setInterval(forceRefresh, 2000);
}

function stopRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// Which subscribe URL works — discovered on first successful call
let _subUrl = null;

async function forceRefresh() {
  if (!marketToken || subscribedMap.size === 0) return;

  const instruments = [...subscribedMap.entries()].map(([token, info]) => ({
    exchangeSegment:      info.xtsSegmentCode,
    exchangeInstrumentID: Number(token),
  }));

  const urls = _subUrl
    ? [_subUrl]
    : [`${MARKET_BASE}/apimarketdata/instruments/subscription`, `${MARKET_BASE}/marketdata/instruments/subscription`];

  for (const url of urls) {
    try {
      const res = await axios.post(url,
        { instruments, xtsMessageCode: 1501 },
        { headers: { Authorization: marketToken, "Content-Type": "application/json" } }
      );

      if (!_subUrl) { _subUrl = url; console.log(`✅ Subscribe URL: ${url.replace(MARKET_BASE,"")}`); }

      // Parse snapshot from response
      _parseListQuotes(res.data?.result?.listQuotes);
      return;

    } catch (err) {
      const d      = err.response?.data;
      const status = err.response?.status;

      // "Already subscribed" still returns quotes in some 5paisa versions
      if (d?.code === "e-session-0002") {
        _parseListQuotes(d?.result?.listQuotes);
        if (!_subUrl) _subUrl = url;
        return;
      }

      if (status === 404) continue;
      // Other error — log once and stop spamming
      console.warn("Refresh error:", d?.description || err.message);

if (d?.description === "Invalid Token") {

    console.log("♻️ Re-login Market Data...");

    stopRefresh();

    socket?.disconnect();

    marketToken = null;
    marketUserID = null;

    await loginMarketData();

    connectMarketSocket();
}

return;
    }
  }
}

function _parseListQuotes(list) {
  if (!Array.isArray(list)) return;
  list.forEach(q => {
    try { parseQuote(typeof q === "string" ? JSON.parse(q) : q); } catch {}
  });
}

// ─────────────────────────────────────────────────────────────
// PARSE BID / ASK
// ─────────────────────────────────────────────────────────────
function parseQuote(raw) {
  try {
    if (typeof raw !== "string") {
      const token = String(raw.ExchangeInstrumentID || "");
      if (!token) return null;

      const tl  = raw.Touchline || raw.TouchLine || {};
      const ask = Number(raw.AskInfo?.Price  ?? raw.AskInfo?.AskPrice  ?? tl.AskInfo?.Price  ?? tl.BestAskPrice  ?? 0);
      const bid = Number(raw.BidInfo?.Price  ?? raw.BidInfo?.BidPrice  ?? tl.BidInfo?.Price  ?? tl.BestBidPrice  ?? 0);
      const ltp = Number(raw.LastTradedPrice ?? raw.LTP ?? tl.LastTradedPrice ?? tl.LTP ?? 0);

      if (ask > 0 || bid > 0) console.log(`✅ Quote  token=${token}  bid=${bid}  ask=${ask}  ltp=${ltp}`);
      _emit(token, bid, ask, ltp);
      return { token, bid, ask, ltp };
    }

    if (raw.startsWith("{")) return null;

    // CSV
    const obj = {};
    raw.split(",").forEach(item => {
      const idx = item.indexOf(":");
      if (idx === -1) return;
      obj[item.substring(0, idx).trim()] = item.substring(idx + 1).trim();
    });

    const token = obj.t?.split("_")[1];
    if (!token) return null;

    const p0  = v => { if (!v) return 0; const p = v.split("|"); return Number(p[2]) || 0; };
    const ask = p0(obj.ai);
    const bid = p0(obj.bi);
    const ltp = Number(obj.ltp) || 0;

    if (ask > 0 || bid > 0) console.log(`✅ Quote(CSV)  token=${token}  bid=${bid}  ask=${ask}`);
    _emit(token, bid, ask, ltp);
    return { token, bid, ask, ltp };

  } catch (err) {
    console.error("parseQuote error:", err.message);
    return null;
  }
}

function _emit(token, bid, ask, ltp = 0) {

  token = String(token);

  // Ignore quotes for unsubscribed tokens
  if (!subscribedMap.has(token)) {
    return;
  }

  const prev = liveQuotes[token];

  // Emit only if something changed
  if (
    prev &&
    prev.bid === bid &&
    prev.ask === ask &&
    prev.ltp === ltp
  ) {
    return;
  }

  liveQuotes[token] = {
    bid,
    ask,
    ltp,
    hasData: true,
  };

  if (quoteCallback) {
    quoteCallback({
      [token]: {
        bid,
        ask,
        ltp,
        hasData: true,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────
// SUBSCRIBE
// ─────────────────────────────────────────────────────────────
async function subscribeTokens(tokens, segmentsArray) {
  if (!tokens?.length) return;

  if (!marketToken) {
    console.warn("⚠️ No market data token.");
    return;
  }

  const newTokens = [...new Set(tokens.map(String))]
    .filter(t => !subscribedMap.has(t));

  if (!newTokens.length) return;

  const segCodes = newTokens.map((token, idx) => {
    const seg = segmentsArray?.[idx]
      ? xtsSegCode(segmentsArray[idx])
      : getSegmentForToken(token).xtsSegmentCode;

    console.log(
      `Token=${token} Segment=${segmentsArray?.[idx] || "AUTO"} XTS=${seg}`
    );

    return seg;
  });

  const instruments = newTokens.map((token, idx) => ({
    exchangeSegment: Number(segCodes[idx]),
    exchangeInstrumentID: Number(token),
  }));

  console.log("\n==============================");
  console.log("SUBSCRIBE REQUEST");
  console.table(instruments);

  const urls = _subUrl
    ? [_subUrl]
    : [
        `${MARKET_BASE}/apimarketdata/instruments/subscription`,
        `${MARKET_BASE}/marketdata/instruments/subscription`
      ];

  for (const url of urls) {

    try {

      const res = await axios.post(
        url,
        {
          instruments,
          xtsMessageCode: 1501
        },
        {
          headers: {
            Authorization: marketToken,
            "Content-Type": "application/json"
          }
        }
      );

      console.log("\nSUBSCRIBE RESPONSE");
      console.log(JSON.stringify(res.data, null, 2));

      if (!_subUrl) {
        _subUrl = url;
      }

      newTokens.forEach((t, i) =>
        subscribedMap.set(t, {
          xtsSegmentCode: segCodes[i]
        })
      );

      console.log(`✅ Subscribed ${newTokens.length} token(s)`);

      _parseListQuotes(res.data?.result?.listQuotes);

      startRefresh();

      return;

    } catch (err) {

      const d = err.response?.data;

      console.log("\n==============================");
      console.log("SUBSCRIBE FAILED");

      console.table(instruments);

      console.log("HTTP:", err.response?.status);

      console.log(
        JSON.stringify(d, null, 2)
      );

      if (d?.code === "e-session-0002") {

        console.log("Already subscribed.");

        newTokens.forEach((t, i) =>
          subscribedMap.set(t, {
            xtsSegmentCode: segCodes[i]
          })
        );

        _parseListQuotes(d?.result?.listQuotes);

        if (!_subUrl) _subUrl = url;

        startRefresh();

        return;
      }

      if (err.response?.status === 404)
        continue;

      return;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// UNSUBSCRIBE — server has no working endpoint; clear locally
// so next subscribeTokens makes a fresh server call for that token
// ─────────────────────────────────────────────────────────────
async function unsubscribeTokens(tokens) {

  if (!tokens?.length || !marketToken) return;

  const instruments = tokens.map(token => {

    const info = subscribedMap.get(String(token)) || getSegmentForToken(token);

    return {
      exchangeSegment: Number(info.xtsSegmentCode),
      exchangeInstrumentID: Number(token)
    };
  });

  try {

    const res = await axios.put(
      `${MARKET_BASE}/apimarketdata/instruments/subscription`,
      {
        instruments,
        xtsMessageCode: 1501
      },
      {
        headers: {
          Authorization: marketToken,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("UNSUBSCRIBE RESPONSE");
    console.log(JSON.stringify(res.data, null, 2));

    tokens.forEach(t => {

  const token = String(t);

  subscribedMap.delete(token);
  delete liveQuotes[token];if (quoteCallback) {
    quoteCallback({
        [token]: {
            removed: true
        }
    });
    console.log("Subscribed:", [...subscribedMap.keys()]);
console.log("LiveQuotes :", Object.keys(liveQuotes));
}

  console.log(`🗑 Removed ${token}`);

});

console.log("Remaining subscribed tokens:");
console.log([...subscribedMap.keys()]);

    console.log(`✅ Unsubscribed ${tokens.length} token(s)`);

  } catch (err) {

    console.error("UNSUBSCRIBE FAILED");

    console.log(
      JSON.stringify(err.response?.data || err.message, null, 2)
    );
  }
}
// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function xtsSegCode(seg) {
  const m = {
  NSECM:1,
  NSEFO:2,
  NSECD:3,

  BSECM:11,
  BSEFO:12,
  BSECD:13,

  MCXFO:51,
  NCDEX:21,

  NSE:1,
  NSE_EQ:1,
  NSE_CM:1,

  BSE:11,
  BSE_EQ:11,
  BSE_CM:11,

  NSE_FO:2,
  BSE_FO:12,

  MCX:51,
  MCX_FO:51,

  NSE_CD:3,
  NCD_FO:3,

  BCD_FO:13,

  NSE_COM:51, // only if these are commodity contracts in your master

  NSE_INDEX:1,
  BSE_INDEX:11,
};
  return m[seg] || 2;
}

async function _bulkSubscribe(tokenList) {
  const instruments = tokenList.map(t => {
    const info = subscribedMap.get(t) || getSegmentForToken(t);
    return { exchangeSegment: info.xtsSegmentCode, exchangeInstrumentID: Number(t) };
  });
  if (!instruments.length) return;
  const urls = _subUrl
    ? [_subUrl]
    : [`${MARKET_BASE}/apimarketdata/instruments/subscription`, `${MARKET_BASE}/marketdata/instruments/subscription`];
  for (const url of urls) {
    try {
      const res = await axios.post(url, { instruments, xtsMessageCode: 1501 },
        { headers: { Authorization: marketToken } });
      _parseListQuotes(res.data?.result?.listQuotes);
      console.log(`📡 Re-subscribed ${instruments.length} token(s) after reconnect`);
      return;
    } catch (err) {
      if (err.response?.status === 404) continue;
      _parseListQuotes(err.response?.data?.result?.listQuotes);
      return;
    }
  }
}

function onPriceUpdate(cb) { quoteCallback = cb; }
function getLivePrices() {

    const out = {};

    for (const token of subscribedMap.keys()) {

        if (liveQuotes[token]) {
            out[token] = liveQuotes[token];
        }

    }

    return out;
}

module.exports = { loginMarketData, connectMarketSocket, subscribeTokens, unsubscribeTokens, onPriceUpdate, getLivePrices, parseQuote };
