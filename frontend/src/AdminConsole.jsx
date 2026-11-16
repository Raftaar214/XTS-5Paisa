import React, { useState, useEffect, useCallback } from "react";
import {
  X, Loader, ShieldAlert, Activity, Users, SlidersHorizontal, LogOut,
  RefreshCw, OctagonX, PlayCircle, PowerOff, Radio, Bot, BookOpen, Timer,
} from "lucide-react";
import AdminClients from "./AdminClients.jsx";
import AdminStrategies from "./AdminStrategies.jsx";
import AdminTradeBooks from "./AdminTradeBooks.jsx";
import AdminMargins from "./AdminMargins.jsx";
import { API_BASE, adminFetch, getAdminToken, setAdminToken, clearAdminToken } from "./authFetch.js";

// Admin console — opened anywhere with Ctrl+Shift+Space.
// Separate admin login (ADMIN_USERNAME / ADMIN_PASSWORD in backend/.env).
//   Monitor             live health: trading state, market feed, instruments,
//                       clients, recent executions, admin audit trail
//   Clients             parent/child roster, API keys, assignment, sessions
//   Execution & Limits  kill switch, engine parameters, risk limits

const inputCls = "w-full bg-[#161a1f] border border-gray-600 text-white text-[12px] px-2 py-1.5 rounded-sm focus:outline-none focus:border-blue-500";

const fmtAge = ms => {
  if (ms == null) return "—";
  if (ms < 1000) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};
const fmtUptime = ms => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
};
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString() : "—";

