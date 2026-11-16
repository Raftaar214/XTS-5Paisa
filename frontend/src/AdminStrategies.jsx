import React, { useState, useEffect, useCallback, useRef } from "react";
import { Upload, Trash2, Download, Loader, Plus, Play, Square, OctagonX, PlayCircle } from "lucide-react";
import { adminFetch, getAdminToken, API_BASE } from "./authFetch.js";
import { downloadFile } from "./download.js";
import JournalView from "./JournalView.jsx";

// Admin console → Strategies.
//   1. Upload strategy files (bt-strategy-config JSON, many at once)
//   2. Assign a strategy to a dashboard user (PAPER or LIVE, capital, clients)
//   3. Watch / control every assignment, and read everyone's trade book and log

const inputCls = "bg-[#161a1f] border border-gray-600 text-white text-[12px] px-2 py-1.5 rounded-sm focus:outline-none focus:border-blue-500";
const statusTone = {
  RUNNING: "text-emerald-400", STOPPING: "text-amber-400", PAUSED: "text-fuchsia-400", STOPPED: "text-gray-500",
};
const money = v => (v == null ? "—" : `${v >= 0 ? "" : "−"}₹${Math.abs(v).toFixed(0)}`);
const authHeader = () => ({ Authorization: `Bearer ${getAdminToken() || ""}` });

