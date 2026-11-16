import React, { useState, useEffect, useCallback } from "react";
import { Play, Square, OctagonX, PlayCircle, Loader, ChevronDown, ChevronRight, Bot } from "lucide-react";
import { API_BASE } from "./config.js";
import { downloadFile, todayIst } from "./download.js";
import JournalView from "./JournalView.jsx";

// Dashboard → Automated Strategies: the strategies the admin assigned to
// this user. Start arms the strategy; it then trades by itself on its entry
// days and times while the backend runs (the browser can be closed).

const statusTone = {
  RUNNING:  "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  STOPPING: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  PAUSED:   "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/40",
  STOPPED:  "bg-gray-600/30 text-gray-400 border-gray-600/40",
};
const money = v => (v == null ? "—" : `${v >= 0 ? "" : "−"}₹${Math.abs(v).toFixed(2)}`);

async function api(path, method = "GET") {
  const r = await fetch(`${API_BASE}${path}`, { method, headers: { "Content-Type": "application/json" } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function Positions({ list }) {
  if (!list.length) return <div className="text-gray-500 text-[10px] px-2 py-2">No positions today.</div>;
  return (
    <table className="w-full text-left text-[10px] whitespace-nowrap">
      <thead><tr className="text-gray-500 uppercase text-[9px]">
        {["Client", "Instrument", "Side", "Qty", "Entry", "LTP", "Stop", "Status", "P&L", "Slot"].map(h => <th key={h} className="px-2 py-1">{h}</th>)}
      </tr></thead>
      <tbody>
        {list.map(p => {
          const pnl = p.status === "OPEN" ? p.unrealized : p.pnl;
          return (
            <tr key={p.id} className="border-t border-gray-800">
              <td className="px-2 py-1 text-gray-300">{p.client}</td>
              <td className="px-2 py-1 text-gray-200">{p.tradingSymbol}{p.delta != null && <span className="text-gray-500"> Δ{p.delta}</span>}</td>
              <td className={`px-2 py-1 font-semibold ${p.side === "SELL" ? "text-red-400" : "text-blue-400"}`}>{p.side}</td>
              <td className="px-2 py-1 text-gray-300">{p.qty}</td>
              <td className="px-2 py-1 text-gray-300">{p.entryPrice}</td>
              <td className="px-2 py-1 text-amber-300">{p.ltp ?? "—"}</td>
              <td className="px-2 py-1 text-gray-400">{p.stopPrice ?? "—"}</td>
              <td className={`px-2 py-1 font-semibold ${p.status === "OPEN" ? "text-emerald-400" : p.status === "CHECK" ? "text-fuchsia-400" : "text-gray-400"}`}>
                {p.status}{p.exitReason ? ` (${p.exitReason})` : ""}
              </td>
              <td className={`px-2 py-1 ${pnl == null ? "text-gray-500" : pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{money(pnl)}</td>
              <td className="px-2 py-1 text-gray-500">{p.slot}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StrategyCard({ s, onAction, busy }) {
  const [open, setOpen] = useState(false);
  const running = s.status === "RUNNING";
  const live = s.mode === "LIVE";
  return (
    <div className={`bg-[#1e2329] border rounded shrink-0 ${live ? "border-red-700/50" : "border-gray-700"}`}>
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <button onClick={() => setOpen(o => !o)} className="text-gray-400 hover:text-white">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="min-w-[160px]">
          <div className="text-[12px] font-bold text-white flex items-center gap-1.5">
            {s.strategyName}
            <span className={`px-1.5 py-0 rounded-full text-[9px] border ${live ? "bg-red-500/20 text-red-300 border-red-500/40" : "bg-amber-500/15 text-amber-300 border-amber-500/30"}`}>{s.mode}</span>
            <span className={`px-1.5 py-0 rounded-full text-[9px] border ${statusTone[s.status] || statusTone.STOPPED}`}>{s.status}</span>
          </div>
          <div className="text-[10px] text-gray-400">{s.phase}</div>
        </div>
        <div className="text-[10px] text-gray-400 flex gap-3 flex-wrap">
          {s.symbols.map(x => (
            <span key={x.underlying}>{x.underlying} <span className="text-gray-500">exp {x.expiry || "—"} · DTE {x.dte ?? "—"}</span>{x.entryDay && <span className="text-emerald-400"> · entry day</span>}</span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right">
            <div className={`text-[12px] font-bold ${s.pnlToday.total >= 0 ? "text-emerald-400" : "text-red-400"}`}>{money(s.pnlToday.total)}</div>
            <div className="text-[9px] text-gray-500">{s.openPositions} open{s.needsCheck ? ` · ${s.needsCheck} need check` : ""}</div>
          </div>
          {s.status === "PAUSED" && (
            <button disabled={busy} onClick={() => onAction(s, "resume")}
              className="flex items-center gap-1 bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[10px] font-semibold px-2.5 py-1 rounded-sm disabled:opacity-50">
              <PlayCircle size={12} /> Resume
            </button>
          )}
          {(s.status === "STOPPED" || s.status === "STOPPING") && (
            <button disabled={busy || !s.enabled} onClick={() => onAction(s, "start")} title={s.enabled ? "" : "Disabled by admin"}
              className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-semibold px-2.5 py-1 rounded-sm disabled:opacity-40">
              {busy ? <Loader size={12} className="animate-spin" /> : <Play size={12} />} Start
            </button>
          )}
          {(running || s.status === "PAUSED") && (
            <button disabled={busy} onClick={() => onAction(s, "stop")}
              className="flex items-center gap-1 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 text-gray-200 text-[10px] px-2.5 py-1 rounded-sm disabled:opacity-50">
              <Square size={11} /> Stop
            </button>
          )}
          {s.openPositions > 0 && (
            <button disabled={busy} onClick={() => onAction(s, "squareoff")}
              className="flex items-center gap-1 bg-red-600/20 hover:bg-red-600/40 border border-red-600/30 text-red-300 text-[10px] px-2.5 py-1 rounded-sm disabled:opacity-50">
              <OctagonX size={11} /> Square off
            </button>
          )}
        </div>
      </div>
      {s.pausedReason && <div className="mx-3 mb-2 text-[10px] text-fuchsia-300 bg-fuchsia-500/10 border border-fuchsia-500/30 rounded-sm px-2 py-1">{s.pausedReason}</div>}
      {open && (
        <div className="border-t border-gray-700 px-3 py-2 space-y-2">
          {s.summary && (
            <div className="text-[10px] text-gray-400 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-0.5">
              <div>Entry: DTE {s.summary.entryDte.join(", ")} · {s.summary.expiry.replace("_", " ")} expiry</div>
              <div>Stop: {s.summary.stop} · Daily loss: {s.summary.dailyLossPct ? `${s.summary.dailyLossPct}% of ₹${s.capital}` : "none"} · Exit: {s.summary.exit}</div>
              {s.summary.groups.map(g => (
                <div key={g.id} className="md:col-span-2">
                  <span className="text-gray-300">{g.id}</span> {g.window} ({g.entries} entries): {g.legs.join(", ")}
                </div>
              ))}
            </div>
          )}
          <div className="bg-[#161a1f] border border-gray-800 rounded overflow-auto max-h-[220px]">
            <Positions list={s.positions} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function StrategyPanel({ log }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try { setList(await api("/api/strategies")); setError(""); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, [load]);

  const onAction = async (s, action) => {
    if (action === "start" && s.mode === "LIVE" &&
        !window.confirm(`Start "${s.strategyName}" in LIVE mode?\n\nIt will send REAL orders to your clients on its entry days and times.`)) return;
    if (action === "squareoff" &&
        !window.confirm(`Square off all ${s.openPositions} open position(s) of "${s.strategyName}" now${s.mode === "LIVE" ? " with real orders" : ""}?`)) return;
    setBusyId(s.assignmentId);
    try {
      await api(`/api/strategies/${s.assignmentId}/${action}`, "POST");
      log?.(`Strategy ${s.strategyName}: ${action} OK`);
      await load();
    } catch (e) {
      setError(e.message);
      log?.(`❌ Strategy ${s.strategyName}: ${action} failed — ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const journalLoad = useCallback((kind, date) => api(`/api/journal/${kind}?date=${date}`), []);
  const journalDownload = useCallback((kind, date) =>
    downloadFile(`${API_BASE}/api/journal/${kind}?date=${date}&format=csv`, `${kind === "trades" ? "trade-book" : "activity-log"}-${date}.csv`), []);

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-[#2d333b] p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-white text-[13px] font-semibold">
        <Bot size={15} className="text-sky-400" /> Automated Strategies
        <span className="text-[10px] font-normal text-gray-400">— run by the backend; they keep trading on schedule while the server is on, even if this page is closed.</span>
      </div>
      {error && <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1">{error}</div>}
      {list === null ? (
        <div className="text-gray-400 text-xs flex items-center gap-2"><Loader size={14} className="animate-spin" /> Loading…</div>
      ) : list.length === 0 ? (
        <div className="text-gray-400 text-[11px] bg-[#1e2329] border border-gray-700 rounded px-3 py-4">
          No strategies are assigned to you yet. An admin uploads strategy files and assigns them in the Admin console.
        </div>
      ) : (
        list.map(s => <StrategyCard key={s.assignmentId} s={s} onAction={onAction} busy={busyId === s.assignmentId} />)
      )}
      <JournalView load={journalLoad} download={journalDownload} compact />
      <div className="text-[9px] text-gray-500">Times are IST ({todayIst()}). PAPER strategies simulate fills from live quotes and never send orders.</div>
    </div>
  );
}