// ─────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────
function AdminLogin({ onLoggedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async e => {
    e.preventDefault();
    if (!username || !password) { setError("Enter admin ID and password"); return; }
    setLoading(true); setError("");
    try {
      const r = await fetch(`${API_BASE}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || "Login failed");
      setAdminToken(d.token);
      onLoggedIn(d.username);
    } catch (err) {
      setError(err.message === "Failed to fetch" ? "Cannot reach the backend" : err.message);
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center">
      <form onSubmit={submit} className="w-[340px] bg-[#1e2329] border border-amber-700/50 rounded-lg shadow-2xl p-6">
        <div className="flex items-center gap-2 mb-1 text-amber-400">
          <ShieldAlert size={20} />
          <span className="text-white font-bold text-lg">Admin Console</span>
        </div>
        <div className="text-gray-500 text-[11px] mb-5">Restricted — client keys, live execution controls and limits</div>
        <label className="block text-[11px] text-gray-400 mb-1">Admin ID</label>
        <input autoFocus value={username} onChange={e => setUsername(e.target.value)} className={`${inputCls} mb-3`} autoComplete="username" />
        <label className="block text-[11px] text-gray-400 mb-1">Password</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} className={`${inputCls} mb-4`} autoComplete="current-password" />
        {error && <div className="mb-3 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1.5">{error}</div>}
        <button type="submit" disabled={loading}
          className="w-full flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-sm">
          {loading ? <Loader size={14} className="animate-spin" /> : <ShieldAlert size={14} />}
          {loading ? "Verifying…" : "Open Admin Console"}
        </button>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Monitor tab
// ─────────────────────────────────────────────────────────────
function Stat({ label, value, tone = "text-gray-100", sub }) {
  return (
    <div className="bg-[#1e2329] border border-gray-700 rounded px-3 py-2 min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-sm font-bold truncate ${tone}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 truncate" title={sub}>{sub}</div>}
    </div>
  );
}

const ms = v => (v == null ? "—" : `${v} ms`);

function LatencyPanel({ latency, streams }) {
  const o = latency?.overall;
  const streamList = Object.entries(streams || {});
  return (
    <div className="bg-[#1e2329] border border-gray-700 rounded">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200">
        <Timer size={12} className="text-sky-400" /> Execution latency today
        <span className="font-normal text-gray-500">queue = request → sent · ack = sent → accepted · fill = accepted → fill seen · total = request → filled</span>
      </div>
      {!o || !o.totalMs.count ? (
        <div className="text-gray-500 text-[11px] px-3 py-3">No timed fills yet today.</div>
      ) : (
        <table className="w-full text-left text-[11px] whitespace-nowrap">
          <thead><tr className="text-gray-500 uppercase text-[9px]">
            {["", "Fills", "Queue p50", "Ack p50 / p95", "Fill p50 / p95", "Total avg", "Total p50 / p95", "Total max"].map(h => <th key={h} className="px-2 py-1">{h}</th>)}
          </tr></thead>
          <tbody>
            {[["All", o], ...(latency.byMode || []).map(m => [m.mode, m]), ...(latency.byClient || []).map(c => [c.client, c])].map(([name, m], i) => (
              <tr key={`${name}-${i}`} className={`border-t border-gray-800 ${i === 0 ? "font-semibold" : ""}`}>
                <td className="px-2 py-1 text-gray-200">{name}</td>
                <td className="px-2 py-1 text-gray-400">{m.totalMs.count}</td>
                <td className="px-2 py-1 text-gray-300">{ms(m.queueMs.p50)}</td>
                <td className="px-2 py-1 text-gray-300">{ms(m.ackMs.p50)} / {ms(m.ackMs.p95)}</td>
                <td className="px-2 py-1 text-gray-300">{ms(m.fillMs.p50)} / {ms(m.fillMs.p95)}</td>
                <td className="px-2 py-1 text-gray-300">{ms(m.totalMs.avg)}</td>
                <td className="px-2 py-1 text-sky-300">{ms(m.totalMs.p50)} / {ms(m.totalMs.p95)}</td>
                <td className={`px-2 py-1 ${m.totalMs.max > 2000 ? "text-amber-400" : "text-gray-300"}`}>{ms(m.totalMs.max)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="px-3 py-1.5 border-t border-gray-800 text-[10px] text-gray-500">
        Order-update streams (instant fill detection):{" "}
        {streamList.length === 0 ? "none connected — fills are found by polling (streams open when a client logs in to the broker)" :
          streamList.map(([id, st]) => <span key={id} className={`mr-3 ${st.connected ? "text-emerald-400" : "text-amber-400"}`}>{id} {st.connected ? "connected" : "reconnecting"}</span>)}
      </div>
    </div>
  );
}

function Monitor() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try { setData(await adminFetch("/api/admin/monitor")); setError(""); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, [load]);

  const action = async (key, path, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key); setError("");
    try { await adminFetch(path, { method: "POST" }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };

  if (!data) return <div className="text-gray-400 text-xs flex items-center gap-2"><Loader size={14} className="animate-spin" /> Loading monitor… {error}</div>;

  const { trading, market, instruments } = data;
  const tickAge = market.lastTickAgeMs;
  const feedTone = !market.loggedIn ? "text-red-400" : !market.socketConnected ? "text-amber-400" : "text-emerald-400";
  const statusTone = s => s === "FILLED" ? "text-emerald-400" : s === "PARTIAL" ? "text-amber-400" : s === "MANUAL_CHECK" ? "text-fuchsia-400" : "text-red-400";

  return (
    <div className="flex flex-col gap-3">
      {error && <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1.5">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Trading" value={trading.tradingHalted ? "HALTED" : trading.tradingMode === "LIVE" ? "LIVE" : "PAPER"}
          tone={trading.tradingHalted ? "text-red-400" : trading.tradingMode === "LIVE" ? "text-red-300" : "text-amber-300"}
          sub={trading.haltReason || (trading.tradingMode === "LIVE" ? "Real orders go to the broker" : "Simulated — nothing reaches the broker")} />
        <Stat label="Market data" tone={market.takeoverSuspected ? "text-red-400" : feedTone}
          value={market.takeoverSuspected ? "Session taken over" : !market.loggedIn ? "Not logged in" : market.socketConnected ? (market.joined ? "Live ticks" : "Joining…") : "Socket down"}
          sub={market.takeoverSuspected
            ? "Another login is using the same Market Data key — stop the other copy/app"
            : `${market.subscribedTokens} token(s) · ${market.ticksLastMinute ?? 0} ticks/min · last ${fmtAge(tickAge)}`} />
        <Stat label="Instruments" value={instruments.count.toLocaleString()}
          tone={instruments.lastError ? "text-amber-400" : "text-gray-100"}
          sub={instruments.lastError ? `Last refresh failed: ${instruments.lastError}` : `${instruments.source || "—"} · ${fmtTime(instruments.fetchedAt)}`} />
        <Stat label="Server" value={fmtUptime(data.uptimeMs)}
          sub={`${data.memoryMb.rss} MB RSS · ${data.quoteSockets} dashboard socket(s)`} />
      </div>

      {data.executionsInFlight.length > 0 && (
        <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-sm px-2 py-1.5 flex items-center gap-2">
          <Loader size={12} className="animate-spin" /> Executing now: {data.executionsInFlight.join(", ")}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button disabled={!!busy} onClick={() => action("md", "/api/admin/market/restart")}
          className="flex items-center gap-1.5 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 text-gray-200 text-[11px] px-3 py-1.5 rounded-sm disabled:opacity-50">
          {busy === "md" ? <Loader size={12} className="animate-spin" /> : <Radio size={12} />} Restart market feed
        </button>
        <button disabled={!!busy || instruments.refreshing} onClick={() => action("instr", "/api/admin/instruments/refresh")}
          className="flex items-center gap-1.5 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 text-gray-200 text-[11px] px-3 py-1.5 rounded-sm disabled:opacity-50">
          {busy === "instr" || instruments.refreshing ? <Loader size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh instruments
        </button>
        <button disabled={!!busy} onClick={() => action("dc", "/api/admin/clients/disconnect-all", "Disconnect ALL clients? None will take part in executions until reconnected.")}
          className="flex items-center gap-1.5 bg-red-600/20 hover:bg-red-600/40 border border-red-600/30 text-red-400 text-[11px] px-3 py-1.5 rounded-sm disabled:opacity-50">
          <PowerOff size={12} /> Disconnect all clients
        </button>
        <button disabled={!!busy} onClick={() => action("lo", "/api/admin/clients/logout-all", "Log ALL clients out of the broker?")}
          className="flex items-center gap-1.5 bg-red-600/20 hover:bg-red-600/40 border border-red-600/30 text-red-400 text-[11px] px-3 py-1.5 rounded-sm disabled:opacity-50">
          <LogOut size={12} /> Logout all clients
        </button>
      </div>

      <div className="bg-[#1e2329] border border-gray-700 rounded">
        <div className="px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200">Clients</div>
        <table className="w-full text-left text-[11px] whitespace-nowrap">
          <thead><tr className="text-gray-500 uppercase text-[9px]">
            <th className="px-2 py-1">Client</th><th className="px-2 py-1">Role</th><th className="px-2 py-1">Assigned</th>
            <th className="px-2 py-1">Mult</th><th className="px-2 py-1">Login</th><th className="px-2 py-1">Conn</th><th className="px-2 py-1">Trading</th>
          </tr></thead>
          <tbody>
            {data.clients.map(c => (
              <tr key={c.id} className="border-t border-gray-800">
                <td className="px-2 py-1 text-gray-200">{c.name} <span className="font-mono text-gray-500 text-[9px]">{c.id}</span></td>
                <td className="px-2 py-1 text-gray-400">{c.role}</td>
                <td className="px-2 py-1 text-gray-400">{c.assignedTo || "everyone"}</td>
                <td className="px-2 py-1 text-gray-400">{c.role === "PARENT" ? "1x" : `${c.multiplier}x`}</td>
                <td className={`px-2 py-1 font-semibold ${c.isLogged ? "text-blue-400" : "text-gray-500"}`}>{c.isLogged ? "IN" : "OUT"}</td>
                <td className={`px-2 py-1 font-semibold ${c.isConnected ? "text-emerald-400" : "text-gray-500"}`}>{c.isConnected ? "ON" : "OFF"}</td>
                <td className={`px-2 py-1 font-semibold ${c.enabled ? "text-emerald-400" : "text-red-400"}`}>{c.enabled ? "OK" : "OFF"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-[#1e2329] border border-gray-700 rounded">
        <div className="px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200">
          Logged-in dashboard users <span className="font-normal text-gray-500">— one active login per user</span>
        </div>
        {(data.sessions || []).length === 0 ? (
          <div className="text-gray-500 text-[11px] px-3 py-2">Nobody is logged in.</div>
        ) : (
          <table className="w-full text-left text-[11px] whitespace-nowrap">
            <thead><tr className="text-gray-500 uppercase text-[9px]">
              {["User", "From", "Since", "Last active", ""].map(h => <th key={h} className="px-2 py-1">{h}</th>)}
            </tr></thead>
            <tbody>
              {data.sessions.map(x => (
                <tr key={x.username} className="border-t border-gray-800">
                  <td className="px-2 py-1 text-purple-300 font-semibold">{x.username}</td>
                  <td className="px-2 py-1 text-gray-400">{x.ip}</td>
                  <td className="px-2 py-1 text-gray-400">{new Date(x.since).toLocaleString()}</td>
                  <td className="px-2 py-1 text-gray-400">{x.lastSeenAt ? fmtAge(Date.now() - new Date(x.lastSeenAt).getTime()) : "—"}</td>
                  <td className="px-2 py-1 text-right">
                    <button disabled={!!busy}
                      onClick={async () => {
                        if (!window.confirm(`Log ${x.username} out? Their dashboard closes and they must log in again.`)) return;
                        setBusy("sess"); setError("");
                        try { await adminFetch(`/api/admin/sessions/${encodeURIComponent(x.username)}`, { method: "DELETE" }); await load(); }
                        catch (e) { setError(e.message); }
                        finally { setBusy(""); }
                      }}
                      className="text-[10px] px-2 py-0.5 bg-red-600/20 hover:bg-red-600/40 border border-red-600/30 rounded-sm text-red-300">
                      End session
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AdminMargins />

      <LatencyPanel latency={data.latency} streams={data.orderStreams} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-[#1e2329] border border-gray-700 rounded flex flex-col max-h-[40vh]">
          <div className="px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200">Recent executions ({data.executions.length})</div>
          <div className="overflow-auto">
            {data.executions.length === 0 ? <div className="text-gray-500 text-[11px] px-3 py-3">No executions since the server started.</div> : (
              <table className="w-full text-left text-[10px] whitespace-nowrap">
                <thead><tr className="text-gray-500 uppercase text-[9px]">
                  <th className="px-2 py-1">Time</th><th className="px-2 py-1">By</th><th className="px-2 py-1">Client</th>
                  <th className="px-2 py-1">Leg</th><th className="px-2 py-1">Fill</th><th className="px-2 py-1">Status</th>
                </tr></thead>
                <tbody>
                  {data.executions.map((x, i) => (
                    <tr key={i} className="border-t border-gray-800" title={x.error || ""}>
                      <td className="px-2 py-1 text-gray-400">{fmtTime(x.at)}</td>
                      <td className="px-2 py-1 text-gray-400">{x.by}</td>
                      <td className="px-2 py-1 text-gray-300">{x.clientName || x.client}</td>
                      <td className="px-2 py-1 text-gray-300">{x.side} {x.label}</td>
                      <td className="px-2 py-1 text-gray-300">{x.filledQty}/{x.requestedQty}{x.avgPrice ? ` @ ${x.avgPrice}` : ""}</td>
                      <td className={`px-2 py-1 font-semibold ${statusTone(x.status)}`}>{x.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="bg-[#1e2329] border border-gray-700 rounded flex flex-col max-h-[40vh]">
          <div className="px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200">Admin audit trail</div>
          <div className="overflow-auto px-3 py-2 font-mono text-[10px] leading-relaxed">
            {data.audit.length === 0 ? <div className="text-gray-500">No admin actions yet.</div> :
              data.audit.map((a, i) => (
                <div key={i} className="text-gray-400">
                  <span className="text-gray-500">{fmtTime(a.at)}</span> <span className="text-amber-300">{a.actor}</span> {a.action}
                  {a.detail && <span className="text-gray-500"> — {a.detail}</span>}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Execution & Limits tab
// ─────────────────────────────────────────────────────────────
const ENGINE_FIELDS = [
  ["bufferPct",     "Price buffer %",          "How far past bid/ask the limit price is set", 0.05],
  ["fillTimeout",   "Fill timeout (s)",        "Wait this long for a fill before cancelling", 1],
  ["maxRetries",    "Retries",                 "Extra attempts for the unfilled remainder",   1],
  ["pollInterval",  "Status poll interval (s)","How often order status is checked",           0.1],
  ["cancelTimeout", "Cancel confirm wait (s)", "Longer than this → MANUAL CHECK",             1],
  ["retryDelay",    "Pause between attempts (s)", "",                                         0.5],
  ["orderGapMs",    "Order spacing per client (ms)", "Lower = faster multi-leg entries; the broker allows 10 orders/s (100 ms) for non-algo apps", 10],
];
const LIMIT_FIELDS = [
  ["maxLegs",          "Max legs per execution",     "1–8",                                     1],
  ["maxLotsPerLeg",    "Max lots per leg",           "0 = no limit",                            1],
  ["maxQtyPerOrder",   "Max quantity per order",     "Per client, after multiplier · 0 = no limit", 1],
  ["maxOrderValue",    "Max order value (₹)",        "Quantity × limit price · 0 = no limit",   1000],
  ["maxActiveClients", "Max clients per execution",  "0 = no limit",                            1],
  ["maxOrdersPerMinute", "Max orders per minute, per client", "Breaker: more are refused and strategies on that client pause · 0 = no limit", 1],
];

const SEGMENT_NAMES = {
  NSE_FO: "NSE F&O", BSE_FO: "BSE F&O", MCX_FO: "MCX commodities", NSE_EQ: "NSE equity",
  BSE_EQ: "BSE equity", NCD_FO: "NSE currency", BCD_FO: "BSE currency",
};
const inr = v => `₹${Number(v || 0).toLocaleString("en-IN")}`;

function TradingSetup({ s, save, saving }) {
  const [sizing, setSizing] = useState(s.sizing);
  useEffect(() => setSizing(s.sizing), [s.sizing]);
  const live = s.tradingMode === "LIVE";

  const setMode = mode => {
    if (mode === s.tradingMode) return;
    if (mode === "LIVE" && !window.confirm("Switch to LIVE?\n\nManual orders will go to the broker with real money, and strategies assigned LIVE will trade for real.")) return;
    save({ tradingMode: mode });
  };
  const toggleSeg = seg => {
    const next = s.allowedSegments.includes(seg) ? s.allowedSegments.filter(x => x !== seg) : [...s.allowedSegments, seg];
    save({ allowedSegments: next });
  };
  const sizingDirty = JSON.stringify(sizing) !== JSON.stringify(s.sizing);

  return (
    <>
      <div className={`rounded border px-4 py-3 flex flex-wrap items-center gap-3 ${live ? "bg-red-500/10 border-red-500/40" : "bg-amber-500/10 border-amber-500/40"}`}>
        <div className="flex-1 min-w-[220px]">
          <div className={`text-sm font-bold ${live ? "text-red-400" : "text-amber-300"}`}>{live ? "LIVE MODE" : "PAPER MODE"}</div>
          <div className="text-[11px] text-gray-400">
            {live
              ? "Manual orders go to the broker. Strategies follow their own PAPER / LIVE setting."
              : "Every order — manual and strategies — is simulated on the live feed. Nothing reaches the broker."}
          </div>
        </div>
        <div className="flex rounded-sm overflow-hidden border border-gray-600">
          {["PAPER", "LIVE"].map(m => (
            <button key={m} disabled={saving} onClick={() => setMode(m)}
              className={`px-4 py-1.5 text-[12px] font-bold ${s.tradingMode === m ? (m === "LIVE" ? "bg-red-600 text-white" : "bg-amber-500 text-black") : "bg-[#2d333b] text-gray-400 hover:text-gray-200"}`}>
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-[#1e2329] border border-gray-700 rounded px-3 py-3">
          <div className="text-[11px] font-bold text-gray-200 mb-2">Segments allowed for trading <span className="text-gray-500 font-normal">(dashboard + strategies)</span></div>
          {(s.segments || []).map(seg => (
            <div key={seg} className="flex items-center gap-2 mb-1.5">
              <label className="flex items-center gap-2 text-[11px] text-gray-300 flex-1">
                <input type="checkbox" checked={s.allowedSegments.includes(seg)} disabled={saving} onChange={() => toggleSeg(seg)} className="accent-emerald-500" />
                {SEGMENT_NAMES[seg] || seg} <span className="text-gray-500 font-mono text-[10px]">{seg}</span>
              </label>
              <select value={s.products?.[seg] || s.products?.default || "NRML"} disabled={saving}
                onChange={e => save({ products: { [seg]: e.target.value } })}
                className="bg-[#161a1f] border border-gray-600 text-gray-200 text-[10px] px-1 py-0.5 rounded-sm" title="Product type for orders in this segment">
                {(s.productTypes || ["NRML", "MIS", "CNC"]).map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          ))}
          <div className="text-[9px] text-gray-500 mt-1">NRML = carry forward · MIS = intraday · CNC = equity delivery</div>
        </div>

        <div className="bg-[#1e2329] border border-gray-700 rounded px-3 py-3">
          <div className="text-[11px] font-bold text-gray-200 mb-2">Lot sizing per client</div>
          {[["multiplier", "By each client's Multiplier ×"], ["capital", "By client capital"]].map(([m, label]) => (
            <label key={m} className="flex items-center gap-2 text-[11px] text-gray-300 mb-1">
              <input type="radio" name="sizing-mode" checked={sizing.mode === m} onChange={() => setSizing(z => ({ ...z, mode: m }))} className="accent-blue-500" />
              {label}
            </label>
          ))}
          {sizing.mode === "capital" && (
            <div className="mt-2">
              <div className="text-[10px] text-gray-500 mb-0.5">Capital for 1x (₹) — a client with this capital trades exactly the lots entered</div>
              <input type="number" min="10000" step="100000" value={sizing.baseCapital}
                onChange={e => setSizing(z => ({ ...z, baseCapital: e.target.value }))} className={inputCls} />
              <div className="text-[9px] text-gray-500 mt-0.5">e.g. {inr(sizing.baseCapital)} = 1x → a {inr(sizing.baseCapital * 2)} client trades 2 lots for every lot. Set each client's capital in Clients.</div>
            </div>
          )}
          <div className="text-[10px] text-gray-500 mt-2 mb-0.5">Fractions of a lot</div>
          <select value={sizing.rounding} onChange={e => setSizing(z => ({ ...z, rounding: e.target.value }))} className={inputCls}>
            <option value="floor">Round down (never more than the ratio — safest)</option>
            <option value="round">Round to nearest</option>
          </select>
          <button disabled={!sizingDirty || saving} onClick={() => save({ sizing: { ...sizing, baseCapital: Number(sizing.baseCapital) } })}
            className="mt-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-[11px] font-semibold px-3 py-1 rounded-sm">
            Save sizing
          </button>
          <div className="text-[9px] text-gray-500 mt-2">Strategies can also allocate capital per client (Strategies → assignment → Allocations).</div>
        </div>
      </div>
    </>
  );
}

function ExecutionControls() {
  const [s, setS] = useState(null);
  const [draft, setDraft] = useState(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await adminFetch("/api/admin/settings");
      setS(d);
      setDraft({ engine: { ...d.engine }, limits: { ...d.limits } });
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async patch => {
    setSaving(true); setError(""); setNotice("");
    try {
      const d = await adminFetch("/api/admin/settings", { method: "PUT", body: patch });
      setS(prev => ({ ...prev, ...d }));
      setDraft({ engine: { ...d.engine }, limits: { ...d.limits } });
      setNotice("Saved — applies to the next execution.");
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const toggleHalt = () => {
    if (s.tradingHalted) {
      if (!window.confirm(s.tradingMode === "LIVE"
        ? "RESUME trading in LIVE mode? Dashboard users will be able to send real orders to the broker."
        : "Resume trading in PAPER mode? Executions are simulated — nothing reaches the broker.")) return;
      save({ tradingHalted: false });
    } else {
      if (!window.confirm("HALT trading? New executions will be refused until resumed. (An execution already running finishes.)")) return;
      save({ tradingHalted: true, haltReason: reason || "Halted by admin" });
      setReason("");
    }
  };

  if (!s || !draft) return <div className="text-gray-400 text-xs flex items-center gap-2"><Loader size={14} className="animate-spin" /> Loading settings… {error}</div>;

  const field = (group, [key, label, hint, step]) => {
    const [min, max] = s.ranges[group][key] || [];
    return (
      <div key={key} className="mb-2">
        <div className="text-[10px] text-gray-500 mb-0.5">{label} <span className="text-gray-600">({min}–{max})</span></div>
        <input type="number" step={step} min={min} max={max} value={draft[group][key]}
          onChange={e => setDraft(d => ({ ...d, [group]: { ...d[group], [key]: e.target.value } }))}
          className={inputCls} />
        {hint && <div className="text-[9px] text-gray-500 mt-0.5">{hint}</div>}
      </div>
    );
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify({ engine: s.engine, limits: s.limits });

  return (
    <div className="flex flex-col gap-3">
      <TradingSetup s={s} save={save} saving={saving} />

      <div className={`rounded border px-4 py-3 flex flex-wrap items-center gap-3 ${s.tradingHalted ? "bg-red-500/10 border-red-500/40" : "bg-emerald-500/10 border-emerald-500/40"}`}>
        <div className="flex-1 min-w-[220px]">
          <div className={`text-sm font-bold ${s.tradingHalted ? "text-red-400" : "text-emerald-400"}`}>
            {s.tradingHalted ? "TRADING HALTED" : "TRADING ENABLED"}
          </div>
          <div className="text-[11px] text-gray-400">
            {s.tradingHalted ? (s.haltReason || "Executions are refused.") : `Dashboard users can execute (${s.tradingMode === "LIVE" ? "LIVE — orders go to the broker" : "PAPER — simulated"}).`}
          </div>
        </div>
        {!s.tradingHalted && (
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (optional)" className={`${inputCls} max-w-[220px]`} />
        )}
        <button disabled={saving} onClick={toggleHalt}
          className={`flex items-center gap-2 px-4 py-2 rounded-sm text-[12px] font-bold disabled:opacity-50 ${s.tradingHalted ? "bg-emerald-600 hover:bg-emerald-500 text-white" : "bg-red-600 hover:bg-red-500 text-white"}`}>
          {s.tradingHalted ? <><PlayCircle size={14} /> Resume trading</> : <><OctagonX size={14} /> HALT TRADING</>}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-[#1e2329] border border-gray-700 rounded px-3 py-3">
          <div className="text-[11px] font-bold text-gray-200 mb-2">Execution engine</div>
          {ENGINE_FIELDS.map(f => field("engine", f))}
        </div>
        <div className="bg-[#1e2329] border border-gray-700 rounded px-3 py-3">
          <div className="text-[11px] font-bold text-gray-200 mb-2">Risk limits <span className="text-gray-500 font-normal">(checked before any order is sent)</span></div>
          {LIMIT_FIELDS.map(f => field("limits", f))}
        </div>
      </div>

      {error  && <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1.5">{error}</div>}
      {notice && <div className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-sm px-2 py-1.5">{notice}</div>}

      <div className="flex gap-2">
        <button disabled={!dirty || saving} onClick={() => save({ engine: draft.engine, limits: draft.limits })}
          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-[11px] font-semibold px-4 py-1.5 rounded-sm">
          {saving && <Loader size={12} className="animate-spin" />} Save engine & limits
        </button>
        <button disabled={!dirty || saving} onClick={() => setDraft({ engine: { ...s.engine }, limits: { ...s.limits } })}
          className="bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 text-gray-200 text-[11px] px-3 py-1.5 rounded-sm disabled:opacity-40">
          Discard changes
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Shell
// ─────────────────────────────────────────────────────────────
const TABS = [
  ["monitor",   "Monitor",            Activity],
  ["clients",   "Clients",            Users],
  ["strategies","Strategies",         Bot],
  ["tradebooks","Trade Books",        BookOpen],
  ["execution", "Execution & Limits", SlidersHorizontal],
];

export default function AdminConsole({ onClose }) {
  const [state, setState] = useState(getAdminToken() ? "checking" : "out"); // checking | out | in
  const [adminName, setAdminName] = useState("");
  const [tab, setTab] = useState("monitor");

  useEffect(() => {
    if (state !== "checking") return;
    adminFetch("/api/admin/verify")
      .then(d => { setAdminName(d.username); setState("in"); })
      .catch(() => { clearAdminToken(); setState("out"); });
  }, [state]);

  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // An expired admin session anywhere in the console drops back to login.
  useEffect(() => {
    if (state !== "in") return;
    const id = setInterval(() => { if (!getAdminToken()) setState("out"); }, 2000);
    return () => clearInterval(id);
  }, [state]);

  const logout = () => { clearAdminToken(); setState("out"); };

  return (
    <div className="fixed inset-0 z-[10000] bg-[#0f1216]/95 backdrop-blur-sm flex flex-col text-gray-300">
      <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[#8a5a1f] to-[#6b4419] border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-2 text-white font-bold text-sm">
          <ShieldAlert size={16} /> ADMIN CONSOLE
          {state === "in" && <span className="text-[10px] font-normal text-amber-100/80">— {adminName}</span>}
        </div>
        <div className="flex items-center gap-2">
          {state === "in" && (
            <button onClick={logout} className="flex items-center gap-1 text-[10px] text-white/80 hover:text-white border border-white/30 rounded-sm px-2 py-0.5">
              <LogOut size={11} /> Admin logout
            </button>
          )}
          <button onClick={onClose} title="Close (Esc)" className="text-white/80 hover:text-white"><X size={18} /></button>
        </div>
      </div>

      {state === "checking" && <div className="flex-1 flex items-center justify-center text-xs text-gray-400"><Loader size={14} className="animate-spin mr-2" /> Checking admin session…</div>}
      {state === "out" && <AdminLogin onLoggedIn={name => { setAdminName(name); setState("in"); }} />}

      {state === "in" && (
        <>
          <div className="flex gap-1 px-4 pt-3 shrink-0 border-b border-gray-700">
            {TABS.map(([key, label, Icon]) => (
              <button key={key} onClick={() => setTab(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-t-sm border border-b-0 ${tab === key ? "bg-[#1e2329] border-gray-600 text-white" : "border-transparent text-gray-400 hover:text-gray-200"}`}>
                <Icon size={12} /> {label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-auto p-4">
            {tab === "monitor"   && <Monitor />}
            {tab === "clients"   && <AdminClients />}
            {tab === "strategies"&& <AdminStrategies />}
            {tab === "tradebooks"&& <AdminTradeBooks />}
            {tab === "execution" && <ExecutionControls />}
          </div>
        </>
      )}
    </div>
  );
}
