import React, { useState, useEffect, useCallback } from "react";
import { Plus, Save, Trash2, RotateCcw, Loader } from "lucide-react";
import { adminFetch } from "./authFetch.js";

// Admin console -> Clients tab.
// Parent (Interactive + Market Data API) and Child (Interactive API, sized by
// Multiplier) roster: add, edit keys, assign to a dashboard login, delete,
// and log in / connect / enable any client. Secrets are only ever shown
// masked; leaving a key field blank while editing keeps the stored value.

const emptyForm = {
  id: "", name: "", role: "CHILD", multiplier: "1",
  rootUrl: "https://xtsmum.5paisa.com", source: "WEBAPI",
  assignedTo: "",
  capital: "",
  interactiveKey: "", interactiveSecret: "",
  marketKey: "", marketSecret: "",
  enabled: true,
};

const inputCls = "w-full bg-[#161a1f] border border-gray-600 text-white text-[12px] px-2 py-1.5 rounded-sm focus:outline-none focus:border-blue-500";

function FormRow({ label, hint, children }) {
  return (
    <div className="mb-2">
      <div className="text-[10px] text-gray-500 mb-0.5">{label}</div>
      {children}
      {hint && <div className="text-[9px] text-gray-500 mt-0.5">{hint}</div>}
    </div>
  );
}

function Pill({ on, onText, offText, onClick, disabled, danger }) {
  const onCls  = "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
  const offCls = danger ? "bg-red-500/10 text-red-400 border border-red-500/20" : "bg-gray-600/30 text-gray-400 border border-gray-600/40";
  return (
    <button disabled={disabled} onClick={onClick}
      className={`px-1.5 py-0.5 rounded-sm text-[9px] font-semibold disabled:opacity-40 ${on ? onCls : offCls}`}>
      {on ? onText : offText}
    </button>
  );
}

