import React, { useState, useEffect, useCallback } from "react";
import { Loader, RefreshCw } from "lucide-react";
import { adminFetch } from "./authFetch.js";

// Admin console -> Monitor -> Client margins: utilized vs available per client,
// read from the broker's balance endpoint (read-only, cached 30 s server-side).

const inr = v => (v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);

export default function AdminMargins() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try { setRows(await adminFetch(`/api/admin/margins${refresh ? "?refresh=1" : ""}`)); setError(""); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { load(); const id = setInterval(() => load(), 30000); return () => clearInterval(id); }, [load]);

  return (
    <div className="bg-[#1e2329] border border-gray-700 rounded">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200">
        Client margins
        <span className="font-normal text-gray-500">utilized vs available, from the broker (needs the client logged in)</span>
        <button onClick={() => load(true)} disabled={busy} className="ml-auto p-1 text-gray-400 hover:text-gray-200 disabled:opacity-50" title="Ask the broker again now">
          {busy ? <Loader size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
      </div>
      {error && <div className="text-[11px] text-red-400 px-3 py-1">{error}</div>}
      {!rows ? <div className="text-gray-400 text-xs px-3 py-3 flex items-center gap-2"><Loader size={12} className="animate-spin" /> Loading…</div> : (
        <table className="w-full text-left text-[11px] whitespace-nowrap">
          <thead><tr className="text-gray-500 uppercase text-[9px]">
            {["Client", "Assigned", "Available", "Utilized", "Total", "Used", "Cash", "MTM", "Updated"].map(h => <th key={h} className="px-2 py-1">{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map(m => {
              const pct = Number(m.usedPct || 0);
              const tone = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
              return (
                <tr key={m.clientId} className="border-t border-gray-800">
                  <td className="px-2 py-1 text-gray-200">{m.clientName} <span className="font-mono text-gray-500 text-[9px]">{m.clientId}</span></td>
                  <td className="px-2 py-1 text-gray-400">{m.assignedTo || "everyone"}</td>
                  {!m.loggedIn ? (
                    <td colSpan={7} className="px-2 py-1 text-gray-500">not logged in — log the client in to read its margin</td>
                  ) : m.error ? (
                    <td colSpan={7} className="px-2 py-1 text-amber-400" title={m.raw ? JSON.stringify(m.raw).slice(0, 2000) : ""}>{m.error}</td>
                  ) : (
                    <>
                      <td className="px-2 py-1 text-emerald-400 font-semibold">{inr(m.available)}</td>
                      <td className="px-2 py-1 text-amber-300 font-semibold">{inr(m.utilized)}</td>
                      <td className="px-2 py-1 text-gray-300">{inr(m.total)}</td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1.5">
                          <div className="w-20 h-1.5 bg-gray-700 rounded-full overflow-hidden"><div className={`h-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
                          <span className="text-gray-300">{pct.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="px-2 py-1 text-gray-400">{inr(m.cash)}</td>
                      <td className={`px-2 py-1 ${Number(m.mtm) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{inr(m.mtm)}</td>
                      <td className="px-2 py-1 text-gray-500">{m.fetchedAt ? new Date(m.fetchedAt).toLocaleTimeString() : "—"}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
