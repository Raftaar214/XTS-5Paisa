import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Upload, Download, LogIn, LogOut, Power, PowerOff, Loader,
  Terminal, Activity, Users, ShieldCheck, Database,
  LayoutList, BookOpen, Briefcase, RefreshCw, OctagonX, Bot,
} from "lucide-react";
import { API_BASE, WS_URL } from "./config.js";
import { getToken } from "./authFetch.js";
import { downloadFile, todayIst, rowsToCsv, saveText } from "./download.js";

// CSV columns for the client-card strategy views. Broker views (orders,
// trades, positions) export every field the broker returned.
const CSV_COLUMNS = {
  algo: [
    ["strategyName", "Strategy"], ["mode", "Mode"], ["orderId", "Entry Order ID"], ["exitOrderId", "Exit Order ID"],
    ["tradingSymbol", "Instrument"], ["token", "Token"], ["side", "Side"], ["qty", "Qty"],
    ["entryPrice", "Entry"], ["ltp", "LTP"], ["stopPrice", "Stop"], ["status", "Status"], ["exitReason", "Exit Reason"],
    ["exitPrice", "Exit"], ["unrealized", "Unrealized P&L"], ["pnl", "Realized P&L"], ["slot", "Slot"],
    ["entryTime", "Entry Time"], ["exitTime", "Exit Time"],
  ],
  algoorders: [
    ["date", "Date"], ["time", "Time"], ["strategy", "Strategy"], ["mode", "Mode"], ["orderId", "Order ID"],
    ["tradingSymbol", "Instrument"], ["token", "Token"], ["side", "Side"], ["qty", "Qty"], ["price", "Price"],
    ["reason", "Reason"], ["pnl", "P&L"], ["status", "Status"],
  ],
};
const CSV_NAMES = { orders: "order-book", trades: "trade-book", positions: "positions", algo: "algo-positions", algoorders: "algo-orders" };
import StrategyPanel from "./StrategyPanel.jsx";

// CONFIG
const API   = API_BASE;
const SIDES = ["Buy", "Sell"];

// Shown until /api/execution/config answers; mirrors backend defaults.
const DEFAULT_EXEC_CONFIG = {
  tradingMode: "PAPER", tradingHalted: false, haltReason: "",
  engine: { bufferPct: 0.5, fillTimeout: 4, maxRetries: 1 },
  limits: { maxLegs: 8 },
};

// The admin's halt reason, unless it only repeats "halted by admin".
const haltNote = reason => {
  const x = String(reason || "").trim().replace(/[.\s]+$/, "");
  return x && !/^halted( by (the )?admin)?$/i.test(x) ? x : "";
};

const authHeaders = () => {
  const token = localStorage.getItem("xts_dashboard_token");

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

const isFutureOrToday = (dateStr) => {
    const [y, m, d] = dateStr.split("-").map(Number);

    const expiry = new Date(y, m - 1, d);
    expiry.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return expiry.getTime() >= today.getTime();
};
// INSTRUMENT PROCESSING
// Equity segments have no expiry/strike; their symbol is the trading symbol.
const EQUITY_SEGMENTS = new Set(["NSE_EQ", "BSE_EQ"]);
const noStrike = type => type === "FO" || type === "EQ";

// The backend sends only the segments the admin allows.
const buildMarketData = (rawData) => {
  const p = {};
  rawData.forEach(item => {
    let seg = item.segment;
    if (!seg) return;
    if (seg === "MCX_FO") seg = "MCX";
    const equity = EQUITY_SEGMENTS.has(seg);
    const sym = equity ? item.trading_symbol : item.asset_symbol; if (!sym) return;
    let type = equity ? "EQ" : item.instrument_type;
    if (type === "F" || type === "FUT") type = "FO";
    if (!["CE","PE","FO","EQ"].includes(type)) return;
    let exp = "N/A";
if (item.expiry && !equity) {

    // If API already sends YYYY-MM-DD, use it directly
    if (typeof item.expiry === "string") {
        exp = item.expiry.substring(0, 10);
    } else {
        const d = new Date(item.expiry);

        if (isNaN(d.getTime())) return;

        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");

        exp = `${yyyy}-${mm}-${dd}`;
    }

    if (!isFutureOrToday(exp))
        return;
}
    const str   = noStrike(type) ? "N/A" : (item.strike_price != null ? String(item.strike_price) : "N/A");
    // tick_size in the instrument master is in paise (5 = ₹0.05, 100 = ₹1)
    const tick  = Number(item.tick_size) > 0 ? Number(item.tick_size) / 100 : 0.05;
    const token = item.exchange_token?.toString() || "";
    const lotSz =
  seg === "MCX"
    ? 1
    : Number(item.lot_size || 1);
    if (!p[seg]) p[seg]={};
    if (!p[seg][sym]) p[seg][sym]={};
    if (!p[seg][sym][type]) p[seg][sym][type]={};
    if (!p[seg][sym][type][exp]) p[seg][sym][type][exp]={ strikes:new Set(), details:{} };
    if (!noStrike(type)) p[seg][sym][type][exp].strikes.add(str);
    p[seg][sym][type][exp].details[str] = { token, lotSize: lotSz, tick };
  });

  const f = {};
  Object.keys(p).sort().forEach(seg => {
    f[seg] = { symbols: Object.keys(p[seg]).sort(), data: {} };
    Object.keys(p[seg]).forEach(sym => {
      f[seg].data[sym] = { types: Object.keys(p[seg][sym]).sort(), data: {} };
      Object.keys(p[seg][sym]).forEach(t => {
        f[seg].data[sym].data[t] = { expiries: Object.keys(p[seg][sym][t]).sort(
    (a, b) => new Date(a) - new Date(b)
), data: {} };
        Object.keys(p[seg][sym][t]).forEach(exp => {
          const sorted = [...p[seg][sym][t][exp].strikes].sort((a,b) => parseFloat(a)-parseFloat(b));
          f[seg].data[sym].data[t].data[exp] = { strikes: sorted, details: p[seg][sym][t][exp].details };
        });
      });
    });
  });
  return f;
};

const getDefaultSelections = (data, tSeg, tSym, tType, tExp, tStr) => {
  const seg = data[tSeg] ? tSeg : Object.keys(data)[0];
  if (!seg) return null;

  let defaultSymbol = data[seg].symbols[0];

if (seg === "NSE_FO") {
  defaultSymbol = data[seg].symbols.includes("NIFTY")
    ? "NIFTY"
    : defaultSymbol;
}

if (seg === "BSE_FO") {
  defaultSymbol = data[seg].symbols.includes("SENSEX")
    ? "SENSEX"
    : defaultSymbol;
}

if (seg === "MCX") {
  defaultSymbol = data[seg].symbols.includes("CRUDEOILM")
    ? "CRUDEOILM"
    : defaultSymbol;
}

const sym = data[seg].symbols.includes(tSym)
  ? tSym
  : defaultSymbol;
  if (!sym) return null;

  const t = data[seg].data[sym].types.includes(tType)
    ? tType
    : data[seg].data[sym].types[0];
  if (!t) return null;

  // Keep only today & future expiries
 const expiries = data[seg].data[sym].data[t].expiries
    .filter(e => e === "N/A" || isFutureOrToday(e))
    .sort((a, b) => {
        if (a === "N/A") return -1;
        if (b === "N/A") return 1;
        return new Date(a) - new Date(b);
    });

  const exp = expiries.includes(tExp)
    ? tExp
    : expiries[0];

  if (!exp) return null;

  const av = data[seg].data[sym].data[t].data[exp].strikes;

  let str = "N/A";

  if (!noStrike(t))
    str = av.includes(tStr)
      ? tStr
      : av[Math.floor(av.length / 2)] || "N/A";

  const cd =
    data[seg].data[sym].data[t].data[exp].details[str] || {
      token: "",
      lotSize: 0,
    };

  return {
    segment: seg,
    symbol: sym,
    type: t,
    expiry: exp,
    strike: str,
    exchange_token: cd.token,
    lot_size: seg === "MCX" ? 1 : cd.lotSize,
    tick_size: cd.tick || 0.05,
    lots: "1",
    side: "Buy",
  };
};
// PORTFOLIO SECTION
const PortfolioSection = ({
  marketData, loading, quoteMap,
  onLoginAll, onLogoutAll, onConnectAll, onDisconnectAll, onUpload, onDownload,
  isAllLogged, isAllConnected, isLoggingAll, isConnectingAll,
  onExecute, isExecuting,
  onRefreshInstruments, isRefreshingInstruments,
  execConfig,
  wsEpoch,
  feedOn = false,      // prices only after a client is logged in (Login All)
  log = () => {},
}) => {
  const [numLegs, setNumLegs] = useState(1);
  const maxLegs = Math.min(8, Math.max(1, Number(execConfig.limits?.maxLegs) || 8));
  const halted  = !!execConfig.tradingHalted;

  // Keep the selection inside the admin's leg limit.
  useEffect(() => { if (numLegs > maxLegs) setNumLegs(maxLegs); }, [maxLegs, numLegs]);
  const [legs, setLegs]       = useState([]);
  const fileRef  = useRef(null);
  const subRef   = useRef(new Set());
  const clearedRef = useRef(false);   // leftover tokens from an earlier page released?
  const epochRef = useRef(wsEpoch);
  const tokenKey = legs
    .map(l => String(l?.exchange_token || ""))
    .join("|");
  // Resize legs
  useEffect(() => {
    if (!marketData || !Object.keys(marketData).length) return;
    setLegs(prev => {
      const next = [...prev];
      while (next.length < numLegs)
        next.push(getDefaultSelections(marketData, "NSE_FO", null, null, null, null));
      next.length = numLegs;
      return next;
    });
  }, [numLegs, marketData]);

  // Subscribe / unsubscribe tokens diff
  useEffect(() => {
    let cancelled = false;

    const syncSubscriptions = async () => {

        // Nothing is subscribed until a client is logged in (Login All);
        // after Logout All every leg token is unsubscribed again.
        const current = new Set(feedOn
            ? legs.map(l => l?.exchange_token?.toString()).filter(Boolean)
            : []);

        // After a quote-socket (re)connect the backend may have restarted and
        // forgotten our subscriptions: re-send every current token.
        if (epochRef.current !== wsEpoch) { epochRef.current = wsEpoch; subRef.current = new Set(); }
        const previous = subRef.current;

        // First run on this page: drop whatever an earlier page of this user left subscribed.
        if (!clearedRef.current) {
            try {
                const r = await fetch(`${API}/api/unsubscribe`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ all: true }) });
                if (r.ok) { clearedRef.current = true; previous.clear(); }
            } catch { /* retried on the next sync */ }
            if (cancelled) return;
        }

        const toSubscribe = [...current].filter(
            token => !previous.has(token)
        );

        const toUnsubscribe = [...previous].filter(
            token => !current.has(token)
        );

        try {

// 1. Unsubscribe OLD tokens

if (toUnsubscribe.length) {

    log(`Unsubscribe token(s): ${toUnsubscribe.join(", ")}`);

    const res = await fetch(`${API}/api/unsubscribe`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
            tokens: toUnsubscribe
        })
    });

    if (!cancelled && res.ok) {
        toUnsubscribe.forEach(t => previous.delete(t));
    }
}