export default function AdminClients() {
  const [rows, setRows]           = useState([]);
  const [users, setUsers]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [busyId, setBusyId]       = useState(null);
  const [error, setError]         = useState("");
  const [notice, setNotice]       = useState("");
  const [editingId, setEditingId] = useState(null);
  const [form, setForm]           = useState(emptyForm);

  const load = useCallback(async () => {
    try {
      const [list, names] = await Promise.all([
        adminFetch("/api/admin/clients"),
        adminFetch("/api/admin/users"),
      ]);
      setRows(Array.isArray(list) ? list : []);
      setUsers(Array.isArray(names) ? names : []);
      setForm(f => (f.id || editingId) ? f : { ...f, role: list.some(c => c.role === "PARENT") ? "CHILD" : "PARENT" });
    } catch (e) {
      setError("Could not load clients: " + e.message);
    } finally {
      setLoading(false);
    }
  }, [editingId]);

  useEffect(() => { load(); }, [load]);

  const parentExists  = rows.some(r => r.role === "PARENT");
  const editingParent = !!editingId && rows.find(r => r.id === editingId)?.role === "PARENT";

  const resetForm = () => {
    setForm({ ...emptyForm, role: parentExists ? "CHILD" : "PARENT" });
    setEditingId(null);
    setError(""); setNotice("");
  };

  const startEdit = (row) => {
    setEditingId(row.id);
    setForm({
      id: row.id, name: row.name, role: row.role,
      multiplier: String(row.multiplier || 1),
      rootUrl: row.rootUrl || emptyForm.rootUrl,
      source: row.source || "WEBAPI",
      assignedTo: row.assignedTo || "",
      capital: row.capital ?? "",
      interactiveKey: "", interactiveSecret: "",
      marketKey: "", marketSecret: "",
      enabled: row.enabled,
    });
    setError(""); setNotice("");
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setNotice("");

    if (!form.id.trim() || !form.name.trim()) { setError("Client ID and Client Name are required"); return; }
    if (form.role === "CHILD" && !(Number(form.multiplier) > 0)) { setError("Multiplier must be a positive number for a child client"); return; }
    if (!editingId) {
      if (!form.interactiveKey || !form.interactiveSecret) { setError("Interactive API Key and Secret are required"); return; }
      if (form.role === "PARENT" && (!form.marketKey || !form.marketSecret || !form.rootUrl)) {
        setError("Parent requires Root URL + Interactive API + Market Data API (all fields)"); return;
      }
    }

    const payload = {
      id: form.id.trim(), name: form.name.trim(), role: form.role,
      multiplier: Number(form.multiplier) || 1,
      rootUrl: form.rootUrl.trim(), source: form.source,
      assignedTo: form.assignedTo || "",
      capital: form.capital === "" ? null : Number(form.capital),
      enabled: form.enabled,
    };
    if (form.interactiveKey)    payload.interactiveKey    = form.interactiveKey.trim();
    if (form.interactiveSecret) payload.interactiveSecret = form.interactiveSecret.trim();
    if (form.role === "PARENT") {
      if (form.marketKey)    payload.marketKey    = form.marketKey.trim();
      if (form.marketSecret) payload.marketSecret = form.marketSecret.trim();
    }

    setSaving(true);
    try {
      if (editingId) await adminFetch(`/api/admin/clients/${encodeURIComponent(editingId)}`, { method: "PUT", body: payload });
      else           await adminFetch("/api/admin/clients", { method: "POST", body: payload });
      setNotice(editingId ? `Updated ${payload.name}` : `Added ${payload.role === "PARENT" ? "parent" : "child"} ${payload.name}`);
      setEditingId(null);
      setForm({ ...emptyForm, role: "CHILD" });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm(`Delete client ${id}? Its saved API keys are removed and it cannot be undone.`)) return;
    setBusyId(id); setError("");
    try {
      await adminFetch(`/api/admin/clients/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (editingId === id) resetForm();
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusyId(null); }
  };

  const act = async (row, action, body) => {
    setBusyId(row.id); setError("");
    try {
      await adminFetch(`/api/admin/clients/${encodeURIComponent(row.id)}/${action}`, { method: "POST", body });
      await load();
    } catch (err) { setError(`${row.id}: ${err.message}`); }
    finally { setBusyId(null); }
  };

  const parentCount = rows.filter(r => r.role === "PARENT").length;

  return (
    <div className="flex flex-col gap-3">
      {!loading && !parentExists && (
        <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-sm px-2 py-1.5">
          No Parent client configured yet. Add one first — set <b>Role = Parent</b> (Market Data API is mandatory for the parent).
        </div>
      )}

      <div className="bg-[#1e2329] border border-gray-700 rounded">
        <div className="px-3 py-2 border-b border-gray-700 text-[11px] font-bold text-gray-200">
          Client roster — {parentCount} parent + {rows.length - parentCount} children
        </div>
        <div className="overflow-auto max-h-[38vh]">
          {loading ? (
            <div className="text-center text-gray-400 text-xs py-6 flex items-center justify-center gap-2">
              <Loader size={14} className="animate-spin" /> Loading clients…
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center text-gray-500 text-xs py-6">No clients yet — add a Parent client below.</div>
          ) : (
            <table className="w-full text-left border-collapse text-[11px] whitespace-nowrap">
              <thead>
                <tr className="text-gray-400 uppercase tracking-wide border-b border-gray-700 text-[9px]">
                  <th className="py-1.5 px-2">Client Name</th>
                  <th className="py-1.5 px-2">Client ID</th>
                  <th className="py-1.5 px-2">Role</th>
                  <th className="py-1.5 px-2">Assigned To</th>
                  <th className="py-1.5 px-2">Mult (x)</th>
                  <th className="py-1.5 px-2">Capital</th>
                  <th className="py-1.5 px-2">Interactive Key</th>
                  <th className="py-1.5 px-2">Market Key</th>
                  <th className="py-1.5 px-2">Login</th>
                  <th className="py-1.5 px-2">Conn</th>
                  <th className="py-1.5 px-2">Trading</th>
                  <th className="py-1.5 px-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const busy = busyId === row.id;
                  return (
                    <tr key={row.id} className={`border-b border-gray-800 ${editingId === row.id ? "bg-[#2a2f38]" : ""}`}>
                      <td className="py-1.5 px-2 text-gray-100">{row.name}</td>
                      <td className="py-1.5 px-2 font-mono text-gray-400">{row.id}</td>
                      <td className="py-1.5 px-2">
                        <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${row.role === "PARENT" ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" : "bg-blue-500/20 text-blue-400 border border-blue-500/30"}`}>
                          {row.role}
                        </span>
                      </td>
                      <td className="py-1.5 px-2">
                        {row.assignedTo
                          ? <span className="px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30">{row.assignedTo}</span>
                          : <span className="text-gray-500 text-[9px]">everyone</span>}
                      </td>
                      <td className="py-1.5 px-2 text-gray-300">{row.role === "PARENT" ? "—" : `${row.multiplier}x`}</td>
                      <td className="py-1.5 px-2 text-gray-300">{row.capital ? `₹${Number(row.capital).toLocaleString("en-IN")}` : <span className="text-gray-600">—</span>}</td>
                      <td className="py-1.5 px-2 font-mono text-[10px] text-gray-400">
                        {row.hasInteractiveCreds ? `${row.interactiveKeyMasked} / ${row.interactiveSecretMasked}` : <span className="text-red-400">missing</span>}
                      </td>
                      <td className="py-1.5 px-2 font-mono text-[10px] text-gray-400">
                        {row.role !== "PARENT" ? "—" : row.hasMarketCreds ? `${row.marketKeyMasked} / ${row.marketSecretMasked}` : <span className="text-red-400">missing</span>}
                      </td>
                      <td className="py-1.5 px-2">
                        <Pill on={row.isLogged} onText={busy ? "…" : "IN"} offText={busy ? "…" : "OUT"} disabled={busy}
                          onClick={() => act(row, row.isLogged ? "logout" : "login")} />
                      </td>
                      <td className="py-1.5 px-2">
                        <Pill on={row.isConnected} onText="ON" offText="OFF" disabled={busy || !row.isLogged}
                          onClick={() => act(row, row.isConnected ? "disconnect" : "connect")} />
                      </td>
                      <td className="py-1.5 px-2">
                        <Pill on={row.enabled} onText="OK" offText="OFF" danger disabled={busy}
                          onClick={() => act(row, "toggle", { enabled: !row.enabled })} />
                      </td>
                      <td className="py-1.5 px-2 text-right">
                        <button onClick={() => startEdit(row)} className="text-[9px] px-1.5 py-0.5 mr-1 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 rounded-sm text-gray-200">Edit</button>
                        <button disabled={busy} onClick={() => remove(row.id)} className="text-[9px] px-1.5 py-0.5 bg-red-600/20 hover:bg-red-600/40 border border-red-600/30 rounded-sm text-red-400">Del</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <form onSubmit={submit} className="bg-[#1e2329] border border-gray-700 rounded px-3 py-3">
        <div className="text-white text-xs font-bold mb-2">{editingId ? `Edit Client — ${editingId}` : "Add New Client"}</div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] text-gray-500 uppercase font-semibold mb-1.5">Identity</div>
            <FormRow label="Client Name">
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="e.g. ABHISHEK KHANDAL" />
            </FormRow>
            <FormRow label="Client ID">
              <input value={form.id} disabled={!!editingId} onChange={e => setForm(f => ({ ...f, id: e.target.value }))}
                className={`${inputCls} ${editingId ? "opacity-50 cursor-not-allowed" : ""}`} placeholder="e.g. 55583335" />
            </FormRow>
            <FormRow label="Root URL">
              <input value={form.rootUrl} onChange={e => setForm(f => ({ ...f, rootUrl: e.target.value }))} className={inputCls} placeholder="https://xtsmum.5paisa.com" />
            </FormRow>
            <FormRow label="Source">
              <select value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))} className={inputCls}>
                <option value="WEBAPI">WEBAPI</option>
                <option value="CTCL">CTCL</option>
              </select>
            </FormRow>
            <FormRow label="Role">
              <select value={form.role} disabled={!!editingId} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                className={`${inputCls} ${editingId ? "opacity-50 cursor-not-allowed" : ""}`}>
                <option value="CHILD">Child</option>
                <option value="PARENT" disabled={parentExists && !editingParent}>
                  Parent {parentExists && !editingParent ? "(already exists)" : ""}
                </option>
              </select>
            </FormRow>
            <FormRow label="Assigned To" hint='Only this dashboard login will see/trade this client. "Everyone" keeps it shared.'>
              <select value={form.assignedTo} onChange={e => setForm(f => ({ ...f, assignedTo: e.target.value }))} className={inputCls}>
                <option value="">Everyone (unassigned)</option>
                {users.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </FormRow>
            {form.role === "CHILD" && (
              <FormRow label="Multiplier (x)">
                <input type="number" min="0.1" step="0.1" value={form.multiplier}
                  onChange={e => setForm(f => ({ ...f, multiplier: e.target.value }))} className={inputCls} placeholder="e.g. 2 for 2x parent size" />
              </FormRow>
            )}
            <FormRow label="Capital (₹)" hint="Account capital — used when Admin > Execution & Limits sizes lots by capital (e.g. ₹1 Cr = 1x).">
              <input type="number" min="0" step="100000" value={form.capital}
                onChange={e => setForm(f => ({ ...f, capital: e.target.value }))} className={inputCls} placeholder="e.g. 10000000 for ₹1 Cr" />
            </FormRow>
            <label className="flex items-center gap-2 text-[11px] text-gray-300 mt-1">
              <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="accent-emerald-500" />
              Trading enabled for this client
            </label>
          </div>

          <div>
            <div className="text-[10px] text-gray-500 uppercase font-semibold mb-1.5">
              XTS Interactive API <span className="text-amber-500">(mandatory)</span>
            </div>
            <FormRow label="API Key">
              <input value={form.interactiveKey} autoComplete="off" onChange={e => setForm(f => ({ ...f, interactiveKey: e.target.value }))}
                className={inputCls} placeholder={editingId ? "Leave blank to keep existing" : "Interactive API Key"} />
            </FormRow>
            <FormRow label="Secret Key">
              <input type="password" autoComplete="new-password" value={form.interactiveSecret} onChange={e => setForm(f => ({ ...f, interactiveSecret: e.target.value }))}
                className={inputCls} placeholder={editingId ? "Leave blank to keep existing" : "Interactive Secret Key"} />
            </FormRow>

            {form.role === "PARENT" && (
              <>
                <div className="text-[10px] text-gray-500 uppercase font-semibold mb-1.5 mt-3">
                  Market Data API <span className="text-amber-500">(mandatory for parent)</span>
                </div>
                <FormRow label="Market Key">
                  <input value={form.marketKey} autoComplete="off" onChange={e => setForm(f => ({ ...f, marketKey: e.target.value }))}
                    className={inputCls} placeholder={editingId ? "Leave blank to keep existing" : "Market Data API Key"} />
                </FormRow>
                <FormRow label="Market Secret">
                  <input type="password" autoComplete="new-password" value={form.marketSecret} onChange={e => setForm(f => ({ ...f, marketSecret: e.target.value }))}
                    className={inputCls} placeholder={editingId ? "Leave blank to keep existing" : "Market Data Secret Key"} />
                </FormRow>
              </>
            )}
          </div>
        </div>

        {error  && <div className="mt-3 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1.5">{error}</div>}
        {notice && <div className="mt-3 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-sm px-2 py-1.5">{notice}</div>}

        <div className="flex items-center gap-2 mt-3">
          <button type="submit" disabled={saving}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-semibold px-3 py-1.5 rounded-sm">
            {saving ? <Loader size={12} className="animate-spin" /> : editingId ? <Save size={12} /> : <Plus size={12} />}
            {editingId ? "Update Client" : "Add Client"}
          </button>
          <button type="button" onClick={resetForm}
            className="flex items-center gap-1.5 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 text-gray-200 text-[11px] px-3 py-1.5 rounded-sm">
            <RotateCcw size={12} /> Clear Form
          </button>
          {editingId && (
            <button type="button" onClick={() => remove(editingId)}
              className="flex items-center gap-1.5 bg-red-600/20 hover:bg-red-600/40 border border-red-600/30 text-red-400 text-[11px] px-3 py-1.5 rounded-sm ml-auto">
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>
        <div className="text-[9px] text-gray-500 mt-2">Saved to <code className="text-gray-400">backend/data/clients.json</code> on the server.</div>
      </form>
    </div>
  );
}
