import React, { useState, useEffect, useCallback } from "react";
import { Download, Loader, RefreshCw } from "lucide-react";
import { todayIst } from "./download.js";

// Trade book + activity log viewer, backed by the server journal (durable
// per-day files). Used by the dashboard (own records) and the admin console
// (everyone). `load(kind, date)` → { rows, dates }; `download(kind, date)`.

const TRADE_COLS = [
  ["time", "Time"], ["source", "Source"], ["mode", "Mode"], ["user", "User"], ["strategy", "Strategy"],
  ["client", "Client"], ["tradingSymbol", "Instrument"], ["side", "Side"], ["qty", "Qty"],
  ["price", "Price"], ["reason", "Reason"], ["pnl", "P&L"], ["status", "Status"], ["orderId", "Order"],
];
const EVENT_COLS = [["time", "Time"], ["level", "Level"], ["user", "User"], ["strategy", "Strategy"], ["message", "Message"]];

const levelTone = l => l === "error" ? "text-red-400" : l === "warn" ? "text-amber-400" : "text-gray-300";

export default function JournalView({ load, download, showUser = false, compact = false }) {
  const [kind, setKind] = useState("trades");
  const [date, setDate] = useState(todayIst());
  const [rows, setRows] = useState([]);
  const [dates, setDates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await load(kind, date);
      setRows(Array.isArray(d?.rows) ? d.rows.slice().reverse() : []);
      setDates(Array.isArray(d?.dates) ? d.dates : []);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [load, kind, date]);

  useEffect(() => {
    setLoading(true);
    refresh();
    if (date !== todayIst()) return undefined;
    const id = setInterval(refresh, 5000);   // live while viewing today
    return () => clearInterval(id);
  }, [refresh, date]);

  const save = async () => {
    setDownloading(true);
    try { await download(kind, date); }
    catch (e) { setError(e.message); }
    finally { setDownloading(false); }
  };

  const cols = (kind === "trades" ? TRADE_COLS : EVENT_COLS).filter(([k]) => showUser || k !== "user");
  const dateOptions = [...new Set([todayIst(), ...dates])];

  return (
    <div className="bg-[#1e2329] border border-gray-700 rounded flex flex-col shrink-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-700 shrink-0 flex-wrap">
        {[["trades", "Trade book"], ["events", "Activity log"]].map(([k, label]) => (
          <button key={k} onClick={() => setKind(k)}
            className={`px-2 py-0.5 text-[10px] font-semibold rounded-sm ${kind === k ? "bg-[#3b4148] text-white" : "text-gray-400 hover:text-gray-200"}`}>
            {label}
          </button>
        ))}
        <select value={date} onChange={e => setDate(e.target.value)}
          className="bg-[#161a1f] border border-gray-600 text-gray-200 text-[10px] px-1 py-0.5 rounded-sm">
          {dateOptions.map(d => <option key={d} value={d}>{d}{d === todayIst() ? " (today)" : ""}</option>)}
        </select>
        <span className="text-[10px] text-gray-500">{rows.length} row(s)</span>
        <div className="ml-auto flex gap-1">
          <button onClick={refresh} title="Refresh" className="p-1 text-gray-400 hover:text-gray-200"><RefreshCw size={11} /></button>
          <button onClick={save} disabled={downloading}
            className="flex items-center gap-1 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 px-2 py-0.5 rounded-sm text-[10px] text-emerald-300 disabled:opacity-50">
            {downloading ? <Loader size={11} className="animate-spin" /> : <Download size={11} />} CSV
          </button>
        </div>
      </div>
      {error && <div className="text-[10px] text-red-400 px-2 py-1">{error}</div>}
      <div className={`overflow-auto ${compact ? "max-h-[180px]" : "max-h-[40vh]"}`}>
        {loading ? (
          <div className="text-gray-400 text-[10px] px-2 py-3 flex items-center gap-1"><Loader size={11} className="animate-spin" /> Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-gray-500 text-[10px] px-2 py-3">Nothing recorded for {date}.</div>
        ) : (
          <table className="w-full text-left text-[10px] whitespace-nowrap">
            <thead className="sticky top-0 bg-[#242a31]">
              <tr className="text-gray-500 uppercase text-[9px]">{cols.map(([k, l]) => <th key={k} className="px-2 py-1 font-semibold">{l}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t border-gray-800 hover:bg-[#2d333b]">
                  {cols.map(([k]) => {
                    let v = r[k];
                    let cls = "text-gray-300";
                    if (k === "side") cls = v === "BUY" ? "text-blue-400 font-semibold" : v === "SELL" ? "text-red-400 font-semibold" : cls;
                    if (k === "pnl" && v !== undefined && v !== "") { cls = Number(v) >= 0 ? "text-emerald-400" : "text-red-400"; v = Number(v).toFixed(2); }
                    if (k === "mode") cls = v === "LIVE" ? "text-red-300 font-semibold" : "text-amber-300";
                    if (k === "level") cls = levelTone(v);
                    if (k === "message") cls = `${levelTone(r.level)} whitespace-normal min-w-[300px]`;
                    return <td key={k} className={`px-2 py-1 ${cls}`}>{v ?? ""}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