// 2. Subscribe NEW tokens

if (toSubscribe.length) {

    const segs = toSubscribe.map(token => {
        const leg = legs.find(
            l => String(l.exchange_token) === token
        );

        return leg?.segment || "NSE_FO";
    });

    log(`Subscribe token(s): ${toSubscribe.join(", ")}`);

    const res = await fetch(`${API}/api/subscribe`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
            tokens: toSubscribe,
            segments: segs
        })
    });

    if (!cancelled && res.ok) {
        toSubscribe.forEach(t => previous.add(t));
    }
}

        } catch (err) {
            console.error("Subscription sync failed:", err);
        }
    };

    // Debounce to avoid multiple API calls while changing dropdowns
    const timer = setTimeout(syncSubscriptions, 100);

    return () => {
        cancelled = true;
        clearTimeout(timer);
    };

}, [tokenKey, wsEpoch, feedOn]);

  // Log the start / stop of leg prices once per change.
  const feedRef = useRef(feedOn);
  useEffect(() => {
    if (feedRef.current === feedOn) return;
    feedRef.current = feedOn;
    log(feedOn ? "Client logged in — leg prices started" : "No client logged in — leg prices stopped");
  }, [feedOn]);

  const handleLegChange = (idx, field, value) => {
    if (!marketData) return;
    log(`L${idx + 1} ${field}: ${value}`);
    setLegs(prev => {
      const next = [...prev];
      const leg  = next[idx];
      if (field==="lots"||field==="side") { next[idx]={...leg,[field]:value}; return next; }
      const intent = {
        segment: field==="segment"?value:leg.segment,
        symbol:  field==="segment"?null:field==="symbol"?value:leg.symbol,
        type:    ["segment","symbol"].includes(field)?null:field==="type"?value:leg.type,
        expiry:  ["segment","symbol","type"].includes(field)?null:field==="expiry"?value:leg.expiry,
        strike:  ["segment","symbol","type","expiry"].includes(field)?null:field==="strike"?value:leg.strike,
      };
      const r = getDefaultSelections(marketData,intent.segment,intent.symbol,intent.type,intent.expiry,intent.strike);
      if (r) next[idx]={...leg,...r};
      return next;
    });
  };

  // All tokens valid + relevant quote available for each leg
  const allTokensValid = legs.length>0 && legs.every(l=>l?.exchange_token&&l.exchange_token!=="");
  const allHaveQuote   = legs.every(l => {
    const q = feedOn ? quoteMap[String(l?.exchange_token||"").trim()] : null;
    if (!q) return false;
    return (l.side||"Buy")==="Buy" ? (q.ask||0)>0 : (q.bid||0)>0;
  });

  if (loading || !marketData) return (
    <div className="h-full flex items-center justify-center gap-3 text-emerald-400 font-mono text-sm">
      <Loader className="animate-spin" size={18}/> Loading instruments…
    </div>
  );

  // Every cell has a fixed width and a fixed height (h-8), so changing a
  // selection or a price never resizes anything.
  const SEL = "w-full h-8 min-w-0 truncate bg-[#1e2430] border border-[#374151] text-white text-[11px] px-1 focus:outline-none focus:border-blue-500";
  const RO  = "w-full h-8 min-w-0 bg-[#161b27] border border-[#2d3748] text-gray-500 text-[12px] px-1 cursor-not-allowed text-center";
  const ED  = "w-full h-8 min-w-0 bg-[#1e2430] border border-[#374151] text-white text-[12px] px-1 focus:outline-none focus:border-blue-500 text-center";
  const PX  = "h-8 flex items-center justify-end pr-1 font-mono tabular-nums font-semibold text-[11px] whitespace-nowrap overflow-hidden";

  // Leg | Segment | Symbol | Type | Expiry | Strike | Ask | Bid | Side | Lot Sz | Lots | Token | LTP
  // Fits ~860px (the left panel on a 1366px laptop) with no horizontal scroll.
  const GRID = "28px 74px minmax(100px,1fr) 44px 92px 66px 64px 64px 54px 44px 46px 58px 64px";
  const ROW_H = 44;   // px, incl. padding — 4 rows fit before the list scrolls

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#2d333b]">

      {/* Toolbar */}
      <div className="bg-[#1e2329] px-2 py-1.5 flex items-center border-b border-gray-700 shrink-0 overflow-x-auto gap-1.5">
        <input type="file" ref={fileRef} style={{display:"none"}} onChange={onUpload} accept=".json"/>
        <button onClick={()=>fileRef.current?.click()} className="flex items-center gap-1 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 px-2 py-1 rounded-sm text-[10px] transition-colors">
          <Upload size={12} className="text-blue-400"/> Upload
        </button>
        <button onClick={onDownload} className="flex items-center gap-1 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 px-2 py-1 rounded-sm text-[10px] transition-colors">
          <Download size={12} className="text-emerald-400"/> Download
        </button>
        <div className="w-px h-4 bg-gray-600 mx-0.5"/>
        <button disabled={isLoggingAll} onClick={isAllLogged?onLogoutAll:onLoginAll}
          className={`flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-medium min-w-[88px] justify-center transition-colors
            ${isAllLogged?"bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30":"bg-blue-600 hover:bg-blue-500 text-white"}
            disabled:opacity-50 disabled:cursor-not-allowed`}>
          {isLoggingAll?<Loader className="animate-spin" size={12}/>:isAllLogged?<LogOut size={12}/>:<Database size={12}/>}
          <span>{isLoggingAll?"Working…":isAllLogged?"Logout All":"Login All"}</span>
        </button>
        <div className="w-px h-4 bg-gray-600 mx-0.5"/>
        <button disabled={isConnectingAll} onClick={isAllConnected?onDisconnectAll:onConnectAll}
          className={`flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-medium min-w-[100px] justify-center transition-colors
            ${isAllConnected?"bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30":"bg-emerald-600 hover:bg-emerald-500 text-white"}
            disabled:opacity-50 disabled:cursor-not-allowed`}>
          {isConnectingAll?<Loader className="animate-spin" size={12}/>:isAllConnected?<PowerOff size={12}/>:<Activity size={12}/>}
          <span>{isConnectingAll?"Working…":isAllConnected?"Disconnect All":"Connect All"}</span>
        </button>
        <div className="w-px h-4 bg-gray-600 mx-0.5"/>
        <button onClick={onRefreshInstruments} disabled={isRefreshingInstruments}
          title="Download the latest instrument master from Upstox"
          className="flex items-center gap-1 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 px-2 py-1 rounded-sm text-[10px] font-medium transition-colors text-sky-300 disabled:opacity-50 disabled:cursor-not-allowed">
          <RefreshCw size={12} className={isRefreshingInstruments ? "animate-spin" : ""}/>
          {isRefreshingInstruments ? "Refreshing…" : "Refresh Instruments"}
        </button>
      </div>

      {/* Trading mode — always visible */}
      <div className={`px-4 py-1 shrink-0 flex items-center gap-2 border-b text-[11px] font-semibold ${
        execConfig.tradingMode === "LIVE" ? "bg-red-500/10 border-red-500/40 text-red-300" : "bg-amber-500/10 border-amber-500/40 text-amber-300"}`}>
        <span className={`px-1.5 rounded-sm text-[10px] ${execConfig.tradingMode === "LIVE" ? "bg-red-600 text-white" : "bg-amber-500 text-black"}`}>
          {execConfig.tradingMode === "LIVE" ? "LIVE" : "PAPER"}
        </span>
        {execConfig.tradingMode === "LIVE"
          ? "Orders go to the broker — real money."
          : "Paper mode — orders are simulated on the live market feed; nothing is sent to the broker."}
      </div>

      {halted && (
        <div className="px-4 py-1.5 shrink-0 flex items-center gap-2 bg-red-500/15 border-b border-red-500/40 text-red-300 text-[11px] font-semibold">
          <OctagonX size={13}/> Trading is halted by the admin{haltNote(execConfig.haltReason) ? ` (reason: ${haltNote(execConfig.haltReason)})` : ""}. The Execute button is off.
        </div>
      )}

      {/* Number of legs */}
      <div className="px-4 py-2 shrink-0 flex items-center gap-6 border-b border-gray-700 bg-[#252b33]">
        <span className="text-white font-medium text-[14px]">Number of Legs:</span>
        {Array.from({ length: maxLegs }, (_, i) => i + 1).map(n=>(
          <label key={n} className="flex items-center gap-2 cursor-pointer select-none">
            <input type="radio" name="numLegs" value={n} checked={numLegs===n}
              onChange={()=>{ log(`Legs: ${numLegs} to ${n}`); setNumLegs(n); }} className="w-[17px] h-[17px] accent-blue-500 cursor-pointer"/>
            <span className="text-white text-[14px]">{n}</span>
          </label>
        ))}
      </div>

      {/* Legs table */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="px-2 pt-2 pb-1 min-w-[860px]">

          {/* Header */}
          <div className="grid gap-1 mb-1.5 px-1.5 text-gray-200 font-semibold text-[11px]"
               style={{gridTemplateColumns:GRID}}>
            <div>Leg</div>
            <div>Segment</div>
            <div>Symbol</div>
            <div>Type</div>
            <div>Expiry</div>
            <div>Strike</div>
            <div className="text-orange-400">Ask</div>
            <div className="text-teal-400">Bid</div>
            <div>Side</div>
            <div>Lot Sz</div>
            <div>Lots</div>
            <div>Token</div>
            <div className="text-amber-300 text-right pr-1">LTP</div>
          </div>

          {/* Rows: up to 4 visible, a scrollbar only from the 5th leg */}
          <div className="flex flex-col gap-1.5 overflow-y-auto custom-scrollbar"
               style={{ maxHeight: ROW_H * 4 + 6 * 3 }}>
            {legs.map((leg,idx)=>{
              if (!leg) return null;
              const segD = marketData[leg.segment]       || {symbols:[]};
              const symD = segD.data?.[leg.symbol]       || {types:[]};
              const typD = symD.data?.[leg.type]         || {expiries:[]};
              const expD = typD.data?.[leg.expiry]       || {strikes:[]};
              const q    = (feedOn && quoteMap[String(leg.exchange_token||"").trim()]) || {bid:0,ask:0,ltp:0};
              const tokOk = leg.exchange_token && leg.exchange_token !== "Unknown Key" && leg.exchange_token !== "";
              const askOk = (q.ask||0) > 0;
              const bidOk = (q.bid||0) > 0;
              const isBuy = (leg.side||"Buy") === "Buy";

              return (
                <div key={idx} className="grid gap-1 items-center px-1.5 border border-gray-600 rounded shrink-0"
                     style={{gridTemplateColumns:GRID, background:"#2d333b", height: ROW_H}}>

                  <div className="font-bold text-white text-center text-[13px]">L{idx+1}</div>

                  <select className={SEL} value={leg.segment} onChange={e=>handleLegChange(idx,"segment",e.target.value)}>
                    {Object.keys(marketData).map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  <select className={SEL} value={leg.symbol} title={leg.symbol} onChange={e=>handleLegChange(idx,"symbol",e.target.value)}>
                    {segD.symbols.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  <select className={SEL} value={leg.type} onChange={e=>handleLegChange(idx,"type",e.target.value)}>
                    {symD.types.map(t=><option key={t} value={t}>{t}</option>)}
                  </select>
                  <select className={SEL} value={leg.expiry} onChange={e=>handleLegChange(idx,"expiry",e.target.value)}>
                    {typD.expiries.map(e=><option key={e} value={e}>{e}</option>)}
                  </select>
                  <select className={SEL} value={leg.strike} onChange={e=>handleLegChange(idx,"strike",e.target.value)}
                    disabled={noStrike(leg.type)} style={noStrike(leg.type)?{opacity:.4}:{}}>
                    {noStrike(leg.type)?<option value="N/A">N/A</option>
                      :expD.strikes.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>

                  {/* Ask — price sellers are offering (used for BUY orders) */}
                  <div className={`${PX} ${askOk ? "text-orange-400" : "text-gray-600"}`}
                       title={!q.hasData ? "No quote yet" : askOk ? "" : "No sellers right now"}>
                    {askOk ? q.ask.toFixed(2) : "—"}
                  </div>

                  {/* Bid — price buyers are bidding (used for SELL orders) */}
                  <div className={`${PX} ${bidOk ? "text-teal-400" : "text-gray-600"}`}
                       title={!q.hasData ? "No quote yet" : bidOk ? "" : "No buyers right now"}>
                    {bidOk ? q.bid.toFixed(2) : "—"}
                  </div>

                  {/* Side */}
                  <select className={`${SEL} font-semibold`} value={leg.side||"Buy"}
                    onChange={e=>handleLegChange(idx,"side",e.target.value)}
                    style={{color:isBuy?"#60a5fa":"#f87171"}}>
                    {SIDES.map(s=><option key={s} value={s} style={{color:s==="Buy"?"#60a5fa":"#f87171"}}>{s}</option>)}
                  </select>

                  {/* Lot Size (read-only) */}
                  <input readOnly value={leg.lot_size||0} className={RO}/>

                  {/* Lots input */}
                  <input type="number" min="1" step="1" value={leg.lots||"1"}
                    onChange={e=>handleLegChange(idx,"lots",e.target.value)} className={ED}/>

                  {/* Token */}
                  <div className="h-8 flex items-center gap-1 overflow-hidden" title={leg.exchange_token}>
                    <span aria-hidden="true" className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${tokOk?"bg-emerald-500":"bg-red-500"}`}/>
                    <span className={`font-mono text-[11px] truncate ${tokOk?"text-emerald-400":"text-red-400"}`}>
                      {tokOk?leg.exchange_token:"N/A"}
                    </span>
                  </div>

                  {/* LTP */}
                  <div className={`${PX} ${(q.ltp||0) > 0 ? "text-amber-300" : "text-gray-600"}`}>
                    {(q.ltp||0) > 0 ? Number(q.ltp).toFixed(2) : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Execute bar */}
      <div className="px-4 py-2.5 bg-[#1e2329] border-t border-gray-700 flex items-center justify-between shrink-0">
        <div className="text-[10px] text-gray-400 leading-5">
          <div>
            <span className="text-orange-400">Ask</span> = BUY limit price &nbsp;|&nbsp; <span className="text-teal-400">Bid</span> = SELL limit price &nbsp;|&nbsp;
            {" "}{execConfig.engine.bufferPct}% buffer, DAY LIMIT order, {execConfig.engine.fillTimeout}s fill timeout, {execConfig.engine.maxRetries} {execConfig.engine.maxRetries === 1 ? "retry" : "retries"}
          </div>
          <div className="text-amber-500 mt-0.5 h-5 overflow-hidden">
            {!feedOn ? "Prices start after Login All — no token is subscribed until a client is logged in"
             : allTokensValid && !allHaveQuote && (
              legs.some(l => quoteMap[String(l?.exchange_token||"").trim()]?.hasData)
                ? "Selected contract has no liquidity right now (no bid / ask)"
                : "Waiting for bid/ask from the market feed…"
            )}
          </div>
        </div>
        <button onClick={()=>onExecute(legs)} disabled={halted||!allTokensValid||!allHaveQuote||isExecuting}
          title={halted ? "Trading is halted by admin" : undefined}
          className={`flex items-center gap-2 px-8 py-2 font-bold rounded-sm text-sm transition-all
            ${!halted&&allTokensValid&&allHaveQuote&&!isExecuting
              ?"bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_12px_rgba(16,185,129,0.4)]"
              :"bg-gray-700 text-gray-500 cursor-not-allowed"}`}>
          {isExecuting?<><Loader size={14} className="animate-spin"/>EXECUTING…</>:execConfig.tradingMode === "LIVE" ? "EXECUTE LIVE" : "EXECUTE (PAPER)"}
        </button>
      </div>
    </div>
  );
};

// CLIENT CARD
const ClientCard = ({ client, quoteMap, onToggleLogin, onToggleConnect }) => {
  const [viewMode, setViewMode] = useState("positions");
  const [rows,     setRows]     = useState([]);
  const [fetching, setFetching] = useState(false);

  const inFlight = useRef(false);

  // background=true: periodic refresh — no spinner, and a failed request
  // (e.g. backend briefly unreachable) keeps the last rows on screen.
  const fetchData = useCallback(async (background = false) => {
    const isAlgo = viewMode === "algo" || viewMode === "algoorders"; // strategy books need no broker login (PAPER)
    if (!isAlgo && !client.isLogged) { setRows([]); return; }
    if (inFlight.current) return;
    inFlight.current = true;
    if (!background) setFetching(true);
    try {
      const path = viewMode === "algo" ? "strategy-positions" : viewMode === "algoorders" ? "strategy-orders" : viewMode;
      const r = await fetch(`${API}/api/clients/${client.id}/${path}`, { headers: authHeaders() });
      const d = await r.json();
      if (r.ok) setRows(Array.isArray(d) ? d : []);
    } catch {
      if (!background) setRows([]);
    } finally {
      inFlight.current = false;
      if (!background) setFetching(false);
    }
  }, [client.id, client.isLogged, viewMode]);

  useEffect(() => {
    fetchData(false);
    const id = setInterval(() => { if (!document.hidden) fetchData(true); }, viewMode.startsWith("algo") ? 3000 : 5000);
    return () => clearInterval(id);
  }, [fetchData, viewMode]);

  const HDRS = {
    algo:      ["Strategy","Mode","Order ID","Instrument","Side","Qty","Entry","LTP","Stop","Status","P&L","Slot"],
    algoorders:["Time","Strategy","Mode","Order ID","Instrument","Side","Qty","Price","Reason","P&L","Status"],
    orders:    ["Token","Side","Qty","Filled","Pending","Price","Product","Type","TIF","Status","AppID","ExchID","Time","Date"],
    trades:    ["Token","Side","Qty","Price","Product","Type","AppID","ExchID","Status","Time","Date"],
    positions: ["Token","Product","LTP","MTM","Realized","Unrealized","BuyQty","BuyAvg","SellQty","SellAvg","NetQty","NetAvg"],
  };

  const renderRows = () => {
    if (fetching) return <tr><td colSpan={20} className="px-2 py-4 text-center text-emerald-400 text-[9px]"><Loader className="animate-spin inline mr-1" size={10}/>Loading…</td></tr>;
    if (!rows.length) return <tr><td colSpan={20} className="px-2 py-4 text-center text-gray-500 text-[9px]">
      {viewMode==="algo" ? "No PAPER strategy positions for this client today"
        : viewMode==="algoorders" ? "No PAPER strategy orders for this client today"
        : client.isLogged ? "No data" : "Login required"}
    </td></tr>;

    if (viewMode==="algoorders") return rows.map(t => (
      <tr key={t.id} className="text-gray-300 text-[9px] hover:bg-[#2d333b] border-b border-gray-800">
        <td className="px-2 py-1">{t.time}</td>
        <td className="px-2 py-1 text-white">{t.strategy}</td>
        <td className={`px-2 py-1 font-semibold ${t.mode==="LIVE"?"text-red-300":"text-amber-300"}`}>{t.mode}</td>
        <td className="px-2 py-1 font-mono text-[8px] text-gray-200">{t.orderId || "—"}</td>
        <td className="px-2 py-1">
          <div className="text-white">{t.tradingSymbol}</div>
          <div className="text-[8px] text-gray-500 font-mono">{t.token}</div>
        </td>
        <td className={`px-2 py-1 font-semibold ${t.side==="BUY"?"text-blue-400":"text-red-400"}`}>{t.side}</td>
        <td className="px-2 py-1">{t.qty}</td>
        <td className="px-2 py-1 text-white">{t.price}</td>
        <td className="px-2 py-1">{t.reason}</td>
        <td className={`px-2 py-1 font-semibold ${t.pnl==null||t.pnl===""?"text-gray-500":Number(t.pnl)>=0?"text-emerald-400":"text-red-400"}`}>
          {t.pnl==null||t.pnl==="" ? "—" : Number(t.pnl).toFixed(2)}
        </td>
        <td className="px-2 py-1">{t.status}</td>
      </tr>
    ));

    if (viewMode==="algo") return rows.map(p => {
      const pnl = p.status==="OPEN" ? p.unrealized : p.pnl;
      return (
        <tr key={`${p.assignmentId}-${p.id}`} className="text-gray-300 text-[9px] hover:bg-[#2d333b] border-b border-gray-800">
          <td className="px-2 py-1 text-white">{p.strategyName}</td>
          <td className={`px-2 py-1 font-semibold ${p.mode==="LIVE"?"text-red-300":"text-amber-300"}`}>{p.mode}</td>
          <td className="px-2 py-1 font-mono text-[8px] text-gray-300">
            <div>{p.orderId || "—"}</div>
            {p.exitOrderId && <div className="text-gray-500">exit {p.exitOrderId}</div>}
          </td>
          <td className="px-2 py-1">
            <div className="text-white">{p.tradingSymbol}</div>
            <div className="text-[8px] text-gray-500 font-mono">{p.token}{p.delta!=null?` · delta ${p.delta}`:""}</div>
          </td>
          <td className={`px-2 py-1 font-semibold ${p.side==="BUY"?"text-blue-400":"text-red-400"}`}>{p.side}</td>
          <td className="px-2 py-1">{p.qty}</td>
          <td className="px-2 py-1">{p.entryPrice}</td>
          <td className="px-2 py-1 text-amber-400 font-semibold">{p.ltp ?? "—"}</td>
          <td className="px-2 py-1">{p.stopPrice ?? "—"}</td>
          <td className={`px-2 py-1 font-semibold ${p.status==="OPEN"?"text-emerald-400":p.status==="CHECK"?"text-fuchsia-400":"text-gray-400"}`}>
            {p.status}{p.exitReason?` (${p.exitReason})`:""}
          </td>
          <td className={`px-2 py-1 font-semibold ${pnl==null?"text-gray-500":pnl>=0?"text-emerald-400":"text-red-400"}`}>{pnl==null?"—":Number(pnl).toFixed(2)}</td>
          <td className="px-2 py-1 text-gray-500">{p.slot}</td>
        </tr>
      );
    });

    if (viewMode==="orders") return rows.map((o,i)=>(
      <tr key={i} className="text-gray-300 text-[9px] hover:bg-[#2d333b] border-b border-gray-800">
        <td className="px-2 py-1">
  <div className="text-white">{o.TradingSymbol ?? "—"}</div>
  <div className="text-[8px] text-gray-500 font-mono">
    {o.ExchangeInstrumentID}
  </div>
</td>
        <td className={`px-2 py-1 font-semibold ${o.OrderSide==="BUY"?"text-blue-400":"text-red-400"}`}>{o.OrderSide}</td>
        <td className="px-2 py-1">{o.OrderQuantity}</td>
        <td className="px-2 py-1">{o.CumulativeQuantity}</td>
        <td className="px-2 py-1">{o.LeavesQuantity}</td>
        <td className="px-2 py-1 text-white">{o.LimitPrice??o.OrderPrice??"—"}</td>
        <td className="px-2 py-1">{o.ProductType}</td>
        <td className="px-2 py-1">{o.OrderType}</td>
        <td className="px-2 py-1">{o.TimeInForce}</td>
        <td className={`px-2 py-1 font-semibold ${o.OrderStatus==="Filled"?"text-emerald-400":o.OrderStatus==="Rejected"?"text-red-400":"text-amber-400"}`}>{o.OrderStatus}</td>
        <td className="px-2 py-1 font-mono text-[8px] text-gray-400">{o.AppOrderID}</td>
        <td className="px-2 py-1 font-mono text-[8px] text-gray-400">{o.ExchangeOrderID}</td>
        <td className="px-2 py-1">{o.OrderGeneratedDateTime?.slice(11,19)||"—"}</td>
        <td className="px-2 py-1">{o.OrderGeneratedDateTime?.slice(0,10)||"—"}</td>
      </tr>
    ));

    if (viewMode==="trades") return rows.map((t,i)=>(
      <tr key={i} className="text-gray-300 text-[9px] hover:bg-[#2d333b] border-b border-gray-800">
        <td className="px-2 py-1">
  <div className="text-white">{t.TradingSymbol ?? "—"}</div>
  <div className="text-[8px] text-gray-500 font-mono">
    {t.ExchangeInstrumentID}
  </div>
</td>
        <td className={`px-2 py-1 font-semibold ${t.OrderSide==="BUY"?"text-blue-400":"text-red-400"}`}>{t.OrderSide}</td>
        <td className="px-2 py-1">{t.OrderQuantity}</td>
        <td className="px-2 py-1 text-white">{t.TradedPrice??"—"}</td>
        <td className="px-2 py-1">{t.ProductType}</td>
        <td className="px-2 py-1">{t.OrderType}</td>
        <td className="px-2 py-1 font-mono text-[8px] text-gray-400">{t.AppOrderID}</td>
        <td className="px-2 py-1 font-mono text-[8px] text-gray-400">{t.ExchangeOrderID}</td>
        <td className={`px-2 py-1 font-semibold ${t.OrderStatus==="Filled"?"text-emerald-400":t.OrderStatus==="Rejected"?"text-red-400":"text-amber-400"}`}>{t.OrderStatus}</td>
        <td className="px-2 py-1">{t.ExchangeTransactTime?.slice(11,19)||"—"}</td>
        <td className="px-2 py-1">{t.ExchangeTransactTime?.slice(0,10)||"—"}</td>
      </tr>
    ));

    return rows.map((p, i) => {

  const ltp = Number(
    quoteMap[Number(p.ExchangeInstrumentId)]?.ltp ??
    quoteMap[String(p.ExchangeInstrumentId)]?.ltp ??
    0
  );

  const qty = Number(p.Quantity || 0);
  const mult = Number(p.Multiplier || 1);

  const buyAvg = Number(p.BuyAveragePrice || 0);
  const sellAvg = Number(p.SellAveragePrice || 0);
  const realized =
  qty === 0
    ? Number(p.NetAmount || 0)
    : Number(p.RealizedMTM || 0);

let unrealized = 0;

if (qty > 0) {
  unrealized = (ltp - buyAvg) * qty * mult;
} else if (qty < 0) {
  unrealized = (sellAvg - ltp) * Math.abs(qty) * mult;
}

const mtm =
  qty === 0
    ? realized
    : realized + unrealized;

  return (
    <tr
      key={i}
      className="text-gray-300 text-[9px] hover:bg-[#2d333b] border-b border-gray-800"
    >
      <td className="px-2 py-1">
        <div className="text-white">{p.TradingSymbol}</div>
        <div className="text-[8px] text-gray-500 font-mono">
          {p.ExchangeInstrumentId}
        </div>
      </td>

      <td className="px-2 py-1">
        {p.ProductType}
      </td>

      <td className="px-2 py-1 text-amber-400 font-semibold">
        {ltp > 0 ? ltp.toFixed(2) : "—"}
      </td>

      <td
        className={`px-2 py-1 font-semibold ${
          mtm >= 0 ? "text-emerald-400" : "text-red-400"
        }`}
      >
        {mtm.toFixed(2)}
      </td>

      <td
        className={`px-2 py-1 ${
          realized >= 0 ? "text-emerald-400" : "text-red-400"
        }`}
      >
        {realized.toFixed(2)}
      </td>

      <td
        className={`px-2 py-1 ${
          unrealized >= 0 ? "text-emerald-400" : "text-red-400"
        }`}
      >
        {qty === 0 ? "—" : unrealized.toFixed(2)}
      </td>

      <td className="px-2 py-1 text-blue-400">
        {Number(p.OpenBuyQuantity || 0)}
      </td>

      <td className="px-2 py-1">
        {buyAvg.toFixed(2)}
      </td>

      <td className="px-2 py-1 text-red-400">
        {Number(p.OpenSellQuantity || 0)}
      </td>

      <td className="px-2 py-1">
        {sellAvg.toFixed(2)}
      </td>

      <td className="px-2 py-1 font-semibold">
        {qty}
      </td>

      <td className="px-2 py-1">
        {qty > 0
          ? buyAvg.toFixed(2)
          : qty < 0
          ? sellAvg.toFixed(2)
          : "—"}
      </td>
    </tr>
  );

});
  };

  return (
    <div className="flex flex-col bg-[#1e2329] rounded border border-gray-700 overflow-hidden h-full shadow-lg">
      <div className="flex justify-between items-center px-2 py-1.5 border-b border-gray-700 bg-[#242a31] shrink-0">
        <div className="flex items-center gap-1.5 overflow-hidden">
          <ShieldCheck className="text-blue-400 shrink-0" size={14}/>
          <span className="text-xs font-bold text-gray-100 truncate">{client.name}</span>
          <span className="text-[9px] font-mono text-gray-500">({client.id})</span>
        </div>
        <div className="flex gap-1.5 items-center shrink-0">
          <div className="flex bg-[#161a1f] p-[2px] rounded-sm border border-gray-700">
            {["orders","trades","positions","algo","algoorders"].map(m=>(
              <button key={m} onClick={()=>setViewMode(m)}
                className={`px-1.5 py-0.5 text-[8px] font-medium rounded-sm transition-colors
                  ${viewMode===m?"bg-[#3b4148] text-white shadow-sm":"text-gray-400 hover:text-gray-200"}`}>
                {m==="orders"?"Orders":m==="trades"?"Trades":m==="positions"?"Positions":m==="algo"?"Algo Pos":"Algo Orders"}
              </button>
            ))}
          </div>
          <button onClick={() => fetchData(false)} className="p-1 text-gray-500 hover:text-gray-200 transition-colors" title="Refresh"><Activity size={12}/></button>
          <button
            onClick={() => saveText(rowsToCsv(rows, CSV_COLUMNS[viewMode]), `${client.id}-${CSV_NAMES[viewMode]}-${todayIst()}.csv`)}
            disabled={!rows.length}
            title={rows.length ? `Download this ${CSV_NAMES[viewMode].replace("-", " ")} as CSV` : "Nothing to download"}
            className="flex items-center gap-0.5 px-1 py-0.5 text-[8px] font-semibold text-emerald-400 hover:text-emerald-300 border border-gray-700 rounded-sm disabled:opacity-30 disabled:cursor-not-allowed">
            <Download size={10}/> CSV
          </button>
          <div className="w-px h-4 bg-gray-600"/>
          {client.isLogged
            ?<button onClick={()=>onToggleLogin(client.id,false)} className="p-1 bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30 rounded-sm"><LogOut size={12}/></button>
            :<button onClick={()=>onToggleLogin(client.id,true)} className="p-1 bg-blue-600 hover:bg-blue-500 text-white rounded-sm"><LogIn size={12}/></button>}
          {client.isConnected
            ?<button onClick={()=>onToggleConnect(client.id,false)} className="p-1 bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30 rounded-sm"><PowerOff size={12}/></button>
            :<button onClick={()=>onToggleConnect(client.id,true)} disabled={!client.isLogged}
               className={`p-1 rounded-sm transition-colors ${client.isLogged?"bg-emerald-600 hover:bg-emerald-500 text-white":"bg-gray-700 text-gray-500 cursor-not-allowed"}`}>
               <Power size={12}/></button>}
        </div>
      </div>
      <div className="flex-1 overflow-auto min-w-0 min-h-0 bg-[#1a1e24]">
        <div className="bg-[#2d333b] px-2 py-0.5 border-b border-gray-700 flex items-center gap-1 text-[8px] text-gray-400 font-semibold uppercase tracking-wider sticky top-0 z-10">
          {viewMode==="orders"   &&<><LayoutList size={9} className="text-blue-400"/>Order Book</>}
          {viewMode==="trades"   &&<><BookOpen   size={9} className="text-emerald-400"/>Trade Book</>}
          {viewMode==="positions"&&<><Briefcase  size={9} className="text-amber-400"/>Positions</>}
          {viewMode==="algo"     &&<><Bot        size={9} className="text-sky-400"/>PAPER strategy positions — LIVE strategy trades are in Orders / Trades / Positions</>}
          {viewMode==="algoorders"&&<><Bot       size={9} className="text-sky-400"/>PAPER strategy orders today, by PAPER order ID — LIVE ones are in Orders / Trades</>}
        </div>
        <table className="w-full text-left border-collapse whitespace-nowrap">
          <thead>
            <tr className="bg-[#242a31] text-gray-400 text-[8px] uppercase tracking-wider">
              {(HDRS[viewMode]||[]).map(h=><th key={h} className="px-2 py-1.5 border-b border-gray-700 font-semibold">{h}</th>)}
            </tr>
          </thead>
          <tbody>{renderRows()}</tbody>
        </table>
      </div>
    </div>
  );
};

// MAIN APP
export default function App() {
  const [marketData,      setMarketData]      = useState(null);
  const [instrLoading,    setInstrLoading]    = useState(true);
  const [clients,         setClients]         = useState([]);
  const [quoteMap,        setQuoteMap]        = useState({});   // { token: { bid, ask } }
  const [globalLogs,      setGlobalLogs]      = useState(() => [`[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] System initialized`]);
  const [wsStatus,        setWsStatus]        = useState("disconnected");
  const [isLoggingAll,    setIsLoggingAll]    = useState(false);
  const [isConnectingAll, setIsConnectingAll] = useState(false);
  const [isExecuting,     setIsExecuting]     = useState(false);
  const [execConfig,      setExecConfig]      = useState(DEFAULT_EXEC_CONFIG);
  const [isRefreshingInstruments, setIsRefreshingInstruments] = useState(false);
  const [leftTab,         setLeftTab]         = useState(() => { try { return localStorage.getItem("xts_left_tab") || "manual"; } catch { return "manual"; } });
  useEffect(() => { try { localStorage.setItem("xts_left_tab", leftTab); } catch {} }, [leftTab]);

  const wsRef     = useRef(null);
  const [wsEpoch, setWsEpoch] = useState(0);   // bumps on every quote-socket (re)connect
  const logEndRef = useRef(null);

  useEffect(()=>{ logEndRef.current?.scrollIntoView({behavior:"smooth"}); },[globalLogs]);

  const ts  = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
  // Every log line also goes to the server's activity journal. Lines wait in
  // localStorage while the network is down, so nothing is lost.
  const outboxRef = useRef(null);
  if (outboxRef.current === null) {
    try { outboxRef.current = JSON.parse(localStorage.getItem("xts_activity_outbox") || "[]"); }
    catch { outboxRef.current = []; }
  }
  const saveOutbox = () => {
    try { localStorage.setItem("xts_activity_outbox", JSON.stringify(outboxRef.current.slice(-2000))); } catch { /* storage full */ }
  };
  const log = useCallback(msg => {
    setGlobalLogs(p => [...p.slice(-500), `[${ts()}] ${msg}`]);
    outboxRef.current.push({ ts: Date.now(), message: String(msg) });
    saveOutbox();
  },[]);

  useEffect(() => {
    let busy = false;
    const flush = async () => {
      if (busy || !outboxRef.current.length || !getToken()) return;
      busy = true;
      const batch = outboxRef.current.slice(0, 200);
      try {
        const r = await fetch(`${API}/api/activity`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ entries: batch }) });
        if (r.ok) { outboxRef.current.splice(0, batch.length); saveOutbox(); }
      } catch { /* offline — retry on the next flush */ }
      busy = false;
    };
    const id = setInterval(flush, 1000);
    return () => clearInterval(id);
  }, []);

  // Today's saved activity (all sources) reloads into the panel after a refresh / restart.
  useEffect(() => {
    fetch(`${API}/api/journal/events`, { headers: authHeaders() })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d?.rows?.length) return;
        const restored = d.rows.slice(-300).map(e => `[${e.time}] ${e.source && e.source !== "UI" ? `[${e.source}] ` : ""}${e.message}`);
        setGlobalLogs(p => [...restored, "Today's saved activity above, this session below", ...p]);
      })
      .catch(() => {});
  }, []);

  const downloadActivity = async () => {
    try {
      await downloadFile(`${API}/api/journal/events?format=csv&date=${todayIst()}`, `activity-log-${todayIst()}.csv`, authHeaders());
      log("Activity log downloaded.");
    } catch (e) {
      log(`Error: Activity log download failed: ${e.message}`);
    }
  };

  // WebSocket for Bid/Ask quotes
  useEffect(() => {
    let mounted     = true;
    let reconnTimer = null;
    let retryMs     = 500;            // fast first retry, backing off to 5 s
    let errorLogged = false;

    // Ticks are applied once per animation frame: a burst of updates causes
    // one render, not one per tick.
    let pending = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = null;
      if (!batch) return;
      setQuoteMap(prev => {
        const next = { ...prev };
        for (const [token, quote] of Object.entries(batch)) {
          if (quote?.removed) delete next[token];
          else next[token] = quote;
        }
        return next;
      });
    };
    const queue = data => {
      pending = Object.assign(pending || {}, data);
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const connect = () => {
      if (!mounted) return;
      // The quote socket only accepts logged-in dashboards.
      const token = getToken();
      if (!token) return;
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      setWsStatus("connecting");

      ws.onopen = () => {
        if (!mounted) { ws.close(); return; }
        retryMs = 500;
        errorLogged = false;
        setWsStatus("connected");
        setWsEpoch(e => e + 1);       // legs re-send their subscriptions (backend may have restarted)
        log("Market socket connected — bid/ask live");
      };

      ws.onclose = () => {
        if (!mounted) return;
        setWsStatus("disconnected");
        if (!errorLogged) log(`Market socket disconnected — reconnecting…`);
        errorLogged = true;
        reconnTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(5000, retryMs * 2);
      };

      ws.onerror = () => { /* onclose follows and handles the reconnect */ };

      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return; // the backend only sends JSON text
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "quote" || msg.type === "quotes") queue(msg.data);
        } catch (err) {
          console.error("Bad quote message:", err);
        }
      };
    };

    connect();

    return () => {
      mounted = false;
      clearTimeout(reconnTimer);
      if (frame) cancelAnimationFrame(frame);
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    };
  }, [log]);

  // Load instruments (backend downloads them from Upstox)
  const loadInstruments = useCallback(async () => {
    const r = await fetch(`${API}/api/instruments`, { headers: authHeaders() });
    const raw = await r.json();
    if (!Array.isArray(raw)) throw new Error(raw?.error || "Unexpected instrument response");
    setMarketData(buildMarketData(raw));
    return raw.length;
  }, []);

  useEffect(() => {
    loadInstruments()
      .then(n => log(`Instruments: ${n.toLocaleString()} instruments loaded (allowed segments)`))
      .catch(e => { log(`ERROR loading instruments: ${e.message}`); setMarketData({}); })
      .finally(() => setInstrLoading(false));
  }, [log, loadInstruments]);

  const refreshInstruments = async () => {
    setIsRefreshingInstruments(true);
    log("Instruments: downloading latest master from Upstox…");
    try {
      const r = await fetch(`${API}/api/instruments/refresh`, { method: "POST", headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const n = await loadInstruments();
      if (d.lastError) log(`Warning: Instruments: download failed (${d.lastError}) — still using the copy from ${new Date(d.fetchedAt).toLocaleString()}`);
      else log(`Instruments refreshed: ${d.count.toLocaleString()} total, ${n.toLocaleString()} in allowed segments`);
    } catch (e) {
      log(`Error: Instrument refresh failed: ${e.message}`);
    } finally {
      setIsRefreshingInstruments(false);
    }
  };

  // Execution settings set by the admin (kill switch, engine, limits)
  const fetchExecConfig = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/execution/config`, { headers: authHeaders() });
      if (r.ok) setExecConfig(await r.json());
    } catch { /* keep the last known values */ }
  }, []);
  useEffect(() => { fetchExecConfig(); const id = setInterval(fetchExecConfig, 5000); return () => clearInterval(id); }, [fetchExecConfig]);

  // Poll client state
  const fetchClients = useCallback(async () => {
  try {
    const r = await fetch(`${API}/api/clients`, {
      headers: authHeaders(),
    });

    if (!r.ok) {
      setClients([]);
      return;
    }

    const data = await r.json();
    setClients(Array.isArray(data) ? data : []);
  } catch (e) {
    console.error(e);
    setClients([]);
  }
}, []);
  useEffect(() => { fetchClients(); const id = setInterval(fetchClients, 4000); return ()=>clearInterval(id); }, [fetchClients]);

  // API helper
  // Trade book CSV from the server journal (manual + strategy fills; survives restarts).
  const downloadTradeBook = async () => {
    try {
      await downloadFile(`${API}/api/journal/trades?format=csv&date=${todayIst()}`, `trade-book-${todayIst()}.csv`, authHeaders());
      log("Trade book downloaded.");
    } catch (e) {
      log(`Error: Trade book download failed: ${e.message}`);
    }
  };

  const callApi = async (url, body) => {
  const r = await fetch(`${API}${url}`, {
    method: "POST",
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  return r.json();
};
  const toggleClientLogin = async (id, login) => {
    const c = clients.find(x=>x.id===id);
    log(`${c?.name||id}: ${login?"Logging in…":"Logging out…"}`);
    try {
      const r = await callApi(`/api/clients/${id}/${login?"login":"logout"}`);
      if (r?.status === "login_failed") {
        log(`${c?.name||id}: Login failed — ${r.error}`);
      } else {
        log(`${c?.name||id}: ${login?"Login OK":"Logout OK"}`);
      }
    } catch (e) {
      log(`${c?.name||id}: Error — ${e.message}`);
    }
    fetchClients();
  };

  const toggleClientWS = async (id, conn) => {
    const c = clients.find(x=>x.id===id);
    try { await callApi(`/api/clients/${id}/${conn?"connect":"disconnect"}`); log(`${c?.name||id}: ${conn?"Connected":"Disconnected"}`); }
    catch (e) { log(`${c?.name||id}: error — ${e.message}`); }
    fetchClients();
  };

  const loginAll = async () => {
    setIsLoggingAll(true); log("System: Login All…");
    try { const r = await callApi("/api/clients/login-all"); r.forEach?.(x=>log(`${x.id}: ${x.status||x.error}`)); }
    catch (e) { log(`Login All error: ${e.message}`); }
    await fetchClients(); setIsLoggingAll(false);
  };
  const logoutAll = async () => {
    setIsLoggingAll(true); log("System: Logout All…");
    try { await callApi("/api/clients/logout-all"); log("System: All logged out"); }
    catch (e) { log(`Logout error: ${e.message}`); }
    await fetchClients(); setIsLoggingAll(false);
  };
  const connectAll = async () => {
    setIsConnectingAll(true); log("System: Connect All…");
    try { const r = await callApi("/api/clients/connect-all"); r.forEach?.(x=>log(`${x.id}: ${x.success?"Connected":x.error}`)); }
    catch (e) { log(`Connect error: ${e.message}`); }
    await fetchClients(); setIsConnectingAll(false);
  };
  const disconnectAll = async () => {
    setIsConnectingAll(true); log("System: Disconnect All…");
    try { await callApi("/api/clients/disconnect-all"); log("System: All disconnected"); }
    catch (e) { log(`Disconnect error: ${e.message}`); }
    await fetchClients(); setIsConnectingAll(false);
  };

  // Execute portfolio
  // Injects current bid/ask from quoteMap into each leg before sending
  const executePortfolio = async (rawLegs) => {
    // PAPER needs no broker session; LIVE needs each client logged in and connected.
    const paperMode = execConfig.tradingMode !== "LIVE";
    const active = clients.filter(c => c.enabled && (paperMode || (c.isLogged && c.isConnected)));
    if (!active.length) { log(paperMode ? "ERROR: No enabled clients" : "ERROR: No active (enabled+logged+connected) clients"); return; }

    // Inject current live bid/ask/ltp into each leg for initial price reference
    const legs = rawLegs.map(l => {
      const q = quoteMap[String(l?.exchange_token||"").trim()] || { bid:0, ask:0, ltp:0 };
      return { ...l, bid: q.bid, ask: q.ask, ltp: q.ltp };
    });

    if (execConfig.tradingHalted) { log(`ERROR: Trading is halted by admin${haltNote(execConfig.haltReason) ? ` — ${haltNote(execConfig.haltReason)}` : ""}`); return; }

    const eng = execConfig.engine;
    setIsExecuting(true);
    log(`MLO EXECUTE: ${legs.length} leg(s) × ${active.length} client(s) | buf=${eng.bufferPct}% timeout=${eng.fillTimeout}s retries=${eng.maxRetries}`);

    try {
      const results = await callApi("/api/order", { legs });
      if (!Array.isArray(results)) {
        // Refused before any order was sent (halted, risk limit, already running…)
        log(`Error: Execution refused: ${results?.error || "unknown error"}`);
        fetchExecConfig();
        setIsExecuting(false);
        return;
      }
      const arr = results;
      const labelOf = r => r.label || [r.symbol, r.type, r.strike && r.strike !== "N/A" ? r.strike : "FUT"].filter(Boolean).join(" ");


      arr.forEach(r => {
        // Summary line
        if (r.status === "FILLED") {
          const L = r.latency || {};
          log(`${r.clientName||r.client} | ${labelOf(r)} | FILLED ${r.filledQty}/${r.requestedQty} @ ₹${r.avgPrice?.toFixed(2)||"—"} | ID: ${r.orderId}` +
              (L.totalMs != null ? ` | ${L.totalMs} ms (queue ${L.queueMs ?? "—"}, ack ${L.ackMs ?? "—"}, fill ${L.fillMs ?? "—"})` : ""));
        } else if (r.status === "PARTIAL") {
          log(`Warning: ${r.clientName||r.client} | ${labelOf(r)} | PARTIAL — ${r.filledQty}/${r.requestedQty} filled, ${r.remainingQty} unfilled | ${r.error||""}`);
        } else if (r.status === "MANUAL_CHECK") {

    log(
        `${r.clientName || r.client} | ${labelOf(r)} | MANUAL CHECK REQUIRED — ${r.error}`
    );

} else if (r.status === "FAILED") {
          log(`Error: ${r.clientName||r.client} | ${labelOf(r)} | FAILED — ${r.error||"unknown error"}`);
        } else {
          log(`${r.clientName||r.client} | ${labelOf(r)} | ${r.status}`);
        }

        // Per-attempt breakdown
        (r.attempts||[]).forEach(a => {
          if (a.error) {
            // Rejection or no feed — show error first like Python
            log(`   Attempt ${a.attempt}: REJECTED — ${a.error}`);
          } else if (a.status === "FILLED") {
            log(`   Attempt ${a.attempt}: FILLED ${a.filledQty} @ ₹${a.avgPrice?.toFixed(2)} | limit=₹${a.limitPrice?.toFixed(2)}`);
          } else if (a.cancelled) {
            // Partial fill + cancel + retry — the core MLO case
            log(`   Attempt ${a.attempt}: PARTIAL ${a.filledQty}/${a.qty} filled | cancelled remaining=${a.remaining} | retrying…`);
          } else if ((a.filledQty||0) > 0) {
            log(`   Attempt ${a.attempt}: PARTIAL ${a.filledQty}/${a.qty} @ ₹${a.avgPrice?.toFixed(2)}`);
          } else {
            log(`   Attempt ${a.attempt}: PENDING | limit=₹${a.limitPrice?.toFixed(2)} bid=${a.bid} ask=${a.ask}`);
          }
        });
      });

    } catch (e) { log(`Execute error: ${e.message}`); }
    setIsExecuting(false);
  };

  const isAllLogged    = clients.length>0 && clients.every(c=>c.isLogged);
  const isAllConnected = clients.length>0 && clients.every(c=>c.isConnected);
  const wsColor = wsStatus==="connected"?"text-emerald-400":wsStatus==="connecting"?"text-amber-400":"text-red-400";
  const wsDot   = wsStatus==="connected"?"bg-emerald-400 animate-pulse":"bg-red-500";
  const wsLabel = wsStatus==="connected"?"Quotes Live":wsStatus==="connecting"?"Connecting…":"Quotes Offline";

  return (
    <div className="h-screen w-full bg-[#161a1f] text-gray-300 font-sans flex flex-col overflow-hidden">

      {/* TOP 55% */}
      <div className="flex h-[55%] border-b border-gray-700 shrink-0">
        <div className="w-[65%] h-full border-r border-gray-700 flex flex-col">
          <div className="flex shrink-0 bg-[#161a1f] border-b border-gray-700">
            {[["manual", "Manual"], ["auto", "Automated Strategies"]].map(([key, label]) => (
              <button key={key} onClick={() => setLeftTab(key)}
                className={`px-4 py-1.5 text-[11px] font-semibold border-r border-gray-700 transition-colors ${leftTab === key ? "bg-[#1e2329] text-white" : "text-gray-400 hover:text-gray-200"}`}>
                {label}
              </button>
            ))}
          </div>
          {leftTab === "auto" && <StrategyPanel log={log} />}
          {/* kept mounted while hidden so the chosen legs survive a tab switch */}
          <div className={leftTab === "manual" ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
          <PortfolioSection
            marketData={marketData} loading={instrLoading} quoteMap={quoteMap}
            onLoginAll={loginAll} onLogoutAll={logoutAll}
            onConnectAll={connectAll} onDisconnectAll={disconnectAll}
            onUpload={async e=>{
              const f=e.target.files[0];
              if (!f) return;
              try {
                const text = await f.text();
                const payload = JSON.parse(text);
                const r = await fetch(`${API}/api/instruments`, {
                  method: "POST",
                  headers: authHeaders(),
                  body: JSON.stringify(payload),
                });
                const data = await r.json();
                if (!r.ok) throw new Error(data.error || "Upload failed");
                const raw = Array.isArray(payload) ? payload : (payload.data || payload.instruments || payload.result || []);
                setMarketData(buildMarketData(raw));
                log(`Uploaded ${raw.length.toLocaleString()} instruments (${data.count} loaded)`);
              } catch (err) {
                log(`Upload error: ${err.message}`);
              }
            }}
            onDownload={downloadTradeBook}
            isAllLogged={isAllLogged} isAllConnected={isAllConnected}
            feedOn={clients.some(c => c.isLogged)}
            isLoggingAll={isLoggingAll} isConnectingAll={isConnectingAll}
            onExecute={executePortfolio} isExecuting={isExecuting}
            onRefreshInstruments={refreshInstruments}
            isRefreshingInstruments={isRefreshingInstruments}
            execConfig={execConfig}
            wsEpoch={wsEpoch}
            log={log}
          />
          </div>
        </div>

        <div className="w-[35%] h-full flex flex-col bg-[#1a1e24]">
          {/* Client summary */}
          <div className="flex-1 flex flex-col min-h-0 border-b border-gray-700">
            <div className="flex justify-between items-center px-3 py-1.5 bg-[#1e2329] border-b border-gray-700 shrink-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-300">
                <Users size={14} className="text-purple-400"/>
                Clients
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] border border-emerald-500/30">
                  {clients.filter(c=>c.isLogged).length} active
                </span>
              </div>
              <div className={`flex items-center gap-1 text-[9px] font-mono ${wsColor}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${wsDot}`}/>{wsLabel}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 custom-scrollbar">
              <div className="grid grid-cols-[1fr_44px_52px_52px] gap-1 mb-1 px-2 text-[8px] font-semibold text-gray-500 uppercase tracking-wider">
                <div>Client</div><div>ID</div><div className="text-center">Login</div><div className="text-center">Conn</div>
              </div>
              <div className="flex flex-col gap-0.5">
                {clients.map(c=>(
                  <div key={c.id} className="grid grid-cols-[1fr_44px_52px_52px] gap-1 items-center px-2 py-1 bg-[#1e2329] border border-gray-700 rounded-sm">
                    <div className="font-medium text-gray-200 text-[10px] truncate">{c.name}</div>
                    <div className="font-mono text-gray-500 text-[8px] truncate">{c.id}</div>
                    <div className="flex justify-center">
                      <span className={`px-1.5 py-0.5 rounded-full text-[7px] font-bold ${c.isLogged?"bg-blue-500/20 text-blue-400 border border-blue-500/30":"bg-gray-600/30 text-gray-500 border border-gray-600/40"}`}>
                        {c.isLogged?"IN":"OUT"}
                      </span>
                    </div>
                    <div className="flex justify-center">
                      <span className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[7px] font-bold ${c.isConnected?"bg-emerald-500/20 text-emerald-400 border border-emerald-500/30":"bg-red-500/10 text-red-400 border border-red-500/20"}`}>
                        <div className={`w-1 h-1 shrink-0 rounded-full ${c.isConnected?"bg-emerald-400 animate-pulse":"bg-red-500"}`}/>
                        {c.isConnected?"ON":"OFF"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Global log */}
          <div className="h-[42%] bg-[#0a0d11] p-1.5">
            <div className="flex flex-col rounded border border-gray-700 overflow-hidden h-full bg-[#1e2329] shadow-lg">
              <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[#242a31] border-b border-gray-700 shrink-0">
                <Terminal size={12} className="text-blue-400"/>
                <span className="text-[10px] font-bold text-gray-100">Global Market Log</span>
                <span className="text-[8px] text-gray-500">saved on the server</span>
                <button onClick={downloadActivity} title="Download today's full activity log (CSV)"
                  className="ml-auto flex items-center gap-0.5 px-1.5 py-0.5 text-[8px] font-semibold text-emerald-400 hover:text-emerald-300 border border-gray-700 rounded-sm">
                  <Download size={10}/> CSV
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-1.5 bg-[#0d1117] font-mono text-[9px] leading-relaxed custom-scrollbar">
                {globalLogs.map((line,i)=>{
                  const l = line.toLowerCase();
                  // Colour by meaning (words, not symbols): errors red, successes green, executions / warnings amber.
                  const c = /error|reject|fail/.test(l) ? "text-red-400"
                    : /filled|login|logged in|connect/.test(l) ? "text-emerald-400"
                    : /execute|warning|partial|pending/.test(l) ? "text-amber-400" : "text-gray-400";
                  return <div key={i} className={c}>{line}</div>;
                })}
                <div ref={logEndRef}/>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* BOTTOM 45% — Client Cards */}
      <div className="flex-1 bg-[#0a0d11] p-2 overflow-y-auto custom-scrollbar">
        {clients.length===0
          ?<div className="h-full flex items-center justify-center text-gray-500 text-sm">No clients assigned to you — an admin can add them in the Admin console (Ctrl+Shift+Space)</div>
          :<div className="grid grid-cols-1 md:grid-cols-3 gap-2 auto-rows-[220px]">
             {clients.map(c => (
  <ClientCard
    key={c.id}
    client={c}
    quoteMap={quoteMap}
    onToggleLogin={toggleClientLogin}
    onToggleConnect={toggleClientWS}
  />
))}
           </div>}
      </div>

      <style dangerouslySetInnerHTML={{__html:`
        .custom-scrollbar::-webkit-scrollbar{width:5px;height:5px}
        .custom-scrollbar::-webkit-scrollbar-track{background:#161a1f}
        .custom-scrollbar::-webkit-scrollbar-thumb{background:#3b4148;border-radius:3px}
        .custom-scrollbar::-webkit-scrollbar-thumb:hover{background:#4b5563}
        select option{background:#24292e}
      `}}/>

    </div>
  );
}