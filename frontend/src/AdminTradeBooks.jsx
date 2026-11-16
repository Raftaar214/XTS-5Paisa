import React, { useState, useEffect, useCallback } from "react";
import { Download, Loader, RefreshCw, Save, Eye } from "lucide-react";
import { adminFetch, getAdminToken, API_BASE } from "./authFetch.js";
import { downloadFile, rowsToCsv, saveText, todayIst } from "./download.js";

// Admin console → Trade Books: every client's trade book, kept per day.
//   Broker = saved copy of the broker's own trade book (refreshed every 5 min
//            in market hours and whenever a Trades view is opened)
//   App    = trades this app placed (manual + strategy, LIVE + PAPER)

const authHeader = () => ({ Authorization: `Bearer ${getAdminToken() || ""}` });
const fmtTime = iso => (iso ? new Date(iso).toLocaleTimeString() : "—");

export default function AdminTradeBooks() {
  const [date, setDate] = useState(todayIst());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [view, setView] = useState(null); // { clientId, source, rows }

  const load = useCallback(async () => {
    try { setData(await adminFetch(`/api/admin/tradebooks?date=${date}`)); setError(""); }
    catch (e) { setError(e.message); }
  }, [date]);

  useEffect(() => { load(); setView(null); }, [load]);
  useEffect(() => {
    if (date !== todayIst()) return undefined;
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load, date]);

  const snapshot = async () => {
    setBusy("snap"); setError("");
    try { await adminFetch("/api/admin/tradebooks/snapshot", { method: "POST" }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };

  const open = async (clientId, source) => {
    setBusy(`v:${clientId}:${source}`);
    try {
      const d = await adminFetch(`/api/admin/tradebooks/${encodeURIComponent(clientId)}?source=${source}&date=${date}`);
      setView({ clientId, source, rows: d.rows || [] });
    } catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };

  const csv = (clientId, source) =>
    downloadFile(`${API_BASE}/api/admin/tradebooks/${encodeURIComponent(clientId)}?source=${source}&date=${date}&format=csv`,
      `${clientId}-${source}-tradebook-${date}.csv`, authHeader()).catch(e => setError(e.message));

  const cols = view ? Object.keys(view.rows.reduce((o, r) => Object.assign(o, r), {})).filter(k => k !== "id") : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={date} onChange={e => setDate(e.target.value)}
          className="bg-[#161a1f] border border-gray-600 text-gray-200 text-[11px] px-2 py-1 rounded-sm">
          {[...new Set([todayIst(), ...(data?.dates || [])])].map(d => <option key={d} value={d}>{d}{d === todayIst() ? " (today)" : ""}</option>)}
        </select>
        <button onClick={load} className="p-1.5 text-gray-400 hover:text-gray-200" title="Refresh"><RefreshCw size={12} /></button>
        <button onClick={snapshot} disabled={!!busy}
          className="flex items-center gap-1.5 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 text-gray-200 text-[11px] px-3 py-1 rounded-sm disabled:opacity-50"
          title="Read every logged-in client's broker trade book now (read-only)">
          {busy === "snap" ? <Loader size={12} className="animate-spin" /> : <Save size={12} />} Save broker trade books now
        </button>
        <div className="ml-auto flex gap-2">
          {["broker", "app"].map(src => (
            <button key={src} onClick={() => csv("all", src)}
              className="flex items-center gap-1 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 text-emerald-300 text-[11px] px-2.5 py-1 rounded-sm">
              <Download size={12} /> All clients — {src === "broker" ? "broker" : "app"} CSV
            </button>
          ))}
        </div>
      </div>
      {error && <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1.5">{error}</div>}

      <div className="bg-[#1e2329] border border-gray-700 rounded overflow-auto">
        {!data ? <div className="text-gray-400 text-xs px-3 py-3 flex items-center gap-2"><Loader size={12} className="animate-spin" /> Loading…</div> : (
          <table className="w-full text-left text-[11px] whitespace-nowrap">
            <thead><tr className="text-gray-500 uppercase text-[9px]">
              {["Client", "Role", "Login", "Broker trades", "Saved at", "App trades", ""].map(h => <th key={h} className="px-2 py-1.5">{h}</th>)}
            </tr></thead>
            <tbody>
              {data.clients.map(c => (
                <tr key={c.clientId} className="border-t border-gray-800">
                  <td className="px-2 py-1.5 text-gray-100">{c.clientName} <span className="font-mono text-gray-500 text-[9px]">{c.clientId}</span></td>
                  <td className="px-2 py-1.5 text-gray-400">{c.role || "—"}</td>
                  <td className={`px-2 py-1.5 font-semibold ${c.isLogged ? "text-blue-400" : "text-gray-500"}`}>{c.isLogged ? "IN" : "OUT"}</td>
                  <td className="px-2 py-1.5 text-gray-200">{c.brokerTrades}</td>
                  <td className="px-2 py-1.5 text-gray-500">{fmtTime(c.brokerUpdatedAt)}</td>
                  <td className="px-2 py-1.5 text-gray-200">{c.appTrades}</td>
                  <td className="px-2 py-1.5">
                    {["broker", "app"].map(src => (
                      <span key={src} className="mr-3 inline-flex items-center gap-1">
                        <button onClick={() => open(c.clientId, src)} className="flex items-center gap-0.5 text-sky-300 hover:text-sky-200 text-[10px]">
                          {busy === `v:${c.clientId}:${src}` ? <Loader size={10} className="animate-spin" /> : <Eye size={10} />} {src}
                        </button>
                        <button onClick={() => csv(c.clientId, src)} title={`${src} trade book CSV`} className="text-emerald-400 hover:text-emerald-300"><Download size={11} /></button>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {view && (
        <div className="bg-[#1e2329] border border-gray-700 rounded">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200">
            {view.clientId} — {view.source === "broker" ? "broker trade book (saved copy)" : "trades placed by this app"} · {date} · {view.rows.length} row(s)
            <button onClick={() => saveText(rowsToCsv(view.rows), `${view.clientId}-${view.source}-tradebook-${date}.csv`)}
              disabled={!view.rows.length}
              className="ml-auto flex items-center gap-1 text-emerald-300 text-[10px] font-normal disabled:opacity-30"><Download size={11} /> CSV</button>
          </div>
          <div className="overflow-auto max-h-[45vh]">
            {view.rows.length === 0 ? <div className="text-gray-500 text-[11px] px-3 py-3">No trades recorded.</div> : (
              <table className="w-full text-left text-[10px] whitespace-nowrap">
                <thead className="sticky top-0 bg-[#242a31]"><tr className="text-gray-500 text-[9px]">{cols.map(k => <th key={k} className="px-2 py-1">{k}</th>)}</tr></thead>
                <tbody>
                  {view.rows.map((r, i) => (
                    <tr key={r.id || i} className="border-t border-gray-800">
                      {cols.map(k => <td key={k} className="px-2 py-1 text-gray-300">{typeof r[k] === "object" && r[k] !== null ? JSON.stringify(r[k]) : String(r[k] ?? "")}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
