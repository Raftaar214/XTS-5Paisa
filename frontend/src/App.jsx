import React, { useState, useEffect, useRef, useCallback } from "react";

const decodeQuotePacket = (data) => {
  if (!data || typeof data === "string") return {};
  if (data instanceof ArrayBuffer) {
    const view = new Uint8Array(data);
    const out = {};
    let offset = 1;
    while (offset < view.length) {
      if (view.length - offset < 2) break;
      const tokenLength = (view[offset] << 8) | view[offset + 1];
      offset += 2;
      if (view.length - offset < tokenLength + 4) break;
      const token = new TextDecoder().decode(view.slice(offset, offset + tokenLength));
      offset += tokenLength;
      const payloadLength = (view[offset] << 24) | (view[offset + 1] << 16) | (view[offset + 2] << 8) | view[offset + 3];
      offset += 4;
      if (view.length - offset < payloadLength) break;
      const payload = JSON.parse(new TextDecoder().decode(view.slice(offset, offset + payloadLength)));
      offset += payloadLength;
      out[token] = payload;
    }
    return out;
  }
  return {};
};
import {
  Upload, Download, LogIn, LogOut, Power, PowerOff, Loader,
  Terminal, Activity, Users, ShieldCheck, Database,
  LayoutList, BookOpen, Briefcase,
} from "lucide-react";
import UserManagement from "./UserManagement.jsx";
import { API_BASE } from "./authFetch.js";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const API   = API_BASE;
const WS    = "ws://localhost:3002";
const SIDES = ["Buy", "Sell"];

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
// ─────────────────────────────────────────────────────────────
// INSTRUMENT PROCESSING
// ─────────────────────────────────────────────────────────────
const buildMarketData = (rawData) => {
  const p = {};
  rawData.forEach(item => {
    let seg = item.segment;
    if (seg === "MCX_FO") seg = "MCX";
    if (!seg || !["NSE_FO","BSE_FO","MCX"].includes(seg)) return;
    const sym = item.asset_symbol; if (!sym) return;
    let type = item.instrument_type;
    if (type === "F" || type === "FUT") type = "FO";
    if (!["CE","PE","FO"].includes(type)) return;
    let exp = "N/A";
console.log(item.expiry, typeof item.expiry);
if (item.expiry) {

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
    const str   = type === "FO" ? "N/A" : (item.strike_price != null ? String(item.strike_price) : "N/A");
    const token = item.exchange_token?.toString() || "";
    const lotSz =
  seg === "MCX"
    ? 1
    : Number(item.lot_size || 1);
    if (!p[seg]) p[seg]={};
    if (!p[seg][sym]) p[seg][sym]={};
    if (!p[seg][sym][type]) p[seg][sym][type]={};
    if (!p[seg][sym][type][exp]) p[seg][sym][type][exp]={ strikes:new Set(), details:{} };
    if (type !== "FO") p[seg][sym][type][exp].strikes.add(str);
    p[seg][sym][type][exp].details[str] = { token, lotSize: lotSz };
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

  if (t !== "FO")
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
    lots: "1",
    side: "Buy",
  };
};
// ═══════════════════════════════════════════════════════════════
// PORTFOLIO SECTION
// ═══════════════════════════════════════════════════════════════
const PortfolioSection = ({
  marketData, loading, quoteMap,
  onLoginAll, onLogoutAll, onConnectAll, onDisconnectAll, onUpload, onDownload,
  isAllLogged, isAllConnected, isLoggingAll, isConnectingAll,
  onExecute, isExecuting,
  onOpenUserManagement,
}) => {
  const [numLegs, setNumLegs] = useState(1);
  const [legs, setLegs]       = useState([]);
  const fileRef  = useRef(null);
  const subRef   = useRef(new Set());
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

        const current = new Set(
            legs
                .map(l => l?.exchange_token?.toString())
                .filter(Boolean)
        );

        const previous = subRef.current;

        const toSubscribe = [...current].filter(
            token => !previous.has(token)
        );

        const toUnsubscribe = [...previous].filter(
            token => !current.has(token)
        );

        try {

            // ============================
            // 1. Subscribe NEW tokens first
            // ============================
            // ============================
// 1. Unsubscribe OLD tokens
// ============================

if (toUnsubscribe.length) {

    console.log("📴 Unsubscribe:", toUnsubscribe);

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


// ============================
// 2. Subscribe NEW tokens
// ============================

if (toSubscribe.length) {

    const segs = toSubscribe.map(token => {
        const leg = legs.find(
            l => String(l.exchange_token) === token
        );

        return leg?.segment || "NSE_FO";
    });

    console.log("📡 Subscribe:", toSubscribe);

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

}, [tokenKey]);

  const handleLegChange = (idx, field, value) => {
    if (!marketData) return;
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
  console.log("quoteMap =", quoteMap);

legs.forEach(l => {
    console.log(
        "Token:",
        l.exchange_token,
        "Quote:",
        quoteMap[String(l.exchange_token).trim()]
    );
});
  const allHaveQuote   = legs.every(l => {
    const q = quoteMap[String(l?.exchange_token||"").trim()];
    if (!q) return false;
    return (l.side||"Buy")==="Buy" ? (q.ask||0)>0 : (q.bid||0)>0;
  });

  if (loading || !marketData) return (
    <div className="h-full flex items-center justify-center gap-3 text-emerald-400 font-mono text-sm">
      <Loader className="animate-spin" size={18}/> Loading instruments…
    </div>
  );

  const SEL = "w-full bg-[#1e2430] border border-[#374151] text-white text-[13px] px-2 py-[7px] focus:outline-none focus:border-blue-500 transition-colors";
  const RO  = "w-full bg-[#161b27] border border-[#2d3748] text-gray-500 text-[13px] px-2 py-[7px] cursor-not-allowed text-center";
  const ED  = "w-full bg-[#1e2430] border border-[#374151] text-white text-[13px] px-2 py-[7px] focus:outline-none focus:border-blue-500 text-center";

  // Grid: Leg | Seg | Sym | Type | Expiry | Strike | Ask | Bid | Side | LotSz | Lots | Token
  const GRID = "44px 108px 1fr 68px 128px 86px 72px 72px 78px 68px 66px 92px";

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
        <button onClick={onOpenUserManagement}
          className="flex items-center gap-1 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 px-2 py-1 rounded-sm text-[10px] font-medium transition-colors text-purple-300">
          <Users size={12}/> User Management
        </button>
      </div>

      {/* Number of legs */}
      <div className="px-4 py-2 shrink-0 flex items-center gap-6 border-b border-gray-700 bg-[#252b33]">
        <span className="text-white font-medium text-[14px]">Number of Legs:</span>
        {[1,2,3,4,5,6,7,8].map(n=>(
          <label key={n} className="flex items-center gap-2 cursor-pointer select-none">
            <input type="radio" name="numLegs" value={n} checked={numLegs===n}
              onChange={()=>setNumLegs(n)} className="w-[17px] h-[17px] accent-blue-500 cursor-pointer"/>
            <span className="text-white text-[14px]">{n}</span>
          </label>
        ))}
      </div>

      {/* Legs table */}
      <div className="flex-1 overflow-auto">
        <div className="px-4 py-3 min-w-[1080px]">

          {/* Header */}
          <div className="grid gap-2 mb-3 px-2 text-white font-semibold text-[13px]"
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
          </div>

          {/* Rows */}
          <div className="flex flex-col gap-2">
            {legs.map((leg,idx)=>{
              if (!leg) return null;
              const segD = marketData[leg.segment]       || {symbols:[]};
              const symD = segD.data?.[leg.symbol]       || {types:[]};
              const typD = symD.data?.[leg.type]         || {expiries:[]};
              const expD = typD.data?.[leg.expiry]       || {strikes:[]};
              const q    = quoteMap[String(leg.exchange_token||"").trim()] || {bid:0,ask:0};
              const tokOk = leg.exchange_token && leg.exchange_token !== "Unknown Key" && leg.exchange_token !== "";
              const askOk = (q.ask||0) > 0;
              const bidOk = (q.bid||0) > 0;
              const isBuy = (leg.side||"Buy") === "Buy";

              return (
                <div key={idx} className="grid gap-2 items-center px-2 py-[10px] border border-gray-600 rounded"
                     style={{gridTemplateColumns:GRID, background:"#2d333b"}}>

                  <div className="font-bold text-white text-center text-[14px]">L{idx+1}</div>

                  <select className={SEL} value={leg.segment} onChange={e=>handleLegChange(idx,"segment",e.target.value)}>
                    {Object.keys(marketData).map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  <select className={SEL} value={leg.symbol} onChange={e=>handleLegChange(idx,"symbol",e.target.value)}>
                    {segD.symbols.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  <select className={SEL} value={leg.type} onChange={e=>handleLegChange(idx,"type",e.target.value)}>
                    {symD.types.map(t=><option key={t} value={t}>{t}</option>)}
                  </select>
                  <select className={SEL} value={leg.expiry} onChange={e=>handleLegChange(idx,"expiry",e.target.value)}>
                    {typD.expiries.map(e=><option key={e} value={e}>{e}</option>)}
                  </select>
                  <select className={SEL} value={leg.strike} onChange={e=>handleLegChange(idx,"strike",e.target.value)}
                    disabled={leg.type==="FO"} style={leg.type==="FO"?{opacity:.4}:{}}>
                    {leg.type==="FO"?<option value="N/A">N/A</option>
                      :expD.strikes.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>

                  {/* Ask — price sellers are offering (used for BUY orders) */}
                  <div
  className={`font-mono font-semibold text-center text-[11px] ${
    askOk
      ? "text-orange-400"
      : q.hasData
      ? "text-yellow-400"
      : "text-gray-600"
  }`}
>
  {!q.hasData
    ? "Closed"
    : askOk
    ? q.ask.toFixed(2)
    : "No Liquidity"}
</div>

                  {/* Bid — price buyers are bidding (used for SELL orders) */}
                  <div
  className={`font-mono font-semibold text-center text-[11px] ${
    bidOk
      ? "text-teal-400"
      : q.hasData
      ? "text-yellow-400"
      : "text-gray-600"
  }`}
>
  {!q.hasData
    ? "Closed"
    : bidOk
    ? q.bid.toFixed(2)
    : "No Liquidity"}
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
                  <div className="flex items-center gap-1.5 overflow-hidden" title={leg.exchange_token}>
                    <span className={`text-lg leading-none shrink-0 ${tokOk?"text-emerald-500":"text-red-500"}`}>●</span>
                    <span className={`font-mono text-[11px] truncate ${tokOk?"text-emerald-400":"text-red-400"}`}>
                      {tokOk?leg.exchange_token:"N/A"}
                    </span>
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
          <div><span className="text-orange-400">Ask</span> = BUY limit price &nbsp;|&nbsp; <span className="text-teal-400">Bid</span> = SELL limit price &nbsp;|&nbsp; 0.1% buffer, DAY LIMIT order</div>
          {allTokensValid && !allHaveQuote && (
            legs.some(l => quoteMap[String(l?.exchange_token||"").trim()]?.hasData)
              ? <div className="text-amber-500 mt-0.5">Selected contract has no liquidity (Bid/Ask unavailable)</div>
              : <div className="text-amber-500 mt-0.5">Waiting for bid/ask from market socket…</div>
          )}
        </div>
        <button onClick={()=>onExecute(legs)} disabled={!allTokensValid||!allHaveQuote||isExecuting}
          className={`flex items-center gap-2 px-8 py-2 font-bold rounded-sm text-sm transition-all
            ${allTokensValid&&allHaveQuote&&!isExecuting
              ?"bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_12px_rgba(16,185,129,0.4)]"
              :"bg-gray-700 text-gray-500 cursor-not-allowed"}`}>
          {isExecuting?<><Loader size={14} className="animate-spin"/>EXECUTING…</>:"EXECUTE PORTFOLIO"}
        </button>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// CLIENT CARD
// ═══════════════════════════════════════════════════════════════
const ClientCard = ({ client, quoteMap, onToggleLogin, onToggleConnect }) => {
  const [viewMode, setViewMode] = useState("positions");
  const [rows,     setRows]     = useState([]);
  const [fetching, setFetching] = useState(false);

  const fetchData = useCallback(async () => {
    if (!client.isLogged) { setRows([]); return; }
    setFetching(true);
    try {
      const r = await fetch(`${API}/api/clients/${client.id}/${viewMode}`, {
  headers: authHeaders(),
});
      const d = await r.json();

      console.log("POSITIONS API RESPONSE:", d);

      setRows(Array.isArray(d) ? d : []);
    } catch { setRows([]); }
    finally { setFetching(false); }
  }, [client.id, client.isLogged, viewMode]);

  useEffect(()=>{ fetchData(); },[fetchData]);

  const HDRS = {
    orders:    ["Token","Side","Qty","Filled","Pending","Price","Product","Type","TIF","Status","AppID","ExchID","Time","Date"],
    trades:    ["Token","Side","Qty","Price","Product","Type","AppID","ExchID","Status","Time","Date"],
    positions: ["Token","Product","LTP","MTM","Realized","Unrealized","BuyQty","BuyAvg","SellQty","SellAvg","NetQty","NetAvg"],
  };

  const renderRows = () => {
    if (fetching) return <tr><td colSpan={20} className="px-2 py-4 text-center text-emerald-400 text-[9px]"><Loader className="animate-spin inline mr-1" size={10}/>Loading…</td></tr>;
    if (!rows.length) return <tr><td colSpan={20} className="px-2 py-4 text-center text-gray-500 text-[9px]">{client.isLogged?"No data":"Login required"}</td></tr>;

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
        <td className="px-2 py-1">
  {qty > 0
    ? buyAvg.toFixed(2)
    : qty < 0
    ? sellAvg.toFixed(2)
    : "—"}
</td>
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
            {["orders","trades","positions"].map(m=>(
              <button key={m} onClick={()=>setViewMode(m)}
                className={`px-1.5 py-0.5 text-[8px] font-medium rounded-sm transition-colors
                  ${viewMode===m?"bg-[#3b4148] text-white shadow-sm":"text-gray-400 hover:text-gray-200"}`}>
                {m==="orders"?"Orders":m==="trades"?"Trades":"Positions"}
              </button>
            ))}
          </div>
          <button onClick={fetchData} className="p-1 text-gray-500 hover:text-gray-200 transition-colors" title="Refresh"><Activity size={12}/></button>
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

// ═══════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════
export default function App() {
  const [marketData,      setMarketData]      = useState(null);
  const [instrLoading,    setInstrLoading]    = useState(true);
  const [clients,         setClients]         = useState([]);
  const [quoteMap,        setQuoteMap]        = useState({});   // { token: { bid, ask } }
  const [globalLogs,      setGlobalLogs]      = useState([`[${new Date().toLocaleTimeString()}] System initialized`]);
  const [wsStatus,        setWsStatus]        = useState("disconnected");
  const [isLoggingAll,    setIsLoggingAll]    = useState(false);
  const [isConnectingAll, setIsConnectingAll] = useState(false);
  const [isExecuting,     setIsExecuting]     = useState(false);
  const [showUserMgmt,    setShowUserMgmt]    = useState(false);
  const [executionHistory, setExecutionHistory] = useState(() => {
  try {
    const today = new Date().toLocaleDateString();

    const saved = JSON.parse(
      localStorage.getItem("executionHistory") || "[]"
    );

    // Keep only today's records
    const todayData = saved.filter(x => x.date === today);

    // Remove old records from localStorage
    localStorage.setItem(
      "executionHistory",
      JSON.stringify(todayData)
    );

    return todayData;
  } catch {
    return [];
  }
});
useEffect(() => {

    try {

        localStorage.setItem(
            "executionHistory",
            JSON.stringify(executionHistory)
        );

    } catch (e) {

        console.error("Failed to save execution history", e);

    }

}, [executionHistory]);

  const wsRef     = useRef(null);
  const logEndRef = useRef(null);

  useEffect(()=>{ logEndRef.current?.scrollIntoView({behavior:"smooth"}); },[globalLogs]);

  const ts  = () => new Date().toLocaleTimeString();
  const log = useCallback(msg => {
    setGlobalLogs(p => [...p.slice(-500), `[${ts()}] ${msg}`]);
  },[]);

  // ── WebSocket for Bid/Ask quotes ──────────────────────────
  useEffect(() => {
    let mounted     = true;
    let reconnTimer = null;

    const connect = () => {
      if (!mounted) return;
      const ws = new WebSocket(WS);
      wsRef.current = ws;
      setWsStatus("connecting");

      ws.onopen = () => {
        if (!mounted) { ws.close(); return; }
        setWsStatus("connected");
        log("Market socket connected — bid/ask live");
      };

      ws.onclose = () => {
        if (!mounted) return;
        setWsStatus("disconnected");
        log("Market socket disconnected — retrying in 4s…");
        reconnTimer = setTimeout(connect, 4000);
      };

      ws.onerror = () => { if (mounted) log("Market socket error"); };

      ws.onmessage = (e) => {
        const data = e.data;
        if (typeof data === "string") {
          try {
            const msg = JSON.parse(data);
            if (msg.type === "quote" || msg.type === "quotes") {
              setQuoteMap(prev => {
    const next = { ...prev };

    Object.entries(msg.data).forEach(([token, quote]) => {

        if (quote?.removed) {
            delete next[token];
        } else {
            next[token] = quote;
        }

    });

    return next;
});
            }
          } catch (err) {
            console.error(err);
          }
          return;
        }

        try {
          const packet = decodeQuotePacket(
  data instanceof Blob
    ? data.arrayBuffer
      ? data.arrayBuffer()
      : data
    : data
);

console.log("📦 Binary Packet:", packet);

// TEMPORARILY DISABLED
// if (Object.keys(packet).length) {
//     setQuoteMap(prev => ({ ...prev, ...packet }));
// }
        } catch (err) {
          console.error(err);
        }
      };
    };

    connect();

    return () => {
      mounted = false;
      clearTimeout(reconnTimer);
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    };
  }, [log]);

  // ── Load instruments ──────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/api/instruments`, {
        headers: authHeaders(),
    })
    .then(r => r.json())
    .then(raw => {
        setMarketData(buildMarketData(raw));
        log(`Instruments: ${raw.length.toLocaleString()} loaded`);
    })
    .catch(e => {
        log(`ERROR loading instruments: ${e.message}`);
        setMarketData({});
    })
    .finally(() => setInstrLoading(false));
}, [log]);

  // ── Poll client state ─────────────────────────────────────
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

  // ── API helper ────────────────────────────────────────────
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

  // ── Execute portfolio ─────────────────────────────────────
  // Injects current bid/ask from quoteMap into each leg before sending
  const executePortfolio = async (rawLegs) => {
    const active = clients.filter(c=>c.enabled&&c.isLogged&&c.isConnected);
    if (!active.length) { log("ERROR: No active (enabled+logged+connected) clients"); return; }

    // Inject current live bid/ask/ltp into each leg for initial price reference
    const legs = rawLegs.map(l => {
      const q = quoteMap[String(l?.exchange_token||"").trim()] || { bid:0, ask:0, ltp:0 };
      return { ...l, bid: q.bid, ask: q.ask, ltp: q.ltp };
    });

    setIsExecuting(true);
    log(`MLO EXECUTE: ${legs.length} leg(s) × ${active.length} client(s) | buf=0.5% timeout=6s retries=1`);

    try {
      const results = await callApi("/api/order", { legs });
      const arr = Array.isArray(results) ? results : [results];

setExecutionHistory(prev => [
  ...prev,
  ...arr.map(r => ({

    // ===========================
    // Date & Time
    // ===========================
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString(),

    // ===========================
    // Client
    // ===========================
    client: r.clientName || r.client,
    clientId: r.client,

    // ===========================
    // Strategy
    // ===========================
    strategy: "MANUAL",

    // ===========================
    // Instrument
    // ===========================
    exchange: r.exchange || "",
    symbol: r.symbol || r.label || "",
    expiry: r.expiry || "",
    strike: r.strike || "",
    instrument: r.type || "",

    // ===========================
    // Order
    // ===========================
    side: r.side || "",

    lots: r.lots || "",
    lotSize: r.lotSize || "",
    multiplier: r.multiplier || 1,

    requestedQty: r.requestedQty || 0,
    filledQty: r.filledQty || 0,
    remainingQty: r.remainingQty || 0,

    avgPrice: r.avgPrice || 0,

    bid: r.attempts?.[0]?.bid ?? "",
    ask: r.attempts?.[0]?.ask ?? "",
    ltp: r.attempts?.[0]?.ltp ?? "",

    limitPrice: r.attempts?.[0]?.limitPrice ?? "",

    // ===========================
    // Execution
    // ===========================
    buffer: r.buffer ?? 0.50,
    fillTimeout: r.fillTimeout ?? 6,

    retryCount: Math.max(
        0,
        (r.attempts?.length || 1) - 1
    ),

    attempts: r.attempts?.length || 1,

    executionTime: r.executionTime ?? "",

    // ===========================
    // Status
    // ===========================
    status: r.status || "",

    orderId: r.orderId || "",
    orderUID: r.orderUniqueIdentifier || "",

    error: r.error || "",

    // ===========================
    // Future P&L
    // ===========================
    buyValue: "",
    sellValue: "",
    netQty: "",
    realizedPnL: "",
    unrealizedPnL: "",
    mtm: "",
    pnl: ""

  }))
]);

      arr.forEach(r => {
        // ── Summary line ──────────────────────────────────────
        if (r.status === "FILLED") {
          log(`✅ ${r.clientName||r.client} | ${r.label} | FILLED ${r.filledQty}/${r.requestedQty} @ ₹${r.avgPrice?.toFixed(2)||"—"} | ID: ${r.orderId}`);
        } else if (r.status === "PARTIAL") {
          log(`⚠️ ${r.clientName||r.client} | ${r.label} | PARTIAL — ${r.filledQty}/${r.requestedQty} filled, ${r.remainingQty} unfilled | ${r.error||""}`);
        } else if (r.status === "MANUAL_CHECK") {

    log(
        `🚨 ${r.clientName || r.client} | ${r.label} | MANUAL CHECK REQUIRED — ${r.error}`
    );

} else if (r.status === "FAILED") {
          log(`❌ ${r.clientName||r.client} | ${r.label} | FAILED — ${r.error||"unknown error"}`);
        } else {
          log(`❓ ${r.clientName||r.client} | ${r.label} | ${r.status}`);
        }

        // ── Per-attempt breakdown ──────────────────────────────
        (r.attempts||[]).forEach(a => {
          if (a.error) {
            // Rejection or no feed — show error first like Python
            log(`   Attempt ${a.attempt}: ❌ REJECTED — ${a.error}`);
          } else if (a.status === "FILLED") {
            log(`   Attempt ${a.attempt}: ✅ FILLED ${a.filledQty} @ ₹${a.avgPrice?.toFixed(2)} | limit=₹${a.limitPrice?.toFixed(2)}`);
          } else if (a.cancelled) {
            // Partial fill + cancel + retry — the core MLO case
            log(`   Attempt ${a.attempt}: ⏱ PARTIAL ${a.filledQty}/${a.qty} filled | cancelled remaining=${a.remaining} | retrying…`);
          } else if ((a.filledQty||0) > 0) {
            log(`   Attempt ${a.attempt}: ⚠️ PARTIAL ${a.filledQty}/${a.qty} @ ₹${a.avgPrice?.toFixed(2)}`);
          } else {
            log(`   Attempt ${a.attempt}: ⏳ PENDING | limit=₹${a.limitPrice?.toFixed(2)} bid=${a.bid} ask=${a.ask}`);
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
            onDownload={() => {

    if (!executionHistory.length) {
        log("No execution history to download.");
        return;
    }

    const rows = [[
    "Date",
    "Time",
    "Client",
    "Client ID",
    "Strategy",
    "Exchange",
    "Symbol",
    "Expiry",
    "Strike",
    "Instrument",
    "Side",
    "Lots",
    "Lot Size",
    "Multiplier",
    "Requested Qty",
    "Filled Qty",
    "Remaining Qty",
    "Average Price",
    "Bid",
    "Ask",
    "LTP",
    "Limit Price",
    "Buffer %",
    "Fill Timeout (s)",
    "Retry Count",
    "Attempts",
    "Execution Time (ms)",
    "Status",
    "AppOrderID",
    "Order UID",
    "Error"
]];

    executionHistory.forEach(r => {

        rows.push([
    r.date,
    r.time,
    r.client,
    r.clientId,
    r.strategy,
    r.exchange,
    r.symbol,
    r.expiry,
    r.strike,
    r.instrument,
    r.side,
    r.lots,
    r.lotSize,
    r.multiplier,
    r.requestedQty,
    r.filledQty,
    r.remainingQty,
    r.avgPrice,
    r.bid,
    r.ask,
    r.ltp,
    r.limitPrice,
    r.buffer,
    r.fillTimeout,
    r.retryCount,
    r.attempts,
    r.executionTime,
    r.status,
    r.orderId,
    r.orderUID,
    r.error
]);

    });

    const csv = rows
        .map(row => row.map(v => `"${v ?? ""}"`).join(","))
        .join("\n");

    const blob = new Blob(
        [csv],
        { type: "text/csv;charset=utf-8;" }
    );

    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");

    a.href = url;

    a.download =
        `Trade_Report_${new Date().toISOString().slice(0,10)}.csv`;

    a.click();

    URL.revokeObjectURL(url);

    log("Trade report downloaded.");

}}
            isAllLogged={isAllLogged} isAllConnected={isAllConnected}
            isLoggingAll={isLoggingAll} isConnectingAll={isConnectingAll}
            onExecute={executePortfolio} isExecuting={isExecuting}
            onOpenUserManagement={()=>setShowUserMgmt(true)}
          />
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
              </div>
              <div className="flex-1 overflow-y-auto p-1.5 bg-[#0d1117] font-mono text-[9px] leading-relaxed custom-scrollbar">
                {globalLogs.map((line,i)=>{
                  const l = line.toLowerCase();
                  const c = l.includes("❌")||l.includes("error")||l.includes("reject")?"text-red-400"
                    : l.includes("✅")||l.includes("login")||l.includes("connect")?"text-emerald-400"
                    : l.includes("🔥")||l.includes("⚡")?"text-amber-400" : "text-gray-400";
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
          ?<div className="h-full flex items-center justify-center text-gray-500 text-sm">No clients — add CLI1_ID etc. to .env</div>
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

      {showUserMgmt && (
        <UserManagement
          onClose={() => setShowUserMgmt(false)}
          onClientsChanged={fetchClients}
        />
      )}
    </div>
  );
}