function UploadBox({ onDone }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);

  const onFiles = async e => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setBusy(true);
    const out = [];
    for (const f of files) {
      try {
        const text = await f.text();
        let content;
        try { content = JSON.parse(text); } catch { throw new Error("not valid JSON"); }
        const s = await adminFetch("/api/admin/strategies", { method: "POST", body: { fileName: f.name, content } });
        out.push({ file: f.name, ok: true, msg: `${s.name}${s.warnings.length ? ` (note: ${s.warnings.join("; ")})` : ""}` });
      } catch (err) {
        out.push({ file: f.name, ok: false, msg: err.message });
      }
    }
    setResults(out);
    setBusy(false);
    onDone();
  };

  return (
    <div className="bg-[#1e2329] border border-gray-700 rounded px-3 py-2">
      <div className="flex items-center gap-3">
        <input ref={ref} type="file" accept=".json,application/json" multiple className="hidden" onChange={onFiles} />
        <button onClick={() => ref.current?.click()} disabled={busy}
          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-semibold px-3 py-1.5 rounded-sm">
          {busy ? <Loader size={12} className="animate-spin" /> : <Upload size={12} />} Upload strategy files
        </button>
        <span className="text-[10px] text-gray-500">Select one or many <code>*.strategy.json</code> exports (bt-strategy-config v1). Unsupported settings are refused with the reason.</span>
      </div>
      {results.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {results.map((r, i) => (
            <div key={i} className={`text-[10px] ${r.ok ? "text-emerald-400" : "text-red-400"}`}>{r.ok ? "✓" : "✗"} {r.file}: {r.msg}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssignForm({ strategies, users, clients, onDone }) {
  const [f, setF] = useState({ strategyId: "", username: "", capital: "", mode: "PAPER", clientIds: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const userClients = clients.filter(c => !c.assignedTo || c.assignedTo === f.username);
  const chosen = strategies.find(s => s.id === f.strategyId);

  const submit = async e => {
    e.preventDefault();
    setError("");
    if (f.mode === "LIVE" && !window.confirm("Create this assignment in LIVE mode? When the user starts it, it sends REAL orders.")) return;
    setBusy(true);
    try {
      await adminFetch("/api/admin/assignments", { method: "POST", body: { ...f, capital: f.capital === "" ? null : Number(f.capital) } });
      setF(x => ({ ...x, strategyId: "", clientIds: [] }));
      onDone();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="bg-[#1e2329] border border-gray-700 rounded px-3 py-2">
      <div className="text-[11px] font-bold text-gray-200 mb-2">Assign a strategy to a user</div>
      <div className="flex flex-wrap gap-2 items-end">
        <label className="text-[10px] text-gray-500">Strategy<br />
          <select value={f.strategyId} onChange={e => setF(x => ({ ...x, strategyId: e.target.value }))} className={`${inputCls} min-w-[180px]`}>
            <option value="">— choose —</option>
            {strategies.filter(s => s.summary).map(s => <option key={s.id} value={s.id}>{s.name} ({s.fileName})</option>)}
          </select>
        </label>
        <label className="text-[10px] text-gray-500">User<br />
          <select value={f.username} onChange={e => setF(x => ({ ...x, username: e.target.value, clientIds: [] }))} className={`${inputCls} min-w-[120px]`}>
            <option value="">— choose —</option>
            {users.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
        <label className="text-[10px] text-gray-500">Capital ₹ (1x){chosen?.summary?.dailyLossPct ? ` — for ${chosen.summary.dailyLossPct}% daily loss` : ""}<br />
          <input type="number" min="1" value={f.capital} onChange={e => setF(x => ({ ...x, capital: e.target.value }))} className={`${inputCls} w-[140px]`} placeholder="e.g. 500000" />
        </label>
        <label className="text-[10px] text-gray-500">Mode<br />
          <select value={f.mode} onChange={e => setF(x => ({ ...x, mode: e.target.value }))} className={inputCls}>
            <option value="PAPER">PAPER (no orders)</option>
            <option value="LIVE">LIVE (real orders)</option>
          </select>
        </label>
        <button type="submit" disabled={busy || !f.strategyId || !f.username}
          className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[11px] font-semibold px-3 py-1.5 rounded-sm">
          {busy ? <Loader size={12} className="animate-spin" /> : <Plus size={12} />} Assign
        </button>
      </div>
      {f.username && (
        <div className="mt-2 text-[10px] text-gray-400 flex flex-wrap gap-3 items-center">
          <span>Clients:</span>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={!f.clientIds.length} onChange={() => setF(x => ({ ...x, clientIds: [] }))} className="accent-emerald-500" />
            all of {f.username}'s clients
          </label>
          {userClients.map(c => (
            <label key={c.id} className="flex items-center gap-1">
              <input type="checkbox" checked={f.clientIds.includes(c.id)}
                onChange={e => setF(x => ({ ...x, clientIds: e.target.checked ? [...x.clientIds, c.id] : x.clientIds.filter(i => i !== c.id) }))}
                className="accent-emerald-500" />
              {c.name} <span className="text-gray-500">{c.id} {c.role === "CHILD" ? `${c.multiplier}x` : "parent"}</span>
            </label>
          ))}
        </div>
      )}
      {error && <div className="mt-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1.5">{error}</div>}
    </form>
  );
}

// Capital each client gives to one strategy (₹). Lots for that client =
// strategy lots × allocation ÷ the strategy capital. Blank = normal sizing.
function AllocationEditor({ a, clients, onSave, busy }) {
  const mine = clients.filter(c => !c.assignedTo || c.assignedTo === a.username)
    .filter(c => !a.clientIds?.length || a.clientIds.includes(c.id));
  const [vals, setVals] = useState(() => Object.fromEntries(mine.map(c => [c.id, a.allocations?.[c.id] ?? ""])));
  const base = Number(a.capital) || 0;
  return (
    <div className="bg-[#161a1f] border border-gray-700 rounded px-3 py-2 my-1">
      <div className="text-[10px] text-gray-400 mb-1.5">
        Capital per client for <b className="text-gray-200">{a.strategyName}</b> — lots = strategy lots × allocation ÷ strategy capital ({base ? `₹${base.toLocaleString("en-IN")}` : "not set"}). Leave blank to use the client's normal sizing; 0 = this client does not run this strategy.
      </div>
      <div className="flex flex-wrap gap-3">
        {mine.map(c => {
          const v = vals[c.id];
          const factor = v === "" || !base ? null : Number(v) / base;
          return (
            <label key={c.id} className="text-[10px] text-gray-400">
              {c.name} <span className="text-gray-600">{c.id}{c.capital ? ` · capital ₹${Number(c.capital).toLocaleString("en-IN")}` : ""}</span><br />
              <input type="number" min="0" step="100000" value={v} placeholder="normal sizing"
                onChange={e => setVals(x => ({ ...x, [c.id]: e.target.value }))}
                className="bg-[#1e2329] border border-gray-600 text-white text-[11px] px-2 py-1 rounded-sm w-[150px]" />
              {factor !== null && <span className="ml-1 text-sky-300">{Math.round(factor * 100) / 100}x</span>}
            </label>
          );
        })}
      </div>
      <button disabled={busy} onClick={() => onSave(Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== "").map(([k, v]) => [k, Number(v)])))}
        className="mt-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-[10px] font-semibold px-3 py-1 rounded-sm">
        Save allocations
      </button>
    </div>
  );
}

// Per client: capital allocated across all strategies vs the client's capital.
function AllocationSummary({ assignments, clients }) {
  const rows = clients.map(c => {
    const parts = assignments.filter(a => a.allocations?.[c.id] > 0).map(a => ({ name: `${a.strategyName} (${a.username})`, amt: a.allocations[c.id] }));
    const total = parts.reduce((s, p) => s + p.amt, 0);
    return { c, parts, total };
  }).filter(r => r.parts.length);
  if (!rows.length) return null;
  return (
    <div className="bg-[#1e2329] border border-gray-700 rounded">
      <div className="px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200">Capital allocated to strategies, per client</div>
      <table className="w-full text-left text-[10px]">
        <thead><tr className="text-gray-500 uppercase text-[9px]">{["Client", "Capital", "Allocated", "Used", "Strategies"].map(h => <th key={h} className="px-2 py-1">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map(({ c, parts, total }) => {
            const pct = c.capital > 0 ? (total / c.capital) * 100 : null;
            return (
              <tr key={c.id} className="border-t border-gray-800">
                <td className="px-2 py-1 text-gray-200">{c.name} <span className="text-gray-500">{c.id}</span></td>
                <td className="px-2 py-1 text-gray-300">{c.capital ? `₹${Number(c.capital).toLocaleString("en-IN")}` : "—"}</td>
                <td className="px-2 py-1 text-gray-300">₹{total.toLocaleString("en-IN")}</td>
                <td className={`px-2 py-1 font-semibold ${pct === null ? "text-gray-500" : pct > 100 ? "text-red-400" : "text-emerald-400"}`}>
                  {pct === null ? "set capital" : `${pct.toFixed(0)}%${pct > 100 ? " — over-allocated" : ""}`}
                </td>
                <td className="px-2 py-1 text-gray-400">{parts.map(p => `${p.name}: ₹${p.amt.toLocaleString("en-IN")}`).join(" · ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminStrategies() {
  const [strategies, setStrategies] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [users, setUsers] = useState([]);
  const [clients, setClients] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [allocOpen, setAllocOpen] = useState(null); // assignment id with the allocation editor open

  const load = useCallback(async () => {
    try {
      const [s, a, u, c] = await Promise.all([
        adminFetch("/api/admin/strategies"),
        adminFetch("/api/admin/assignments"),
        adminFetch("/api/admin/users"),
        adminFetch("/api/admin/clients"),
      ]);
      setStrategies(s); setAssignments(a); setUsers(u); setClients(c); setError("");
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 4000); return () => clearInterval(id); }, [load]);

  const act = async (key, fn) => {
    setBusy(key); setError("");
    try { await fn(); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };

  const delStrategy = s => {
    if (!window.confirm(`Delete strategy "${s.name}" (${s.fileName})?`)) return;
    act(`s:${s.id}`, () => adminFetch(`/api/admin/strategies/${s.id}`, { method: "DELETE" }));
  };
  const control = (a, action) => {
    if (action === "start" && a.mode === "LIVE" && !window.confirm(`Start "${a.strategyName}" for ${a.username} in LIVE mode? It sends REAL orders.`)) return;
    if (action === "squareoff" && !window.confirm(`Square off ${a.openPositions} open position(s) of "${a.strategyName}" for ${a.username}?`)) return;
    act(`a:${a.assignmentId}`, () => adminFetch(`/api/admin/assignments/${a.assignmentId}/${action}`, { method: "POST" }));
  };
  const update = (a, body, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    act(`a:${a.assignmentId}`, () => adminFetch(`/api/admin/assignments/${a.assignmentId}`, { method: "PUT", body }));
  };
  const remove = a => {
    if (!window.confirm(`Remove "${a.strategyName}" from ${a.username}?`)) return;
    act(`a:${a.assignmentId}`, () => adminFetch(`/api/admin/assignments/${a.assignmentId}`, { method: "DELETE" }));
  };

  const journalLoad = useCallback((kind, date) => adminFetch(`/api/admin/journal/${kind}?date=${date}`), []);
  const journalDownload = useCallback((kind, date) =>
    downloadFile(`${API_BASE}/api/admin/journal/${kind}?date=${date}&format=csv`, `all-${kind}-${date}.csv`, authHeader()), []);

  return (
    <div className="flex flex-col gap-3">
      {error && <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1.5">{error}</div>}

      <UploadBox onDone={load} />

      <div className="bg-[#1e2329] border border-gray-700 rounded">
        <div className="px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200">Strategy library ({strategies.length})</div>
        <div className="overflow-auto max-h-[30vh]">
          {strategies.length === 0 ? <div className="text-gray-500 text-[11px] px-3 py-3">No strategies uploaded yet.</div> : (
            <table className="w-full text-left text-[10px]">
              <thead><tr className="text-gray-500 uppercase text-[9px]">
                {["Name", "File", "Symbols", "When", "Legs", "Risk", "Assigned to", ""].map(h => <th key={h} className="px-2 py-1">{h}</th>)}
              </tr></thead>
              <tbody>
                {strategies.map(s => (
                  <tr key={s.id} className="border-t border-gray-800 align-top">
                    <td className="px-2 py-1 text-gray-100 font-semibold whitespace-nowrap">{s.name}{s.tags.length > 0 && <span className="text-gray-500 font-normal"> [{s.tags.join(", ")}]</span>}</td>
                    <td className="px-2 py-1 text-gray-400 whitespace-nowrap">{s.fileName}<div className="text-gray-600">{new Date(s.uploadedAt).toLocaleString()}</div></td>
                    {s.summary ? (
                      <>
                        <td className="px-2 py-1 text-gray-300">{s.summary.symbols.join(" + ")}</td>
                        <td className="px-2 py-1 text-gray-300 whitespace-nowrap">DTE {s.summary.entryDte.join(",")} · {s.summary.expiry.replace("_", " ")}</td>
                        <td className="px-2 py-1 text-gray-300 whitespace-nowrap">{s.summary.groups.map(g => <div key={g.id}>{g.window} ×{g.entries}: {g.legs.join(", ")}</div>)}</td>
                        <td className="px-2 py-1 text-gray-300 whitespace-nowrap">stop {s.summary.stop}<br />daily loss {s.summary.dailyLossPct ? `${s.summary.dailyLossPct}%` : "—"}<br />{s.summary.exit}</td>
                      </>
                    ) : <td colSpan={4} className="px-2 py-1 text-red-400">Invalid: {s.errors.join("; ")}</td>}
                    <td className="px-2 py-1 text-purple-300">{s.assignedTo.join(", ") || <span className="text-gray-500">—</span>}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      <button title="Download file" onClick={() => downloadFile(`${API_BASE}/api/admin/strategies/${s.id}/raw`, s.fileName || `${s.name}.json`, authHeader()).catch(e => setError(e.message))}
                        className="p-1 text-gray-400 hover:text-gray-100"><Download size={12} /></button>
                      <button title="Delete" disabled={busy === `s:${s.id}`} onClick={() => delStrategy(s)} className="p-1 text-red-400 hover:text-red-300"><Trash2 size={12} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <AssignForm strategies={strategies} users={users} clients={clients} onDone={load} />

      <div className="bg-[#1e2329] border border-gray-700 rounded">
        <div className="px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200">Assignments ({assignments.length})</div>
        <div className="overflow-auto max-h-[40vh]">
          {assignments.length === 0 ? <div className="text-gray-500 text-[11px] px-3 py-3">Nothing assigned yet.</div> : (
            <table className="w-full text-left text-[10px]">
              <thead><tr className="text-gray-500 uppercase text-[9px]">
                {["Strategy", "User", "Mode", "Capital", "Status", "Open", "P&L today", "Enabled", "Actions"].map(h => <th key={h} className="px-2 py-1">{h}</th>)}
              </tr></thead>
              <tbody>
                {assignments.map(a => {
                  const isBusy = busy === `a:${a.assignmentId}`;
                  const stopped = a.status === "STOPPED";
                  return (
                    <React.Fragment key={a.assignmentId}>
                    <tr className="border-t border-gray-800 align-top">
                      <td className="px-2 py-1 text-gray-100 font-semibold">{a.strategyName}</td>
                      <td className="px-2 py-1 text-purple-300">{a.username}</td>
                      <td className="px-2 py-1">
                        <select value={a.assignedMode || a.mode} disabled={!stopped || isBusy}
                          title={stopped ? "" : "Stop the strategy to change mode"}
                          onChange={e => update(a, { mode: e.target.value }, e.target.value === "LIVE" ? `Switch "${a.strategyName}" for ${a.username} to LIVE? Its next start sends REAL orders.` : null)}
                          className={`bg-[#161a1f] border border-gray-600 text-[10px] px-1 py-0.5 rounded-sm disabled:opacity-60 ${(a.assignedMode || a.mode) === "LIVE" ? "text-red-300" : "text-amber-300"}`}>
                          <option value="PAPER">PAPER</option>
                          <option value="LIVE">LIVE</option>
                        </select>
                        {a.assignedMode === "LIVE" && a.mode === "PAPER" && <div className="text-[9px] text-amber-400">runs PAPER (global mode)</div>}
                      </td>
                      <td className="px-2 py-1 text-gray-300">
                        {a.capital ? `₹${Number(a.capital).toLocaleString("en-IN")}` : "—"}
                        <button onClick={() => setAllocOpen(o => (o === a.assignmentId ? null : a.assignmentId))}
                          className="block text-[9px] text-sky-300 hover:text-sky-200">
                          Allocations{Object.keys(a.allocations || {}).length ? ` (${Object.keys(a.allocations).length})` : ""} {allocOpen === a.assignmentId ? "▲" : "▼"}
                        </button>
                      </td>
                      <td className="px-2 py-1">
                        <div className={`font-semibold ${statusTone[a.status]}`}>{a.status}</div>
                        <div className="text-gray-500 max-w-[260px]">{a.phase}</div>
                      </td>
                      <td className="px-2 py-1 text-gray-300">{a.openPositions}{a.needsCheck ? <span className="text-fuchsia-400"> +{a.needsCheck} check</span> : ""}</td>
                      <td className={`px-2 py-1 font-semibold ${a.pnlToday.total >= 0 ? "text-emerald-400" : "text-red-400"}`}>{money(a.pnlToday.total)}</td>
                      <td className="px-2 py-1">
                        <input type="checkbox" checked={a.enabled} disabled={isBusy} onChange={e => update(a, { enabled: e.target.checked })} className="accent-emerald-500" />
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {(a.status === "STOPPED" || a.status === "STOPPING") && (
                          <button title="Start" disabled={isBusy || !a.enabled} onClick={() => control(a, "start")} className="p-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-40"><Play size={12} /></button>
                        )}
                        {a.status === "PAUSED" && <button title="Resume" disabled={isBusy} onClick={() => control(a, "resume")} className="p-1 text-fuchsia-400"><PlayCircle size={12} /></button>}
                        {(a.status === "RUNNING" || a.status === "PAUSED") && <button title="Stop" disabled={isBusy} onClick={() => control(a, "stop")} className="p-1 text-gray-300"><Square size={12} /></button>}
                        {a.openPositions > 0 && <button title="Square off" disabled={isBusy} onClick={() => control(a, "squareoff")} className="p-1 text-red-400"><OctagonX size={12} /></button>}
                        {stopped && <button title="Remove assignment" disabled={isBusy} onClick={() => remove(a)} className="p-1 text-red-400"><Trash2 size={12} /></button>}
                        {isBusy && <Loader size={12} className="inline animate-spin text-gray-400" />}
                      </td>
                    </tr>
                    {allocOpen === a.assignmentId && (
                      <tr><td colSpan={9} className="px-2">
                        <AllocationEditor key={a.assignmentId} a={a} clients={clients} busy={isBusy}
                          onSave={allocations => update(a, { allocations })} />
                      </td></tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <AllocationSummary assignments={assignments} clients={clients} />

      <JournalView load={journalLoad} download={journalDownload} showUser />
    </div>
  );
}
